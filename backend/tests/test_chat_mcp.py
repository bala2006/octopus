"""Direct chat streaming/tooling/persistence and real MCP (stdio) tool calls from agents."""
from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

from app.core.deps import get_or_create_single_user
from app.db.session import registry_factory
from app.llm.router import set_provider_override
from app.services.chat import ChatConnection
from conftest import ScriptedProvider, agent, env, events, make_company, start_run, wait_status

MCP_SERVER = '''
from mcp.server.fastmcp import FastMCP
mcp = FastMCP("calc")

@mcp.tool()
def add(a: int, b: int) -> str:
    """Add two integers."""
    return str(a + b)

if __name__ == "__main__":
    mcp.run()
'''


class FakeWS:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, data: dict[str, Any]) -> None:
        self.sent.append(data)


async def test_direct_chat_stream_tool_and_regenerate(client, workspace) -> None:
    set_provider_override(None)
    cid = await make_company(client, workspace, [agent("a1", "Ava", role="CEO")], [])
    base = f"/api/v1/w/{workspace['id']}"
    s = (await client.post(f"{base}/sessions", json={"company_id": cid, "mode": "direct", "agent_id": "a1"})).json()
    from app.core.deps import load_project

    async with registry_factory()() as rdb:
        user = await get_or_create_single_user(rdb)
        ctx = await load_project(workspace["id"], user, rdb)
    ws = FakeWS()
    conn = ChatConnection(ws, s["id"], user.id, ctx.sf)  # type: ignore[arg-type]
    await conn.handle({"type": "user_message", "content": "Please calculate 12*7"})
    await conn.task
    kinds = [m["type"] for m in ws.sent]
    assert kinds[0] == "message_created" and "stream_start" in kinds and "token_stream" in kinds
    assert "tool_call" in kinds and kinds[-1] == "stream_end"
    final = ws.sent[-1]["data"]["message"]
    assert "84" in final["content"] and final["meta"]["tool_calls"][0]["result"] == "84"
    phases = [m["data"]["phase"] for m in ws.sent if m["type"] == "status"]
    assert phases[:2] == ["thinking", "writing"] and "tool" in phases

    ws.sent.clear()
    await conn.handle({"type": "regenerate"})
    await conn.task
    assert any(m["type"] == "message_deleted" for m in ws.sent) and ws.sent[-1]["type"] == "stream_end"
    msgs = (await client.get(f"{base}/sessions/{s['id']}/messages")).json()
    assert [m["sender"] for m in msgs] == ["user", "agent"]
    md = await client.get(f"{base}/sessions/{s['id']}/export", params={"format": "md"})
    assert "calculate 12*7" in md.text
    renamed = (await client.get(f"{base}/sessions", params={"company_id": cid})).json()[0]["title"]
    assert renamed.startswith("Please calculate")


async def test_agent_calls_stdio_mcp_tool(client, workspace, tmp_path: Path) -> None:
    script = tmp_path / "calc_server.py"
    script.write_text(MCP_SERVER)
    r = await client.post("/api/v1/mcp-servers", json={"name": f"calc{tmp_path.name[-4:]}", "transport": "stdio",
                                                       "command": sys.executable, "args": [str(script)]})
    assert r.status_code == 201, r.text
    srv = r.json()
    assert srv["last_error"] == "" and [t["name"] for t in srv["tools"]] == ["add"]
    cid = await make_company(client, workspace, [agent("m", "Max", entry=True, tools={"mcp_servers": [srv["id"]]})], [])
    set_provider_override(ScriptedProvider({"Max": [
        env({"action": "mcp_call", "server": srv["name"], "tool": "add", "arguments": {"a": 2, "b": 40}}),
        env({"action": "finish", "summary": "added"})]}))
    run = await start_run(client, workspace, cid, permission_level="danger")
    done = await wait_status(client, workspace, run["id"], timeout=60)
    assert done["status"] == "completed"
    res = [e["payload"] for e in await events(client, workspace, run["id"], "tool_result") if e["payload"]["tool"] == "mcp_call"]
    assert res and res[0]["ok"] and res[0]["output"].strip() == "42"


async def test_mcp_not_granted_is_denied(client, workspace) -> None:
    cid = await make_company(client, workspace, [agent("m", "Max", entry=True)], [])
    set_provider_override(ScriptedProvider({"Max": [
        env({"action": "mcp_call", "server": "anything", "tool": "x", "arguments": {}}), env({"action": "finish", "summary": "x"})]}))
    run = await start_run(client, workspace, cid, permission_level="danger")
    await wait_status(client, workspace, run["id"])
    res = [e["payload"] for e in await events(client, workspace, run["id"], "tool_result") if e["payload"]["tool"] == "mcp_call"]
    assert res and not res[0]["ok"] and "not granted" in res[0]["output"]
