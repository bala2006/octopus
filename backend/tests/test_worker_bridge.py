from app.kernel.current import current
from app.kernel.runtime.context import build_turn_prompts
import asyncio
from types import SimpleNamespace

import httpx
import pytest
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

from app.sdk import toolspecs as T
from app.sdk.agents import AgentSpec
from app.sdk.contracts import Assignment, ExecutionPolicy
from app.sdk.execution_contracts import ACTIVE_ATTEMPT, AttemptContext
from app.plugins.mcp.worker_bridge import WorkerBridge


def node(aid="worker", **kwargs):
    return AgentSpec(id=aid, name=aid.title(), role="Engineer", description="Owns implementation", system_prompt="Be precise.",
                     provider="opencode", model="test/model", temperature=.4, max_tokens=1000,
                     tools={"file_read": True, "file_write": False, "send_message": True, "terminal": False},
                     behavior={"reasoning_effort": "high"}, is_entry=aid == "lead", color="orange", **kwargs)


class FakeRuntime:
    def __init__(self, root, agent=None):
        self.root = root
        self.services = current().services
        self.agent = agent or node()
        self.company_name = "Octopus"
        self.goal = "Inspect the requested source"
        self.agents = {self.agent.id: self.agent}
        self.edges = []
        self.roles = {}
        self.skills = {}
        self.status = {self.agent.id: "thinking"}
        self.names = {self.agent.id: self.agent.name}
        self.history = []
        self.observations = {}
        self.pinned_guidance = {"content": "Pinned project rule", "content_hash": "rule-hash"}
        self.worker_sessions = {}
        self.attachments = []
        self.budget = SimpleNamespace(max_tool_rounds=6, timeout_s=20, context_recent=30)
        self.pending_approval = None
        self.paused = False
        self.stop_requested = False
        self.turn_no = 1
        self.events = []
        self.execution = self  # the fake plays the runtime and its execution service
        self.executed = []
        self.messages = []
        self.used = []
        self.revision = 1
        self.finished_summary = None
        self.done_agents = set()
        self._bounced_finish = None
        self.waiting_peers = {}
        self.journal_n = 0
        self.seen = {}
        self.seen_turn = {}

    def build_turn_prompts(self, agent, inbox_ids, observations, *, native, memory_context):
        return build_turn_prompts(self, agent, inbox_ids, observations, native=native, memory_context=memory_context)

    def context(self):
        assignment = Assignment(run_id="run", owner=self.agent.id, lead="lead", provider="opencode", model=self.agent.model,
                                effort="high", original_goal=self.goal, policy=ExecutionPolicy())
        return AttemptContext("attempt", assignment)

    def assert_current_attempt(self):
        context = ACTIVE_ATTEMPT.get()
        if context is None or context.assignment.revision != self.revision:
            raise ValueError("superseded")

    def wf_tool_exclusions(self, agent):
        return {"create_agent"}

    async def run_tool_call(self, agent, call, mcp_map):
        action, error = T.parse_tool_call(call.name, call.arguments, mcp_map)
        if error:
            return "Error: " + error, False
        await self.execute(agent, action)
        return "Executed " + action.action, action.action in T.TERMINAL_ACTIONS

    async def execute(self, agent, action):
        self.assert_current_attempt()
        self.executed.append((agent.id, action))
        if action.action == "send_message":
            self.history.append({"from": agent.id, "type": action.type, "to": action.to, "content": action.content})
        if action.action == "finish":
            if agent.id == "lead":
                self.finished_summary = action.summary
            else:
                self.done_agents.add(agent.id)

    async def set_agent_status(self, aid, status, message):
        self.status[aid] = status

    async def scoped_context(self, aid):
        return "\nScoped memory for " + aid

    def engineering_brief(self):
        return "\nEngineering workflow explain v1"

    def preview_url(self):
        return "http://127.0.0.1/preview/"

    def blackboard(self):
        return "Owned task"

    def digest(self, aid):
        return "Recent team activity"

    def goal_images(self):
        return []

    def worker_root(self, aid):
        return self.root

    def model_for(self, agent):
        return agent.provider, agent.model

    def effort_for(self, agent):
        return agent.behavior["reasoning_effort"]

    def active_now(self):
        return 0

    async def emit(self, kind, payload):
        self.events.append((kind, payload))

    async def save(self):
        pass

    async def usage_event(self):
        pass

    def add_usage(self, aid, usage):
        self.used.append((aid, usage))

    async def post_message(self, **kwargs):
        self.messages.append(kwargs)

    def notice(self, aid, message, activate=False):
        self.observations.setdefault(aid, []).append((1, {"content": message, "activate": activate}))


