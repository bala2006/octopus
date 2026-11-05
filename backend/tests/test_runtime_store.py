from __future__ import annotations

import asyncio
from datetime import timedelta
from types import SimpleNamespace

import httpx
import pytest
import pytest_asyncio
from fastapi import FastAPI
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.db.base import ProjectBase, utcnow
from app.db.session import make_engine
from app.models import Company, Run, User
from app.models.runtime_records import Consultation, RunRequest, TaskAttempt
from app.orchestrator.contracts import Assignment, ExecutionPolicy
from app.orchestrator.runtime_store import RuntimeStore, Conflict, mutation_lock


@pytest_asyncio.fixture
async def durable(tmp_path):
    (tmp_path / ".octopus").mkdir()
    engine = make_engine(f"sqlite+aiosqlite:///{tmp_path / '.octopus' / 'project.db'}")
    async with engine.begin() as connection:
        await connection.run_sync(ProjectBase.metadata.create_all)
    sf = async_sessionmaker(engine, expire_on_commit=False)
    async with sf() as db, db.begin():
        db.add(Company(id="co", user_id="owner", name="Mine"))
        await db.flush()
        db.add(Run(id="r", company_id="co", goal="Test", snapshot_json={"agents": [
            {"id": "a", "name": "Ann", "active": True, "is_entry": True}, {"id": "b", "name": "Bob", "active": True}]},
            state_json={"plan_revision": 1}))
    yield RuntimeStore(sf, "r"), sf, tmp_path
    await engine.dispose()


def assignment(request_id=None):
    return Assignment(run_id="r", request_id=request_id, owner="a", lead="a", provider="azure", model="gpt-6-luna",
                      original_goal="Test", policy=ExecutionPolicy())


@pytest.mark.asyncio
async def test_idempotent_enqueue_claim_and_steer_priority(durable):
    store, _, _ = durable
    first, created = await store.enqueue(client_id="one", content="First", target="a", attachments=[])
    repeated, again = await store.enqueue(client_id="one", content="First", target="a", attachments=[])
    assert created and not again and repeated["id"] == first["id"]
    with pytest.raises(Conflict):
        await store.enqueue(client_id="one", content="Changed", target="a", attachments=[])
    second, _ = await store.enqueue(client_id="two", content="Correction", target="b", attachments=[])
    promoted, changed = await store.steer_request(second["id"])
    assert promoted["kind"] == "steer" and changed
    assert (await store.claim()).id == second["id"]
    with pytest.raises(Conflict):
        await store.cancel_request(second["id"])
    await store.request_state(second["id"], "applied")
    await store.cancel_request(first["id"])
    assert await store.claim() is None


@pytest.mark.asyncio
async def test_claim_is_exclusive_under_concurrency(durable):
    store, sf, _ = durable
    row, _ = await store.enqueue(client_id="one", content="First", target="a", attachments=[])
    claims = await asyncio.gather(store.claim(), RuntimeStore(sf, "r").claim())
    assert [claim.id for claim in claims if claim] == [row["id"]]


@pytest.mark.asyncio
async def test_attempt_assignment_identity_and_one_invocation_per_agent(durable):
    store, sf, _ = durable
    with pytest.raises(Conflict, match="another run"):
        await store.start_attempt(assignment().model_copy(update={"run_id": "foreign"}))
    with pytest.raises(Conflict, match="stale plan"):
        await store.start_attempt(assignment().model_copy(update={"revision": 2}))
    await store.start_attempt(assignment())
    with pytest.raises(Conflict, match="already has"):
        await RuntimeStore(sf, "r").start_attempt(assignment())


@pytest.mark.asyncio
async def test_steering_atomically_invalidates_old_attempts_and_is_idempotent(durable):
    store, sf, _ = durable
    aid = await store.start_attempt(assignment())
    cid = await store.consult("a", "b", 1, "Question")
    request, created = await store.enqueue(client_id="steer-once", content="New direction", target="a", attachments=[], kind="steer")
    assert created and request["revision"] == 2
    same, created = await RuntimeStore(sf, "r").enqueue(client_id="steer-once", content="New direction", target="a", attachments=[], kind="steer")
    assert not created and same["revision"] == 2
    async with sf() as db:
        assert (await db.get(Run, "r")).state_json["plan_revision"] == 2
        assert (await db.get(TaskAttempt, aid)).state == "superseded"
        assert (await db.get(Consultation, cid)).state == "superseded"
    queued, _ = await store.enqueue(client_id="promote-once", content="Another correction", target="a", attachments=[])
    first, changed = await store.steer_request(queued["id"])
    repeated, changed_again = await store.steer_request(queued["id"])
    assert changed and not changed_again and first["revision"] == repeated["revision"] == 3


