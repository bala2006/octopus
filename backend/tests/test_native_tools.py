"""Native function calling and the edit_file tool."""
from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest

from app.llm.azure_v1 import AzureV1Provider, _body, supports_native_tools
from app.llm.base import LLMRequest
from app.llm.router import set_provider_override
from app.orchestrator.actions import Edit, EditFile, parse_envelope
from app.orchestrator.engine import apply_edits
from app.orchestrator.tools import parse_tool_call, tool_specs
from conftest import NativeScriptedProvider, ScriptedProvider, agent, edge, env, events, make_company, run_messages, start_run, wait_status


# ------------------------------------------------------------------ edit_file
def test_apply_edits_replaces_exact_unique_text() -> None:
    src = "def add(a, b):\n    return a - b\n\nprint(add(1, 2))\n"
    out, line = apply_edits(src, [Edit(old_string="    return a - b", new_string="    return a + b")])
    assert out == src.replace("a - b", "a + b") and line == 2


def test_apply_edits_is_atomic_and_explains_failures() -> None:
    src = "x = 1\nx = 1\ny = 2\n"
    with pytest.raises(ValueError, match="occurs 2 times"):
        apply_edits(src, [Edit(old_string="x = 1", new_string="x = 3")])
    with pytest.raises(ValueError, match="edit 2: old_string not found"):
        apply_edits(src, [Edit(old_string="y = 2", new_string="y = 5"), Edit(old_string="z = 9", new_string="")])
    with pytest.raises(ValueError, match="different surrounding whitespace"):
        apply_edits("    indented()\n", [Edit(old_string="indented() \n", new_string="x")])
    assert apply_edits(src, [Edit(old_string="x = 1", new_string="x = 3", replace_all=True)])[0] == "x = 3\nx = 3\ny = 2\n"


def test_edit_file_accepts_a_single_edit_shorthand() -> None:
    e = EditFile.model_validate({"action": "edit_file", "path": "a.py", "old_string": "a", "new_string": "b"})
    assert len(e.edits) == 1 and e.edits[0].new_string == "b"
    assert parse_envelope(json.dumps({"actions": [{"action": "str_replace", "path": "a", "old_string": "x", "new_string": "y"}]})).ok


async def test_edit_file_changes_only_the_target_and_keeps_history(client, workspace) -> None:
    root = Path(workspace["path"])
    big = "".join(f"line {i}\n" for i in range(2000)) + "TARGET = 1\n" + "".join(f"tail {i}\n" for i in range(2000))
    cid = await make_company(client, workspace, [agent("a", "Ann", entry=True)], [])
    set_provider_override(ScriptedProvider({"Ann": [
        env({"action": "write_file", "path": "big.py", "content": big},
            {"action": "edit_file", "path": "big.py", "edits": [{"old_string": "TARGET = 1", "new_string": "TARGET = 2"}]},
            {"action": "edit_file", "path": "big.py", "edits": [{"old_string": "missing text", "new_string": "x"}]},
            {"action": "finish", "summary": "ok"})]}))
    run = await start_run(client, workspace, cid, permission_level="danger")
    await wait_status(client, workspace, run["id"])
    assert (root / "big.py").read_text() == big.replace("TARGET = 1", "TARGET = 2")
    versions = (await client.get(f"/api/v1/w/{workspace['id']}/runs/{run['id']}/artifacts?all_versions=true")).json()
    assert [v["version"] for v in versions] == [1, 2]
    results = [e["payload"] for e in await events(client, workspace, run["id"], "tool_result") if e["payload"]["tool"] == "edit_file"]
    assert [r["ok"] for r in results] == [True, False] and "old_string not found" in results[1]["output"]


async def test_edit_file_respects_read_only(client, workspace) -> None:
    root = Path(workspace["path"])
    (root / "a.txt").write_text("hello")
    cid = await make_company(client, workspace, [agent("a", "Ann", entry=True)], [])
    set_provider_override(ScriptedProvider({"Ann": [env({"action": "edit_file", "path": "a.txt", "old_string": "hello", "new_string": "bye"}),
                                                    env({"action": "finish", "summary": "x"})]}))
    run = await start_run(client, workspace, cid, permission_level="read_only")
    await wait_status(client, workspace, run["id"])
    assert (root / "a.txt").read_text() == "hello"


