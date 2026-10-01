from __future__ import annotations

import asyncio


from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import Response
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import ProjectCtx, current_user, get_pdb, owned_company, project_ctx
from app.models import Artifact, ChatSession, Message, Run, RunEvent, Task, User
from app.orchestrator.engine import ACTIVE_STATES, OPEN_TASK_STATES, ProjectRef, RunRuntime, manager
from app.schemas import (
    ApprovalIn, ArtifactContentOut, ArtifactOut, InterjectIn, MessageOut, RevertIn, RunCreate, RunDetail, RunEventOut, RunOut,
    RunOutcome, TaskOut,
)
from app.services.canvas import snapshot
from app.tools.workspace import ProjectFS, WorkspaceError

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
    company = await owned_company(body.company_id, db, user)
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
    run = Run(company_id=company.id, session_id=session_id, goal=body.goal, mode=body.mode, status="queued",
              permission_level=body.permission_level or ctx.workspace.default_permission,
              budget_json=body.budget.model_dump(), snapshot_json=snapshot(company),
              state_json={"attachments": [{"filename": a.get("filename", "file")[:200], "text": a.get("text", "")[:30000]} for a in body.attachments[:5]]})
    db.add(run)
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
        for k in ("input_tokens", "cached_tokens", "loop_strikes", "rejected_messages", "recalls", "history_searches", "ledger_items"):
            setattr(o.outcome, k, int(m.get(k, 0) or 0))
        o.outcome.context_mode = str(m.get("context_mode") or (r.budget_json or {}).get("context_mode") or "pointers")
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
async def delete_run(run_id: str, db: AsyncSession = Depends(get_pdb), user: User = Depends(current_user)) -> None:
    run = await owned_run(run_id, db, user)
    if run.status in ACTIVE_STATES and manager.get(run_id):
        raise HTTPException(409, "Stop the run before deleting it")
    await db.delete(run)
    await db.commit()
    from app.services import browser_frames

    browser_frames.delete_run(run_id)


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
                    ctx: ProjectCtx = Depends(project_ctx)) -> dict[str, bool]:
    """Message the team. On a finished run this continues it (same run, full history, files untouched)."""
    return await _send(run_id, body, db, user, ctx)


@router.post("/{run_id}/continue", status_code=202)
async def continue_run(run_id: str, body: InterjectIn, db: AsyncSession = Depends(get_pdb), user: User = Depends(current_user),
                       ctx: ProjectCtx = Depends(project_ctx)) -> dict[str, bool]:
    """Follow up on a run like a chat: the same team picks up where it left off."""
    return await _send(run_id, body, db, user, ctx)


async def _send(run_id: str, body: InterjectIn, db: AsyncSession, user: User, ctx: ProjectCtx) -> dict[str, bool]:
    run = await owned_run(run_id, db, user)
    agent_ids = {a.get("id") for a in (run.snapshot_json or {}).get("agents", [])}
    if body.to_agent_id and body.to_agent_id not in agent_ids and not (manager.get(run_id) and body.to_agent_id in manager.get(run_id).agents):
        raise HTTPException(422, "Unknown agent")
    from app.services.images import ImageError, attach_text, parse_images

    try:
        images = parse_images([i.model_dump() for i in body.images])
    except ImageError as exc:
        raise HTTPException(422, str(exc)) from exc
    content = attach_text(body.content.strip(), [a.model_dump() for a in body.attachments])
    if not content and images:
        content = "(see the attached image" + ("s)" if len(images) > 1 else ")")
    if not content:
        raise HTTPException(422, "Write a message or attach a file or image")
    for _ in range(40):  # a run that is finalizing right now can be continued a moment later
        if await manager.continue_run(run_id, ref(ctx), content, body.to_agent_id, images):
            return {"ok": True}
        await asyncio.sleep(0.1)
    raise HTTPException(409, "Run could not be continued")


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
    return ArtifactOut(id=a.id, run_id=a.run_id, path=a.path, version=a.version, planned=a.planned, author_agent_id=a.author_agent_id,
                       change_note=a.change_note, created_at=a.created_at, size=len(a.content))


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
        return ArtifactContentOut(**{**o.model_dump(), "version": 0, "change_note": "original"}, content=first.previous_content or "")
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
    if rows[-1].planned:
        raise HTTPException(409, "Planned files never touched the project; nothing to revert")
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
    fs.write(rel, target.content)
    return {"status": "restored", "path": rel}