@pytest.mark.asyncio
async def test_steering_waits_for_canonical_mutation_boundary(durable):
    store, sf, _ = durable
    entered = asyncio.Event()
    release = asyncio.Event()
    async def integrate():
        async with mutation_lock("r"):
            entered.set()
            await release.wait()
            async with sf() as db:
                assert (await db.get(Run, "r")).state_json["plan_revision"] == 1
    task = asyncio.create_task(integrate())
    await entered.wait()
    steering = asyncio.create_task(store.enqueue(client_id="blocked-steer", content="New direction", target="a", attachments=[], kind="steer"))
    await asyncio.sleep(0)
    assert not steering.done()
    release.set()
    await task
    row, _ = await steering
    assert row["revision"] == 2


@pytest.mark.asyncio
async def test_stale_runtime_save_cannot_lower_persisted_plan_revision(durable):
    from app.orchestrator.engine import ProjectRef, RunRuntime
    store, sf, root = durable
    async with sf() as db:
        saved = await db.get(Run, "r")
    runtime = RunRuntime(saved, "owner", ProjectRef(workspace_id="ws", root=root, sf=sf))
    assert runtime.plan_revision == 1
    await store.enqueue(client_id="new-generation", content="Changed requirements", target="a", attachments=[], kind="steer")
    await runtime.save()
    async with sf() as db:
        assert (await db.get(Run, "r")).state_json["plan_revision"] == 2


@pytest.mark.asyncio
async def test_recovery_does_not_replay_and_requires_acknowledgement(durable):
    store, sf, _ = durable
    row, _ = await store.enqueue(client_id="one", content="Potential side effect", target="a", attachments=[])
    await store.claim()
    aid = await store.start_attempt(assignment(row["id"]))
    assert await store.recover()
    assert not await store.recover()
    assert await store.claim() is None
    with pytest.raises(Conflict):
        await store.recover_request(row["id"], "retry", acknowledged=False)
    recovered = await store.recover_request(row["id"], "retry", acknowledged=True)
    assert recovered["state"] == "queued"
    async with sf() as db:
        assert (await db.get(TaskAttempt, aid)).state == "cancelled"
    assert (await store.claim()).id == row["id"]


@pytest.mark.asyncio
async def test_consultation_cycle_one_wait_and_expiry(durable):
    store, sf, _ = durable
    first = await store.consult("a", "b", 1, "API contract?")
    with pytest.raises(Conflict, match="outstanding"):
        await store.consult("a", "c", 1, "Another?")
    with pytest.raises(Conflict, match="cycle"):
        await store.consult("b", "a", 1, "Need your answer first")
    async with sf() as db, db.begin():
        await db.execute(update(Consultation).where(Consultation.id == first).values(deadline=utcnow() - timedelta(seconds=1)))
    assert await store.expire_consultations() == [{"id": first, "sender": "a", "recipient": "b", "state": "expired"}]
    assert await store.answer("b", "a", "Late") == []
    second = await store.consult("a", "b", 1, "Retry contract?")
    assert await store.answer("b", "a", "Contract v2") == [second]


@pytest_asyncio.fixture
async def durable_client(durable, monkeypatch):
    from app.api.v1.runs import router
    from app.channels.deps import current_user, get_pdb, project_ctx
    from app.orchestrator.engine import manager
    store, sf, root = durable
    async def notify(*_, **__):
        pass  # API persistence test must never launch a model.
    monkeypatch.setattr(manager, "notify_requests", notify, raising=False)
    app = FastAPI()
    app.include_router(router, prefix="/api/v1/w/{workspace_id}")
    async def pdb():
        async with sf() as db:
            yield db
    app.dependency_overrides[get_pdb] = pdb
    app.dependency_overrides[current_user] = lambda: User(id="owner", email="owner@test", password_hash="unused")
    app.dependency_overrides[project_ctx] = lambda: SimpleNamespace(sf=sf, root=root, workspace=SimpleNamespace(id="ws"))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        yield client


