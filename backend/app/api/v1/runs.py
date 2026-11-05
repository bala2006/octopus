from __future__ import annotations

import asyncio
import hashlib
import json
import platform
from typing import Any, Literal
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import Response
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from pydantic import BaseModel, ConfigDict

from app.channels.deps import ProjectCtx, current_user, get_pdb, owned_company, project_ctx
from app.models import Artifact, ChatSession, Message, Run, RunEvent, Task, User, Company
from app.orchestrator.engine import ACTIVE_STATES, OPEN_TASK_STATES, ProjectRef, RunRuntime, manager
from app.schemas import (
    ApprovalIn, ArtifactContentOut, ArtifactOut, InterjectIn, MessageOut, RevertIn, RunCreate, RunDetail, RunEventOut, RunOut,
    RunOutcome, TaskOut,
)
from app.orchestrator.permissions import normalize_mode
from app.services import run_attachments
from app.workflows.canvas import snapshot
from app.capabilities.workspace.project_fs import ProjectFS, WorkspaceError
from app.orchestrator.runtime_store import RuntimeStore, Conflict
from app.orchestrator.contracts import choose_lead, route_target
from app.orchestrator.evidence import capture_manifest, validate_evidence, RevisionEvidence

router = APIRouter(prefix="/runs", tags=["runs"])


def ref(ctx: ProjectCtx) -> ProjectRef:
    return ProjectRef(workspace_id=ctx.workspace.id, root=ctx.root, sf=ctx.sf)


async def owned_run(run_id: str, db: AsyncSession, user: User) -> Run:
    run = await db.get(Run, run_id)
    if run is None:
        raise HTTPException(404, "Run not found")
    await owned_company(run.company_id, db, user)
    return run


@router.post("", response_model=RunDetail, status_code=201)
async def create_run(body: RunCreate, db: AsyncSession = Depends(get_pdb), user: User = Depends(current_user),
                     ctx: ProjectCtx = Depends(project_ctx)) -> Run:
    import hashlib
    import json
    initial_hash = hashlib.sha256(json.dumps(body.model_dump(mode="json"), sort_keys=True).encode()).hexdigest()
    company = await owned_company(body.company_id, db, user)
    if body.client_request_id:
        # Serialize initial request deduplication in the same project transaction.
        await db.execute(update(Company).where(Company.id == company.id).values(revision=Company.revision))
        existing = await db.scalar(select(Run).where(Run.company_id == company.id,
            func.json_extract(Run.state_json, "$.initial_client_id") == body.client_request_id))
        if existing:
            if (existing.state_json or {}).get("initial_content_hash") != initial_hash:
                raise HTTPException(409, "The initial request ID was already used for different content")
            await db.commit()
            if existing.started_at is None:
                await manager.start(existing.id, ref(ctx))
            return existing
    from app.core.config import get_settings
    from app.schemas import RunModel
    from app.capabilities.models.opencode import discover
    if body.budget.model is None and get_settings().default_provider == "opencode":
        body.budget.model = RunModel(provider="opencode", model=get_settings().default_model)
    if body.budget.model and body.budget.model.provider == "opencode":
        if not get_settings().single_user_mode:
            raise HTTPException(422, "Host OpenCode is available only in local single-user mode.")
        local = await discover()
        if not local.available:
            raise HTTPException(422, local.error)
        if body.budget.model.model != "default" and body.budget.model.model not in local.models:
            raise HTTPException(422, "This model is no longer available in the installed OpenCode. Refresh the model list.")
        if body.mode != "autonomous":
            raise HTTPException(422, "OpenCode conversations use autonomous mode with OpenCode permission requests.")
    if body.budget.model is not None and body.budget.model.provider == "azure":
        from app.db.session import registry_factory
        from app.capabilities.models.router import allowed_models, is_configured, resolve_credentials

        async with registry_factory()() as registry:
            key, base, options = await resolve_credentials(registry, user.id, "azure")
        if not is_configured("azure", key, base, options):
            raise HTTPException(422, "Connect Azure in Model settings before using this model. Your message has not been sent.")
        if body.budget.model.model not in allowed_models(options):
            raise HTTPException(422, "This deployment is no longer configured. Choose a model again in Model settings.")
    company = await owned_company(body.company_id, db, user)
    from app.orchestrator.contracts import validate_reporting, choose_lead, route_target
    try:
        validate_reporting(snapshot(company)["agents"])
        lead = choose_lead(snapshot(company)["agents"])
        target = route_target(body.goal, snapshot(company)["agents"], lead)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    if body.budget.execution_mode == "restricted":
        raise HTTPException(422, "No verified restricted worker is configured. Trusted-host execution is not a sandbox.")
    if not company.agents:
        raise HTTPException(422, "Add at least one agent to the company before running it")
    live = (await db.execute(select(func.count()).select_from(Run).where(Run.company_id == company.id, Run.status.in_(["running", "queued"])))).scalar()
    if live and live >= 3:
        raise HTTPException(429, "Too many concurrent runs for this company")
    session_id = body.session_id
    if session_id:
        s = await db.get(ChatSession, session_id)
        if s is None or s.company_id != company.id:
            raise HTTPException(422, "Invalid session")
    else:
        s = ChatSession(company_id=company.id, title=body.goal[:60], mode="company")
        db.add(s)
        await db.flush()
        session_id = s.id
    permission_level = normalize_mode(user.approval_mode)  # the user's global setting, recorded on the run
    run = Run(company_id=company.id, session_id=session_id, goal=body.goal, mode=body.mode, status="queued",
              permission_level=permission_level,
              budget_json=body.budget.model_dump(), snapshot_json=snapshot(company), state_json={"attachments": []})
    db.add(run)
    await db.flush()
    try:  # images are kept as files next to the project database; text attachments stay in the run state
        run.state_json = {"attachments": run_attachments.store(ctx.root, run.id, body.attachments), "lead_agent_id": lead,
                          "initial_target": target, "plan_revision": 1,
                          "initial_client_id": body.client_request_id, "initial_content_hash": initial_hash}
    except (run_attachments.AttachmentError, OSError) as exc:
        run_attachments.delete_run(ctx.root, run.id)
        raise HTTPException(422, f"Attachment rejected: {exc}") from exc
    await db.commit()
    await db.refresh(run)
    await manager.start(run.id, ref(ctx))
    return run


