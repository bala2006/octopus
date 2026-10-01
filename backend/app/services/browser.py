"""Built-in browser for agents: a Playwright MCP server started, supervised and stopped by Octopus.

* One ``@playwright/mcp`` process listens on ``127.0.0.1`` (random free port) with a shared, in-memory browser context.
* Each agent in a run keeps **one persistent MCP session** (its own tab), so ``browser_navigate`` followed by
  ``browser_snapshot`` / ``browser_click`` see the same page. Sessions close when the run ends.
* The browser binary is installed automatically on first use (``npx @playwright/mcp install-browser``) unless Chrome is
  already on the machine.

Agents reach it through the ``browser`` tool (granted by default); it shows up to them as the MCP server ``browser``.

Health is reported honestly: the MCP server answering (``server_ready``) is not the same as a browser that can launch.
``@playwright/mcp`` starts Chromium lazily, so after the server is up Octopus opens a ``data:`` page and reads it back;
only then is the status ``ready``. A launch failure later on degrades the status to ``error`` with a diagnosis
(e.g. a missing system library) instead of the raw Chromium command line.
"""
from __future__ import annotations

import asyncio
import os
import re
import shutil
import socket
import sys
from contextlib import AsyncExitStack
from pathlib import Path
from typing import Any

from app.core.config import get_settings
from app.core.logging import get_logger

log = get_logger("browser")

SERVER_ID = "builtin:browser"
SERVER_NAME = "browser"
START_TIMEOUT_S = 120
INSTALL_TIMEOUT_S = 900
CALL_TIMEOUT_S = 90

# Shown to agents before the server has been started once (then replaced by the live tool list).
FALLBACK_TOOLS: list[dict[str, Any]] = [
    {"name": "browser_navigate", "description": "Open a URL in your tab", "input_schema": {"properties": {"url": {"type": "string"}}, "required": ["url"]}},
    {"name": "browser_snapshot", "description": "Accessibility snapshot of the page (use the element refs it returns)", "input_schema": {"properties": {}}},
    {"name": "browser_click", "description": "Click an element", "input_schema": {"properties": {"element": {"type": "string"}, "target": {"type": "string"}}, "required": ["target"]}},
    {"name": "browser_type", "description": "Type into an element", "input_schema": {"properties": {"element": {"type": "string"}, "target": {"type": "string"}, "text": {"type": "string"}, "submit": {"type": "boolean"}}, "required": ["target", "text"]}},
    {"name": "browser_fill_form", "description": "Fill several form fields", "input_schema": {"properties": {"fields": {"type": "array"}}}},
    {"name": "browser_press_key", "description": "Press a key", "input_schema": {"properties": {"key": {"type": "string"}}}},
    {"name": "browser_wait_for", "description": "Wait for text or time", "input_schema": {"properties": {"text": {"type": "string"}, "time": {"type": "number"}}}},
    {"name": "browser_console_messages", "description": "Console messages (errors!)", "input_schema": {"properties": {}}},
    {"name": "browser_network_requests", "description": "Network requests since load", "input_schema": {"properties": {}}},
    {"name": "browser_evaluate", "description": "Run a JS function on the page", "input_schema": {"properties": {"function": {"type": "string"}}}},
    {"name": "browser_take_screenshot", "description": "Screenshot of the page", "input_schema": {"properties": {}}},
    {"name": "browser_resize", "description": "Resize the viewport", "input_schema": {"properties": {"width": {"type": "number"}, "height": {"type": "number"}}}},
    {"name": "browser_navigate_back", "description": "Go back", "input_schema": {"properties": {}}},
]
PREFERRED = [t["name"] for t in FALLBACK_TOOLS] + ["browser_select_option", "browser_hover", "browser_tabs", "browser_handle_dialog"]
SMOKE_PAGE = "data:text/html,<title>Octopus</title><h1>Browser ready</h1>"
SMOKE_TEXT = "Browser ready"
_LAUNCH_FAILURE = re.compile(r"error while loading shared libraries|exit(?:ed)?(?: with)?(?: code)?[ =:]*127|exitCode=127|"
                             r"Target page, context or browser has been closed|Failed to launch|browserType\.launch|"
                             r"Executable doesn't exist|is not installed|initializeServer", re.I)
