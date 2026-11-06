"""Event sequences of scripted company runs. Each run goes through the HTTP API with the test fakes from tests/conftest.py.

Every event becomes one JSON line: its sequence id, run id and timestamp are replaced by placeholders numbered in order of first
appearance. Event type, payload keys and values, and the order of lines are kept as they are.
"""
from __future__ import annotations

import asyncio
import json
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx
from conftest import (
    NativeScriptedProvider,
    agent,
    edge,
    make_company,
    start_run,
    wait_status,
)

from app.capabilities.models.router import set_provider_override
from app.main import app
from scripts.golden import _harness
from scripts.golden.canon import Placeholders

PROJECTS_ROOT = _harness.harness._TMP / "projects"  # the only directory workspaces may use in the test harness
# Wall-clock measurements (usage_update.active_seconds). Their values change on every run, so they become "<duration>".
VOLATILE_KEYS = frozenset({"active_seconds"})
# execution.py builds the policy capabilities from a frozenset, so the list order follows the process hash seed. The set is the
# contract, so the golden keeps the members and sorts them.
UNORDERED_KEYS = frozenset({"capabilities"})


@dataclass
class Scenario:
    name: str
    agents: list[dict[str, Any]]
    edges: list[dict[str, Any]]
    goal: str
    permission: str  # "auto" or "ask": the global approval mode for the run
    provider: NativeScriptedProvider
    approve_first: bool = False  # answer the one approval card the run raises
    must_contain: tuple[str, ...] = ()  # event types the golden must include, so the scenario stays meaningful


def scenarios() -> list[Scenario]:
    delegate = Scenario(
        name="delegate_native_auto",
        agents=[agent("lead", "Ava", entry=True, role="CEO"), agent("dev", "Sam", role="Software Engineer")],
        edges=[edge("e-1", "lead", "dev", "delegate"), edge("e-2", "dev", "lead", "report")],
        goal="Create hello.py that prints hello",
        permission="auto",
        provider=NativeScriptedProvider({
            "Ava": [[("delegate", {"to": "Sam", "objective": "Write hello.py that prints hello", "deliverable": "hello.py",
                                   "done_when": "hello.py exists and prints hello", "context": "Keep it to one file."})],
                    [("finish", {"summary": "hello.py delivered by Sam"})]],
            "Sam": [[("write_file", {"path": "hello.py", "content": "print('hello')\n", "note": "greeting script"})],
                    [("finish", {"summary": "Wrote hello.py"})]],
        }),
        must_contain=("tool_call", "tool_result", "artifact_updated", "agent_finished", "message_created"),
    )
    approval = Scenario(
        name="approval_ask_native",
        agents=[agent("wes", "Wes", entry=True, role="Engineer")],
        edges=[],
        goal="Write notes.md",
        permission="ask",
        provider=NativeScriptedProvider({
            "Wes": [[("write_file", {"path": "notes.md", "content": "# Notes\n", "note": "first notes"})],
                    [("finish", {"summary": "notes.md written"})]],
        }),
        approve_first=True,
        must_contain=("approval_requested", "approval_resolved"),
    )
    return [delegate, approval]


async def _workspace(client: httpx.AsyncClient, path: Path) -> dict[str, Any]:
    path.mkdir(parents=True, exist_ok=True)
    r = await client.post("/api/v1/workspaces", json={"path": str(path)})
    assert r.status_code == 201, r.text
    return r.json()


async def _approve_first(client: httpx.AsyncClient, ws: dict[str, Any], run_id: str) -> None:
    base = f"/api/v1/w/{ws['id']}/runs/{run_id}"
    await wait_status(client, ws, run_id, {"awaiting_user"})
    pending = None
    for _ in range(200):
        pending = (await client.get(base)).json()["state"].get("pending_approval")
        if pending:
            break
        await asyncio.sleep(0.02)
    assert pending, "the run never asked for approval"
    r = await client.post(f"{base}/approve", json={"approval_id": pending["id"], "approved": True})
    assert r.status_code == 202, r.text


async def _run_events(client: httpx.AsyncClient, scenario: Scenario, project: Path) -> list[dict[str, Any]]:
    ws = await _workspace(client, project)
    company_id = await make_company(client, ws, scenario.agents, scenario.edges)
    set_provider_override(scenario.provider)
    try:
        run = await start_run(client, ws, company_id, goal=scenario.goal, permission_level=scenario.permission)
        if scenario.approve_first:
            await _approve_first(client, ws, run["id"])
        done = await wait_status(client, ws, run["id"], timeout=60)
        assert done["status"] == "completed", f"{scenario.name}: {done['status']} {done['halt_reason']}"
        events = (await client.get(f"/api/v1/w/{ws['id']}/runs/{run['id']}/events")).json()
    finally:
        set_provider_override(None)
    kinds = {e["type"] for e in events}
    missing = set(scenario.must_contain) - kinds
    assert not missing, f"{scenario.name} did not produce {sorted(missing)}"
    return events


def _lines(events: list[dict[str, Any]], roots: dict[str, str]) -> str:
    placeholders = Placeholders(number_times=False)
    out = []
    for e in events:
        record = {"id": placeholders.name("seq", str(e["id"])), "run_id": e["run_id"], "type": e["type"], "payload": e["payload"],
                  "created_at": e["created_at"]}
        out.append(json.dumps(placeholders.scrub(record, roots, VOLATILE_KEYS, UNORDERED_KEYS), sort_keys=True, ensure_ascii=False))
    return "".join(line + "\n" for line in out)


async def run_texts() -> dict[str, str]:
    """File name (runs/<scenario>.jsonl) -> JSON lines text."""
    PROJECTS_ROOT.mkdir(parents=True, exist_ok=True)
    texts: dict[str, str] = {}
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        for scenario in scenarios():
            project = Path(tempfile.mkdtemp(prefix=f"golden-{scenario.name}-", dir=PROJECTS_ROOT))
            events = await _run_events(client, scenario, project)
            roots = {str(project): "<project>", str(_harness.harness._TMP): "<tmp>"}
            texts[f"runs/{scenario.name}.jsonl"] = _lines(events, roots)
    return texts
