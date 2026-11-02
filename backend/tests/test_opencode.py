import asyncio
import sys

import pytest

from app.core.config import get_settings
from app.services import opencode
from app.orchestrator.bus import bus
from conftest import agent, make_company, run_messages, start_run, wait_status


@pytest.fixture
def installed_cli(tmp_path, monkeypatch):
    script = tmp_path / "fake_opencode.py"
    script.write_text('''
import json, re, sys
def send(value):
    print(json.dumps({"jsonrpc": "2.0", **value}), flush=True)
pending = None
for line in sys.stdin:
    msg = json.loads(line)
    method = msg.get("method")
    params = msg.get("params", {})
    if method == "initialize":
        send({"id": msg["id"], "result": {"protocolVersion": 1}})
    elif method in ("session/new", "session/load"):
        send({"id": msg["id"], "result": {"sessionId": "existing-session"}})
    elif method in ("session/set_config_option", "session/set_mode"):
        send({"id": msg["id"], "result": {}})
    elif method == "session/prompt":
        prompt = "\\n".join(block.get("text", "") for block in params["prompt"] if block.get("type") == "text")
        messages = re.findall(r"\\((?:task|user_interjection)\\)(?:[^:]*): ([^\\n]*)", prompt)
        text = messages[-1] if messages else "No new message"
        if text == "WAIT":
            pending = msg["id"]
            continue
        if text == "PERMISSION":
            pending = msg["id"]
            send({"id": "permission-1", "method": "session/request_permission", "params": {
                "toolCall": {"title": "Edit test file"}, "options": [
                    {"optionId": "once", "kind": "allow_once"}, {"optionId": "reject", "kind": "reject_once"}]}})
            continue
        send({"method": "session/update", "params": {"update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "ANSWER:" + text}}}})
        send({"id": msg["id"], "result": {"stopReason": "end_turn", "usage": {"inputTokens": 10, "outputTokens": 5, "thoughtTokens": 2, "totalTokens": 17}}})
    elif method == "session/cancel":
        send({"id": pending, "result": {"stopReason": "cancelled"}})
    elif msg.get("id") == "permission-1":
        send({"method": "session/update", "params": {"update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": msg["result"]["outcome"].get("optionId", "cancelled")}}}})
        send({"id": pending, "result": {"stopReason": "end_turn"}})
''', encoding="utf-8")
    monkeypatch.setattr(opencode, "executable", lambda: [sys.executable, str(script)])
    async def discover():
        return opencode.OpenCodeStatus(available=True, executable=str(script), models=["test/model"])
    monkeypatch.setattr(opencode, "discover", discover)
    monkeypatch.setattr(get_settings(), "default_provider", "opencode")
    monkeypatch.setattr(get_settings(), "default_model", "default")
    return script


@pytest.mark.asyncio
async def test_proxy_default_streaming_and_followup(client, workspace, installed_cli):
    cid = await make_company(client, workspace, [agent("a", "OpenCode", entry=True)], [])
    run = await start_run(client, workspace, cid, "Hello")
    queue = bus.subscribe(run["id"])
    final = await wait_status(client, workspace, run["id"])
    assert final["status"] == "completed", final
    assert final["tokens_used"] == 17
    assert final["state"]["worker_sessions"]["a"]["session_id"] == "existing-session"
    assert [m["content"] for m in await run_messages(client, workspace, run["id"]) if m["sender"] == "agent"] == ["ANSWER:Hello"]
    streamed = []
    while not queue.empty():
        streamed.append(queue.get_nowait())
    bus.unsubscribe(run["id"], queue)
    assert [e["data"]["delta"] for e in streamed if e["type"] == "token_stream"] == ["ANSWER:Hello"]
    response = await client.post(f"/api/v1/w/{workspace['id']}/runs/{run['id']}/continue", json={"content": "Again"})
    assert response.status_code == 202, response.text
    final = await wait_status(client, workspace, run["id"])
    assert final["status"] == "completed"
    assert final["tokens_used"] == 34
    assert [m["content"] for m in await run_messages(client, workspace, run["id"]) if m["sender"] == "agent"][-1] == "ANSWER:Follow-up from the user: Again"


@pytest.mark.asyncio
async def test_native_permission_is_denied_and_stop_cancels(client, workspace, installed_cli):
    cid = await make_company(client, workspace, [agent("a", "OpenCode", entry=True)], [])
    run = await start_run(client, workspace, cid, "PERMISSION", permission_level="ask")
    assert (await wait_status(client, workspace, run["id"]))["status"] == "completed"
    assert [m["content"] for m in await run_messages(client, workspace, run["id"]) if m["sender"] == "agent"] == ["reject"]
    slow = await start_run(client, workspace, cid, "WAIT")
    await wait_status(client, workspace, slow["id"], {"running"})
    await asyncio.sleep(.1)
    response = await client.post(f"/api/v1/w/{workspace['id']}/runs/{slow['id']}/control/stop")
    assert response.status_code == 200
    assert (await wait_status(client, workspace, slow["id"]))["status"] == "cancelled"


@pytest.mark.asyncio
async def test_missing_install_does_not_fall_back_or_install(client, workspace, monkeypatch):
    monkeypatch.setattr(get_settings(), "default_provider", "opencode")
    async def missing():
        return opencode.OpenCodeStatus(error="OpenCode is not installed")
    monkeypatch.setattr(opencode, "discover", missing)
    cid = await make_company(client, workspace, [agent("a", "OpenCode", entry=True)], [])
    response = await client.post(f"/api/v1/w/{workspace['id']}/runs", json={"company_id": cid, "goal": "Hello", "approval_mode": "ask"})
    assert response.status_code == 422
    assert response.json()["detail"] == "OpenCode is not installed"


@pytest.mark.asyncio
async def test_proxy_pause_marks_uncertain_invocation_without_automatic_replay(client, workspace, installed_cli):
    cid = await make_company(client, workspace, [agent("a", "OpenCode", entry=True)], [])
    run = await start_run(client, workspace, cid, "WAIT", budget={"model": {"provider": "opencode", "model": "test/model"}})
    base = f"/api/v1/w/{workspace['id']}/runs/{run['id']}"
    await wait_status(client, workspace, run["id"], {"running"})
    await asyncio.sleep(.2)
    assert (await client.post(base + "/control/pause")).status_code == 200
    try:
        for _ in range(100):
            execution = (await client.get(base + "/execution")).json()
            if execution["recovery_required"]:
                break
            await asyncio.sleep(.03)
        assert execution["recovery_required"]
        paused = await wait_status(client, workspace, run["id"], {"paused"})
        assert paused["budget"]["model"] == {"provider": "opencode", "model": "test/model"}
        assert paused["state"]["worker_sessions"]["a"]["state"] == "recovery_required"
        before = len(execution["attempts"])
        assert (await client.post(base + "/control/resume")).status_code == 200
        await asyncio.sleep(.15)
        still = (await client.get(base + "/execution")).json()
        assert still["recovery_required"] and len(still["attempts"]) == before
        assert [m["content"] for m in await run_messages(client, workspace, run["id"]) if m["sender"] == "agent"] == []
        denied = await client.post(base + "/recovery", json={"action": "cancel", "acknowledge_side_effects": False})
        assert denied.status_code == 422
        cancelled = await client.post(base + "/recovery", json={"action": "cancel", "acknowledge_side_effects": True})
        assert cancelled.status_code == 200 and not cancelled.json()["recovery_required"]
        assert (await wait_status(client, workspace, run["id"]))["status"] == "cancelled"
    finally:
        await client.post(base + "/control/stop")
