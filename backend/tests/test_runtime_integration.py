"""Coordinator regressions with isolated projects, real tools, and a scripted model."""
from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.db.base import ProjectBase
from app.db.session import make_engine
from app.llm.router import set_provider_override
from app.models import Company, Run
from app.orchestrator.engine import ProjectRef, RunRuntime
from conftest import NativeScriptedProvider, agent, edge, events, make_company, run_messages, start_run, wait_status
from test_engineering_workflows import WorkflowProgram


async def test_staged_conflict_never_publishes_a_canonical_artifact(client, workspace):
    root = Path(workspace["path"])
    (root / "app.py").write_text("original\n", encoding="utf-8")

    def concurrent_edit(_context, _outputs):
        (root / "app.py").write_text("newer canonical edit\n", encoding="utf-8")
        return [("finish", {"summary": "Worker proposal ready"})]

    set_provider_override(NativeScriptedProvider({
        "Lead": [[("delegate", {"to": "Worker", "objective": "Update app.py"})],
                 [("finish", {"summary": "Conflict requires a new attempt"})]],
        "Worker": [[("write_file", {"path": "app.py", "content": "worker proposal\n"})], concurrent_edit],
    }))
    cid = await make_company(client, workspace, [agent("lead", "Lead", entry=True), agent("worker", "Worker")],
                             [edge("lw", "lead", "worker")])
    run = await start_run(client, workspace, cid, permission_level="danger")
    await wait_status(client, workspace, run["id"], timeout=15)
    base = f"/api/v1/w/{workspace['id']}/runs/{run['id']}"
    execution = (await client.get(f"{base}/execution")).json()
    blocked = [attempt for attempt in execution["attempts"] if attempt["state"] == "blocked"]
    assert blocked and "conflict" in blocked[0]["result"]
    assert (root / "app.py").read_text() == "newer canonical edit\n"
    assert (await client.get(f"{base}/artifacts")).json() == []
    assert not any(event["type"] == "artifact_created" for event in await events(client, workspace, run["id"]))


async def test_steering_revokes_pending_write_approval(client, workspace):
    provider = NativeScriptedProvider({"Lead": [
        [("write_file", {"path": "obsolete.txt", "content": "Old requirements"})],
        [("finish", {"summary": "Following the corrected request"})],
        [("finish", {"summary": "Following the corrected request"})],
    ]})
    set_provider_override(provider)
    cid = await make_company(client, workspace, [agent("lead", "Lead", entry=True)], [])
    run = await start_run(client, workspace, cid, permission_level="ask")
    base = f"/api/v1/w/{workspace['id']}/runs/{run['id']}"
    pending = None
    for _ in range(150):
        pending = (await client.get(base)).json()["state"].get("pending_approval")
        if pending:
            break
        await asyncio.sleep(0.02)
    assert pending and pending["details"]["path"] == "obsolete.txt"
    response = await client.post(f"{base}/requests", json={"content": "Discard that write; answer only",
        "client_request_id": "corrected-request", "delivery": "steer"})
    assert response.status_code == 202, response.text
    approval = await client.post(f"{base}/approve", json={"approval_id": pending["id"], "approved": True})
    assert approval.status_code == 404, "An invalidated approval cannot authorize the old request"
    final = await wait_status(client, workspace, run["id"], timeout=15)
    assert final["state"]["plan_revision"] == 2
    assert not (Path(workspace["path"]) / "obsolete.txt").exists()
    assert (await client.get(f"{base}/artifacts")).json() == []
    execution = (await client.get(f"{base}/execution")).json()
    assert any(attempt["state"] == "superseded" for attempt in execution["attempts"])


async def test_direct_specialist_requests_return_to_lead_for_initial_and_followup(client, workspace):
    provider = NativeScriptedProvider({
        "Lead": [[("finish", {"summary": "Lead accepts initial specialist result"})],
                 [("finish", {"summary": "Lead accepts followup specialist result"})]],
        "Worker": [[("finish", {"summary": "Initial specialist result"})],
                   [("finish", {"summary": "Followup specialist result"})]],
    })
    set_provider_override(provider)
    cid = await make_company(client, workspace, [agent("lead", "Lead", entry=True), agent("worker", "Worker")],
                             [edge("lw", "lead", "worker")])
    run = await start_run(client, workspace, cid, goal="@Worker answer the initial question", permission_level="danger")
    initial = await wait_status(client, workspace, run["id"], timeout=15)
    assert initial["summary"] == "Lead accepts initial specialist result"
    base = f"/api/v1/w/{workspace['id']}/runs/{run['id']}"
    response = await client.post(f"{base}/requests", json={"content": "@Worker answer the followup question",
        "client_request_id": "specialist-followup", "delivery": "queue"})
    assert response.status_code == 202, response.text
    for _ in range(200):
        current = (await client.get(base)).json()
        if current["summary"] == "Lead accepts followup specialist result":
            break
        await asyncio.sleep(0.02)
    assert current["summary"] == "Lead accepts followup specialist result"
    messages = await run_messages(client, workspace, run["id"])
    reports = [message for message in messages if message["type"] == "final_report"]
    assert [message["from_agent_id"] for message in reports] == ["lead", "lead"]
    returned = [message for message in messages if message.get("from_agent_id") == "worker"
                and message.get("to_agent_id") == "lead"]
    assert {message["content"] for message in returned} >= {"Initial specialist result", "Followup specialist result"}
    assert [request.metadata["turn_context"]["agent"]["name"] for request in provider.requests] == [
        "Worker", "Lead", "Worker", "Lead"]


