"""Built-in browser health is honest: "ready" means a browser launched, failures degrade it with a diagnosis (issue #30)."""
from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from app.services import browser as B

# What Playwright MCP returned in the reported container (abridged): the cause is buried under Chromium's command line.
LAUNCH_FAILURE = """### Error: async initializeServer: Target page, context or browser has been closed
Browser logs:
<launching> /home/octopus/.cache/ms-playwright/chromium-1247/chrome-linux64/chrome
  --disable-field-trial-config
  --disable-background-networking
  --disable-client-side-phishing-detection
/home/octopus/.cache/ms-playwright/chromium-1247/chrome-linux64/chrome: error while loading shared libraries: libglib-2.0.so.0: cannot open shared object file: No such file or directory
[pid=88][err] exited with code 127"""


def test_diagnosis_names_the_missing_library_and_drops_the_flag_wall() -> None:
    d = B.diagnose(LAUNCH_FAILURE)
    first = d.splitlines()[0]
    assert "libglib-2.0.so.0" in first and "install-deps" in first
    assert "--disable" not in d and "<launching>" not in d
    assert B.is_launch_failure(LAUNCH_FAILURE)


@pytest.mark.parametrize("out, expect", [
    ("[err] Process exited with code 127", "code 127"),
    ("Error: browserType.launch: Executable doesn't exist at /root/.cache/ms-playwright/chrome", "not installed"),
    ("### Error: async initializeServer: Target page, context or browser has been closed", "closed immediately"),
])
def test_diagnosis_of_other_launch_failures(out: str, expect: str) -> None:
    assert expect in B.diagnose(out).splitlines()[0] and B.is_launch_failure(out)


def test_page_level_errors_are_not_launch_failures() -> None:
    assert not B.is_launch_failure("### Result\nError: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:8000/")


class FakeSession:
    """Stands in for one MCP session to the Playwright server: replies are scripted per tool."""

    replies: dict[str, tuple[bool, str]] = {}
    calls: list[str] = []

    def __init__(self, url: str) -> None:
        self.url = url

        class _Done:
            def done(self) -> bool:
                return False

        self.task = _Done()

    async def call(self, tool: str, args: dict[str, Any]) -> tuple[bool, str]:
        FakeSession.calls.append(tool)
        return FakeSession.replies.get(tool, (True, "ok"))

    async def close(self) -> None:
        return None


@pytest.fixture
def svc(monkeypatch) -> B.BrowserService:  # type: ignore[no-untyped-def]
    monkeypatch.setattr(B, "_AgentSession", FakeSession)
    FakeSession.calls = []
    s = B.BrowserService()

    class Proc:
        returncode = None

    s.proc, s.url = Proc(), "http://127.0.0.1:1/mcp"  # type: ignore[assignment]
    s.status = "server_ready"
    return s


async def test_ready_only_after_a_page_was_actually_rendered(svc) -> None:  # type: ignore[no-untyped-def]
    FakeSession.replies = {"browser_navigate": (True, "navigated"), "browser_snapshot": (True, "- heading \"Browser ready\"")}
    await svc._verify()
    assert svc.status == "ready" and svc.verified and svc.error == ""


async def test_failed_smoke_test_is_an_error_with_a_diagnosis(svc) -> None:  # type: ignore[no-untyped-def]
    FakeSession.replies = {"browser_navigate": (False, LAUNCH_FAILURE)}
    await svc._verify()
    assert svc.status == "error" and not svc.verified
    assert "libglib-2.0.so.0" in svc.error.splitlines()[0]


async def test_launch_failure_during_a_call_degrades_health_and_short_circuits(svc) -> None:  # type: ignore[no-untyped-def]
    """Regression: the badge stayed 'Running' while every agent call failed identically."""
    svc.verified = True
    svc.status = "ready"
    FakeSession.replies = {"browser_navigate": (False, LAUNCH_FAILURE)}
    ok, out = await svc.call("run", "agent", "browser_navigate", {"url": "http://x"})
    assert not ok and svc.status == "error" and "libglib-2.0.so.0" in out
    FakeSession.calls.clear()
    ok, out = await svc.call("run", "agent2", "browser_snapshot", {})
    assert not ok and out.startswith("Browser unavailable:") and FakeSession.calls == [], "no further launch attempts"
    assert not svc.available()


async def test_recheck_recovers_after_the_environment_is_fixed(svc) -> None:  # type: ignore[no-untyped-def]
    svc.mark_broken(LAUNCH_FAILURE)
    FakeSession.replies = {"browser_navigate": (True, "navigated"), "browser_snapshot": (True, "Browser ready")}
    await svc.recheck()
    assert svc.status == "ready" and svc.verified


async def test_status_endpoint_separates_server_from_browser_health(client) -> None:
    body = (await client.get("/api/v1/settings/browser")).json()
    assert {"status", "verified", "error", "tools"} <= set(body)


def test_docker_image_installs_chromium_system_libraries() -> None:
    """The backend image must carry the libraries Chromium links against, and a Node that Playwright supports."""
    dockerfile = (Path(__file__).resolve().parents[1] / "Dockerfile").read_text()
    for lib in ("libglib2.0-0", "libnss3", "libgbm1", "libatk-bridge2.0-0", "libxkbcommon0", "libasound2"):
        assert lib in dockerfile, lib
    assert "FROM node:22" in dockerfile and "nodejs npm" not in dockerfile
