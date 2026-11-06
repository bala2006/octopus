"""Host-installed OpenCode discovery and its stdio Agent Client Protocol transport.

Never installs packages or launches a shell. OpenCode retains its own credentials,
configuration, tools and permission rules; Octopus relays its permission requests.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
from collections.abc import Awaitable, Callable

from pydantic import BaseModel, Field, ValidationError

from app.core.config import get_settings
from app.tools.sandbox import stop_process


class OpenCodeError(Exception):
    pass


class OpenCodeStatus(BaseModel):
    available: bool = False
    executable: str = ""
    models: list[str] = Field(default_factory=list)
    error: str = ""


def executable() -> list[str]:
    configured = get_settings().opencode_executable
    found = configured or shutil.which("opencode")
    if not found and os.name == "nt":
        candidate = Path(os.environ.get("APPDATA", "")) / "npm" / "opencode.cmd"
        found = str(candidate) if candidate.is_file() else None
    if not found:
        raise OpenCodeError("OpenCode is not installed or not on the backend's PATH. Set OPENCODE_EXECUTABLE to your existing installation.")
    path = Path(found).resolve()
    if path.suffix.lower() in (".cmd", ".ps1", ".bat"):
        # npm launchers cannot be passed to CreateProcess without a shell. Resolve
        # the existing package's native binary instead of using cmd or npx.
        for relative in ("node_modules/@opencode/cli/bin/opencode.exe", "node_modules/opencode-ai/bin/opencode"):
            native = path.parent / relative
            if native.is_file():
                if native.suffix == ".exe":
                    return [str(native)]
                node = shutil.which("node")
                if node:
                    return [node, str(native)]
        raise OpenCodeError("Cannot resolve the installed OpenCode launcher. Set OPENCODE_EXECUTABLE to the existing opencode executable.")
    return [str(path)]


def process_options() -> dict:
    return {"creationflags": subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP} if os.name == "nt" else {"start_new_session": True}


_cached: tuple[float, OpenCodeStatus] | None = None
_lock = asyncio.Lock()


async def discover() -> OpenCodeStatus:
    global _cached
    async with _lock:
        if _cached and time.monotonic() - _cached[0] < 30:
            return _cached[1]
        proc = None
        try:
            argv = executable()
            proc = await asyncio.create_subprocess_exec(*argv, "models", cwd=Path.home(), stdout=asyncio.subprocess.PIPE,
                                                        stderr=asyncio.subprocess.DEVNULL, **process_options())
            out, _ = await asyncio.wait_for(proc.communicate(), 20)
            if proc.returncode:
                raise OpenCodeError("OpenCode model discovery failed. Check your existing OpenCode configuration.")
            models = list(dict.fromkeys(line.strip() for line in out.decode("utf-8", "replace").splitlines()
                                       if "/" in line.strip() and not any(c.isspace() for c in line.strip())))
            models.sort(key=lambda name: (not name.startswith("opencode"), name))
            status = OpenCodeStatus(available=True, executable=argv[-1], models=models)
        except (OpenCodeError, OSError, TimeoutError) as exc:
            status = OpenCodeStatus(error=str(exc) or "OpenCode model discovery timed out.")
        finally:
            if proc and proc.returncode is None:
                await stop_process(proc)
        _cached = time.monotonic(), status
        return status


class RpcMessage(BaseModel):
    jsonrpc: str = "2.0"
    id: int | str | None = None
    method: str | None = None
    params: dict = Field(default_factory=dict)
    result: dict | None = None
    error: dict | None = None


class OpenCodeProbe(BaseModel):
    available: bool = False
    protocol_version: int | None = None
    agent_info: dict = Field(default_factory=dict)
    capabilities: dict = Field(default_factory=dict)
    config_options: list[dict] = Field(default_factory=list)
    execution_mode: str = "trusted-host"
    restrictions_supported: bool = False
    isolation_note: str = "The installed CLI retains host filesystem, shell, network and inherited configuration access."
    error: str = ""


class OpenCodeSession:
    def __init__(self, root: Path, update: Callable[[dict], Awaitable[None]], permission: Callable[[dict], Awaitable[dict]]):
        self.root, self.update, self.permission = root, update, permission
        self.proc: asyncio.subprocess.Process | None = None
        self.counter = 0
        self.session_id = ""
        self.replaying = False
        self.initialize_result: dict = {}
        self.capabilities: dict = {}
        self.config_options: list[dict] = []
        self._advertised_config = False
        self._pending: dict[int, asyncio.Future[dict]] = {}
        self._reader: asyncio.Task[None] | None = None
        self._notifications: asyncio.Task[None] | None = None
        self._events: asyncio.Queue[dict] = asyncio.Queue(maxsize=4096)
        self._permissions: set[asyncio.Task[None]] = set()
        self._write_lock = asyncio.Lock()
        self._prompt_active = False
        self._prompt_quarantined = False
        self._closed = False
        self._error: OpenCodeError | None = None

    async def __aenter__(self):
        try:
            self.proc = await asyncio.create_subprocess_exec(*executable(), "acp", cwd=self.root,
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
                limit=16 * 1024 * 1024, **process_options())
            self._reader = asyncio.create_task(self._read_messages(), name="opencode-acp-reader")
            self._notifications = asyncio.create_task(self._deliver_updates(), name="opencode-acp-updates")
            self.initialize_result = await asyncio.wait_for(self.request("initialize", {"protocolVersion": 1, "clientCapabilities": {},
                "clientInfo": {"name": "octopus", "version": "1.0"}}), 30)
            if self.initialize_result.get("protocolVersion", 1) != 1:
                raise OpenCodeError("The installed OpenCode selected an unsupported ACP protocol version.")
            self.capabilities = self.initialize_result.get("agentCapabilities") or {}
            return self
        except BaseException:
            await self.__aexit__(None, None, None)
            raise

    async def __aexit__(self, *_):
        self._closed = True
        for task in list(self._permissions):
            task.cancel()
        if self.proc:
            if self.proc.stdin:
                self.proc.stdin.close()
            try:
                await asyncio.wait_for(self.proc.wait(), 3)
            except TimeoutError:
                await stop_process(self.proc)
        for task in (self._reader, self._notifications, *list(self._permissions)):
            if task:
                task.cancel()
        await asyncio.gather(*(task for task in (self._reader, self._notifications, *list(self._permissions)) if task), return_exceptions=True)
        self._fail(OpenCodeError("OpenCode session closed."))

    async def send(self, message: dict) -> None:
        if self._closed or not self.proc or not self.proc.stdin:
            raise OpenCodeError("OpenCode is not running")
        if message.get("method") == "session/cancel":
            for task in list(self._permissions):
                task.cancel()
        async with self._write_lock:
            try:
                self.proc.stdin.write((json.dumps({"jsonrpc": "2.0", **message}) + "\n").encode())
                await self.proc.stdin.drain()
            except (BrokenPipeError, ConnectionResetError) as exc:
                raise OpenCodeError("OpenCode closed its input stream.") from exc

    async def request(self, method: str, params: dict) -> dict:
        if self._error:
            raise self._error
        self.counter += 1
        request_id = self.counter
        future = asyncio.get_running_loop().create_future()
        self._pending[request_id] = future
        try:
            await self.send({"id": request_id, "method": method, "params": params})
            return await future
        finally:
            self._pending.pop(request_id, None)

    def _fail(self, error: OpenCodeError) -> None:
        self._error = error
        for future in self._pending.values():
            if not future.done():
                future.set_exception(error)

    async def _read_messages(self) -> None:
        assert self.proc and self.proc.stdout
        try:
            while True:
                line = await self.proc.stdout.readline()
                if not line:
                    raise OpenCodeError("OpenCode exited before replying. Check the installed CLI and its provider login.")
                msg = RpcMessage.model_validate_json(line)
                if msg.method == "session/update":
                    event_session = msg.params.get("sessionId")
                    if event_session and self.session_id and event_session != self.session_id:
                        continue
                    update = msg.params.get("update", {})
                    if update.get("sessionUpdate") == "config_option_update":
                        self._capture_options(update)
                    if not self.replaying:
                        self._events.put_nowait(update)
                elif msg.id is not None and msg.method:
                    if msg.method == "session/request_permission":
                        task = asyncio.create_task(self._answer_permission(msg), name="opencode-acp-permission")
                        self._permissions.add(task)
                        task.add_done_callback(self._permissions.discard)
                    else:
                        await self.send({"id": msg.id, "error": {"code": -32601, "message": "Client method not supported"}})
                elif isinstance(msg.id, int) and (future := self._pending.get(msg.id)) and not future.done():
                    if msg.error:
                        future.set_exception(OpenCodeError(str(msg.error.get("message", "OpenCode request failed"))))
                    else:
                        future.set_result(msg.result or {})
        except asyncio.CancelledError:
            raise
        except ValidationError:
            self._fail(OpenCodeError("OpenCode returned invalid ACP output."))
        except (ValueError, asyncio.QueueFull):
            self._fail(OpenCodeError("OpenCode exceeded the supported ACP message buffer."))
        except Exception as exc:
            self._fail(exc if isinstance(exc, OpenCodeError) else OpenCodeError("OpenCode transport failed."))

    async def _deliver_updates(self) -> None:
        while True:
            event = await self._events.get()
            try:
                await self.update(event)
            except asyncio.CancelledError:
                raise
            except Exception:
                self._fail(OpenCodeError("Octopus could not process an OpenCode update."))
            finally:
                self._events.task_done()

    async def _answer_permission(self, msg: RpcMessage) -> None:
        try:
            answer = await self.permission(msg.params)
        except asyncio.CancelledError:
            answer = {"outcome": {"outcome": "cancelled"}}
        except Exception:
            answer = {"outcome": {"outcome": "cancelled"}}
        if not self._closed:
            with contextlib.suppress(OpenCodeError):
                await self.send({"id": msg.id, "result": answer})

    def _capture_options(self, response: dict) -> None:
        if "configOptions" in response:
            options = response["configOptions"]
            if not isinstance(options, list) or any(not isinstance(option, dict) for option in options):
                raise OpenCodeError("OpenCode returned invalid session configuration options.")
            self.config_options = options
            self._advertised_config = True

    def _validate_option(self, config_id: str, value: str) -> None:
        if not self._advertised_config:
            return  # Older ACP implementations expose set_config_option without a catalog.
        option = next((item for item in self.config_options if item.get("id") == config_id), None)
        if option is None:
            raise OpenCodeError(f"The installed OpenCode does not expose the requested {config_id} setting.")
        def values(items: list) -> set[str]:
            found = set()
            for item in items:
                if not isinstance(item, dict):
                    continue
                if isinstance(item.get("value"), str):
                    found.add(item["value"])
                if isinstance(item.get("options"), list):
                    found.update(values(item["options"]))
            return found
        allowed = values(option.get("options") or [])
        if allowed and value not in allowed:
            raise OpenCodeError(f"The requested {config_id} is unavailable in the installed OpenCode session.")

    async def open(self, session_id: str | None, model: str, effort: str, plan: bool, *, agent: str | None = None,
                   mcp_servers: list[dict] | None = None) -> None:
        self.replaying = True
        try:
            params = {"cwd": str(self.root.resolve()), "mcpServers": mcp_servers or []}
            if session_id:
                params["sessionId"] = session_id
            result = await asyncio.wait_for(self.request("session/load" if session_id else "session/new", params), 45)
            self.session_id = session_id or result["sessionId"]
            self._capture_options(result)
            if model != "default":
                self._validate_option("model", model)
                await self.request("session/set_config_option", {"sessionId": self.session_id, "configId": "model", "value": model})
            if effort != "default":
                self._validate_option("effort", effort)
                await self.request("session/set_config_option", {"sessionId": self.session_id, "configId": "effort", "value": effort})
            if plan or agent:
                mode = "plan" if plan else agent
                if self._advertised_config:
                    self._validate_option("mode", mode or "")
                await self.request("session/set_mode", {"sessionId": self.session_id, "modeId": mode})
        finally:
            self.replaying = False

    async def prompt(self, blocks: list[dict]) -> dict:
        if self._prompt_quarantined:
            raise OpenCodeError("OpenCode prompt acceptance is uncertain. Recover or open a new session before retrying.")
        if self._prompt_active:
            raise OpenCodeError("An OpenCode session can run only one active prompt.")
        if not self.session_id:
            raise OpenCodeError("OpenCode session must be opened before prompting.")
        self._prompt_active = True
        try:
            result = await self.request("session/prompt", {"sessionId": self.session_id, "prompt": blocks})
            await self._events.join()
            if self._error:
                raise self._error
            return result
        except asyncio.CancelledError:
            self._prompt_quarantined = True
            with contextlib.suppress(OpenCodeError):
                await self.send({"method": "session/cancel", "params": {"sessionId": self.session_id}})
            raise
        finally:
            self._prompt_active = False

    def manifest(self) -> OpenCodeProbe:
        return OpenCodeProbe(available=True, protocol_version=self.initialize_result.get("protocolVersion"),
                             agent_info=self.initialize_result.get("agentInfo") or {}, capabilities=self.capabilities,
                             config_options=self.config_options)


async def probe(root: Path) -> OpenCodeProbe:
    """Inspect the installed ACP handshake without sending a model prompt or changing user configuration."""
    async def ignore(_: dict) -> None:
        return None
    async def reject(_: dict) -> dict:
        return {"outcome": {"outcome": "cancelled"}}
    try:
        async with OpenCodeSession(root, ignore, reject) as session:
            await session.open(None, "default", "default", False)
            return session.manifest()
    except (OpenCodeError, OSError, TimeoutError) as exc:
        return OpenCodeProbe(error=str(exc) or "OpenCode capability probe timed out.")
