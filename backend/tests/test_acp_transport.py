import asyncio
import sys
from contextlib import asynccontextmanager

import pytest

from app.capabilities.models import opencode


@pytest.fixture
def acp_cli(tmp_path, monkeypatch):
    cli = tmp_path / "acp_fixture.py"
    cli.write_text('''
import json, sys
def send(value):
    print(json.dumps({"jsonrpc": "2.0", **value}), flush=True)
pending = None
first = None
for line in sys.stdin:
    message = json.loads(line)
    method = message.get("method")
    params = message.get("params", {})
    if method == "initialize":
        send({"id": message["id"], "result": {"protocolVersion": 1, "agentInfo": {"name": "fixture", "version": "1"}, "agentCapabilities": {"loadSession": True}}})
    elif method in ("session/new", "session/load"):
        send({"id": message["id"], "result": {"sessionId": "fixture-session", "configOptions": [
            {"id": "model", "options": [{"group": "Local", "options": [{"value": "fixture/model"}]}]},
            {"id": "effort", "options": [{"value": "high"}, {"value": "low"}]},
            {"id": "mode", "options": [{"value": "plan"}, {"value": "reviewer"}]}
        ]}})
    elif method in ("session/set_config_option", "session/set_mode"):
        send({"id": message["id"], "result": {"accepted": params}})
    elif method == "first":
        first = message["id"]
    elif method == "second":
        send({"id": message["id"], "result": {"answer": "second"}})
        send({"id": first, "result": {"answer": "first"}})
    elif method == "malformed":
        print("invalid-output", flush=True)
    elif method == "exit":
        sys.exit(0)
    elif method == "session/prompt":
        pending = message["id"]
        text = params["prompt"][0]["text"]
        if text == "WAIT":
            continue
        if text == "PERMISSION":
            send({"id": "approval", "method": "session/request_permission", "params": {"options": []}})
            continue
        for part in ("one", "two", "three"):
            send({"method": "session/update", "params": {"update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": part}}}})
        send({"id": message["id"], "result": {"stopReason": "end_turn"}})
    elif method == "session/cancel":
        send({"id": pending, "result": {"stopReason": "cancelled"}})
        if "id" in message:
            send({"id": message["id"], "result": {"cancelled": True}})
''', encoding="utf-8")
    monkeypatch.setattr(opencode, "executable", lambda: [sys.executable, str(cli)])
    return tmp_path


@asynccontextmanager
async def session_for(root, update=None, permission=None):
    async def discard(_):
        return None
    async def deny(_):
        return {"outcome": {"outcome": "cancelled"}}
    async with opencode.OpenCodeSession(root, update or discard, permission or deny) as session:
        await session.open(None, "fixture/model", "high", False, agent="reviewer")
        yield session


@pytest.mark.asyncio
async def test_dispatches_out_of_order_responses_to_their_callers(acp_cli):
    async with session_for(acp_cli) as session:
        one = asyncio.create_task(session.request("first", {}))
        await asyncio.sleep(.01)
        two = asyncio.create_task(session.request("second", {}))
        assert await asyncio.wait_for(two, 3) == {"answer": "second"}
        assert await asyncio.wait_for(one, 3) == {"answer": "first"}
        assert session.manifest().agent_info == {"name": "fixture", "version": "1"}


@pytest.mark.asyncio
async def test_delivers_updates_in_order_before_prompt_returns(acp_cli):
    chunks = []
    async def receive(update):
        await asyncio.sleep(.01)
        chunks.append(update["content"]["text"])
    async with session_for(acp_cli, update=receive) as session:
        assert await session.prompt([{"type": "text", "text": "hello"}]) == {"stopReason": "end_turn"}
        assert chunks == ["one", "two", "three"]