# ------------------------------------------------------------------ tool definitions
def test_tool_specs_follow_the_agents_tools() -> None:
    specs, mcp = tool_specs({"terminal": False}, [{"name": "browser", "tools": [
        {"name": "browser_navigate", "description": "Open a URL", "input_schema": {"properties": {"url": {"type": "string"}}, "required": ["url"]}}]}])
    names = {s["name"] for s in specs}
    assert {"send_message", "write_file", "edit_file", "read_file", "finish", "wait"} <= names
    assert "run_code" not in names and "create_agent" not in names, "only tools the agent has"
    assert "mcp__browser__browser_navigate" in names and mcp["mcp__browser__browser_navigate"] == ("browser", "browser_navigate")
    for s in specs:
        assert s["parameters"]["type"] == "object" and "$ref" not in json.dumps(s) and "action" not in s["parameters"].get("properties", {})
    board = next(s for s in specs if s["name"] == "update_task_board")["parameters"]
    assert "title" in board["properties"]["tasks"]["items"]["properties"], "a field named 'title' must survive schema cleanup"


def test_parse_tool_call() -> None:
    a, err = parse_tool_call("edit_file", json.dumps({"path": "a.py", "edits": [{"old_string": "a", "new_string": "b"}]}))
    assert err is None and a.action == "edit_file"
    a, err = parse_tool_call("mcp__browser__browser_navigate", '{"url": "http://x"}', {"mcp__browser__browser_navigate": ("browser", "browser_navigate")})
    assert a.action == "mcp_call" and a.server == "browser" and a.arguments == {"url": "http://x"}
    assert parse_tool_call("write_file", "{not json")[1].startswith("arguments are not valid JSON")
    assert "path" in parse_tool_call("write_file", "{}")[1]
    assert parse_tool_call("nope", "{}")[1] == "unknown tool 'nope'"


# ------------------------------------------------------------------ native loop in the engine
async def test_read_then_edit_in_one_turn(client, workspace) -> None:
    """The agent reads a file, sees its content as the tool result, and edits it in the same turn."""
    root = Path(workspace["path"])
    (root / "app.py").write_text("def total(xs):\n    return sum(xs) - 1  # bug\n")

    def fix(ctx, outputs):  # type: ignore[no-untyped-def]
        assert "return sum(xs) - 1" in outputs[-1], "the read result came back to the model within the turn"
        return [("edit_file", {"path": "app.py", "edits": [{"old_string": "sum(xs) - 1  # bug", "new_string": "sum(xs)"}]})]

    provider = NativeScriptedProvider({"Ann": [[("read_file", {"path": "app.py"})], fix,
                                               [("finish", {"summary": "fixed the off-by-one"})]]})
    set_provider_override(provider)
    cid = await make_company(client, workspace, [agent("a", "Ann", entry=True)], [])
    run = await start_run(client, workspace, cid, permission_level="danger")
    done = await wait_status(client, workspace, run["id"])
    assert done["status"] == "completed" and done["turns"] == 1, "one turn, three model calls"
    assert (root / "app.py").read_text() == "def total(xs):\n    return sum(xs)\n"
    last = provider.requests[-1]
    assert {t["name"] for t in last.tools} >= {"read_file", "edit_file"} and not last.json_mode
    kinds = [i["type"] for i in last.continuation]
    assert kinds.count("function_call_output") == 2 and kinds.count("function_call") == 2
    assert [i["encrypted_content"] for i in last.continuation if i["type"] == "reasoning"] == ["enc-1", "enc-2"], "reasoning is replayed"
    assert "Lines around the change" in [i for i in last.continuation if i["type"] == "function_call_output"][-1]["output"]
    system = last.messages[0]["content"]
    assert "Reply with ONE JSON object" not in system and "You act by calling your tools" in system


async def test_invalid_arguments_go_back_to_the_model(client, workspace) -> None:
    provider = NativeScriptedProvider({"Ann": [
        [("write_file", {"content": "no path"})],
        lambda ctx, outs: [("write_file", {"path": "ok.txt", "content": "fixed"})] if "invalid arguments" in outs[-1] else [],
        [("finish", {"summary": "done"})]]})
    set_provider_override(provider)
    cid = await make_company(client, workspace, [agent("a", "Ann", entry=True)], [])
    run = await start_run(client, workspace, cid, permission_level="danger")
    await wait_status(client, workspace, run["id"])
    assert (Path(workspace["path"]) / "ok.txt").read_text() == "fixed"


