"""Behavior regressions for inspection provenance, recovery, and chat memory ACLs."""
from __future__ import annotations

import asyncio
import io
import zipfile
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.storage.base import ProjectBase
from app.storage.session import make_engine
from app.storage.models import Agent, Artifact, Company, Run, RunEvent
from app.sdk import actions as A
from app.plugins.providers import opencode_turn as adapter
from app.sdk.contracts import Assignment, ExecutionPolicy
from app.kernel.run_manager import ProjectRef
from app.kernel.runtime.engine import RunRuntime
from app.kernel.current import current
from app.sdk.execution_contracts import ACTIVE_ATTEMPT, AttemptContext
from app.plugins.providers import opencode
from app.plugins.memory.scoped import Actor, MemoryDenied, Target, get, owner_put, put
from conftest import agent, make_company, start_run, wait_status


@pytest_asyncio.fixture
async def inspection_runtime(tmp_path):
    (tmp_path / ".octopus").mkdir()
    engine = make_engine(f"sqlite+aiosqlite:///{tmp_path / '.octopus' / 'project.db'}")
    async with engine.begin() as connection:
        await connection.run_sync(ProjectBase.metadata.create_all)
    sf = async_sessionmaker(engine, expire_on_commit=False)
    nodes = [agent("lead", "Lead", entry=True), agent("reviewer", "Reviewer")]
    async with sf() as db, db.begin():
        db.add(Company(id="co", user_id="owner", name="Company"))
        await db.flush()
        db.add_all([Agent(id=node["id"], company_id="co", name=node["name"]) for node in nodes])
        db.add(Agent(id="outsider", company_id="co", name="Not assigned to this chat"))
        row = Run(id="run", company_id="co", goal="Review app.py", permission_level="auto",
                  snapshot_json={"agents": nodes}, budget_json={"workflow": "off", "engineering_workflow": "review",
                  "verify_before_finish": True, "independent_review": False}, state_json={"plan_revision": 1})
        db.add(row)
    runtime = RunRuntime(row, "owner", ProjectRef(workspace_id="ws", root=tmp_path, sf=sf))
    (tmp_path / "app.py").write_bytes(b"VALUE = 1\n")
    try:
        yield runtime
    finally:
        await engine.dispose()


async def execute(runtime, owner, action):
    assignment = Assignment(run_id=runtime.run_id, owner=owner, lead="lead", provider="azure", model="gpt-6-luna",
                            original_goal=runtime.goal, workflow="review",
                            policy=ExecutionPolicy(capabilities=frozenset({"file_read", "terminal"})))
    attempt_id = await runtime.runtime_store.start_attempt(assignment)
    token = ACTIVE_ATTEMPT.set(AttemptContext(attempt_id, assignment))
    try:
        await runtime.execute(runtime.agents[owner], action)
    finally:
        ACTIVE_ATTEMPT.reset(token)
        await runtime.runtime_store.finish_attempt(attempt_id, 1, "completed", {})


@pytest.mark.parametrize("invalid_source", ["stale", "other_owner"])
async def test_inspection_requires_current_source_read_by_checkpoint_owner(inspection_runtime, invalid_source):
    runtime = inspection_runtime
    reader = "lead" if invalid_source == "other_owner" else "reviewer"
    await execute(runtime, reader, A.ReadFile(action="read_file", path="app.py"))
    read_id = next(cid for cid, record in runtime.observed_checks.items() if record["tool"] == "read_file")
    if invalid_source == "stale":
        (runtime.root / "app.py").write_text("VALUE = 2\n", encoding="utf-8")
    await execute(runtime, "reviewer", A.RecordCheckpoint(action="record_checkpoint", step="inspect",
                  outputs={"source_references": "app.py:1"}, tool_call_ids=[read_id]))
    assert runtime.plan_revision == 1, "A same-revision source edit must invalidate the inspection"
    assert runtime.engineering_checkpoints == []
    async with runtime.db() as db:
        results = (await db.scalars(select(RunEvent).where(RunEvent.run_id == runtime.run_id,
                                                         RunEvent.type == "tool_result"))).all()
    rejected = [event.payload_json for event in results if event.payload_json["tool"] == "record_checkpoint"]
    assert len(rejected) == 1
    assert rejected[0]["ok"] is False
    assert "this agent's current source inspection" in rejected[0]["output"]

    await execute(runtime, "reviewer", A.ReadFile(action="read_file", path="app.py"))
    current_id = next(cid for cid in reversed(runtime.observed_checks)
                      if runtime.observed_checks[cid]["tool"] == "read_file")
    await execute(runtime, "reviewer", A.RecordCheckpoint(action="record_checkpoint", step="inspect",
                  outputs={"source_references": "app.py:1 inspected directly"}, tool_call_ids=[current_id]))
    assert len(runtime.engineering_checkpoints) == 1
    assert runtime.engineering_checkpoints[0]["owner"] == "reviewer"
    assert runtime.engineering_checkpoints[0]["tool_call_ids"] == [current_id]


