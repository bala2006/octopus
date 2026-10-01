"""Live view of an agent's real browser tab: Chromium's screencast streamed over the run's browser socket.

``serve()`` owns one viewer websocket (``/ws/w/{w}/runs/{run}/browser/{agent}``). It waits until the agent has a tab, then
connects to that tab's DevTools target and forwards:

* server → viewer: ``status {live, reason?, url?, title?}``, ``frame {data: base64 JPEG, w, h}`` (``w``/``h`` = the
  page's CSS viewport, for mapping clicks), ``url {url}`` on navigation.
* viewer → server (when the user takes control): ``mouse {event, x, y, button?, clicks?, modifiers?}``,
  ``wheel {x, y, dx, dy}``, ``key {event, key, code?, text?, keyCode?, modifiers?}``. Coordinates are CSS pixels.

Frames are acknowledged only after they were sent (plus a small minimum interval), so a slow viewer slows the
screencast down instead of queueing frames. Playwright keeps driving the same tab; the screencast is a second,
read-mostly DevTools client and does not disturb it.
"""
from __future__ import annotations

import asyncio
import contextlib
import itertools
import json
import time
from typing import Any

from fastapi import WebSocket

from app.core.logging import get_logger
from app.services.browser import browser

log = get_logger("browser_live")

MAX_FPS = 20
QUALITY = 70
WAIT_POLL_S = 1.0
MOUSE_EVENTS = {"mousePressed", "mouseReleased", "mouseMoved"}
KEY_EVENTS = {"keyDown", "keyUp"}
BUTTONS = {"none", "left", "middle", "right"}


def _num(v: Any, lo: float = -1e5, hi: float = 1e5) -> float:
    try:
        return max(lo, min(hi, float(v)))
    except (TypeError, ValueError):
        return 0.0


def input_command(msg: dict[str, Any]) -> tuple[str, dict[str, Any]] | None:
    """Translate one viewer input message into a CDP Input.* command (None = ignored / invalid)."""
    kind = msg.get("type")
    mods = int(_num(msg.get("modifiers"), 0, 15))
    if kind == "mouse" and msg.get("event") in MOUSE_EVENTS:
        button = msg.get("button") if msg.get("button") in BUTTONS else ("none" if msg["event"] == "mouseMoved" else "left")
        return "Input.dispatchMouseEvent", {"type": msg["event"], "x": _num(msg.get("x"), 0), "y": _num(msg.get("y"), 0),
                                            "button": button, "clickCount": int(_num(msg.get("clicks", 1 if button != "none" else 0), 0, 3)),
                                            "modifiers": mods}
    if kind == "wheel":
        return "Input.dispatchMouseEvent", {"type": "mouseWheel", "x": _num(msg.get("x"), 0), "y": _num(msg.get("y"), 0),
                                            "deltaX": _num(msg.get("dx")), "deltaY": _num(msg.get("dy")), "modifiers": mods}
    if kind == "key" and msg.get("event") in KEY_EVENTS:
        key = str(msg.get("key") or "")[:32]
        params: dict[str, Any] = {"type": msg["event"], "key": key, "code": str(msg.get("code") or "")[:32], "modifiers": mods}
        code = int(_num(msg.get("keyCode"), 0, 255))
        if code:
            params["windowsVirtualKeyCode"] = params["nativeVirtualKeyCode"] = code
        text = str(msg.get("text") or "")[:4]
        if msg["event"] == "keyDown" and text:
            params["text"] = params["unmodifiedText"] = text
        return "Input.dispatchKeyEvent", params
    return None


