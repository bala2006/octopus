"""Test fixtures: isolated Octopus home + allowed project root, ASGI client, scripted LLM provider."""
from __future__ import annotations

import asyncio
import json
import os
import tempfile
from collections import defaultdict
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

_TMP = Path(tempfile.mkdtemp(prefix="octopus-test-"))
os.environ.update({
    "OCTOPUS_HOME": str(_TMP / "home"),
    "WORKSPACE_ALLOWED_ROOTS": json.dumps([str(_TMP / "projects")]),
    "MOCK_STREAM_DELAY": "0",
    "DEMO_MODE": "true",
    "SINGLE_USER_MODE": "true",
    "RATE_LIMIT_PER_MINUTE": "100000",
    "SANDBOX_TIMEOUT_S": "60",
})
(_TMP / "projects").mkdir(parents=True, exist_ok=True)

import httpx  # noqa: E402
import pytest  # noqa: E402
import pytest_asyncio  # noqa: E402

from app.core.config import get_settings  # noqa: E402
from app.db.migrate import upgrade_registry  # noqa: E402
from app.llm.base import LLMChunk, LLMRequest, Usage  # noqa: E402
from app.llm.router import set_provider_override  # noqa: E402
from app.main import app  # noqa: E402

upgrade_registry(get_settings().registry_database_url)

TERMINAL = {"completed", "failed", "cancelled"}


class ScriptedProvider:
    """Returns queued JSON envelopes per agent name; falls back to `wait` (or a fixed reply)."""

    name = "scripted"

    def __init__(self, scripts: dict[str, list[Any]] | None = None, default: Any = None, tokens: int = 50) -> None:
        self.scripts: dict[str, list[Any]] = defaultdict(list, {k: list(v) for k, v in (scripts or {}).items()})
        self.default = default if default is not None else {"thought": "", "actions": [{"action": "wait"}]}
        self.tokens = tokens
        self.calls: list[str] = []

    async def stream(self, req: LLMRequest) -> AsyncIterator[LLMChunk]:
        ctx = req.metadata.get("mock_context")
        if ctx is None:  # condition judge / chat
            yield LLMChunk(delta=req.metadata.get("mock_script", "YES"))
            yield LLMChunk(usage=Usage(1, 1, 0.0))
            return
        name = ctx["agent"]["name"]
        self.calls.append(name)
        queue = self.scripts[name]
        item = queue.pop(0) if queue else self.default
        if callable(item):
            item = item(ctx)
        text = item if isinstance(item, str) else json.dumps(item)
        yield LLMChunk(delta=text)
        yield LLMChunk(usage=Usage(self.tokens, self.tokens, 0.001))


def env(*actions: dict[str, Any]) -> dict[str, Any]:
    return {"thought": "scripted", "actions": list(actions)}


def msg(to: str, type_: str, content: str, **kw: Any) -> dict[str, Any]:
    return {"action": "send_message", "to": to, "type": type_, "content": content, **kw}


@pytest.fixture
def tmp_root() -> Path:
    return _TMP / "projects"


@pytest_asyncio.fixture
async def client() -> AsyncIterator[httpx.AsyncClient]:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c
    set_provider_override(None)


@pytest_asyncio.fixture
async def workspace(client: httpx.AsyncClient, tmp_root: Path, request: pytest.FixtureRequest) -> dict[str, Any]:
    d = tmp_root / f"proj-{request.node.name[:40]}-{os.urandom(3).hex()}"
    d.mkdir()
    r = await client.post("/api/v1/workspaces", json={"path": str(d), "default_permission": "danger"})
    assert r.status_code == 201, r.text
    return r.json()


def agent(aid: str, name: str, *, entry: bool = False, tools: dict[str, Any] | None = None, **kw: Any) -> dict[str, Any]:
    return {"id": aid, "name": name, "role": kw.pop("role", "Engineer"), "provider": "mock", "model": "mock/demo", "is_entry": entry,
            "tools": {"terminal": True, **(tools or {})}, "behavior": {"max_autonomous_turns": kw.pop("max_auto", 30)}, **kw}


def edge(eid: str, src: str, dst: str, type_: str = "delegate", bidirectional: bool = False, **cfg: Any) -> dict[str, Any]:
    return {"id": eid, "source_agent_id": src, "target_agent_id": dst, "type": type_, "bidirectional": bidirectional,
            "config": {"max_turns": 20, "max_rounds": 4, "max_revisions": 3, **cfg}}


async def make_company(client: httpx.AsyncClient, ws: dict[str, Any], agents: list[dict[str, Any]], edges: list[dict[str, Any]]) -> str:
    base = f"/api/v1/w/{ws['id']}"
    r = await client.post(f"{base}/companies", json={"name": "Test Co"})
    assert r.status_code == 201, r.text
    cid = r.json()["company"]["id"]
    r = await client.put(f"{base}/companies/{cid}/canvas", json={"agents": agents, "edges": edges})
    assert r.status_code == 200, r.text
    return cid


async def start_run(client: httpx.AsyncClient, ws: dict[str, Any], company_id: str, goal: str = "Do the thing", **kw: Any) -> dict[str, Any]:
    r = await client.post(f"/api/v1/w/{ws['id']}/runs", json={"company_id": company_id, "goal": goal, **kw})
    assert r.status_code == 201, r.text
    return r.json()


async def wait_status(client: httpx.AsyncClient, ws: dict[str, Any], run_id: str, statuses: set[str] = TERMINAL,
                      timeout: float = 60) -> dict[str, Any]:
    loop = asyncio.get_running_loop()
    end = loop.time() + timeout
    while loop.time() < end:
        r = await client.get(f"/api/v1/w/{ws['id']}/runs/{run_id}")
        data = r.json()
        if data["status"] in statuses:
            return data
        await asyncio.sleep(0.05)
    raise AssertionError(f"run {run_id} did not reach {statuses}; last={data['status']}")


async def events(client: httpx.AsyncClient, ws: dict[str, Any], run_id: str, type_: str | None = None) -> list[dict[str, Any]]:
    r = await client.get(f"/api/v1/w/{ws['id']}/runs/{run_id}/events")
    evs = r.json()
    return [e for e in evs if type_ is None or e["type"] == type_]


async def run_messages(client: httpx.AsyncClient, ws: dict[str, Any], run_id: str) -> list[dict[str, Any]]:
    return (await client.get(f"/api/v1/w/{ws['id']}/runs/{run_id}/messages")).json()