@pytest_asyncio.fixture
async def runtime_factory(tmp_path):
    (tmp_path / ".octopus").mkdir()
    engine = make_engine(f"sqlite+aiosqlite:///{tmp_path / '.octopus' / 'project.db'}")
    async with engine.begin() as connection:
        await connection.run_sync(ProjectBase.metadata.create_all)
    sf = async_sessionmaker(engine, expire_on_commit=False)
    async with sf() as db, db.begin():
        db.add(Company(id="co", user_id="owner", name="Test"))
    def create(**budget):
        lead = agent("lead", "Lead", entry=True)
        worker = agent("worker", "Worker")
        worker.update(provider="azure", model="worker-model", behavior={"reasoning_effort": "low"})
        run = Run(id="r", company_id="co", goal="Build a feature", snapshot_json={"agents": [lead, worker]},
                  budget_json={"workflow": "off", **budget}, state_json={"plan_revision": 1})
        return RunRuntime(run, "owner", ProjectRef(workspace_id="ws", root=tmp_path, sf=sf))
    yield create
    await engine.dispose()


@pytest.mark.parametrize("scope", ["lead", "team"])
async def test_model_and_thinking_override_respect_explicit_scope(runtime_factory, scope):
    runtime = runtime_factory(model={"provider": "azure", "model": "lead-model"}, reasoning_effort="high", model_scope=scope)
    lead, worker = runtime.agents["lead"], runtime.agents["worker"]
    assert runtime.model_for(lead) == ("azure", "lead-model")
    assert runtime.effort_for(lead) == "high"
    assert runtime.model_for(worker) == ("azure", "lead-model" if scope == "team" else "worker-model")
    assert runtime.effort_for(worker) == ("high" if scope == "team" else "low")


async def test_artifact_author_cannot_record_independent_review(client, workspace):
    program = WorkflowProgram("review")
    def next_step(_context, outputs):
        return [program.next(outputs[-1] if outputs else "")]
    provider = NativeScriptedProvider({"Lead": [
        [("write_file", {"path": "app.py", "content": "VALUE = 1\n"})], *([next_step] * 6)]})
    set_provider_override(provider)
    cid = await make_company(client, workspace, [agent("lead", "Lead", entry=True)], [])
    run = await start_run(client, workspace, cid, permission_level="danger", budget={"engineering_workflow": "review"})
    final = await wait_status(client, workspace, run["id"], timeout=15)
    results = [event["payload"] for event in await events(client, workspace, run["id"], "tool_result")]
    assert any(result["tool"] == "record_checkpoint" and not result["ok"]
               and "cannot certify their own independent review" in result["output"] for result in results)
    assert final["state"]["engineering_checkpoints"] == [], "Neither independent inspection nor review can be self-certified"
    assert (Path(workspace["path"]) / "app.py").read_text() == "VALUE = 1\n"


async def test_optional_review_is_a_required_independent_workflow_step(runtime_factory):
    ordinary = runtime_factory(engineering_workflow="build", independent_review=False).workflow_contract()
    reviewed = runtime_factory(engineering_workflow="build", independent_review=True).workflow_contract()
    assert [step.key for step in ordinary.steps] == ["acceptance", "design", "implement", "verify"]
    assert [step.key for step in reviewed.steps] == ["acceptance", "design", "implement", "verify", "review"]
    assert reviewed.steps[-1].independent_owner
    assert reviewed.steps[-1].required_outputs == ("review_report",)
    assert reviewed.content_hash != ordinary.content_hash


async def test_opencode_auto_does_not_inherit_native_provider_thinking_default(runtime_factory):
    runtime = runtime_factory(model={"provider": "opencode", "model": "default"}, reasoning_effort="default")
    assert runtime.effort_for(runtime.agents["lead"]) is None
    runtime.budget.reasoning_effort = "high"
    assert runtime.effort_for(runtime.agents["lead"]) == "high", "Explicit unsupported effort must fail visibly in the adapter"


async def test_task_board_cannot_wake_peer_outside_specialist_authority(client, workspace):
    provider = NativeScriptedProvider({
        "Worker": [[("update_task_board", {"tasks": [{"title": "Unauthorized peer job", "assignee": "Other"}]})],
                   [("finish", {"summary": "Worker contribution"})]],
        "Lead": [[("finish", {"summary": "Lead accepts scoped result"})]],
    })
    set_provider_override(provider)
    cid = await make_company(client, workspace, [agent("lead", "Lead", entry=True), agent("worker", "Worker"), agent("other", "Other")], [])
    run = await start_run(client, workspace, cid, goal="@Worker Answer this request")
    await wait_status(client, workspace, run["id"], timeout=15)
    board = (await client.get(f"/api/v1/w/{workspace['id']}/runs/{run['id']}/tasks")).json()
    assert not any(item["title"] == "Unauthorized peer job" for item in board)
    assert all(request.metadata["turn_context"]["agent"]["name"] != "Other" for request in provider.requests)
