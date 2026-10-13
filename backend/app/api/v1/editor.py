"""Project editor endpoints. All actions here are explicit user actions, not agent tool calls."""
from __future__ import annotations

import asyncio
import os
import tempfile
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from typing import Literal

from app.core.deps import ProjectCtx, project_ctx
from app.services import editor
from app.services import file_items
from app.tools.workspace import MAX_LIST, ProjectFS, WorkspaceError

router = APIRouter(prefix="/editor", tags=["project editor"])


class Document(BaseModel):
    path: str
    content: str
    size: int
    revision: str


class SaveDocument(BaseModel):
    path: str = Field(min_length=1, max_length=400)
    content: str = Field(max_length=1_000_000)
    revision: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")


class FileVersion(BaseModel):
    path: str = Field(min_length=1, max_length=400)
    revision: str = Field(pattern=r"^[a-f0-9]{64}$")


class MoveDocument(FileVersion):
    destination: str = Field(min_length=1, max_length=400)


class FileItem(BaseModel):
    path: str
    kind: Literal["file", "folder"]
    size: int
    revision: str


class TrashedItem(BaseModel):
    token: str
    path: str
    kind: Literal["file", "folder"]
    size: int
    deleted_at: float


class FolderIn(BaseModel):
    path: str = Field(min_length=1, max_length=400)


class EditorTree(BaseModel):
    files: list[str]
    folders: list[str]
    truncated: bool


class SearchMatch(BaseModel):
    path: str
    line: int
    text: str


class SearchResults(BaseModel):
    matches: list[SearchMatch]
    truncated: bool
    searched: int


class TrashResult(BaseModel):
    token: str


class CommandIn(BaseModel):
    command: str = Field(min_length=1, max_length=4000)


class CommandResult(BaseModel):
    ok: bool
    exit_code: int
    output: str
    timed_out: bool
    backend: str


class ServerStatus(BaseModel):
    command: str
    status: Literal["idle", "running", "exited"]
    exit_code: int | None
    output: str
    truncated: bool
    directory: str = "."


class CommandStatus(ServerStatus):
    timed_out: bool


class StartCommand(CommandIn):
    timeout_seconds: int = Field(default=3600, ge=1, le=14400)
    directory: str = Field(default=".", min_length=1, max_length=400)


class StartServer(CommandIn):
    directory: str = Field(default=".", min_length=1, max_length=400)


class CommandInput(BaseModel):
    text: str = Field(max_length=16000)


class GitFile(BaseModel):
    path: str
    status: str
    original_path: str | None


class GitStatus(BaseModel):
    branch: str
    files: list[GitFile]
    index_revision: str


class GitDiff(BaseModel):
    patch: str


class GitStage(BaseModel):
    path: str = Field(min_length=1, max_length=400)
    staged: bool


class GitCommit(BaseModel):
    message: str = Field(min_length=1, max_length=5000)
    expected_index: str = Field(pattern=r"^[a-f0-9]{64}$")


class GitCommitResult(BaseModel):
    commit_sha: str
    status: GitStatus


class ProjectTask(BaseModel):
    id: str
    name: str
    command: str
    directory: str
    source: str
    kind: Literal["task", "server"]


class ProjectTasks(BaseModel):
    tasks: list[ProjectTask]
    warnings: list[str]


@router.get("/tasks", response_model=ProjectTasks)
async def project_tasks(ctx: ProjectCtx = Depends(project_ctx)) -> dict:
    from app.services.project_tasks import discover
    try:
        return await asyncio.to_thread(discover, ctx.root)
    except OSError as exc:
        raise HTTPException(400, "Project tasks could not be read. Reopen the project folder.") from exc


