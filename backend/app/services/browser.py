"""Built-in browser for agents: a Playwright MCP server started, supervised and stopped by Octopus.

* One ``@playwright/mcp`` process listens on ``127.0.0.1`` (random free port) with a shared, in-memory browser context.
* Each agent in a run keeps **one persistent MCP session** (its own tab), so ``browser_navigate`` followed by
  ``browser_snapshot`` / ``browser_click`` see the same page. Sessions close when the run ends.
* Live view: Chromium is launched with a local DevTools port (``--remote-debugging-port`` via the MCP config file), and
  each agent's session is mapped to its page target. The run's Browser tab then streams that real tab (CDP screencast,
  ``services/browser_live.py``) and can forward the user's clicks and keys to it.
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
import base64
import json
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


def _image(content: Any) -> bytes | None:
    if getattr(content, "type", "") != "image" or not getattr(content, "data", None):
        return None
    try:
        return base64.b64decode(content.data)
    except (ValueError, TypeError):
        return None


# Tools that don't change what's on screen: no new live frame after them.
NO_FRAME_TOOLS = {"browser_snapshot", "browser_console_messages", "browser_network_requests", "browser_tabs", "browser_close",
                  "browser_install", "browser_take_screenshot"}
_URL_RE = re.compile(r"Page URL:[ \t]*(.+)")  # the whole line: data: and file URLs may contain spaces
_TITLE_RE = re.compile(r"Page Title:[ \t]*(.*)")


def live_frame_name(run_id: str, agent_id: str) -> str:
    return "live-" + re.sub(r"[^\w-]", "_", f"{run_id[:12]}-{agent_id}")[:80] + ".jpeg"


OUTPUT_MAX_AGE_S = 3600


def prune_output_dir(run_id: str) -> None:
    """Playwright MCP writes a file for every page snapshot and screenshot into its output dir; without pruning that grows forever.

    Removes this run's live frames and anything older than an hour (other runs' files in use are recent)."""
    import time

    d = get_settings().octopus_home / "browser"
    if not d.is_dir():
        return
    prefix, cutoff = live_frame_name(run_id, "")[:-5], time.time() - OUTPUT_MAX_AGE_S
    for p in d.iterdir():
        try:
            if p.is_file() and (p.name.startswith(prefix) or (p.name.startswith(("page-", "live-")) and p.stat().st_mtime < cutoff)):
                p.unlink()
        except OSError:
            pass


def page_info(out: str) -> tuple[str, str]:
    """(url, title) from a Playwright MCP tool result ("- Page URL: …" / "- Page Title: …"), "" when absent."""
    url, title = _URL_RE.search(out), _TITLE_RE.search(out)
    return (url.group(1).strip() if url else ""), (title.group(1).strip() if title else "")


class _AgentSession:
    """A long-lived MCP client session owned by one task (anyio contexts must be exited by the task that entered them)."""

    def __init__(self, url: str) -> None:
        self.url = url
        self.queue: asyncio.Queue[tuple[str, dict[str, Any], asyncio.Future[tuple[bool, str]]] | None] = asyncio.Queue()
        self.ready: asyncio.Future[None] = asyncio.get_running_loop().create_future()
        self.images: list[bytes] = []  # images (screenshots) returned by the last call; the agent only gets text
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
                        self.images = [img for c in res.content if (img := _image(c)) is not None]
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
        self.cdp_port: int | None = None  # Chromium's DevTools port (live view); None when unavailable
        self._targets: dict[tuple[str, str], str] = {}  # (run, agent) → CDP page target id of the agent's tab
        self._urls: dict[tuple[str, str], str] = {}  # (run, agent) → last URL its tab reported
        self._map_lock = asyncio.Lock()

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
            self.cdp_port = None
            if s.browser_live_view and self._browser_arg() not in ("firefox", "webkit"):
                self.cdp_port = _free_port()
                cfg = out_dir / "octopus-mcp-config.json"
                cfg.write_text(json.dumps({"browser": {"launchOptions": {"args": [f"--remote-debugging-port={self.cdp_port}"]}}}))
                args += ["--config", str(cfg)]
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
        self.proc, self.url, self.cdp_port = None, None, None
        self._targets.clear()

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
            self._targets.pop(key, None)
        try:
            ok, out = await self._call_mapped(key, sess, tool, args)
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
        if ok and (page_url := page_info(out)[0]):
            self._urls[key] = page_url
        return ok, out

    # ---------------------------------------------------------------- live view (CDP)
    async def pages(self) -> list[dict[str, Any]]:
        """Chromium's page targets ({id, url, title, webSocketDebuggerUrl}); [] when the live view is unavailable."""
        if not self.cdp_port:
            return []
        import httpx

        try:
            async with httpx.AsyncClient(timeout=3) as c:
                r = await c.get(f"http://127.0.0.1:{self.cdp_port}/json/list")
            return [t for t in r.json() if t.get("type") == "page" and t.get("webSocketDebuggerUrl")]
        except (httpx.HTTPError, ValueError, TypeError):
            return []

    async def _call_mapped(self, key: tuple[str, str], sess: _AgentSession, tool: str, args: dict[str, Any]) -> tuple[bool, str]:
        """Run a call; the first one of a session opens the agent's tab, which is how its CDP target is found."""
        if not self.cdp_port or key in self._targets:
            return await sess.call(tool, args)
        async with self._map_lock:  # first calls one at a time, so the one new page target is this agent's
            before = {t["id"] for t in await self.pages()}
            res = await sess.call(tool, args)
            taken = set(self._targets.values())
            new = [t for t in await self.pages() if t["id"] not in before and t["id"] not in taken]
            if len(new) == 1:
                self._targets[key] = new[0]["id"]
            return res

    async def live_target(self, run_id: str, agent_id: str) -> dict[str, Any] | None:
        """The CDP page target showing this agent's tab right now, or None (not browsing yet, run over, no live view)."""
        key = (run_id, agent_id)
        sess = self._sessions.get(key)
        if not self.cdp_port or sess is None or sess.task.done():
            return None
        pages = await self.pages()
        tid = self._targets.get(key)
        hit = next((t for t in pages if t["id"] == tid), None)
        if hit is None and (url := self._urls.get(key)):  # tab replaced or never mapped: find it by the URL the agent saw
            taken = {v for k, v in self._targets.items() if k != key}
            same = [t for t in pages if t["id"] not in taken and t.get("url") == url]
            if len(same) == 1:
                hit = same[0]
                self._targets[key] = hit["id"]
        return hit

    async def frame(self, run_id: str, agent_id: str, tool: str) -> bytes | None:
        """What the agent's tab shows right after `tool`, as an image, so people can watch the agent browse.

        A screenshot the agent took itself is reused; otherwise one viewport screenshot (JPEG, small and quick) is taken.
        Never raises: the live view is a convenience and must not break the agent's work."""
        sess = self._sessions.get((run_id, agent_id))
        if sess is None or sess.task.done():
            return None
        if tool == "browser_take_screenshot":
            imgs = getattr(sess, "images", [])
            return imgs[0] if imgs else None
        if tool in NO_FRAME_TOOLS:
            return None
        try:
            # a fixed file name per agent: Playwright MCP writes every screenshot to disk (page-<timestamp> by default), and
            # with a file name it returns no image, so the file is read back
            name = live_frame_name(run_id, agent_id)
            ok, _ = await sess.call("browser_take_screenshot", {"type": "jpeg", "filename": name})
        except Exception:  # noqa: BLE001
            return None
        imgs = getattr(sess, "images", [])
        if not ok or imgs:
            return imgs[0] if ok else None
        try:
            return (get_settings().octopus_home / "browser" / name).read_bytes() or None
        except OSError:
            return None

    async def close_run(self, run_id: str) -> None:
        for key in [k for k in self._sessions if k[0] == run_id]:
            await self._sessions.pop(key).close()
        for d in (self._targets, self._urls):
            for key in [k for k in d if k[0] == run_id]:
                d.pop(key, None)
        prune_output_dir(run_id)


browser = BrowserService()