async def test_messages_and_turn_ending(client, workspace) -> None:
    """send_message works natively; wait ends the turn; the next agent takes over."""
    provider = NativeScriptedProvider({
        "Ann": [[("send_message", {"to": "Ben", "type": "task", "content": "Write hello.txt"}), ("wait", {}),
                 ("write_file", {"path": "never.txt", "content": "x"})]],
        "Ben": [[("write_file", {"path": "hello.txt", "content": "hi"})], "All done."]})
    set_provider_override(provider)
    cid = await make_company(client, workspace, [agent("a", "Ann", entry=True), agent("b", "Ben")], [edge("e", "a", "b")])
    run = await start_run(client, workspace, cid, permission_level="danger")
    await wait_status(client, workspace, run["id"])
    root = Path(workspace["path"])
    assert (root / "hello.txt").read_text() == "hi"
    assert not (root / "never.txt").exists(), "calls after `wait` in the same reply are not run"
    assert any(m["type"] == "task" and m["to_agent_id"] == "b" for m in await run_messages(client, workspace, run["id"]))
    thoughts = [e["payload"]["text"] for e in await events(client, workspace, run["id"], "thought")]
    assert "All done." in thoughts


async def test_tool_rounds_are_capped(client, workspace) -> None:
    provider = NativeScriptedProvider({"Ann": [[("list_files", {})]] * 50})
    set_provider_override(provider)
    cid = await make_company(client, workspace, [agent("a", "Ann", entry=True)], [])
    run = await start_run(client, workspace, cid, budget={"max_tool_rounds": 5, "max_turns": 1, "stall_turns": 0})
    await wait_status(client, workspace, run["id"])
    assert len(provider.requests) == 5
    warn = [e["payload"]["message"] for e in await events(client, workspace, run["id"], "error")]
    assert any("used all 5 tool rounds" in w for w in warn)


# ------------------------------------------------------------------ Azure Responses API wire format
def _sse(*evs: dict) -> bytes:
    return "".join(f"data: {json.dumps(e)}\n\n" for e in evs).encode()


async def test_azure_sends_tools_and_collects_function_calls() -> None:
    seen: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(json.loads(request.content))
        body = _sse(
            {"type": "response.output_item.added", "output_index": 0, "item": {"type": "reasoning", "id": "rs_1"}},
            {"type": "response.output_item.done", "output_index": 0, "item": {"type": "reasoning", "id": "rs_1", "encrypted_content": "abc", "summary": []}},
            {"type": "response.output_item.added", "output_index": 1, "item": {"type": "function_call", "id": "fc_1", "call_id": "call_1", "name": "read_file", "arguments": ""}},
            {"type": "response.function_call_arguments.delta", "output_index": 1, "item_id": "fc_1", "delta": "{\"path\":"},
            {"type": "response.function_call_arguments.delta", "output_index": 1, "item_id": "fc_1", "delta": "\"a.py\"}"},
            {"type": "response.output_item.done", "output_index": 1, "item": {"type": "function_call", "id": "fc_1", "call_id": "call_1", "name": "read_file", "arguments": "{\"path\":\"a.py\"}"}},
            {"type": "response.completed", "response": {"usage": {"input_tokens": 10, "output_tokens": 5}}})
        return httpx.Response(200, content=body, headers={"content-type": "text/event-stream"})

    specs, _ = tool_specs({})
    req = LLMRequest(provider="azure", model="gpt-6-luna", messages=[{"role": "user", "content": "hi"}], api_key="k",
                     base_url="https://res.openai.azure.com", tools=specs, extra={"reasoning_effort": "xhigh"},
                     continuation=[{"type": "function_call_output", "call_id": "call_0", "output": "previous"}])
    assert supports_native_tools(req)
    chunks = [c async for c in AzureV1Provider(httpx.MockTransport(handler)).stream(req)]
    final = chunks[-1]
    assert [(c.name, c.arguments, c.id) for c in final.tool_calls] == [("read_file", '{"path":"a.py"}', "call_1")]
    assert [i["type"] for i in final.items] == ["reasoning", "function_call"] and final.items[0]["encrypted_content"] == "abc"
    assert "read_file" in [c.tool_started for c in chunks]
    sent = seen[0]
    assert sent["tool_choice"] == "auto" and sent["tools"][0]["type"] == "function" and "parameters" in sent["tools"][0]
    assert sent["include"] == ["reasoning.encrypted_content"] and sent["store"] is False
    assert sent["input"][-1] == {"type": "function_call_output", "call_id": "call_0", "output": "previous"}
    assert "text" not in sent, "no json_object response format when tools are used"


def test_chat_completions_keeps_the_envelope() -> None:
    req = LLMRequest(provider="azure", model="gpt-6-luna", messages=[], base_url="https://res.openai.azure.com/openai/v1/chat/completions")
    assert not supports_native_tools(req)
    assert "tools" not in _body(req, "chat", set())