@router.post("/git/commit", response_model=GitCommitResult)
async def git_commit(body: GitCommit, ctx: ProjectCtx = Depends(project_ctx)) -> dict:
    from app.services import git_review
    if ctx.workspace.default_permission in ("read_only", "plan"):
        raise HTTPException(403, "Committing changes is disabled in read-only and plan mode.")
    try:
        async with git_review.operation_lock(ctx.root):
            return await git_review.commit(ctx.root, body.message, body.expected_index)
    except (WorkspaceError, OSError, TimeoutError) as exc:
        raise HTTPException(400, str(exc) or "Git timed out. Use the command panel for this commit.") from exc


@router.post("/git/stage", response_model=GitStatus)
async def git_stage(body: GitStage, ctx: ProjectCtx = Depends(project_ctx)) -> dict:
    from app.services import git_review
    if ctx.workspace.default_permission in ("read_only", "plan"):
        raise HTTPException(403, "Staging changes is disabled in read-only and plan mode.")
    try:
        async with git_review.operation_lock(ctx.root):
            return await git_review.stage(ctx.root, body.path, body.staged)
    except (WorkspaceError, OSError, TimeoutError) as exc:
        raise HTTPException(400, str(exc) or "Git timed out. Try refreshing.") from exc


@router.get("/git", response_model=GitStatus)
async def git_status(ctx: ProjectCtx = Depends(project_ctx)) -> dict:
    from app.services import git_review
    try:
        return await git_review.status(ctx.root)
    except (WorkspaceError, OSError, TimeoutError) as exc:
        raise HTTPException(400, str(exc) or "Git timed out. Try refreshing.") from exc


@router.get("/git/diff", response_model=GitDiff)
async def git_diff(path: str, staged: bool = False, ctx: ProjectCtx = Depends(project_ctx)) -> GitDiff:
    from app.services import git_review
    try:
        return GitDiff(patch=await git_review.diff(ctx.root, path, staged))
    except (WorkspaceError, OSError, TimeoutError) as exc:
        raise HTTPException(400, str(exc) or "Git timed out. Try refreshing.") from exc


@router.get("/server", response_model=ServerStatus)
async def server_status(ctx: ProjectCtx = Depends(project_ctx)) -> dict:
    from app.services.processes import servers
    return servers.status(ctx.key)


@router.post("/server", response_model=ServerStatus)
async def start_server(body: StartServer, ctx: ProjectCtx = Depends(project_ctx)) -> dict:
    from app.services.processes import servers
    from app.tools.sandbox import SandboxError
    if ctx.workspace.default_permission in ("read_only", "plan"):
        raise HTTPException(403, "Development servers are disabled in read-only and plan mode.")
    try:
        return await servers.start(ctx.key, ctx.root, body.command, danger=ctx.workspace.default_permission == "danger", directory=body.directory)
    except (SandboxError, OSError) as exc:
        raise HTTPException(400, str(exc)) from exc


@router.delete("/server", response_model=ServerStatus)
async def stop_server(ctx: ProjectCtx = Depends(project_ctx)) -> dict:
    from app.services.processes import servers
    return await servers.stop(ctx.key)


@router.post("/command", response_model=CommandResult)
async def command(body: CommandIn, ctx: ProjectCtx = Depends(project_ctx)) -> CommandResult:
    from app.tools.sandbox import SandboxError, run_command
    if ctx.workspace.default_permission in ("read_only", "plan"):
        raise HTTPException(403, "Commands are disabled in read-only and plan mode. Change the project permission in Settings to run commands.")
    try:
        result = await run_command(body.command, ctx.root, danger=ctx.workspace.default_permission == "danger", timeout=60)
        return CommandResult(**result.__dict__)
    except (SandboxError, OSError) as exc:
        raise HTTPException(400, str(exc)) from exc


@router.get("/commands/current", response_model=CommandStatus)
async def current_command(ctx: ProjectCtx = Depends(project_ctx)) -> dict:
    from app.services.processes import commands
    return commands.status(ctx.key)