@pytest.mark.asyncio
async def test_request_api_images_have_stable_references_and_reject_conflicts(durable_client, durable):
    import base64
    url = "/api/v1/w/ws/runs/r/requests"
    body = {"content": "Inspect image", "client_request_id": "image-one", "delivery": "queue", "attachments": [
        {"kind": "image", "filename": "image.png", "data": base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"x" * 32).decode()}]}
    first = await durable_client.post(url, json=body)
    assert first.status_code == 202, first.text
    retry = await durable_client.post(url, json=body)
    assert retry.status_code == 202 and retry.json()["id"] == first.json()["id"]
    assert retry.json()["attachments"] == first.json()["attachments"]
    body["content"] = "Different prompt"
    assert (await durable_client.post(url, json=body)).status_code == 409
    body.update(content="Second image", client_request_id="image-two")
    second = (await durable_client.post(url, json=body)).json()
    assert second["attachments"][0]["name"] != first.json()["attachments"][0]["name"]
    assert len((await durable_client.get(url)).json()) == 2
    assert (await durable_client.post(url + "/" + second["id"] + "/steer")).json()["kind"] == "steer"
    assert (await durable_client.delete(url + "/" + first.json()["id"])).status_code == 204


@pytest.mark.asyncio
async def test_execution_api_reports_current_evidence_and_recovery(durable_client, durable):
    import platform
    from app.orchestrator.evidence import capture_manifest, record_evidence, VerificationCheck
    store, _, root = durable
    (root / "app.py").write_text("print('ok')", encoding="utf-8")
    aid = await store.start_attempt(assignment())
    manifest = capture_manifest(root)
    proof = record_evidence(manifest, task_revision=1,
        environment={"platform": platform.system(), "python": platform.python_version(), "root": str(root.resolve()), "execution_root": str(root.resolve())},
        criterion_ids=["requested_outcome"], check=VerificationCheck(kind="command", name="Compile", tool_call_id="call",
            command="python -m compileall app.py", exit_code=0, observed=True), status="pass", covered_paths=["app.py"], producer="a")
    await store.add_evidence(aid, 1, proof.model_dump(mode="json"))
    await store.finish_attempt(aid, 1, "completed", {})
    url = "/api/v1/w/ws/runs/r/execution"
    data = (await durable_client.get(url)).json()
    assert data["evidence"][0]["validity"]["valid"] is True
    assert all(key in data for key in ("requests", "attempts", "consultations", "engineering_checkpoints", "engineering_blockers",
                                      "lead_agent_id", "engineering_workflow", "execution_mode"))
    (root / "app.py").write_text("print('changed')", encoding="utf-8")
    assert (await durable_client.get(url)).json()["evidence"][0]["validity"]["valid"] is False
    await store.start_attempt(assignment())
    assert (await durable_client.get(url)).json()["recovery_required"] is True
    response = await durable_client.post("/api/v1/w/ws/runs/r/recovery", json={"action": "acknowledge", "acknowledge_side_effects": False})
    assert response.status_code == 422
    response = await durable_client.post("/api/v1/w/ws/runs/r/recovery", json={"action": "cancel", "acknowledge_side_effects": True})
    assert response.status_code == 200 and response.json()["recovery_required"] is False


@pytest.mark.asyncio
async def test_staged_evidence_cannot_certify_canonical_workspace(durable_client, durable):
    import platform
    from app.orchestrator.evidence import capture_manifest, record_evidence, VerificationCheck
    store, sf, root = durable
    (root / "app.py").write_text("print('ok')", encoding="utf-8")
    aid = await store.start_attempt(assignment())
    stage = root / ".octopus" / "workers" / "a"
    stage.mkdir(parents=True)
    (stage / "app.py").write_text("print('ok')", encoding="utf-8")
    proof = record_evidence(capture_manifest(stage), task_revision=1,
        environment={"platform": platform.system(), "python": platform.python_version(), "root": str(root.resolve()),
                     "execution_root": str(stage.resolve())}, criterion_ids=["requested_outcome"],
        check=VerificationCheck(kind="command", name="Compile stage", tool_call_id="stage-call", command="python -m compileall app.py",
                                exit_code=0, observed=True), status="pass", covered_paths=["app.py"], producer="a")
    await store.add_evidence(aid, 1, proof.model_dump(mode="json"))
    await store.finish_attempt(aid, 1, "completed", {})
    async with sf() as db, db.begin():
        run = await db.get(Run, "r")
        run.state_json = {**run.state_json, "lead_agent_id": "a", "engineering_workflow": "build", "execution_mode": "trusted_host"}
    result = (await durable_client.get("/api/v1/w/ws/runs/r/execution")).json()
    assert result["lead_agent_id"] == "a" and result["engineering_workflow"] == "build"
    assert not result["evidence"][0]["validity"]["valid"]
    assert "Verification environment changed" in result["evidence"][0]["validity"]["reasons"]
