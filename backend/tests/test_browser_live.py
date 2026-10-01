"""Live view of an agent's tab (CDP screencast + user input). The end-to-end test drives a real Chromium through
Playwright MCP and only runs with OCTOPUS_E2E_BROWSER=1 (it needs Node and downloads a browser on first use)."""
from __future__ import annotations

import asyncio
import os
import shutil
from typing import Any

import pytest

from app.services.browser_live import input_command


def test_mouse_wheel_and_key_inputs_become_cdp_commands() -> None:
    m, p = input_command({"type": "mouse", "event": "mousePressed", "x": 10.5, "y": 20, "button": "left", "clicks": 1})
    assert m == "Input.dispatchMouseEvent" and p["type"] == "mousePressed" and (p["x"], p["y"], p["button"], p["clickCount"]) == (10.5, 20, "left", 1)
    m, p = input_command({"type": "mouse", "event": "mouseMoved", "x": 1, "y": 2})
    assert p["button"] == "none" and p["clickCount"] == 0
    m, p = input_command({"type": "wheel", "x": 5, "y": 5, "dx": 0, "dy": 120})
    assert p["type"] == "mouseWheel" and p["deltaY"] == 120
    m, p = input_command({"type": "key", "event": "keyDown", "key": "a", "code": "KeyA", "text": "a", "keyCode": 65})
    assert m == "Input.dispatchKeyEvent" and p["text"] == "a" and p["windowsVirtualKeyCode"] == 65
    _, p = input_command({"type": "key", "event": "keyUp", "key": "a", "text": "a"})
    assert "text" not in p  # only keyDown inserts text


@pytest.mark.parametrize("msg", [{"type": "mouse", "event": "evil"}, {"type": "key", "event": "keyPress"}, {"type": "navigate"}, {}])
def test_unknown_inputs_are_ignored(msg: dict[str, Any]) -> None:
    assert input_command(msg) is None


class FakeViewer:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []
        self.incoming: asyncio.Queue[dict[str, Any]] = asyncio.Queue()

    async def send_json(self, m: dict[str, Any]) -> None:
        self.sent.append(m)

    async def receive_json(self) -> dict[str, Any]:
        return await self.incoming.get()

    async def wait_for(self, pred, timeout: float = 30) -> dict[str, Any]:  # type: ignore[no-untyped-def]
        async def poll() -> dict[str, Any]:
            while True:
                for m in self.sent:
                    if pred(m):
                        return m
                await asyncio.sleep(0.05)
        return await asyncio.wait_for(poll(), timeout)


PAGE = ("data:text/html,<title>Live</title><button id=b style='position:fixed;left:0;top:0;width:300px;height:200px' "
        "onclick=\"document.title='clicked'\">Go</button>")


@pytest.mark.skipif(os.environ.get("OCTOPUS_E2E_BROWSER") != "1" or not shutil.which("npx"), reason="real browser e2e (OCTOPUS_E2E_BROWSER=1)")
async def test_live_view_streams_the_agents_real_tab_and_forwards_clicks() -> None:
    from app.services import browser_live
    from app.services.browser import BrowserService

    svc = BrowserService()
    browser_live.browser = svc  # the module-level service the viewer socket uses
    try:
        ok, out = await svc.call("run1", "ann", "browser_navigate", {"url": PAGE})
        assert ok, out
        ok, out = await svc.call("run1", "bob", "browser_navigate", {"url": "data:text/html,<title>Bob</title>bob"})
        assert ok, out
        target = await svc.live_target("run1", "ann")
        assert target and "Live" in target.get("title", "") + target.get("url", "")
        assert (await svc.live_target("run1", "bob"))["id"] != target["id"]  # each agent has its own tab

        viewer = FakeViewer()
        task = asyncio.create_task(browser_live.serve(viewer, "run1", "ann", run_live=lambda: True))  # type: ignore[arg-type]
        frame = await viewer.wait_for(lambda m: m["type"] == "frame")
        assert len(frame["data"]) > 500 and frame["w"] and frame["h"]
        assert any(m["type"] == "status" and m["live"] for m in viewer.sent)
        for ev in ("mousePressed", "mouseReleased"):  # the user clicks the button in the live view
            await viewer.incoming.put({"type": "mouse", "event": ev, "x": 50, "y": 50, "button": "left", "clicks": 1})
        for _ in range(50):
            ok, out = await svc.call("run1", "ann", "browser_evaluate", {"function": "() => document.title"})
            if "clicked" in out:
                break
            await asyncio.sleep(0.1)
        assert "clicked" in out
        await svc.close_run("run1")
        await viewer.wait_for(lambda m: m["type"] == "status" and not m["live"], timeout=15)
        task.cancel()
    finally:
        await svc.shutdown()