DEPS_HINT = ("Install Chromium's system libraries: rebuild the Octopus Docker image (it includes them), or run "
             "`npx playwright install-deps chromium` on this machine.")


def is_launch_failure(out: str) -> bool:
    """Does a tool result mean the browser itself can't start (as opposed to a page-level error)?"""
    return bool(_LAUNCH_FAILURE.search(out or ""))


def diagnose(out: str) -> str:
    """Turn Playwright/Chromium launch output into an actionable sentence plus the log lines that matter.

    The raw message is dominated by Chromium's command line (dozens of ``--flag`` lines), which used to push the real
    cause out of the visible error."""
    text = out or ""
    lib = re.search(r"error while loading shared libraries: ([^\s:]+)", text)
    if lib:
        head = f"Chromium cannot start: the system library {lib.group(1)} is missing. {DEPS_HINT}"
    elif re.search(r"exit(?:ed)?(?: with)?(?: code)?[ =:]*127|exitCode=127", text, re.I):
        head = f"Chromium exited with code 127 right after launch: system libraries are missing. {DEPS_HINT}"
    elif re.search(r"Executable doesn't exist|is not installed", text, re.I):
        head = "The browser binary is not installed yet; it is downloaded on first use (needs internet access)."
    elif re.search(r"Target page, context or browser has been closed|Failed to launch|initializeServer", text, re.I):
        head = f"Chromium closed immediately after launch (most often: missing system libraries). {DEPS_HINT}"
    else:
        head = "The browser could not be used."
    keep = [ln.strip() for ln in text.splitlines()
            if ln.strip() and not ln.strip().startswith("--") and "<launching>" not in ln and not re.fullmatch(r"[-=\s]*", ln)]
    detail = "\n".join(keep)[:1500]
    return f"{head}\n{detail}" if detail else head


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def chrome_installed() -> bool:
    if sys.platform == "darwin":
        return Path("/Applications/Google Chrome.app").exists()
    if sys.platform.startswith("win"):
        return any(Path(os.environ.get(v, ""), "Google/Chrome/Application/chrome.exe").exists()
                   for v in ("PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"))
    return any(shutil.which(b) for b in ("google-chrome", "google-chrome-stable"))


class _AgentSession:
    """A long-lived MCP client session owned by one task (anyio contexts must be exited by the task that entered them)."""

    def __init__(self, url: str) -> None:
        self.url = url
        self.queue: asyncio.Queue[tuple[str, dict[str, Any], asyncio.Future[tuple[bool, str]]] | None] = asyncio.Queue()
        self.ready: asyncio.Future[None] = asyncio.get_running_loop().create_future()
        self.task = asyncio.create_task(self._run(), name="browser-session")

    async def _run(self) -> None:
        from mcp import ClientSession
        from mcp.client.streamable_http import streamablehttp_client

        try:
            async with AsyncExitStack() as stack:
                read, write, _ = await stack.enter_async_context(streamablehttp_client(self.url))
                session = await stack.enter_async_context(ClientSession(read, write))
                await session.initialize()
                self.ready.set_result(None)
                while (item := await self.queue.get()) is not None:
                    tool, args, fut = item
                    try:
                        res = await asyncio.wait_for(session.call_tool(tool, args), CALL_TIMEOUT_S)
                        parts = [getattr(c, "text", None) or f"[{getattr(c, 'type', 'content')}]" for c in res.content]
                        out = "\n".join(parts)
                        if len(out) > 12000:
                            out = out[:12000] + f"\n…[truncated: 12,000 of {len(out):,} characters]"
                        fut.set_result((not res.isError, out))
                    except asyncio.TimeoutError:
                        fut.set_result((False, f"Browser tool '{tool}' timed out after {CALL_TIMEOUT_S}s"))
                    except Exception as exc:  # the session may be broken; report and stop
                        fut.set_result((False, f"Browser error ({type(exc).__name__}): {exc}"))
                        raise
        except BaseException as exc:
            if not self.ready.done():
                self.ready.set_exception(RuntimeError(f"Could not connect to the browser: {exc}"))
            while not self.queue.empty():
                item = self.queue.get_nowait()
                if item is not None and not item[2].done():
                    item[2].set_result((False, "Browser session closed"))

    async def call(self, tool: str, args: dict[str, Any]) -> tuple[bool, str]:
        await asyncio.wait_for(asyncio.shield(self.ready), 30)
        if self.task.done():
            return False, "Browser session closed"
        fut: asyncio.Future[tuple[bool, str]] = asyncio.get_running_loop().create_future()
        await self.queue.put((tool, args, fut))
        return await fut

    async def close(self) -> None:
        if not self.task.done():
            await self.queue.put(None)
            try:
                await asyncio.wait_for(self.task, 10)
            except (asyncio.TimeoutError, Exception):
                self.task.cancel()