async def _stream(ws: WebSocket, run_id: str, agent_id: str, target: dict[str, Any], inbox: asyncio.Queue[dict[str, Any]],
                  viewer_gone: asyncio.Task[Any]) -> None:
    """Screencast one target until it is no longer the agent's tab (closed, replaced, run over) or the viewer leaves."""
    import websockets

    ids = itertools.count(1)
    async with websockets.connect(target["webSocketDebuggerUrl"], max_size=None, open_timeout=5, ping_interval=None) as cdp:
        async def cmd(method: str, params: dict[str, Any] | None = None) -> None:
            await cdp.send(json.dumps({"id": next(ids), "method": method, "params": params or {}}))

        await cmd("Page.enable")
        await cmd("Page.startScreencast", {"format": "jpeg", "quality": QUALITY, "maxWidth": 1600, "maxHeight": 1000, "everyNthFrame": 1})
        await ws.send_json({"type": "status", "live": True, "url": target.get("url", ""), "title": target.get("title", "")})

        async def from_browser() -> None:
            last = 0.0
            async for raw in cdp:
                m = json.loads(raw)
                method, p = m.get("method"), m.get("params") or {}
                if method == "Page.screencastFrame":
                    meta = p.get("metadata") or {}
                    await ws.send_json({"type": "frame", "data": p.get("data", ""), "w": meta.get("deviceWidth"), "h": meta.get("deviceHeight")})
                    wait = last + 1 / MAX_FPS - time.monotonic()
                    if wait > 0:
                        await asyncio.sleep(wait)
                    last = time.monotonic()
                    await cmd("Page.screencastFrameAck", {"sessionId": p.get("sessionId")})
                elif method == "Page.frameNavigated" and not (p.get("frame") or {}).get("parentId"):
                    await ws.send_json({"type": "url", "url": (p.get("frame") or {}).get("url", "")})
                elif method in ("Inspector.detached", "Inspector.targetCrashed"):
                    return

        async def from_viewer() -> None:
            while True:
                c = input_command(await inbox.get())
                if c:
                    await cmd(*c)

        async def still_the_agents_tab() -> None:
            while True:
                await asyncio.sleep(WAIT_POLL_S)
                cur = await browser.live_target(run_id, agent_id)
                if cur is None or cur["id"] != target["id"]:
                    return

        tasks = [asyncio.create_task(from_browser()), asyncio.create_task(from_viewer()), asyncio.create_task(still_the_agents_tab())]
        try:
            await asyncio.wait([*tasks, viewer_gone], return_when=asyncio.FIRST_COMPLETED)
        finally:
            for t in tasks:
                t.cancel()
            for t in tasks:
                with contextlib.suppress(BaseException):
                    await t


async def serve(ws: WebSocket, run_id: str, agent_id: str, *, run_live: Any) -> None:
    """Run the viewer socket until the viewer disconnects. ``run_live()`` tells whether the run is still going."""
    inbox: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=200)

    async def read() -> None:
        while True:
            msg = await ws.receive_json()
            if isinstance(msg, dict) and msg.get("type") != "pong":
                with contextlib.suppress(asyncio.QueueFull):
                    inbox.put_nowait(msg)

    reader = asyncio.create_task(read())
    last_reason = None
    try:
        while not reader.done():
            target = await browser.live_target(run_id, agent_id)
            if target is None:
                reason = ("not_running" if not run_live() else "no_live_view" if not browser.cdp_port and browser.proc
                          else "not_browsing")
                if reason != last_reason:
                    await ws.send_json({"type": "status", "live": False, "reason": reason})
                    last_reason = reason
                await asyncio.wait([reader], timeout=WAIT_POLL_S)
                continue
            last_reason = None
            try:
                await _stream(ws, run_id, agent_id, target, inbox, reader)
            except (OSError, asyncio.TimeoutError) as exc:
                log.info("browser_live_target_lost", error=str(exc)[:200])
            except Exception as exc:  # noqa: BLE001 - websockets' ConnectionClosed and friends: the tab went away
                if reader.done():
                    break
                log.info("browser_live_stream_ended", error=f"{type(exc).__name__}: {str(exc)[:200]}")
            if not reader.done():
                await asyncio.wait([reader], timeout=WAIT_POLL_S)
    finally:
        reader.cancel()
        with contextlib.suppress(BaseException):
            await reader