ERROR_KINDS = ("llm", "parse", "limit", "loop", "stall", "permission")


async def run_outcomes(db: AsyncSession, run_ids: list[str]) -> dict[str, RunOutcome]:
    """Task board, files, errors and final report per run: a handful of grouped queries for the whole list."""
    out = {rid: RunOutcome() for rid in run_ids}
    if not run_ids:
        return out
    for rid, status, n in (await db.execute(select(Task.run_id, Task.status, func.count()).where(Task.run_id.in_(run_ids))
                                            .group_by(Task.run_id, Task.status))).all():
        o = out[rid]
        o.tasks_total += n
        if status == "done":
            o.tasks_done += n
        elif status in OPEN_TASK_STATES:
            o.tasks_open += n
            if status == "blocked":
                o.tasks_blocked += n
    for rid, n in (await db.execute(select(Artifact.run_id, func.count(func.distinct(Artifact.path))).where(Artifact.run_id.in_(run_ids))
                                    .group_by(Artifact.run_id))).all():
        out[rid].files = n
    kind = func.json_extract(RunEvent.payload_json, "$.kind")
    for rid, n in (await db.execute(select(RunEvent.run_id, func.count()).where(RunEvent.run_id.in_(run_ids), RunEvent.type == "error",
                                                                              kind.in_(ERROR_KINDS)).group_by(RunEvent.run_id))).all():
        out[rid].errors = n
    for (rid,) in (await db.execute(select(Message.run_id).where(Message.run_id.in_(run_ids), Message.type == "final_report").distinct())).all():
        out[rid].final_report = True
    return out


