"""Project workspaces (user-selected directories) + server-side directory picker + project file browser."""
from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import ProjectCtx, current_user, load_project, project_ctx
from app.db.session import close_project, get_registry_db
from app.models import Artifact, User, Workspace
from app.orchestrator.engine import manager
from app.schemas import (
    BrowseOut, DirEntryOut, FileContentOut, FileNode, MkdirIn, NativeDialogOut, NativeOpenIn, NativeOpenOut, ProjectTreeOut, WorkspaceIn,
    WorkspaceOut, WorkspacePatch,
)
from app.core.config import get_settings
from app.services import hostpaths, native_dialog
from app.services.projects import ProjectPathError, allowed_roots, browse, init_project, make_dir, rename_project, validate_project_dir
from app.tools.workspace import ProjectFS, WorkspaceError

router = APIRouter(tags=["workspaces"])


def ws_out(w: Workspace, existing: bool = False) -> WorkspaceOut:
    return WorkspaceOut(id=w.id, name=w.name, path=w.path, default_permission=w.default_permission, created_at=w.created_at,
                        last_opened_at=w.last_opened_at, exists=Path(w.path).is_dir(), existing_project=existing,
                        display_path=hostpaths.to_host(w.path))


@router.get("/fs/browse", response_model=BrowseOut)
async def browse_dirs(path: str | None = None, show_hidden: bool = False, user: User = Depends(current_user)) -> BrowseOut:
    try:
        cur, parent, entries = browse(hostpaths.to_container(path) if path else path, show_hidden)
    except ProjectPathError as exc:
        raise HTTPException(400, hostpaths.outside_shared_folder(path or "") or str(exc)) from exc
    roots = [str(r) for r in allowed_roots()]
    return BrowseOut(path=str(cur) if cur else None, parent=str(parent) if parent else None,
                     entries=[DirEntryOut(**e.__dict__, display_path=hostpaths.to_host(e.path)) for e in entries], roots=roots,
                     display_path=hostpaths.to_host(str(cur)) if cur else "", root_labels={r: hostpaths.to_host(r) for r in roots})


@router.post("/fs/mkdir", response_model=DirEntryOut, status_code=201)
async def mkdir(body: MkdirIn, user: User = Depends(current_user)) -> DirEntryOut:
    try:
        p = make_dir(hostpaths.to_container(body.parent), body.name)
    except ProjectPathError as exc:
        raise HTTPException(400, str(exc)) from exc
    return DirEntryOut(name=p.name, path=str(p), is_project=False, is_git=False, display_path=hostpaths.to_host(str(p)))


@router.get("/workspaces", response_model=list[WorkspaceOut])
async def list_workspaces(db: AsyncSession = Depends(get_registry_db), user: User = Depends(current_user)) -> list[WorkspaceOut]:
    rows = (await db.execute(select(Workspace).where(Workspace.user_id == user.id).order_by(Workspace.last_opened_at.desc()))).scalars().all()
    return [ws_out(w) for w in rows]


def _is_local(request: Request) -> bool:
    host = request.client.host if request.client else ""
    return host in ("127.0.0.1", "::1", "localhost", "testclient") or host.startswith("127.")


@router.get("/fs/native", response_model=NativeDialogOut)
async def native_status(request: Request, user: User = Depends(current_user)) -> NativeDialogOut:
    """Can this backend show the OS folder dialog? (Only for browsers on the same machine.)"""
    s = get_settings()
    extra = {"bridge_url": s.folder_bridge_url if s.native_dialogs else "", "host_dir": s.host_dir}
    if not _is_local(request):
        return NativeDialogOut(available=False, reason="Octopus runs in a container or on another machine, so it can't open your "
                                                       "laptop's folder dialog itself", **extra)
    av = native_dialog.availability()
    return NativeDialogOut(available=av.available, method=av.method, reason=av.reason, **extra)


@router.post("/workspaces/native", response_model=NativeOpenOut)
async def open_native(body: NativeOpenIn, request: Request, db: AsyncSession = Depends(get_registry_db),
                      user: User = Depends(current_user)) -> NativeOpenOut:
    """Show the OS "choose folder" dialog (the user can create a new folder there) and open the chosen folder as a project."""
    if not _is_local(request):
        raise HTTPException(403, "The system folder dialog is only available on the machine running Octopus")
    try:
        picked = await native_dialog.pick_directory()
    except native_dialog.DialogError as exc:
        raise HTTPException(501, str(exc)) from exc
    if picked is None:
        return NativeOpenOut(cancelled=True)
    try:
        root = validate_project_dir(str(picked), any_root=True)
    except ProjectPathError as exc:
        raise HTTPException(400, str(exc)) from exc
    return NativeOpenOut(cancelled=False, workspace=await _register(root, None, body.default_permission, db, user))