class BrowserService:
    def __init__(self) -> None:
        self.proc: asyncio.subprocess.Process | None = None
        self.url: str | None = None
        self.tools: list[dict[str, Any]] = []
        # stopped | starting | installing | server_ready (MCP up, browser not verified) | ready (a page was opened) | error
        self.status = "stopped"
        self.error = ""
        self.verified = False  # a browser actually launched and rendered a page
        self._lock = asyncio.Lock()
        self._sessions: dict[tuple[str, str], _AgentSession] = {}
        self._installed = False

    # ---------------------------------------------------------------- process
    def _browser_arg(self) -> str:
        s = get_settings()
        return s.playwright_browser or ("chrome" if chrome_installed() else "chromium")

    async def ensure(self) -> str:
        """Start the server if needed and return its MCP URL."""
        async with self._lock:
            if self.proc and self.proc.returncode is None and self.url:
                return self.url
            s = get_settings()
            if not s.browser_enabled:
                raise RuntimeError("The built-in browser is disabled (BROWSER_ENABLED=false)")
            npx = shutil.which("npx")
            if not npx:
                self.status, self.error = "error", "Node.js (npx) is required for the built-in browser: install Node 18+"
                raise RuntimeError(self.error)
            port = s.playwright_mcp_port or _free_port()
            out_dir = s.octopus_home / "browser"
            out_dir.mkdir(parents=True, exist_ok=True)
            args = [npx, "-y", s.playwright_mcp_package, "--port", str(port), "--host", "127.0.0.1",
                    "--allowed-hosts", f"127.0.0.1:{port}", "--isolated", "--shared-browser-context",
                    "--browser", self._browser_arg(), "--output-dir", str(out_dir), "--viewport-size", "1280x800"]
            if s.playwright_headless:
                args.append("--headless")
            self.status, self.error = "starting", ""
            self.proc = await asyncio.create_subprocess_exec(*args, cwd=str(out_dir), stdout=asyncio.subprocess.PIPE,
                                                             stderr=asyncio.subprocess.STDOUT)
            self.url = f"http://127.0.0.1:{port}/mcp"
            try:
                await asyncio.wait_for(self._wait_listening(), START_TIMEOUT_S)
            except (asyncio.TimeoutError, RuntimeError) as exc:
                await self._kill()
                self.status, self.error = "error", f"Playwright MCP did not start: {exc}"
                raise RuntimeError(self.error) from exc
            self.status, self.verified = "server_ready", False
            log.info("browser_server_started", url=self.url, browser=self._browser_arg())
        try:
            from app.tools.mcp_client import McpConfig, list_tools

            listed = await list_tools(McpConfig(id=SERVER_ID, name=SERVER_NAME, transport="http", url=self.url))
            order = {n: i for i, n in enumerate(PREFERRED)}
            self.tools = sorted(listed, key=lambda t: order.get(t["name"], 99))
        except Exception as exc:  # tool listing is informative only
            log.warning("browser_tools_unavailable", error=str(exc))
        if not self.verified:
            await self._verify()
        return self.url

    async def _verify(self) -> None:
        """Launch smoke test: open a data: page and read it back. Sets ready or error (with a diagnosis)."""
        async with self._lock:
            if self.verified or not self.url:
                return
            sess = _AgentSession(self.url)
            try:
                ok, out = await sess.call("browser_navigate", {"url": SMOKE_PAGE})
                if not ok and re.search(r"Executable doesn't exist|is not installed", out, re.I):
                    try:
                        await self._install_browser()
                    except RuntimeError as exc:
                        ok, out = False, str(exc)
                    else:
                        ok, out = await sess.call("browser_navigate", {"url": SMOKE_PAGE})
                if ok:
                    ok, out = await sess.call("browser_snapshot", {})
                    ok = ok and SMOKE_TEXT in out
            except Exception as exc:  # noqa: BLE001 - any failure here means "not usable"
                ok, out = False, f"{type(exc).__name__}: {exc}"
            finally:
                await sess.close()
            if ok:
                self.status, self.error, self.verified = "ready", "", True
                log.info("browser_verified")
            else:
                self.mark_broken(out)

    def mark_broken(self, out: str) -> None:
        self.status, self.error, self.verified = "error", diagnose(out), False
        log.warning("browser_unusable", error=self.error[:300])

    async def _wait_listening(self) -> None:
        assert self.proc and self.proc.stdout
        while True:
            line = await self.proc.stdout.readline()
            if not line:
                raise RuntimeError("process exited")
            if b"Listening on" in line:
                asyncio.create_task(self._drain())
                return

    async def _drain(self) -> None:
        while self.proc and self.proc.stdout and await self.proc.stdout.readline():
            pass

    async def _install_browser(self) -> None:
        if self._installed:
            return
        s = get_settings()
        self.status = "installing"
        log.info("browser_installing")
        target = "chrome-for-testing" if self._browser_arg() == "chromium" else self._browser_arg()
        proc = await asyncio.create_subprocess_exec(shutil.which("npx") or "npx", "-y", s.playwright_mcp_package, "install-browser", target,
                                                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
        try:
            out, _ = await asyncio.wait_for(proc.communicate(), INSTALL_TIMEOUT_S)
        except asyncio.TimeoutError:
            proc.kill()
            raise RuntimeError("Installing the browser timed out")
        if proc.returncode != 0:
            raise RuntimeError(f"Installing the browser failed: {out.decode(errors='replace')[-300:]}")
        self._installed = True
        self.status = "server_ready"

    async def _kill(self) -> None:
        if self.proc and self.proc.returncode is None:
            self.proc.terminate()
            try:
                await asyncio.wait_for(self.proc.wait(), 5)
            except asyncio.TimeoutError:
                self.proc.kill()
        self.proc, self.url = None, None

    async def shutdown(self) -> None:
        for sess in list(self._sessions.values()):
            await sess.close()
        self._sessions.clear()
        await self._kill()
        self.status, self.verified = "stopped", False

    # ---------------------------------------------------------------- tools
    def tool_list(self) -> list[dict[str, Any]]:
        return self.tools or FALLBACK_TOOLS

    def available(self) -> bool:
        return self.status != "error"

    async def recheck(self) -> None:
        """Re-run the launch smoke test (e.g. after the user installed the missing libraries)."""
        if self.status == "error" and self.proc and self.proc.returncode is None and self.url:
            self.status, self.verified = "server_ready", False
            await self._verify()

    async def call(self, run_id: str, agent_id: str, tool: str, args: dict[str, Any]) -> tuple[bool, str]:
        try:
            url = await self.ensure()
        except RuntimeError as exc:
            return False, str(exc)
        if self.status == "error":  # the launch smoke test failed: don't let every agent call fail the same way
            return False, f"Browser unavailable: {self.error}"
        key = (run_id, agent_id)
        sess = self._sessions.get(key)
        if sess is None or sess.task.done():
            sess = self._sessions[key] = _AgentSession(url)
        try:
            ok, out = await sess.call(tool, args)
        except Exception as exc:
            self._sessions.pop(key, None)
            out = f"{type(exc).__name__}: {exc}"
            if is_launch_failure(out):
                self.mark_broken(out)
            return False, f"Browser unavailable: {diagnose(out)}"
        if not ok and "is not installed" in out:  # first use on this machine: download the browser, then retry once
            try:
                await self._install_browser()
            except RuntimeError as exc:
                return False, str(exc)
            ok, out = await sess.call(tool, args)
        if not ok and is_launch_failure(out):  # degrade health instead of staying "Running" forever
            self.mark_broken(out)
            return False, f"Browser unavailable: {self.error}"
        if ok and not self.verified:
            self.status, self.error, self.verified = "ready", "", True
        return ok, out

    async def close_run(self, run_id: str) -> None:
        for key in [k for k in self._sessions if k[0] == run_id]:
            await self._sessions.pop(key).close()


browser = BrowserService()