@router.get("", response_model=list[RunOut])
async def list_runs(company_id: str | None = None, db: AsyncSession = Depends(get_pdb), user: User = Depends(current_user)) -> list[RunOut]:
    q = select(Run).order_by(Run.created_at.desc()).limit(200)
    if company_id:
        await owned_company(company_id, db, user)
        q = q.where(Run.company_id == company_id)
    runs = list((await db.execute(q)).scalars().all())
    outcomes = await run_outcomes(db, [r.id for r in runs])
    result = []
    for r in runs:
        o = RunOut.model_validate(r)
        rt = manager.get(r.id)
        if rt is not None:  # live counters are fresher than the row
            o.status, o.turns, o.tokens_used, o.cost_usd = rt.run_status, rt.turn_no, rt.tokens, round(rt.cost, 6)
        o.outcome = outcomes[r.id]
        m = rt.efficiency() if rt is not None else ((r.state_json or {}).get("metrics") or {})
        o.outcome.agent_turns, o.outcome.work_turns = int(m.get("turns", 0)), int(m.get("work_turns", 0))
        o.outcome.first_deliverable_turn, o.outcome.delegations = m.get("first_deliverable_turn"), int(m.get("delegations", 0))
        result.append(o)
    return result


@router.get("/{run_id}", response_model=RunDetail)
async def get_run(run_id: str, db: AsyncSession = Depends(get_pdb), user: User = Depends(current_user)) -> Run:
    run = await owned_run(run_id, db, user)
    rt = manager.get(run_id)
    if rt is not None:  # live state is fresher than the persisted row; take all of it from the runtime so it's consistent
        run.state_json = rt.state_dict()
        run.status = rt.run_status
        run.turns, run.tokens_used, run.cost_usd = rt.turn_no, rt.tokens, round(rt.cost, 6)
    return run


@router.delete("/{run_id}", status_code=204, response_class=Response, response_model=None)
async def delete_run(run_id: str, db: AsyncSession = Depends(get_pdb), user: User = Depends(current_user),
                     ctx: ProjectCtx = Depends(project_ctx)) -> None:
    run = await owned_run(run_id, db, user)
    if run.status in ACTIVE_STATES and manager.get(run_id):
        raise HTTPException(409, "Stop the run before deleting it")
    await db.delete(run)
    await db.commit()
    from app.capabilities.browser import frames as browser_frames

    browser_frames.delete_run(run_id)
    run_attachments.delete_run(ctx.root, run_id)


async def _runtime(run_id: str, db: AsyncSession, user: User, ctx: ProjectCtx) -> RunRuntime:
    await owned_run(run_id, db, user)
    rt = await manager.ensure(run_id, ref(ctx))
    if rt is None:
        raise HTTPException(409, "Run is not active")
    return rt


@router.post("/{run_id}/control/{action}", response_model=RunOut)
async def control(run_id: str, action: str, db: AsyncSession = Depends(get_pdb), user: User = Depends(current_user),
                  ctx: ProjectCtx = Depends(project_ctx)) -> Run:
    if action not in ("pause", "resume", "step", "stop"):
        raise HTTPException(422, "action must be pause|resume|step|stop")
    rt = await _runtime(run_id, db, user, ctx)
    getattr(rt, action)()
    run = await owned_run(run_id, db, user)
    await db.refresh(run)
    return run


@router.post("/{run_id}/interject", status_code=202)
async def interject(run_id: str, body: InterjectIn, db: AsyncSession = Depends(get_pdb), user: User = Depends(current_user),
                    ctx: ProjectCtx = Depends(project_ctx)) -> dict[str, Any]:
    """Message the team. On a finished run this continues it (same run, full history, files untouched)."""
    return await _send(run_id, body, db, user, ctx)


@router.post("/{run_id}/continue", status_code=202)
async def continue_run(run_id: str, body: InterjectIn, db: AsyncSession = Depends(get_pdb), user: User = Depends(current_user),
                       ctx: ProjectCtx = Depends(project_ctx)) -> dict[str, Any]:
    """Follow up on a run like a chat: the same team picks up where it left off."""
    return await _send(run_id, body, db, user, ctx)


async def _send(run_id: str, body: InterjectIn, db: AsyncSession, user: User, ctx: ProjectCtx) -> dict[str, Any]:
    normalized = body.model_copy(update={"client_request_id": body.client_request_id or str(uuid4()),
        "delivery": "steer" if body.delivery == "steer" else "queue"})
    result = await queue_request(run_id, normalized, db, user, ctx)
    return {"ok": True, "request": result}