@router.post("/workspaces", response_model=WorkspaceOut, status_code=201)
async def create_workspace(body: WorkspaceIn, db: AsyncSession = Depends(get_registry_db), user: User = Depends(current_user)) -> WorkspaceOut:
    """Select a directory as a project. Creates ``<dir>/.octopus`` (or re-opens an existing one with all its data).

    In Docker ``path`` may be a laptop path (e.g. picked with the laptop's own folder dialog); it is translated to the
    shared folder inside the container."""
    try:
        root = validate_project_dir(hostpaths.to_container(body.path))
    except ProjectPathError as exc:
        raise HTTPException(400, hostpaths.outside_shared_folder(body.path) or str(exc)) from exc
    return await _register(root, body.name, body.default_permission, db, user)


async def _register(root: Path, name: str | None, permission: str, db: AsyncSession, user: User) -> WorkspaceOut:
    existing_row = (await db.execute(select(Workspace).where(Workspace.user_id == user.id, Workspace.path == str(root)))).scalar_one_or_none()
    meta = init_project(root, name)
    if existing_row:
        return ws_out(existing_row, existing=True)
    w = Workspace(user_id=user.id, name=name or meta.name, path=str(root), default_permission=permission)
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


# ---------------- project files (what agents see: the project + .octopus/work; the rest of .octopus and .git hidden)
@router.get("/w/{workspace_id}/tree", response_model=ProjectTreeOut, tags=["project files"])
async def project_tree(ctx: ProjectCtx = Depends(project_ctx)) -> ProjectTreeOut:
    """The project folder as the agents see it (``.git``, dependency folders and secrets hidden), plus the agents'
    working documents from ``.octopus/work/`` (``area="work"``). The rest of ``.octopus`` stays hidden."""
    files = await project_files(ctx)
    from app.tools.workspace import MAX_LIST

    return ProjectTreeOut(root=str(ctx.root), name=ctx.root.name, files=files, truncated=len(files) >= MAX_LIST)


@router.get("/w/{workspace_id}/files", response_model=list[FileNode], tags=["project files"])
async def project_files(ctx: ProjectCtx = Depends(project_ctx)) -> list[FileNode]:
    """The project's files plus the agents' working documents (``area="work"``, in ``.octopus/work/``).

    ``generated`` tells files some run wrote apart from the user's own files."""
    fs = ProjectFS(ctx.root)
    async with ctx.sf() as db:
        generated = set((await db.execute(select(Artifact.path).distinct())).scalars())
    out = []
    for area, paths in (("project", fs.list()), ("work", fs.list_work())):
        for rel in paths:
            try:
                size = (ctx.root / rel).stat().st_size
            except OSError:
                size = 0
            out.append(FileNode(path=rel, size=size, area=area, generated=rel in generated))
    return out


@router.get("/w/{workspace_id}/files/content", response_model=FileContentOut, tags=["project files"])
async def project_file(path: str = Query(...), ctx: ProjectCtx = Depends(project_ctx)) -> FileContentOut:
    fs = ProjectFS(ctx.root)
    try:
        content = fs.read(path)
    except WorkspaceError as exc:
        raise HTTPException(404 if "not found" in str(exc) else 400, str(exc)) from exc
    return FileContentOut(path=path, content=content, size=len(content))


@router.get("/w/{workspace_id}/preview/{path:path}", tags=["project files"])
async def project_preview(path: str, request: Request, ctx: ProjectCtx = Depends(project_ctx)) -> Response:
    """Live preview of the project folder (HTML apps with their CSS/JS/images, Markdown, images…)."""
    from app.services.preview import serve

    return serve(ProjectFS(ctx.root), path, f"{str(request.base_url).rstrip('/')}/api/v1/w/{ctx.workspace.id}/preview/")


@router.get("/w/{workspace_id}/files.zip", tags=["project files"])
async def project_zip(ctx: ProjectCtx = Depends(project_ctx)) -> Response:
    data = ProjectFS(ctx.root).zip_bytes()
    return Response(data, media_type="application/zip", headers={"Content-Disposition": f'attachment; filename="{ctx.root.name}.zip"'})