@pytest.mark.asyncio
async def test_cancel_is_not_blocked_by_permission_callback(acp_cli):
    requested = asyncio.Event()
    released = asyncio.Event()
    async def permission(_):
        requested.set()
        try:
            await asyncio.Event().wait()
        finally:
            released.set()
    async with session_for(acp_cli, permission=permission) as session:
        prompt = asyncio.create_task(session.prompt([{"type": "text", "text": "PERMISSION"}]))
        await asyncio.wait_for(requested.wait(), 3)
        cancel = await asyncio.wait_for(session.request("session/cancel", {"sessionId": session.session_id}), 3)
        assert cancel == {"cancelled": True}
        assert await asyncio.wait_for(prompt, 3) == {"stopReason": "cancelled"}
        await asyncio.wait_for(released.wait(), 3)


@pytest.mark.asyncio
async def test_rejects_second_prompt_and_can_cancel_first(acp_cli):
    async with session_for(acp_cli) as session:
        first = asyncio.create_task(session.prompt([{"type": "text", "text": "WAIT"}]))
        await asyncio.sleep(.02)
        with pytest.raises(opencode.OpenCodeError, match="one active prompt"):
            await session.prompt([{"type": "text", "text": "second"}])
        await session.send({"method": "session/cancel", "params": {"sessionId": session.session_id}})
        assert await asyncio.wait_for(first, 3) == {"stopReason": "cancelled"}


@pytest.mark.asyncio
async def test_cancelled_client_prompt_requires_recovery_before_reuse(acp_cli):
    async with session_for(acp_cli) as session:
        first = asyncio.create_task(session.prompt([{"type": "text", "text": "WAIT"}]))
        await asyncio.sleep(.02)
        first.cancel()
        with pytest.raises(asyncio.CancelledError):
            await first
        with pytest.raises(opencode.OpenCodeError, match="acceptance is uncertain"):
            await session.prompt([{"type": "text", "text": "repeat"}])


@pytest.mark.asyncio
@pytest.mark.parametrize("method,reason", [("malformed", "invalid ACP"), ("exit", "exited before replying")])
async def test_transport_failure_releases_all_pending_callers(acp_cli, method, reason):
    async with session_for(acp_cli) as session:
        waiting = asyncio.create_task(session.request("first", {}))
        await asyncio.sleep(.01)
        failing = asyncio.create_task(session.request(method, {}))
        for task in (waiting, failing):
            with pytest.raises(opencode.OpenCodeError, match=reason):
                await asyncio.wait_for(task, 3)


@pytest.mark.asyncio
async def test_advertised_model_and_effort_are_validated(acp_cli):
    async with session_for(acp_cli) as session:
        with pytest.raises(opencode.OpenCodeError, match="model is unavailable"):
            await session.open(None, "unlisted/model", "default", False)
        with pytest.raises(opencode.OpenCodeError, match="effort is unavailable"):
            await session.open(None, "fixture/model", "max", False)
        session.config_options = [option for option in session.config_options if option["id"] != "mode"]
        with pytest.raises(opencode.OpenCodeError, match="does not expose.*mode"):
            session._validate_option("mode", "reviewer")


@pytest.mark.asyncio
async def test_probe_reports_capabilities_without_prompting_or_claiming_isolation(acp_cli):
    result = await opencode.probe(acp_cli)
    assert result.available is True
    assert result.protocol_version == 1
    assert result.capabilities == {"loadSession": True}
    assert result.config_options[0]["id"] == "model"
    assert result.execution_mode == "trusted-host"
    assert result.restrictions_supported is False


@pytest.mark.asyncio
async def test_exit_cancels_pending_permission_and_closes_process(acp_cli):
    requested = asyncio.Event()
    cleaned = asyncio.Event()
    async def permission(_):
        requested.set()
        try:
            await asyncio.Event().wait()
        finally:
            cleaned.set()
    async with session_for(acp_cli, permission=permission) as session:
        prompt = asyncio.create_task(session.prompt([{"type": "text", "text": "PERMISSION"}]))
        await asyncio.wait_for(requested.wait(), 3)
    with pytest.raises(opencode.OpenCodeError):
        await prompt
    assert cleaned.is_set()
    assert session.proc.returncode is not None