async def test_chat_memory_rejects_active_company_agent_outside_run_snapshot(inspection_runtime):
    runtime = inspection_runtime
    owner = Actor("owner", "co")
    record = await owner_put(runtime.sf, owner, Target("chat", "run"), "constraint", "Private chat constraint",
                             expected_version=0)
    assigned = Actor("owner", "co", "reviewer")
    outsider = Actor("owner", "co", "outsider")
    assert (await get(runtime.sf, assigned, record.id)).content == "Private chat constraint"
    with pytest.raises(MemoryDenied, match="not shared"):
        await get(runtime.sf, outsider, record.id)
    with pytest.raises(MemoryDenied, match="not shared"):
        await put(runtime.sf, outsider, Target("chat", "run"), "injected", "Unassigned agent's note", expected_version=0)


@pytest.mark.parametrize("deletion", [False, True])
async def test_stage_terminal_results_publish_canonical_content_and_original_history(inspection_runtime, monkeypatch, deletion):
    from app.channels.api.routes import runs
    runtime = inspection_runtime
    if deletion:
        program = "from pathlib import Path\nPath('app.py').unlink()\n"
    else:
        program = "from pathlib import Path\nPath('app.py').write_bytes(b'VALUE = 3\\n')\n"
    (runtime.root / "mutate.py").write_text(program, encoding="utf-8")
    async def turn(aid):
        worker = runtime.agents[aid]
        if not deletion:
            await runtime.execute(worker, A.WriteFile(action="write_file", path="app.py", content="VALUE = 2\n"))
        await runtime.execute(worker, A.RunCode(action="run_code", command="python mutate.py"))
    monkeypatch.setattr(runtime, "_turn", turn)
    await runtime.execution.owned_turn("reviewer")
    async with runtime.db() as db:
        versions = (await db.scalars(select(Artifact).where(Artifact.run_id == "run", Artifact.path == "app.py")
                                    .order_by(Artifact.version))).all()
        assert len(versions) == 1
        assert versions[0].previous_content == "VALUE = 1\n"
        assert versions[0].content == ("" if deletion else "VALUE = 3\n")
        assert versions[0].deleted is deletion
        from app.plugins.observers.report import build_report
        report = await build_report("run", runtime.sf)
        assert ("| deleted |" in report) is deletion
        user = SimpleNamespace(id="owner")
        original = await runs.get_artifact("run", "app.py", version=0, db=db, user=user)
        assert original.content == "VALUE = 1\n" and not original.deleted
        latest = await runs.get_artifact("run", "app.py", db=db, user=user)
        assert latest.deleted is deletion
        archive = await runs.download_zip("run", db=db, user=user, ctx=SimpleNamespace(sf=runtime.sf))
        with zipfile.ZipFile(io.BytesIO(archive.body)) as zipped:
            assert ("app.py" in zipped.namelist()) is not deletion
            if not deletion:
                assert zipped.read("app.py") == b"VALUE = 3\n"
        reverted = await runs.revert_artifact("run", runs.RevertIn(path="app.py", to_version=0), db=db,
                                             user=user, ctx=SimpleNamespace(root=runtime.root))
        assert reverted["status"] == "restored"
        assert (runtime.root / "app.py").read_text() == "VALUE = 1\n"
        if deletion:
            reverted = await runs.revert_artifact("run", runs.RevertIn(path="app.py", to_version=1), db=db,
                                                 user=user, ctx=SimpleNamespace(root=runtime.root))
            assert reverted["status"] == "deleted"
            assert not (runtime.root / "app.py").exists()


async def test_post_integration_command_can_verify_deleted_file_absence(inspection_runtime, monkeypatch):
    runtime = inspection_runtime
    (runtime.root / "remove.py").write_text("from pathlib import Path\nPath('app.py').unlink()\n", encoding="utf-8")
    (runtime.root / "test_absence.py").write_text(
        "import unittest\nfrom pathlib import Path\nclass Absence(unittest.TestCase):\n"
        "    def test_deleted(self):\n        self.assertFalse(Path('app.py').exists())\n", encoding="utf-8")
    async def turn(aid):
        await runtime.execute(runtime.agents[aid], A.RunCode(action="run_code", command="python remove.py"))
    monkeypatch.setattr(runtime, "_turn", turn)
    await runtime.execution.owned_turn("reviewer")
    assert "app.py" in runtime.unverified
    await execute(runtime, "lead", A.RunCode(action="run_code", command="python -m unittest test_absence",
                  covered_paths=["app.py", "test_absence.py"], criterion_ids=["requested_outcome"]))
    assert "app.py" not in runtime.unverified
    proof = runtime.execution_records[-1]
    assert proof["status"] == "pass"
    deleted = next(path for path in proof["coverage"] if path["path"] == "app.py")
    assert deleted["exists"] is False and deleted["sha256"] is None