@router.post("/commands/current", response_model=CommandStatus)
async def start_command(body: StartCommand, ctx: ProjectCtx = Depends(project_ctx)) -> dict:
    from app.services.processes import commands
    from app.tools.sandbox import SandboxError
    if ctx.workspace.default_permission in ("read_only", "plan"):
        raise HTTPException(403, "Commands are disabled in read-only and plan mode.")
    try:
        return await commands.start(ctx.key, ctx.root, body.command, danger=ctx.workspace.default_permission == "danger", timeout=body.timeout_seconds, directory=body.directory)
    except (SandboxError, OSError) as exc:
        raise HTTPException(400, str(exc)) from exc


@router.delete("/commands/current", response_model=CommandStatus)
async def stop_command(ctx: ProjectCtx = Depends(project_ctx)) -> dict:
    from app.services.processes import commands
    return await commands.stop(ctx.key)


@router.post("/commands/input", response_model=CommandStatus)
async def command_input(body: CommandInput, ctx: ProjectCtx = Depends(project_ctx)) -> dict:
    from app.services.processes import commands
    from app.tools.sandbox import SandboxError
    if ctx.workspace.default_permission in ("read_only", "plan"):
        raise HTTPException(403, "Command input is disabled in read-only and plan mode.")
    try:
        return await commands.send(ctx.key, body.text)
    except (SandboxError, OSError) as exc:
        raise HTTPException(400, str(exc)) from exc


@router.delete("/commands/output", response_model=CommandStatus)
async def clear_command(ctx: ProjectCtx = Depends(project_ctx)) -> dict:
    from app.services.processes import commands
    from app.tools.sandbox import SandboxError
    try:
        return commands.clear(ctx.key)
    except SandboxError as exc:
        raise HTTPException(400, str(exc)) from exc


def fail(exc: Exception) -> HTTPException:
    if isinstance(exc, editor.FileConflict):
        return HTTPException(409, str(exc))
    if isinstance(exc, FileNotFoundError):
        return HTTPException(404, "File not found. It may have been moved or deleted.")
    if isinstance(exc, WorkspaceError):
        return HTTPException(400, str(exc))
    return HTTPException(400, "The file operation failed. Check the path and file permissions.")


@router.get("/item", response_model=FileItem)
def item(path: str, ctx: ProjectCtx = Depends(project_ctx)) -> dict:
    try:
        return file_items.inspect(ProjectFS(ctx.root), path)
    except (WorkspaceError, OSError) as exc:
        raise fail(exc) from exc


@router.get("/items/trash", response_model=list[TrashedItem])
def trash_items(ctx: ProjectCtx = Depends(project_ctx)) -> list[file_items.TrashItem]:
    return file_items.list_trash(ProjectFS(ctx.root))


@router.post("/item/move", response_model=FileItem)
async def move_item(body: MoveDocument, ctx: ProjectCtx = Depends(project_ctx)) -> dict:
    try:
        return file_items.move(ProjectFS(ctx.root), body.path, body.destination, body.revision)
    except (WorkspaceError, OSError) as exc:
        raise fail(exc) from exc


@router.post("/item/trash", response_model=TrashResult)
async def trash_item(body: FileVersion, ctx: ProjectCtx = Depends(project_ctx)) -> TrashResult:
    try:
        return TrashResult(token=file_items.trash(ProjectFS(ctx.root), body.path, body.revision))
    except (WorkspaceError, OSError) as exc:
        raise fail(exc) from exc


@router.post("/item/restore/{token}", response_model=FileItem)
async def restore_item(token: str, ctx: ProjectCtx = Depends(project_ctx)) -> dict:
    import re
    if not re.fullmatch(r"[a-f0-9]{32}", token):
        raise HTTPException(400, "Invalid restore token")
    try:
        return file_items.restore(ProjectFS(ctx.root), token)
    except (WorkspaceError, OSError) as exc:
        raise fail(exc) from exc


