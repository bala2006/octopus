"""Short-lived authenticated loopback MCP tools for one Octopus worker attempt."""
from __future__ import annotations

import asyncio
import contextlib
import contextvars
import hmac
import json
import secrets
import socket
from contextlib import contextmanager
from typing import TYPE_CHECKING, Any

from fastapi import FastAPI, Request
from starlette.responses import JSONResponse, Response
import uvicorn

from app.orchestrator import tools as T
from app.orchestrator.execution import ACTIVE_ATTEMPT
from app.core.evidence import redact_evidence
from app.llm.base import ToolCall

if TYPE_CHECKING:
    from app.orchestrator.context import AgentSpec
    from app.orchestrator.engine import RunRuntime

MAX_REQUEST_BYTES = 1_500_000
SUPPORTED_PROTOCOLS = {"2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"}


class _LoopbackServer(uvicorn.Server):
    @contextmanager
    def capture_signals(self):
        # The main Octopus server owns process signal handlers.
        yield


class WorkerBridge:
    def __init__(self, runtime: RunRuntime, agent: AgentSpec):
        self.rt, self.agent = runtime, agent
        self.attempt = ACTIVE_ATTEMPT.get()
        if self.attempt is None or self.attempt.assignment.owner != agent.id:
            raise ValueError("An owned active attempt is required for an OpenCode bridge")
        self.context = contextvars.copy_context()
        self.secret = secrets.token_urlsafe(32)
        self.name = "octopus_" + secrets.token_hex(8)
        self.yielded = asyncio.Event()
        self.yield_reason = ""
        self.calls = 0
        self._lock = asyncio.Lock()
        self._closed = False
        self._socket: socket.socket | None = None
        self._server: uvicorn.Server | None = None
        self._server_task: asyncio.Task | None = None
        self.url = ""
        specs, self.mcp_map = T.tool_specs(agent.tools, agent.mcp)
        excluded = self.rt.wf_tool_exclusions(agent)
        self.specs = {spec["name"]: spec for spec in specs if spec["name"] not in excluded}
        self.app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
        self.app.add_api_route("/mcp", self._http, methods=["POST", "GET", "DELETE"])

    def config(self) -> dict[str, Any]:
        if not self.url or self._closed:
            raise ValueError("Worker bridge is not running")
        return {"type": "http", "name": self.name, "url": self.url,
                "headers": [{"name": "Authorization", "value": "Bearer " + self.secret}]}

    def grants_acp_call(self, call: dict) -> bool:
        """Only a machine tool identity may select this invocation's granted MCP tools."""
        return not self._closed and not self.yielded.is_set() and any(
            call.get("name") == f"{self.name}_{name}" for name in self.specs)

    async def __aenter__(self):
        self._socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            self._socket.bind(("127.0.0.1", 0))
            self._socket.listen(16)
            self._socket.setblocking(False)
            port = self._socket.getsockname()[1]
            self.url = f"http://127.0.0.1:{port}/mcp"
            config = uvicorn.Config(self.app, host="127.0.0.1", port=port, log_level="error", access_log=False, lifespan="off")
            self._server = _LoopbackServer(config)
            self._server_task = asyncio.create_task(self._server.serve(sockets=[self._socket]), name="octopus-worker-mcp")
            async with asyncio.timeout(5):
                while not self._server.started:
                    if self._server_task.done():
                        await self._server_task
                        raise RuntimeError("Worker bridge did not start")
                    await asyncio.sleep(.005)
            return self
        except BaseException:
            await self.__aexit__(None, None, None)
            raise

    async def __aexit__(self, *_):
        self._closed = True
        if self._server:
            self._server.should_exit = True
        if self._server_task:
            try:
                await asyncio.wait_for(self._server_task, 3)
            except (TimeoutError, asyncio.CancelledError):
                self._server_task.cancel()
                await asyncio.gather(self._server_task, return_exceptions=True)
        if self._socket:
            self._socket.close()

    async def _http(self, request: Request) -> Response:
        if self._closed:
            return Response(status_code=410)
        expected = "Bearer " + self.secret
        if not hmac.compare_digest(request.headers.get("authorization", ""), expected):
            return Response(status_code=401)
        # No browser origins are needed for the subprocess MCP client.
        if request.headers.get("origin"):
            return Response(status_code=403)
        host = request.headers.get("host", "").split(":", 1)[0]
        if host not in {"127.0.0.1", "localhost", "["}:
            return Response(status_code=403)
        if request.client and request.client.host not in {"127.0.0.1", "::1", "testclient"}:
            return Response(status_code=403)
        if request.method == "GET":
            return Response(status_code=405, headers={"Allow": "POST, DELETE"})
        if request.method == "DELETE":
            return Response(status_code=204)
        try:
            length = int(request.headers.get("content-length", "0"))
        except ValueError:
            return Response(status_code=400)
        if length > MAX_REQUEST_BYTES:
            return Response(status_code=413)
        body = bytearray()
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body) > MAX_REQUEST_BYTES:
                return Response(status_code=413)
        try:
            message = json.loads(body)
        except (UnicodeError, json.JSONDecodeError):
            return JSONResponse({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Invalid JSON"}}, status_code=400)
        if not isinstance(message, dict) or message.get("jsonrpc") != "2.0" or not isinstance(message.get("method"), str):
            return JSONResponse({"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "Invalid MCP request"}}, status_code=400)
        if "id" not in message:
            return Response(status_code=202)
        request_id = message["id"]
        if not isinstance(request_id, (str, int)) or isinstance(request_id, bool):
            return Response(status_code=400)
        params = message.get("params") or {}
        if not isinstance(params, dict):
            return JSONResponse({"jsonrpc": "2.0", "id": request_id, "error": {"code": -32602, "message": "Params must be an object"}})
        method = message["method"]
        if method == "initialize":
            protocol = params.get("protocolVersion", "2025-03-26")
            result = {"protocolVersion": protocol if protocol in SUPPORTED_PROTOCOLS else "2025-03-26",
                      "capabilities": {"tools": {"listChanged": False}}, "serverInfo": {"name": self.name, "version": "1.0"}}
        elif method == "ping":
            result = {}
        elif method == "tools/list":
            result = {"tools": [{"name": spec["name"], "description": spec["description"], "inputSchema": spec["parameters"]} for spec in self.specs.values()]}
        elif method == "tools/call":
            arguments = params.get("arguments", {})
            if not isinstance(params.get("name"), str) or not isinstance(arguments, dict):
                return JSONResponse({"jsonrpc": "2.0", "id": request_id, "error": {"code": -32602, "message": "Invalid tool call"}})
            task = asyncio.create_task(self.call_tool(params["name"], arguments), context=self.context.copy())
            result = await task
        else:
            return JSONResponse({"jsonrpc": "2.0", "id": request_id, "error": {"code": -32601, "message": "Method not supported"}})
        return JSONResponse({"jsonrpc": "2.0", "id": request_id, "result": result})

    async def call_tool(self, name: str, arguments: dict) -> dict:
        async with self._lock:
            if self._closed or self.yielded.is_set():
                return self._result("This attempt has yielded or closed. No action was executed.", error=True)
            try:
                self.rt.assert_current_attempt()
                if ACTIVE_ATTEMPT.get() is not self.attempt:
                    raise ValueError("Worker action does not belong to its pinned attempt")
            except Exception:
                return self._result("Attempt is no longer current. No action was executed.", error=True)
            if name not in self.specs:
                return self._result("Tool is not granted to this agent.", error=True)
            if self.calls >= self.rt.budget.max_tool_rounds:
                self.yield_reason = "tool_budget"
                self.yielded.set()
                return self._result("Attempt tool-call budget exhausted; yield to Octopus.", error=True)
            action, error = T.parse_tool_call(name, json.dumps(arguments), self.mcp_map)
            if action is None:
                return self._result(error or "Invalid arguments", error=True)
            self.calls += 1
            message_cursor = len(self.rt.history)
            try:
                # The normal tool runner owns validation, execute(), observations and gates.
                text, ended = await self.rt.run_tool_call(self.agent, ToolCall(id=secrets.token_hex(12), name=name, arguments=json.dumps(arguments)), self.mcp_map)
            except Exception as exc:
                return self._result(redact_evidence(str(exc)), error=True)
            question_sent = action.action == "send_message" and action.type == "question" and any(
                message.get("from") == self.agent.id and message.get("type") == "question"
                for message in self.rt.history[message_cursor:])
            if question_sent:
                await self.rt.set_agent_status(self.agent.id, "waiting_reply", "Waiting for a teammate reply")
            if question_sent or ended:
                self.yield_reason = "peer_question" if question_sent else action.action
                self.yielded.set()
                text += "\nThis invocation has ended. Do not execute further tools; Octopus will schedule the next turn."
            return self._result(text or "Action completed through Octopus.", error=text.startswith("Error:"))

    @staticmethod
    def _result(text: str, *, error: bool = False) -> dict:
        return {"content": [{"type": "text", "text": text[:60_000]}], "isError": error}
