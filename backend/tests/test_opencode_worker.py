import asyncio

import httpx
import pytest

from app.orchestrator import opencode as adapter
from app.orchestrator.execution import ACTIVE_ATTEMPT
from app.services.opencode import OpenCodeError
from test_worker_bridge import FakeRuntime, node


class FakeSession:
    instances = []
    behavior = "answer"
    permission_call = None

    def __init__(self, root, update, permission):
        self.root, self.update, self.permission = root, update, permission
        self.cancelled = asyncio.Event()
        self.session_id = ""
        self.prompts = []
        self.opened = None
        self.permission_result = None
        self.result = {"stopReason": "end_turn", "usage": {"inputTokens": 10, "outputTokens": 5, "thoughtTokens": 2, "totalTokens": 17}}
        self.instances.append(self)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        pass

    async def open(self, previous, model, effort, plan, *, mcp_servers=None, agent=None):
        self.opened = {"previous": previous, "model": model, "effort": effort, "plan": plan, "mcp_servers": mcp_servers}
        self.session_id = previous or f"session-{len(self.instances)}"

    async def send(self, message):
        if message.get("method") == "session/cancel":
            self.cancelled.set()

    async def prompt(self, blocks):
        self.prompts.append(blocks)
        server = self.opened["mcp_servers"][0]
        if self.behavior in {"native", "spoofed_native", "spoofed_native_update"}:
            title = "Native shell" if self.behavior == "native" else "Native shell " + server["name"]
            update = "tool_call_update" if self.behavior == "spoofed_native_update" else "tool_call"
            await self.update({"sessionUpdate": update, "toolCallId": "shell-1", "title": title,
                               "name": server["name"] + "_read_file", "kind": "execute", "status": "completed"})
            return self.result
        if self.behavior == "permission":
            call = self.permission_call(server["name"])
            self.permission_result = await self.permission({"toolCall": call, "options": [
                {"optionId": "once", "kind": "allow_once"}, {"optionId": "reject", "kind": "reject_once"}]})
            return self.result
        if self.behavior == "cancel":
            return {"stopReason": "cancelled"}
        if self.behavior in {"question", "finish"}:
            server = self.opened["mcp_servers"][0]
            headers = {item["name"]: item["value"] for item in server["headers"]}
            arguments = {"to": "Reviewer", "type": "question", "content": "Which API contract?"} if self.behavior == "question" else {"summary": "Verified my assignment"}
            async with httpx.AsyncClient() as client:
                response = await client.post(server["url"], headers=headers,
                    json={"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "send_message" if self.behavior == "question" else "finish", "arguments": arguments}})
                assert not response.json()["result"]["isError"]
            await asyncio.wait_for(self.cancelled.wait(), 3)
            return {**self.result, "stopReason": "cancelled"}
        await self.update({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "Answer from this node"}})
        return self.result


@pytest.fixture(autouse=True)
def fake_session(monkeypatch):
    FakeSession.instances = []
    FakeSession.behavior = "answer"
    FakeSession.permission_call = None
    monkeypatch.setattr(adapter, "OpenCodeSession", FakeSession)


async def run(runtime):
    token = ACTIVE_ATTEMPT.set(runtime.context())
    try:
        await adapter.opencode_turn(runtime, runtime.agent, [], [])
    finally:
        ACTIVE_ATTEMPT.reset(token)


@pytest.mark.asyncio
async def test_node_model_role_scoped_context_and_broker_are_used(tmp_path):
    runtime = FakeRuntime(tmp_path, node("worker"))
    memory_reads = []

    async def scoped_context(aid):
        memory_reads.append(aid)
        return "\nScoped memory for " + aid

    runtime.execution.scoped_context = scoped_context
    await run(runtime)
    invocation = FakeSession.instances[0]
    assert invocation.root == tmp_path
    assert invocation.opened["model"] == "test/model"
    assert invocation.opened["effort"] == "high"
    assert invocation.opened["mcp_servers"][0]["url"].startswith("http://127.0.0.1:")
    system = invocation.prompts[0][0]["text"]
    assert "You are Worker, model `test/model` through `opencode`" in system
    assert "Pinned project rule" in system
    assert "Scoped memory for worker" in system
    assert "Engineering workflow explain v1" in system
    assert memory_reads == ["worker"], "the prompt and session signature use one consistent memory snapshot"
    assert runtime.finished_summary is None
    assert runtime.done_agents == {"worker"}
    assert runtime.worker_sessions["worker"]["state"] == "ready"
    assert runtime.worker_sessions["worker"]["broker_calls"] == 0
    assert runtime.used[0][0] == "worker"
    assert runtime.used[0][1].total_tokens == 17
    assert runtime.messages[-1]["content"] == "Answer from this node"


@pytest.mark.asyncio
async def test_each_node_has_its_own_session_and_only_lead_finishes_chat(tmp_path):
    runtime = FakeRuntime(tmp_path, node("lead"))
    await run(runtime)
    first = runtime.worker_sessions["lead"]["session_id"]
    assert runtime.finished_summary == "Answer from this node"
    worker = node("second")
    worker.model = "other/model"
    worker.behavior["reasoning_effort"] = "low"
    runtime.agent = worker
    runtime.agents[worker.id] = worker
    runtime.names[worker.id] = worker.name
    await run(runtime)
    assert runtime.worker_sessions["second"]["session_id"] != first
    assert FakeSession.instances[-1].opened["model"] == "other/model"
    assert FakeSession.instances[-1].opened["effort"] == "low"


@pytest.mark.asyncio
async def test_known_peer_question_yields_and_prevents_more_actions(tmp_path):
    runtime = FakeRuntime(tmp_path)
    FakeSession.behavior = "question"
    await run(runtime)
    assert runtime.status["worker"] == "waiting_reply"
    assert FakeSession.instances[0].cancelled.is_set()
    assert runtime.worker_sessions["worker"]["state"] == "ready"
    assert runtime.worker_sessions["worker"]["broker_calls"] == 1
    assert [action.action for _, action in runtime.executed] == ["send_message"]
    assert runtime.finished_summary is None


@pytest.mark.asyncio
async def test_unexpected_cancel_is_not_automatically_replayed(tmp_path):
    runtime = FakeRuntime(tmp_path)
    FakeSession.behavior = "cancel"
    with pytest.raises(OpenCodeError, match="automatically resent"):
        await run(runtime)
    assert runtime.worker_sessions["worker"]["state"] == "recovery_required"
    with pytest.raises(OpenCodeError, match="uncertain"):
        await run(runtime)
    assert len(FakeSession.instances) == 1
    assert not runtime.executed


@pytest.mark.asyncio
@pytest.mark.parametrize("behavior", ["native", "spoofed_native", "spoofed_native_update"])
async def test_native_mutation_is_not_accepted_as_verified_octopus_work(tmp_path, behavior):
    runtime = FakeRuntime(tmp_path)
    FakeSession.behavior = behavior
    with pytest.raises(OpenCodeError, match="reconciliation|native mutation"):
        await run(runtime)
    assert runtime.worker_sessions["worker"]["state"] == "recovery_required"
    assert not runtime.executed
    assert not runtime.used
    assert not runtime.messages
    acp_calls = [payload for kind, payload in runtime.events if kind == "tool_call"]
    if behavior != "spoofed_native_update":
        assert acp_calls and all(payload["args"] == {"source": "acp", "brokered": False} for payload in acp_calls)


@pytest.mark.asyncio
@pytest.mark.parametrize(("call", "approved"), [
    (lambda name: {"name": name + "_read_file", "kind": "other"}, True),
    (lambda name: {"name": name + "_write_file", "kind": "other"}, False),
    (lambda name: {"name": "bash", "title": "Run " + name, "rawInput": {"command": "echo " + name}}, False),
    (lambda name: {"title": name + "_read_file", "rawInput": {"name": name + "_read_file"}}, False),
    (lambda name: {"name": "prefix_" + name + "_read_file", "kind": "other"}, False),
    (lambda name: {"name": name + "_read_file", "kind": "execute"}, False),
])
async def test_permission_requires_exact_granted_machine_identity(tmp_path, call, approved):
    runtime = FakeRuntime(tmp_path)
    FakeSession.behavior = "permission"
    FakeSession.permission_call = staticmethod(call)
    await run(runtime)
    assert FakeSession.instances[0].permission_result == {
        "outcome": {"outcome": "selected", "optionId": "once" if approved else "reject"}}
    assert runtime.executed == []
    assert runtime.worker_sessions["worker"]["broker_calls"] == 0