class RecoverySession:
    """Fake ACP transport; successful prompts use the real authenticated MCP broker."""
    instances = []

    def __init__(self, root, update, permission):
        self.update = update
        self.cancelled = asyncio.Event()
        self.session_id = ""
        self.previous = None
        self.instances.append(self)
        self.index = len(self.instances)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        pass

    async def open(self, previous, model, effort, plan, *, mcp_servers=None, agent=None):
        self.previous = previous
        self.session_id = previous or f"fresh-session-{self.index}"
        self.server = mcp_servers[0]

    async def send(self, message):
        if message.get("method") == "session/cancel":
            self.cancelled.set()

    async def prompt(self, blocks):
        if self.index == 2:
            return {"stopReason": "cancelled"}
        headers = {item["name"]: item["value"] for item in self.server["headers"]}
        async with httpx.AsyncClient() as broker:
            response = await broker.post(self.server["url"], headers=headers,
                json={"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                      "params": {"name": "finish", "arguments": {"summary": f"Accepted result {self.index}"}}})
            assert response.status_code == 200, response.text
            assert not response.json()["result"]["isError"], response.text
        await asyncio.wait_for(self.cancelled.wait(), 3)
        return {"stopReason": "cancelled"}


async def test_acknowledged_request_retry_resumes_and_starts_fresh_opencode_session(client, workspace, monkeypatch):
    RecoverySession.instances = []
    monkeypatch.setattr(adapter, "OpenCodeSession", RecoverySession)
    async def discover():
        return opencode.OpenCodeStatus(available=True, executable="scripted-no-model", models=["test/model"])
    monkeypatch.setattr(opencode, "discover", discover)
    lead = agent("lead", "Lead", entry=True)
    lead.update(provider="opencode", model="test/model")
    company_id = await make_company(client, workspace, [lead], [])
    run = await start_run(client, workspace, company_id, permission_level="danger")
    initial = await wait_status(client, workspace, run["id"], timeout=15)
    assert initial["status"] == "completed", initial
    base = f"/api/v1/w/{workspace['id']}/runs/{run['id']}"
    queued = await client.post(f"{base}/requests", json={"content": "Continue the request",
                               "client_request_id": "ambiguous-followup", "delivery": "queue"})
    assert queued.status_code == 202, queued.text
    request_id = queued.json()["id"]
    paused = await wait_status(client, workspace, run["id"], statuses={"paused"}, timeout=15)
    assert paused["state"]["recovery_required"]
    runtime = current().runs.get(run["id"])
    assert runtime.paused
    old_session = runtime.worker_sessions["lead"]["session_id"]
    for _ in range(150):
        execution = (await client.get(f"{base}/execution")).json()
        if any(request["id"] == request_id and request["state"] == "recovery_required" for request in execution["requests"]):
            break
        await asyncio.sleep(.02)
    else:
        pytest.fail(f"Interrupted request was not quarantined: {execution}")
    retried = await client.post(f"{base}/requests/{request_id}/recover",
                                json={"action": "retry", "acknowledge_side_effects": True})
    assert retried.status_code == 200, retried.text
    completed = await wait_status(client, workspace, run["id"], timeout=15)
    assert completed["status"] == "completed"
    assert completed["summary"] == "Accepted result 3"
    assert len(RecoverySession.instances) == 3, "Explicit retry starts exactly one new invocation"
    assert RecoverySession.instances[2].previous is None, "An uncertain session must never be resumed"
    assert not runtime.paused and not runtime.recovery_required
    assert runtime.worker_sessions["lead"]["session_id"] != old_session
    assert runtime.worker_sessions["lead"]["state"] == "ready"
    assert runtime.worker_session_history[-1]["session_id"] == old_session
    assert runtime.worker_session_history[-1]["recovery_action"] == "retry"
    execution = (await client.get(f"{base}/execution")).json()
    assert next(request for request in execution["requests"] if request["id"] == request_id)["state"] == "applied"
    assert any(attempt["state"] == "cancelled" and attempt["result"].get("recovery_acknowledged")
               for attempt in execution["attempts"])
