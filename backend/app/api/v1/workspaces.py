"""Project workspaces (user-selected directories) + server-side directory picker + project file browser."""
from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import ProjectCtx, current_user, load_project, project_ctx
from app.db.session import close_project, get_registry_db
from app.models import User, Workspace
from app.orchestrator.engine import manager
from app.schemas import BrowseOut, DirEntryOut, FileContentOut, FileNode, MkdirIn, WorkspaceIn, WorkspaceOut, WorkspacePatch
from app.services.projects import ProjectPathError, allowed_roots, browse, init_project, make_dir, rename_project, validate_project_dir
from app.tools.workspace import ProjectFS, WorkspaceError

router = APIRouter(tags=["workspaces"])


def ws_out(w: Workspace, existing: bool = False) -> WorkspaceOut:
    return WorkspaceOut(id=w.id, name=w.name, path=w.path, default_permission=w.default_permission, created_at=w.created_at,
                        last_opened_at=w.last_opened_at, exists=Path(w.path).is_dir(), existing_project=existing)


@router.get("/fs/browse", response_model=BrowseOut)
async def browse_dirs(path: str | None = None, show_hidden: bool = False, user: User = Depends(current_user)) -> BrowseOut:
    try:
        cur, parent, entries = browse(path, show_hidden)
    except ProjectPathError as exc:
        raise HTTPException(400, str(exc)) from exc
    return BrowseOut(path=str(cur) if cur else None, parent=str(parent) if parent else None,
                     entries=[DirEntryOut(**e.__dict__) for e in entries], roots=[str(r) for r in allowed_roots()])


@router.post("/fs/mkdir", response_model=DirEntryOut, status_code=201)
async def mkdir(body: MkdirIn, user: User = Depends(current_user)) -> DirEntryOut:
    try:
        p = make_dir(body.parent, body.name)
    except ProjectPathError as exc:
        raise HTTPException(400, str(exc)) from exc
    return DirEntryOut(name=p.name, path=str(p), is_project=False, is_git=False)


@router.get("/workspaces", response_model=list[WorkspaceOut])
async def list_workspaces(db: AsyncSession = Depends(get_registry_db), user: User = Depends(current_user)) -> list[WorkspaceOut]:
    rows = (await db.execute(select(Workspace).where(Workspace.user_id == user.id).order_by(Workspace.last_opened_at.desc()))).scalars().all()
    return [ws_out(w) for w in rows]


@router.post("/workspaces", response_model=WorkspaceOut, status_code=201)
async def create_workspace(body: WorkspaceIn, db: AsyncSession = Depends(get_registry_db), user: User = Depends(current_user)) -> WorkspaceOut:
    """Select a directory as a project. Creates ``<dir>/.octopus`` (or re-opens an existing one with all its data)."""
    try:
        root = validate_project_dir(body.path)
    except ProjectPathError as exc:
        raise HTTPException(400, str(exc)) from exc
    existing_row = (await db.execute(select(Workspace).where(Workspace.user_id == user.id, Workspace.path == str(root)))).scalar_one_or_none()
    meta = init_project(root, body.name)
    if existing_row:
        return ws_out(existing_row, existing=True)
    w = Workspace(user_id=user.id, name=body.name or meta.name, path=str(root), default_permission=body.default_permission)
    db.add(w)
    await db.commit()
    await db.refresh(w)
    await load_project(w.id, user, db)  # creates + migrates .octopus/octopus.db
    return ws_out(w, existing=meta.existing)


@router.get("/workspaces/{workspace_id}", response_model=WorkspaceOut)
async def get_workspace(workspace_id: str, db: AsyncSession = Depends(get_registry_db), user: User = Depends(current_user)) -> WorkspaceOut:
    ctx = await load_project(workspace_id, user, db, touch=True)
    return ws_out(ctx.workspace)


@router.patch("/workspaces/{workspace_id}", response_model=WorkspaceOut)
async def patch_workspace(workspace_id: str, body: WorkspacePatch, db: AsyncSession = Depends(get_registry_db),
                          user: User = Depends(current_user)) -> WorkspaceOut:
    w = await db.get(Workspace, workspace_id)
    if w is None or w.user_id != user.id:
        raise HTTPException(404, "Workspace not found")
    if body.name:
        w.name = body.name
        rename_project(Path(w.path), body.name)
    if body.default_permission:
        w.default_permission = body.default_permission
    await db.commit()
    await db.refresh(w)
    return ws_out(w)


@router.delete("/workspaces/{workspace_id}", status_code=204, response_class=Response, response_model=None)
async def forget_workspace(workspace_id: str, db: AsyncSession = Depends(get_registry_db), user: User = Depends(current_user)) -> None:
    """Remove the project from Octopus' list. The directory and its .octopus data are left untouched."""
    w = await db.get(Workspace, workspace_id)
    if w is None or w.user_id != user.id:
        raise HTTPException(404, "Workspace not found")
    if manager.active_for(Path(w.path)):
        raise HTTPException(409, "Stop this project's active runs first")
    await close_project(str(Path(w.path)))
    await db.delete(w)
    await db.commit()


# ---------------- project files (what agents see; .octopus/.git hidden)
@router.get("/w/{workspace_id}/files", response_model=list[FileNode], tags=["project files"])
async def project_files(ctx: ProjectCtx = Depends(project_ctx)) -> list[FileNode]:
    fs = ProjectFS(ctx.root)
    out = []
    for rel in fs.list():
        try:
            size = (ctx.root / rel).stat().st_size
        except OSError:
            size = 0
        out.append(FileNode(path=rel, size=size))
    return out


@router.get("/w/{workspace_id}/files/content", response_model=FileContentOut, tags=["project files"])
async def project_file(path: str = Query(...), ctx: ProjectCtx = Depends(project_ctx)) -> FileContentOut:
    fs = ProjectFS(ctx.root)
    try:
        content = fs.read(path)
    except WorkspaceError as exc:
        raise HTTPException(404 if "not found" in str(exc) else 400, str(exc)) from exc
    return FileContentOut(path=path, content=content, size=len(content))


@router.get("/w/{workspace_id}/files.zip", tags=["project files"])
async def project_zip(ctx: ProjectCtx = Depends(project_ctx)) -> Response:
    data = ProjectFS(ctx.root).zip_bytes()
    return Response(data, media_type="application/zip", headers={"Content-Disposition": f'attachment; filename="{ctx.root.name}.zip"'})