@router.post("/asset", response_model=FileItem, status_code=201)
async def upload_asset(file: UploadFile, path: str = Query(min_length=1, max_length=400), ctx: ProjectCtx = Depends(project_ctx)) -> dict:
    temporary: Path | None = None
    try:
        fs = ProjectFS(ctx.root)
        rel, target = fs.resolve(path)
        if target.exists():
            raise editor.FileConflict("A file or folder already exists here. Choose a different name.")
        if any(part.lower() in file_items.IGNORED_DIRS or file_items.is_secret(part) for part in Path(rel).parts):
            raise WorkspaceError("Choose a path outside dependencies and private folders.")
        target.parent.mkdir(parents=True, exist_ok=True)
        fd, name = tempfile.mkstemp(prefix=".upload-", suffix=".octopus-tmp", dir=target.parent)
        temporary = Path(name)
        size = 0
        with os.fdopen(fd, "wb") as stream:
            while block := await file.read(65536):
                size += len(block)
                if size > file_items.MAX_UPLOAD_BYTES:
                    raise HTTPException(413, "Upload is limited to 20 MB per file.")
                stream.write(block)
        # Create only: a competing request cannot replace an existing file.
        try:
            os.link(temporary, target)
        except FileExistsError as exc:
            raise editor.FileConflict("A file was created here during upload. Choose a different name.") from exc
        return file_items.inspect(fs, rel)
    except (WorkspaceError, OSError) as exc:
        raise fail(exc) from exc
    finally:
        await file.close()
        if temporary:
            temporary.unlink(missing_ok=True)


@router.get("/download")
def download(path: str, ctx: ProjectCtx = Depends(project_ctx)) -> FileResponse:
    try:
        rel, target = ProjectFS(ctx.root).resolve(path)
        if not target.is_file():
            raise FileNotFoundError(rel)
        return FileResponse(target, filename=target.name, media_type="application/octet-stream", headers={"X-Content-Type-Options": "nosniff"})
    except (WorkspaceError, OSError) as exc:
        raise fail(exc) from exc


@router.get("/tree", response_model=EditorTree)
def tree(ctx: ProjectCtx = Depends(project_ctx)) -> EditorTree:
    fs = ProjectFS(ctx.root)
    files = fs.list()
    dirs, truncated = editor.folders(fs)
    return EditorTree(files=files, folders=dirs, truncated=truncated or len(files) >= MAX_LIST)


@router.get("/document", response_model=Document)
def document(path: str, ctx: ProjectCtx = Depends(project_ctx)) -> dict:
    try:
        return editor.read_document(ProjectFS(ctx.root), path)
    except (WorkspaceError, OSError) as exc:
        raise fail(exc) from exc


# Mutations have no await between the revision check and the write, so concurrent
# requests and agent writes in this process cannot interleave that critical section.
@router.put("/document", response_model=Document)
async def save(body: SaveDocument, ctx: ProjectCtx = Depends(project_ctx)) -> dict:
    try:
        return editor.save_document(ProjectFS(ctx.root), body.path, body.content, body.revision)
    except (WorkspaceError, OSError) as exc:
        raise fail(exc) from exc


@router.post("/folder", response_model=FolderIn, status_code=201)
async def folder(body: FolderIn, ctx: ProjectCtx = Depends(project_ctx)) -> FolderIn:
    try:
        return FolderIn(path=ProjectFS(ctx.root).make_dir(body.path))
    except (WorkspaceError, OSError) as exc:
        raise fail(exc) from exc



@router.get("/search", response_model=SearchResults)
def search(q: str = Query(min_length=1, max_length=200), ctx: ProjectCtx = Depends(project_ctx)) -> SearchResults:
    fs = ProjectFS(ctx.root)
    files = fs.list()
    matches = []
    searched = 0
    needle = q.casefold()
    for path in files:
        try:
            content = editor.read_document(fs, path)["content"]
        except (WorkspaceError, OSError):
            continue
        searched += 1
        for line, text in enumerate(content.splitlines(), 1):
            if needle in text.casefold():
                if len(matches) == 200:
                    return SearchResults(matches=matches, truncated=True, searched=searched)
                matches.append(SearchMatch(path=path, line=line, text=text[:500]))
    return SearchResults(matches=matches, truncated=len(files) >= MAX_LIST, searched=searched)
