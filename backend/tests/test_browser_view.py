"""People can see when an agent uses the browser and what its tab shows: browser_action events + saved screenshots."""
from __future__ import annotations

from typing import Any

import pytest

from app.core.config import get_settings
from app.llm.router import set_provider_override
from app.services import browser as B
from app.services import browser_frames
from conftest import NativeScriptedProvider, agent, events, make_company, start_run, wait_status

JPEG = b"\xff\xd8\xff\xe0fake-jpeg"
PNG = b"\x89PNG\r\n\x1a\nfake-png"
NAV_OUT = "### Ran Playwright code\n```js\nawait page.goto('http://127.0.0.1:8000/');\n```\n### Page state\n- Page URL: http://127.0.0.1:8000/\n- Page Title: Snake\n- Page Snapshot:\n```yaml\n- heading \"Snake\"\n```"


class FakeTab:
    """One agent's tab: scripted text replies; screenshots return an image like Playwright MCP does."""

    calls: list[tuple[str, dict[str, Any]]] = []

    def __init__(self, url: str) -> None:
        self.images: list[bytes] = []

        class _Live:
            def done(self) -> bool:
                return False

        self.task = _Live()

    async def call(self, tool: str, args: dict[str, Any]) -> tuple[bool, str]:
        FakeTab.calls.append((tool, args))
        self.images = []
        if tool == "browser_navigate":
            return True, NAV_OUT
        if tool == "browser_take_screenshot":
            if args.get("filename"):  # like Playwright MCP: with a file name the image is only written to its output dir
                out = get_settings().octopus_home / "browser"
                out.mkdir(parents=True, exist_ok=True)
                (out / args["filename"]).write_bytes(JPEG)
                return True, f"### Result\n- [Screenshot of viewport](./{args['filename']})"
            self.images = [PNG]
            return True, "[image]"
        if tool == "browser_click":
            return False, "### Error\nRef e99 not found in the current page snapshot"
        return True, "ok"

    async def close(self) -> None:
        return None


@pytest.fixture
def fake_browser(monkeypatch):  # type: ignore[no-untyped-def]
    monkeypatch.setattr(B, "_AgentSession", FakeTab)
    FakeTab.calls = []
    svc = B.browser

    class Proc:
        returncode = None

    monkeypatch.setattr(svc, "proc", Proc())
    monkeypatch.setattr(svc, "url", "http://127.0.0.1:1/mcp")
    monkeypatch.setattr(svc, "status", "ready")
    monkeypatch.setattr(svc, "verified", True)
    monkeypatch.setattr(svc, "_sessions", {})
    return svc


def nav(url: str) -> tuple[str, dict[str, Any]]:
    return "mcp__browser__browser_navigate", {"url": url}


def test_page_info_reads_url_and_title() -> None:
    assert B.page_info(NAV_OUT) == ("http://127.0.0.1:8000/", "Snake")
    assert B.page_info("ok") == ("", "")


async def test_each_browser_action_is_shown_with_what_the_tab_looked_like(client, workspace, fake_browser) -> None:
    set_provider_override(NativeScriptedProvider({"Ann": [
        [nav("http://127.0.0.1:8000/")],
        [("mcp__browser__browser_snapshot", {})],
        [("mcp__browser__browser_click", {"element": "Start", "target": "e99"})],
        [("finish", {"summary": "checked"})]]}))
    cid = await make_company(client, workspace, [agent("a", "Ann", entry=True)], [])
    run = await start_run(client, workspace, cid)
    await wait_status(client, workspace, run["id"])

    acts = [e["payload"] for e in await events(client, workspace, run["id"], "browser_action")]
    assert [a["tool"] for a in acts] == ["browser_navigate", "browser_snapshot", "browser_click"]
    navigate, snapshot, click = acts
    assert navigate["agent_id"] == "a" and navigate["ok"] and navigate["args"] == {"url": "http://127.0.0.1:8000/"}
    assert (navigate["url"], navigate["title"]) == ("http://127.0.0.1:8000/", "Snake")
    assert navigate["frame"], "a screenshot follows an action that changes the page"
    assert snapshot["frame"] is None, "reading the page doesn't change it: no extra screenshot"
    assert snapshot["url"] == "http://127.0.0.1:8000/", "the tab's address carries over to actions that don't report one"
    assert not click["ok"] and click["frame"] is None and "not found" in click["note"]

    shots = [args for tool, args in FakeTab.calls if tool == "browser_take_screenshot"]
    assert shots == [{"type": "jpeg", "filename": B.live_frame_name(run["id"], "a")}], "one fixed file per agent, not a new file per frame"

    r = await client.get(f"/api/v1/w/{workspace['id']}/runs/{run['id']}/browser/{navigate['frame']}")
    assert r.status_code == 200 and r.content == JPEG and r.headers["content-type"] == "image/jpeg"
    for bad in ("registry.db", "000001.jpeg.html", "999999.jpeg"):  # only frame names, only existing frames
        assert (await client.get(f"/api/v1/w/{workspace['id']}/runs/{run['id']}/browser/{bad}")).status_code == 404

    live = get_settings().octopus_home / "browser" / B.live_frame_name(run["id"], "a")
    assert not live.exists(), "the browser's scratch file for this run is cleaned up when the run ends"
    await client.delete(f"/api/v1/w/{workspace['id']}/runs/{run['id']}")
    assert not browser_frames.run_dir(run["id"]).exists(), "deleting a run deletes its screenshots"


async def test_agents_own_screenshot_is_reused_not_retaken(client, workspace, fake_browser) -> None:
    set_provider_override(NativeScriptedProvider({"Ann": [
        [("mcp__browser__browser_take_screenshot", {})], [("finish", {"summary": "ok"})]]}))
    cid = await make_company(client, workspace, [agent("a", "Ann", entry=True)], [])
    run = await start_run(client, workspace, cid)
    await wait_status(client, workspace, run["id"])
    (act,) = [e["payload"] for e in await events(client, workspace, run["id"], "browser_action")]
    assert act["frame"].endswith(".png")
    assert [t for t, _ in FakeTab.calls] == ["browser_take_screenshot"]


def test_old_frames_are_pruned(monkeypatch) -> None:
    monkeypatch.setattr(browser_frames, "KEEP_PER_RUN", 3)
    names = [browser_frames.save("prune-run", JPEG) for _ in range(5)]
    kept = sorted(p.name for p in browser_frames.run_dir("prune-run").iterdir())
    assert kept == names[-3:]
    assert browser_frames.path("prune-run", names[0]) is None
    assert browser_frames.path("prune-run", "../x.jpeg") is None
    browser_frames.delete_run("prune-run")