def stored_request_attachments(ctx: ProjectCtx, run_id: str, body: InterjectIn) -> list[dict]:
    """Stable names prevent both image overwrite across requests and false conflicts on retries."""
    if len(body.attachments) > run_attachments.MAX_FILES:
        raise run_attachments.AttachmentError("Too many attachments")
    digest = hashlib.sha256(json.dumps([body.client_request_id, body.attachments], sort_keys=True).encode()).hexdigest()[:24]
    original = [dict(attachment) for attachment in body.attachments]
    renamed = [{**attachment, "filename": f"{digest}-{str(attachment.get('filename') or 'file')[:140]}"} for attachment in original]
    stored = run_attachments.store(ctx.root, run_id, renamed)
    for record, attachment in zip(stored, original):
        record["filename"] = str(attachment.get("filename") or "file")[:200]
    return stored


async def queue_request(run_id: str, body: InterjectIn, db: AsyncSession, user: User, ctx: ProjectCtx) -> dict:
    run = await owned_run(run_id, db, user)
    if not body.client_request_id:
        raise HTTPException(422, "A client_request_id is required for durable delivery")
    runtime = manager.get(run_id)
    agents = [agent.to_dict() for agent in runtime.agents.values()] if runtime else (run.snapshot_json or {}).get("agents", [])
    try:
        lead = choose_lead(agents, (run.state_json or {}).get("lead_agent_id"))
        target = route_target(body.content, agents, lead, body.to_agent_id)
        attachments = await asyncio.to_thread(stored_request_attachments, ctx, run_id, body)
        result, created = await RuntimeStore(ctx.sf, run_id).enqueue(client_id=body.client_request_id,
            content=body.content, target=target, attachments=attachments, kind="steer" if body.delivery == "steer" else "queue")
    except Conflict as exc:
        raise HTTPException(409, str(exc)) from exc
    except (ValueError, OSError) as exc:
        raise HTTPException(422, str(exc)) from exc
    if created or result["state"] == "queued":
        await manager.notify_requests(run_id, ref(ctx), steer=result["kind"] == "steer")
    return result


@router.post("/{run_id}/requests", status_code=202)
async def post_request(run_id: str, body: InterjectIn, db: AsyncSession = Depends(get_pdb), user: User = Depends(current_user),
                       ctx: ProjectCtx = Depends(project_ctx)) -> dict:
    return await queue_request(run_id, body, db, user, ctx)


@router.get("/{run_id}/requests")
async def queued_requests(run_id: str, db: AsyncSession = Depends(get_pdb), user: User = Depends(current_user),
                          ctx: ProjectCtx = Depends(project_ctx)) -> list[dict]:
    await owned_run(run_id, db, user)
    return await RuntimeStore(ctx.sf, run_id).requests()


@router.delete("/{run_id}/requests/{request_id}", status_code=204, response_class=Response)
async def remove_request(run_id: str, request_id: str, db: AsyncSession = Depends(get_pdb), user: User = Depends(current_user),
                         ctx: ProjectCtx = Depends(project_ctx)) -> Response:
    await owned_run(run_id, db, user)
    try:
        await RuntimeStore(ctx.sf, run_id).cancel_request(request_id)
    except Conflict as exc:
        raise HTTPException(409, str(exc)) from exc
    return Response(status_code=204)


@router.post("/{run_id}/requests/{request_id}/steer")
async def steer_request(run_id: str, request_id: str, db: AsyncSession = Depends(get_pdb), user: User = Depends(current_user),
                        ctx: ProjectCtx = Depends(project_ctx)) -> dict:
    await owned_run(run_id, db, user)
    try:
        record, changed = await RuntimeStore(ctx.sf, run_id).steer_request(request_id)
    except Conflict as exc:
        raise HTTPException(409, str(exc)) from exc
    if changed or record["state"] == "queued":
        await manager.notify_requests(run_id, ref(ctx), steer=True)
    return record