@router.post("/{run_id}/plans/apply", status_code=200)
async def apply_plan(run_id: str, db: AsyncSession = Depends(get_pdb), user: User = Depends(current_user),
                     ctx: ProjectCtx = Depends(project_ctx)) -> dict[str, list[str]]:
    """Apply every file planned in a plan-mode run to the real project."""
    run = await owned_run(run_id, db, user)
    if run.status in ACTIVE_STATES and manager.get(run_id):
        raise HTTPException(409, "Wait for the run to finish before applying its plan")
    rows = (await db.execute(select(Artifact).where(Artifact.run_id == run_id, Artifact.planned.is_(True)).order_by(Artifact.path, Artifact.version))).scalars().all()
    latest: dict[str, Artifact] = {}
    for a in rows:
        latest[a.path] = a
    fs = ProjectFS(ctx.root)
    applied = []
    for p, a in latest.items():
        fs.write(p, a.content)
        applied.append(p)
    return {"applied": applied}


@router.get("/{run_id}/artifacts.zip")
async def download_zip(run_id: str, db: AsyncSession = Depends(get_pdb), user: User = Depends(current_user),
                       ctx: ProjectCtx = Depends(project_ctx)) -> Response:
    """ZIP of every file the run produced (latest version) plus the run report."""
    run = await owned_run(run_id, db, user)
    rows = (await db.execute(select(Artifact).where(Artifact.run_id == run_id).order_by(Artifact.path, Artifact.version))).scalars().all()
    latest: dict[str, str] = {}
    for a in rows:
        latest[a.path] = a.content
    import io
    import zipfile

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for p, content in sorted(latest.items()):
            zf.writestr(p, content)
        if run.report_md:
            zf.writestr("RUN_REPORT.md", run.report_md)
    return Response(buf.getvalue(), media_type="application/zip",
                    headers={"Content-Disposition": f'attachment; filename="octopus-run-{run_id[:8]}.zip"'})


@router.get("/{run_id}/images/{image_ref}")
async def run_image(run_id: str, image_ref: str, db: AsyncSession = Depends(get_pdb), user: User = Depends(current_user)) -> Response:
    """An image the user attached to a message in this run (messages carry its reference, e.g. "i2")."""
    from app.models import RunRecord
    from app.services.images import ImageError, decode

    await owned_run(run_id, db, user)
    rec = (await db.execute(select(RunRecord).where(RunRecord.run_id == run_id, RunRecord.ref == image_ref,
                                                    RunRecord.kind == "image"))).scalar_one_or_none()
    if rec is None:
        raise HTTPException(404, "Image not found")
    try:
        media, data = decode(rec.content)
    except ImageError as exc:
        raise HTTPException(404, "Image not found") from exc
    return Response(data, media_type=media, headers={"Cache-Control": "private, max-age=86400, immutable", "X-Content-Type-Options": "nosniff"})


@router.get("/{run_id}/browser/{name}")
async def browser_frame(run_id: str, name: str, db: AsyncSession = Depends(get_pdb), user: User = Depends(current_user)) -> Response:
    """One screenshot of an agent's browser tab (named by a browser_action event)."""
    from app.services import browser_frames

    await owned_run(run_id, db, user)
    p = browser_frames.path(run_id, name)
    if p is None:
        raise HTTPException(404, "Frame not found (frames beyond the most recent ones are not kept)")
    return Response(p.read_bytes(), media_type="image/png" if name.endswith(".png") else "image/jpeg",
                    headers={"Cache-Control": "private, max-age=86400, immutable", "X-Content-Type-Options": "nosniff"})


@router.get("/{run_id}/preview/{path:path}")
async def preview(run_id: str, path: str, request: Request, db: AsyncSession = Depends(get_pdb), user: User = Depends(current_user),
                  ctx: ProjectCtx = Depends(project_ctx)) -> Response:
    """Serve the project as this run left it (plan shadow first) for the sandboxed live preview."""
    from app.core.config import PROJECT_DIRNAME
    from app.services.preview import serve

    run = await owned_run(run_id, db, user)
    shadow = ctx.root / PROJECT_DIRNAME / "plans" / run_id if run.permission_level == "plan" else None
    fs = ProjectFS(ctx.root, shadow=shadow if shadow and shadow.is_dir() else None)
    return serve(fs, path, f"{str(request.base_url).rstrip('/')}/api/v1/w/{ctx.workspace.id}/runs/{run_id}/preview/")