@pytest.mark.asyncio
async def test_bridge_auth_filters_tools_and_rejects_stale_attempt(tmp_path):
    runtime = FakeRuntime(tmp_path)
    token = ACTIVE_ATTEMPT.set(runtime.context())
    try:
        bridge = WorkerBridge(runtime, runtime.agent)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=bridge.app), base_url="http://127.0.0.1") as client:
            rpc = {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}
            assert (await client.post("/mcp", json=rpc)).status_code == 401
            headers = {"Authorization": "Bearer " + bridge.secret}
            assert (await client.post("/mcp", json=rpc, headers={**headers, "Origin": "http://malicious.invalid"})).status_code == 403
            result = (await client.post("/mcp", json=rpc, headers=headers)).json()["result"]
            names = {tool["name"] for tool in result["tools"]}
            assert "read_file" in names
            assert "write_file" not in names
            assert "create_agent" not in names
            denied = await bridge.call_tool("write_file", {"path": "x.py", "content": "forbidden"})
            assert denied["isError"]
            assert runtime.executed == []
            runtime.revision = 2
            stale = await bridge.call_tool("read_file", {"path": "app.py"})
            assert stale["isError"]
            assert runtime.executed == []
    finally:
        ACTIVE_ATTEMPT.reset(token)


@pytest.mark.asyncio
async def test_bridge_works_with_real_mcp_client_and_yields_after_question(tmp_path):
    runtime = FakeRuntime(tmp_path)
    token = ACTIVE_ATTEMPT.set(runtime.context())
    try:
        async with WorkerBridge(runtime, runtime.agent) as bridge:
            assert bridge.url.startswith("http://127.0.0.1:")
            async with streamablehttp_client(bridge.url, headers={"Authorization": "Bearer " + bridge.secret}) as (reader, writer, _):
                async with ClientSession(reader, writer) as client:
                    await client.initialize()
                    tools = await client.list_tools()
                    assert "read_file" in {tool.name for tool in tools.tools}
                    result = await client.call_tool("read_file", {"path": "app.py"})
                    assert not result.isError
                    assert runtime.executed[-1][1].path == "app.py"
                    result = await client.call_tool("send_message", {"to": "Reviewer", "type": "question", "content": "Which contract applies?"})
                    assert not result.isError
                    assert bridge.yielded.is_set()
                    assert runtime.status["worker"] == "waiting_reply"
                    result = await client.call_tool("read_file", {"path": "later.py"})
                    assert result.isError
                    assert len(runtime.executed) == 2
        assert bridge._closed
    finally:
        ACTIVE_ATTEMPT.reset(token)


@pytest.mark.asyncio
async def test_bridge_refuses_after_budget_and_does_not_accept_invalid_tool_arguments(tmp_path):
    runtime = FakeRuntime(tmp_path)
    runtime.budget.max_tool_rounds = 1
    token = ACTIVE_ATTEMPT.set(runtime.context())
    try:
        bridge = WorkerBridge(runtime, runtime.agent)
        invalid = await bridge.call_tool("read_file", {})
        assert invalid["isError"]
        assert not runtime.executed
        await bridge.call_tool("read_file", {"path": "first.py"})
        limited = await bridge.call_tool("read_file", {"path": "second.py"})
        assert limited["isError"]
        assert bridge.yield_reason == "tool_budget"
        assert len(runtime.executed) == 1
    finally:
        ACTIVE_ATTEMPT.reset(token)