async def execution_summary(run_id: str, ctx: ProjectCtx, run: Run) -> dict:
    store = RuntimeStore(ctx.sf, run_id)
    runtime = manager.get(run_id)
    if runtime is None:
        await store.recover()  # Marks uncertain invocations only. Never dispatches a prompt.
    if runtime is None:
        await store.expire_consultations()
    result = await store.summary()
    saved = run.state_json or {}
    revision = max(int(result["plan_revision"]), runtime.plan_revision if runtime else int(saved.get("plan_revision", 1)))
    manifest = await asyncio.to_thread(capture_manifest, ctx.root)
    environment = {"platform": platform.system(), "python": platform.python_version(), "root": str(ctx.root.resolve()),
                   "execution_root": str(ctx.root.resolve())}
    for item in result["evidence"]:
        try:
            record = RevisionEvidence.model_validate({key: value for key, value in item.items() if key not in ("attempt_id", "revision")})
            validity = validate_evidence(record, manifest, task_revision=revision, environment=environment, criterion="requested_outcome")
            item["validity"] = validity.model_dump(mode="json")
        except ValueError:
            item["validity"] = {"valid": False, "status": "unknown", "reasons": ["Evidence record is invalid or legacy"]}
    result.update(plan_revision=revision, manifest_hash=manifest.content_hash, manifest_complete=manifest.complete)
    if runtime:
        result.update(engineering_checkpoints=runtime.engineering_checkpoints, engineering_blockers=runtime.execution.engineering_blockers(),
                      recovery_required=runtime.recovery_required, lead_agent_id=runtime.lead_agent_id,
                      engineering_workflow=runtime.engineering_workflow, execution_mode=runtime.budget.execution_mode)
    return result


@router.get("/{run_id}/execution")
async def execution_details(run_id: str, db: AsyncSession = Depends(get_pdb), user: User = Depends(current_user),
                            ctx: ProjectCtx = Depends(project_ctx)) -> dict:
    return await execution_summary(run_id, ctx, await owned_run(run_id, db, user))


