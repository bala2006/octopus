"""Delivery and replay guarantees at the actual API/coordinator boundary."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

from sqlalchemy import func, select

from app.channels.ws.endpoints import handle_client
from app.channels.deps import get_or_create_single_user, load_project
from app.storage.session import registry_factory
from app.plugins.providers.router import set_provider_override
from app.storage.models import Run, User
from app.storage.models.runtime_records import RunRequest, TaskAttempt
from app.kernel.runtime.engine import ProjectRef
from conftest import NativeScriptedProvider, agent, events, make_company, start_run, wait_status


async def project_context(workspace):
    async with registry_factory()() as registry:
        user = await get_or_create_single_user(registry)
        return await load_project(workspace["id"], user, registry)


async def test_concurrent_initial_retries_create_one_run_and_one_model_attempt(client, workspace):
    provider = NativeScriptedProvider({"Lead": [[("finish", {"summary": "One execution"})]]})
    set_provider_override(provider)
    cid = await make_company(client, workspace, [agent("lead", "Lead", entry=True)], [])
    payload = {"company_id": cid, "goal": "Answer once", "permission_level": "danger",
               "client_request_id": "initial-once", "budget": {"workflow": "off", "verify_before_finish": False}}
    url = f"/api/v1/w/{workspace['id']}/runs"
    first, retry = await asyncio.gather(client.post(url, json=payload), client.post(url, json=payload))
    assert first.status_code == retry.status_code == 201, (first.text, retry.text)
    assert first.json()["id"] == retry.json()["id"]
    final = await wait_status(client, workspace, first.json()["id"], timeout=15)
    assert final["status"] == "completed" and final["summary"] == "One execution"
    changed = await client.post(url, json={**payload, "goal": "Different content with reused ID"})
    assert changed.status_code == 409
    ctx = await project_context(workspace)
    async with ctx.sf() as db:
        assert await db.scalar(select(func.count()).select_from(Run).where(Run.company_id == cid)) == 1
        assert await db.scalar(select(func.count()).select_from(TaskAttempt).where(TaskAttempt.run_id == final["id"])) == 1
    assert len(provider.requests) == 1, "A transport retry must not invoke the model again"


async def test_websocket_messages_use_authenticated_owner_and_shared_durable_queue(client, workspace):
    provider = NativeScriptedProvider({"Lead": [[("finish", {"summary": "Initial"})],
                                               [("finish", {"summary": "Delivered once"})]]})
    set_provider_override(provider)
    cid = await make_company(client, workspace, [agent("lead", "Lead", entry=True)], [])
    run = await start_run(client, workspace, cid, permission_level="danger")
    await wait_status(client, workspace, run["id"], timeout=15)
    ctx = await project_context(workspace)
    project = ProjectRef(workspace_id=workspace["id"], root=ctx.root, sf=ctx.sf)
    message = {"type": "user_message", "content": "Follow up once", "client_request_id": "ws-once"}
    await handle_client(message, run["id"], project)
    foreign = User(id="not-the-owner", email="foreign@example.test", password_hash="unused")
    await handle_client(message, run["id"], project, user=foreign, ctx=ctx)
    async with ctx.sf() as db:
        assert await db.scalar(select(func.count()).select_from(RunRequest).where(RunRequest.run_id == run["id"])) == 0
    failures = [event["payload"]["message"] for event in await events(client, workspace, run["id"], "error")]
    assert any("authenticated project connection" in failure for failure in failures)
    assert any("Company not found" in failure for failure in failures)
    await handle_client(message, run["id"], project, user=ctx.user, ctx=ctx)
    base = f"/api/v1/w/{workspace['id']}/runs/{run['id']}"
    retry = await client.post(f"{base}/requests", json={"content": message["content"],
        "client_request_id": message["client_request_id"], "delivery": "queue"})
    assert retry.status_code == 202, retry.text
    for _ in range(200):
        final = (await client.get(base)).json()
        if final["summary"] == "Delivered once":
            break
        await asyncio.sleep(0.02)
    assert final["summary"] == "Delivered once"
    async with ctx.sf() as db:
        rows = (await db.scalars(select(RunRequest).where(RunRequest.run_id == run["id"]))).all()
    assert len(rows) == 1 and rows[0].client_id == "ws-once" and rows[0].state == "applied"
    assert len(provider.requests) == 2, "REST and WebSocket retries share one durable request"


async def test_tool_result_replay_redacts_recognizable_credentials(client, workspace):
    credentials = ("private-fixture-password", "private-fixture-api-key", "private-fixture-bearer")
    root = Path(workspace["path"])
    (root / "audit.py").write_text(
        "print('password: private-fixture-password')\n"
        "print('API_KEY=private-fixture-api-key')\n"
        "print('Authorization: Bearer private-fixture-bearer')\n"
        "print('public diagnostic remains visible')\n", encoding="utf-8")
    set_provider_override(NativeScriptedProvider({"Lead": [
        [("run_code", {"command": "python audit.py"})], [("finish", {"summary": "Audited output"})]]}))
    cid = await make_company(client, workspace, [agent("lead", "Lead", entry=True)], [])
    run = await start_run(client, workspace, cid, permission_level="danger")
    await wait_status(client, workspace, run["id"], timeout=15)
    results = await events(client, workspace, run["id"], "tool_result")
    command_results = [event["payload"] for event in results if event["payload"]["tool"] == "run_code"]
    assert len(command_results) == 1 and command_results[0]["ok"]
    assert "public diagnostic remains visible" in command_results[0]["output"]
    assert "[REDACTED]" in command_results[0]["output"]
    persisted_replay = json.dumps(results)
    assert all(credential not in persisted_replay for credential in credentials)