class RequestRecovery(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action: Literal["retry", "cancel"]
    acknowledge_side_effects: Literal[True]


class ExecutionRecovery(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action: Literal["acknowledge", "cancel"]
    acknowledge_side_effects: Literal[True]


@router.post("/{run_id}/requests/{request_id}/recover")
async def recover_request(run_id: str, request_id: str, body: RequestRecovery, db: AsyncSession = Depends(get_pdb),
                          user: User = Depends(current_user), ctx: ProjectCtx = Depends(project_ctx)) -> dict:
    await owned_run(run_id, db, user)
    try:
        record = await RuntimeStore(ctx.sf, run_id).recover_request(request_id, body.action, acknowledged=body.acknowledge_side_effects)
    except Conflict as exc:
        raise HTTPException(409, str(exc)) from exc
    runtime = manager.get(run_id)
    if runtime:
        await runtime.execution.adopt_recovery()
    if body.action == "retry":
        await manager.notify_requests(run_id, ref(ctx))
    return record


@router.post("/{run_id}/recovery")
async def recover_execution(run_id: str, body: ExecutionRecovery, db: AsyncSession = Depends(get_pdb),
                            user: User = Depends(current_user), ctx: ProjectCtx = Depends(project_ctx)) -> dict:
    run = await owned_run(run_id, db, user)
    try:
        await RuntimeStore(ctx.sf, run_id).acknowledge_recovery(body.action, acknowledged=body.acknowledge_side_effects)
    except Conflict as exc:
        raise HTTPException(409, str(exc)) from exc
    runtime = manager.get(run_id)
    if runtime:
        # Stop before reconciling: adopting the cleared state can resume the loop, which must not start another turn.
        if body.action == "cancel":
            runtime.stop()
        await runtime.execution.adopt_recovery()
        if body.action != "cancel":
            runtime.resume()
            runtime.wake.set()
    return await execution_summary(run_id, ctx, run)


@router.post("/{run_id}/approve", status_code=202)
async def approve(run_id: str, body: ApprovalIn, db: AsyncSession = Depends(get_pdb), user: User = Depends(current_user),
                  ctx: ProjectCtx = Depends(project_ctx)) -> dict[str, bool]:
    rt = await _runtime(run_id, db, user, ctx)
    if not rt.resolve_approval(body.approval_id, body.approved, body.reason, body.scope):
        raise HTTPException(404, "No such pending approval")
    return {"ok": True}


@router.get("/{run_id}/events", response_model=list[RunEventOut])
async def events(run_id: str, after: int = 0, limit: int = Query(5000, le=20000), db: AsyncSession = Depends(get_pdb),
                 user: User = Depends(current_user)) -> list[RunEvent]:
    await owned_run(run_id, db, user)
    return list((await db.execute(select(RunEvent).where(RunEvent.run_id == run_id, RunEvent.id > after).order_by(RunEvent.id).limit(limit))).scalars().all())


@router.get("/{run_id}/messages", response_model=list[MessageOut])
async def messages(run_id: str, db: AsyncSession = Depends(get_pdb), user: User = Depends(current_user)) -> list[Message]:
    await owned_run(run_id, db, user)
    out: list[Message] = []
    seen: set[str] = set()
    for m in (await db.execute(select(Message).where(Message.run_id == run_id).order_by(Message.created_at))).scalars().all():
        group = (m.meta_json or {}).get("broadcast")
        if group:  # a message to everyone is stored once per recipient (their inboxes) but listed once, to everyone
            if group in seen:
                continue
            seen.add(group)
            db.expunge(m)
            m.to_agent_id = None
        out.append(m)
    return out


@router.get("/{run_id}/tasks", response_model=list[TaskOut])
async def tasks(run_id: str, db: AsyncSession = Depends(get_pdb), user: User = Depends(current_user)) -> list[Task]:
    await owned_run(run_id, db, user)
    return list((await db.execute(select(Task).where(Task.run_id == run_id).order_by(Task.key))).scalars().all())


@router.get("/{run_id}/report")
async def report(run_id: str, download: bool = False, db: AsyncSession = Depends(get_pdb), user: User = Depends(current_user),
                 ctx: ProjectCtx = Depends(project_ctx)) -> Response:
    run = await owned_run(run_id, db, user)
    if not run.report_md:
        from app.services.report import build_report

        run.report_md = await build_report(run_id, ctx.sf)
    headers = {"Content-Disposition": f'attachment; filename="run-report-{run_id[:8]}.md"'} if download else {}
    return Response(run.report_md, media_type="text/markdown; charset=utf-8", headers=headers)


# ---------------- artifacts (versioned changes made by agents in a run)
def _art_out(a: Artifact) -> ArtifactOut:
    return ArtifactOut(id=a.id, run_id=a.run_id, path=a.path, version=a.version, author_agent_id=a.author_agent_id,
                       change_note=a.change_note, created_at=a.created_at, size=len(a.content), deleted=a.deleted)


@router.get("/{run_id}/artifacts", response_model=list[ArtifactOut])
async def list_artifacts(run_id: str, all_versions: bool = False, db: AsyncSession = Depends(get_pdb),
                         user: User = Depends(current_user)) -> list[ArtifactOut]:
    await owned_run(run_id, db, user)
    rows = (await db.execute(select(Artifact).where(Artifact.run_id == run_id).order_by(Artifact.path, Artifact.version))).scalars().all()
    if not all_versions:
        latest: dict[str, Artifact] = {}
        for a in rows:
            latest[a.path] = a
        rows = list(latest.values())
    return [_art_out(a) for a in rows]


@router.get("/{run_id}/artifacts/file", response_model=ArtifactContentOut)
async def get_artifact(run_id: str, path: str, version: int | None = None, db: AsyncSession = Depends(get_pdb),
                       user: User = Depends(current_user)) -> ArtifactContentOut:
    """Version content. ``version=0`` returns the file as it was before the run touched it."""
    await owned_run(run_id, db, user)
    if version == 0:
        first = (await db.execute(select(Artifact).where(Artifact.run_id == run_id, Artifact.path == path).order_by(Artifact.version).limit(1))).scalar_one_or_none()
        if first is None:
            raise HTTPException(404, "Artifact not found")
        o = _art_out(first)
        return ArtifactContentOut(**{**o.model_dump(), "version": 0, "change_note": "original", "deleted": first.previous_content is None}, content=first.previous_content or "")
    q = select(Artifact).where(Artifact.run_id == run_id, Artifact.path == path)
    q = q.where(Artifact.version == version) if version else q.order_by(Artifact.version.desc())
    a = (await db.execute(q.limit(1))).scalar_one_or_none()
    if a is None:
        raise HTTPException(404, "Artifact not found")
    return ArtifactContentOut(**_art_out(a).model_dump(), content=a.content)


@router.post("/{run_id}/artifacts/revert", status_code=200)
async def revert_artifact(run_id: str, body: RevertIn, db: AsyncSession = Depends(get_pdb), user: User = Depends(current_user),
                          ctx: ProjectCtx = Depends(project_ctx)) -> dict[str, str]:
    """Restore a file in the project to an earlier version (0 = before the run). Deletes files the run created."""
    await owned_run(run_id, db, user)
    rows = (await db.execute(select(Artifact).where(Artifact.run_id == run_id, Artifact.path == body.path).order_by(Artifact.version))).scalars().all()
    if not rows:
        raise HTTPException(404, "Artifact not found")
    fs = ProjectFS(ctx.root)
    try:
        rel, full = fs.resolve(body.path)
    except WorkspaceError as exc:
        raise HTTPException(400, str(exc)) from exc
    if body.to_version == 0:
        if rows[0].previous_content is None:
            full.unlink(missing_ok=True)
            return {"status": "deleted", "path": rel}
        fs.write(rel, rows[0].previous_content)
        return {"status": "restored", "path": rel}
    target = next((r for r in rows if r.version == body.to_version), None)
    if target is None:
        raise HTTPException(404, "No such version")
    if target.deleted:
        full.unlink(missing_ok=True)
        return {"status": "deleted", "path": rel}
    fs.write(rel, target.content)
    return {"status": "restored", "path": rel}


@router.get("/{run_id}/artifacts.zip")
async def download_zip(run_id: str, db: AsyncSession = Depends(get_pdb), user: User = Depends(current_user),
                       ctx: ProjectCtx = Depends(project_ctx)) -> Response:
    """ZIP of every file the run produced (latest version) plus the run report."""
    run = await owned_run(run_id, db, user)
    rows = (await db.execute(select(Artifact).where(Artifact.run_id == run_id).order_by(Artifact.path, Artifact.version))).scalars().all()
    latest: dict[str, Artifact] = {}
    for a in rows:
        latest[a.path] = a
    import io
    import zipfile

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for p, artifact in sorted(latest.items()):
            if not artifact.deleted:
                zf.writestr(p, artifact.content)
        if run.report_md:
            zf.writestr("RUN_REPORT.md", run.report_md)
    return Response(buf.getvalue(), media_type="application/zip",
                    headers={"Content-Disposition": f'attachment; filename="octopus-run-{run_id[:8]}.zip"'})


@router.get("/{run_id}/browser/{name}")
async def browser_frame(run_id: str, name: str, db: AsyncSession = Depends(get_pdb), user: User = Depends(current_user)) -> Response:
    """One screenshot of an agent's browser tab (named by a browser_action event)."""
    from app.capabilities.browser import frames as browser_frames

    await owned_run(run_id, db, user)
    p = browser_frames.path(run_id, name)
    if p is None:
        raise HTTPException(404, "Frame not found (frames beyond the most recent ones are not kept)")
    return Response(p.read_bytes(), media_type="image/png" if name.endswith(".png") else "image/jpeg",
                    headers={"Cache-Control": "private, max-age=86400, immutable", "X-Content-Type-Options": "nosniff"})


@router.get("/{run_id}/attachments/{name}")
async def run_attachment(run_id: str, name: str, db: AsyncSession = Depends(get_pdb), user: User = Depends(current_user),
                         ctx: ProjectCtx = Depends(project_ctx)) -> Response:
    """An image attached to the run's goal (named in the goal message's ``meta.images``)."""
    await owned_run(run_id, db, user)
    p = run_attachments.path(ctx.root, run_id, name)
    if p is None:
        raise HTTPException(404, "Attachment not found")
    mime = {"png": "image/png", "jpg": "image/jpeg", "gif": "image/gif", "webp": "image/webp"}[name.rsplit(".", 1)[-1]]
    return Response(p.read_bytes(), media_type=mime,
                    headers={"Cache-Control": "private, max-age=86400, immutable", "X-Content-Type-Options": "nosniff"})


@router.get("/{run_id}/preview/{path:path}")
async def preview(run_id: str, path: str, request: Request, db: AsyncSession = Depends(get_pdb), user: User = Depends(current_user),
                  ctx: ProjectCtx = Depends(project_ctx)) -> Response:
    """Serve the project as it is on disk, for the sandboxed live preview."""
    from app.capabilities.workspace.preview import serve

    await owned_run(run_id, db, user)
    fs = ProjectFS(ctx.root)
    return serve(fs, path, f"{str(request.base_url).rstrip('/')}/api/v1/w/{ctx.workspace.id}/runs/{run_id}/preview/")
