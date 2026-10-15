"""Project Git status, patches, and explicit staging without a shell or external diff drivers."""
from __future__ import annotations

import asyncio
import hashlib
import os
from pathlib import Path

from app.tools.sandbox import command_environment
from app.tools.workspace import IGNORED_DIRS, ProjectFS, WorkspaceError

MAX_GIT_BYTES = 250_000
_operation_locks: dict[str, asyncio.Lock] = {}


def operation_lock(root: Path) -> asyncio.Lock:
    return _operation_locks.setdefault(str(root.resolve()), asyncio.Lock())


def visible_path(fs: ProjectFS, path: str) -> None:
    rel, _ = fs.resolve(path)
    if any(part.lower() in IGNORED_DIRS for part in Path(rel).parts):
        raise WorkspaceError("This path is hidden from Git review. Use your Git client to inspect and commit it explicitly.")


async def git(root: Path, *args: str, developer: bool = False) -> str:
    env = {**command_environment(root, developer=developer), "GIT_OPTIONAL_LOCKS": "0", "GIT_TERMINAL_PROMPT": "0",
           "GIT_CONFIG_NOSYSTEM": "1"}
    if not developer:
        env["GIT_CONFIG_GLOBAL"] = os.devnull
    proc = await asyncio.create_subprocess_exec(
        "git", "--no-pager", "-c", "core.fsmonitor=false", *args, cwd=root, env=env,
        stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    async def read(stream: asyncio.StreamReader | None) -> bytes:
        chunks = bytearray()
        if stream:
            while block := await stream.read(8192):
                chunks.extend(block)
                if len(chunks) > MAX_GIT_BYTES:
                    raise WorkspaceError("This Git result is too large to display. Use the command panel or your Git client.")
        return bytes(chunks)

    try:
        async with asyncio.timeout(10):
            stdout, stderr = await asyncio.gather(read(proc.stdout), read(proc.stderr))
            await proc.wait()
    finally:
        if proc.returncode is None:
            proc.kill()
            await proc.wait()
    if proc.returncode:
        raise WorkspaceError(stderr.decode("utf-8", errors="replace").strip()[:500] or "Git could not read this repository.")
    return stdout.decode("utf-8", errors="replace")


async def require_root(root: Path) -> None:
    actual = (await git(root, "rev-parse", "--show-toplevel")).strip()
    if Path(actual).resolve() != root.resolve():
        raise WorkspaceError("Open the Git repository's root folder to review its changes.")


async def status(root: Path) -> dict:
    await require_root(root)
    branch = (await git(root, "branch", "--show-current")).strip()
    output = await git(root, "status", "--porcelain=v1", "-z", "--untracked-files=all")
    parts = iter(output.split("\x00"))
    files = []
    fs = ProjectFS(root)
    for entry in parts:
        if not entry:
            continue
        code, path = entry[:2], entry[3:]
        original = next(parts, "") if "R" in code or "C" in code else None
        try:
            visible_path(fs, path)
            if original:
                visible_path(fs, original)
        except WorkspaceError:
            continue
        files.append({"path": path, "status": code, "original_path": original})
    index = await git(root, "diff", "--cached", "--raw", "--no-abbrev", "-z", "--no-ext-diff", "--no-textconv")
    return {"branch": branch or "Detached HEAD", "files": files,
            "index_revision": hashlib.sha256(index.encode("utf-8")).hexdigest()}


async def diff(root: Path, path: str, staged: bool) -> str:
    fs = ProjectFS(root)
    rel, _ = fs.resolve(path)
    await require_root(root)
    return await git(root, "diff", "--no-ext-diff", "--no-textconv", *( ["--cached"] if staged else []), "--", f":(literal){rel}")


async def stage(root: Path, path: str, staged: bool) -> dict:
    fs = ProjectFS(root)
    rel, target = fs.resolve(path)
    await require_root(root)
    # Stage explicit files only. Directories would recursively include hidden files.
    if target.is_dir():
        raise WorkspaceError("Select an individual file to stage or unstage.")
    visible = await status(root)
    entry = next((f for f in visible["files"] if f["path"] == rel), None)
    if entry is None:
        raise WorkspaceError("This file has no visible Git changes. Refresh the changes list.")
    paths = [f":(literal){rel}"]
    if entry["original_path"] and not staged:
        paths.append(f":(literal){entry['original_path']}")
    if staged:
        await git(root, "add", "--", *paths)
    else:
        # --no-refresh keeps the operation scoped to index entries without running hooks.
        try:
            await git(root, "rev-parse", "--verify", "HEAD")
        except WorkspaceError:
            await git(root, "rm", "--cached", "--ignore-unmatch", "--", *paths)
        else:
            await git(root, "reset", "--no-refresh", "HEAD", "--", *paths)
    return await status(root)


async def commit(root: Path, message: str, expected_index: str) -> dict:
    """Commit explicitly staged files, rejecting a stale review or hidden staged content."""
    message = message.strip()
    if not message or "\x00" in message:
        raise WorkspaceError("Enter a nonempty commit message without NUL characters.")
    current = await status(root)
    if current["index_revision"] != expected_index:
        raise WorkspaceError("Staged changes changed since your review. Refresh and review them before committing.")
    paths = (await git(root, "diff", "--cached", "--name-only", "-z", "--no-renames")).split("\x00")
    if not any(paths):
        raise WorkspaceError("Stage at least one file before committing.")
    fs = ProjectFS(root)
    for path in filter(None, paths):
        visible_path(fs, path)
    # A UI commit does not run arbitrary repository hooks or invoke a signing prompt.
    # Developers who need hooks or signing can commit through the command panel.
    await git(root, "-c", f"core.hooksPath={os.devnull}", "commit", "--no-gpg-sign", "-m", message, developer=True)
    sha = (await git(root, "rev-parse", "HEAD")).strip()
    return {"commit_sha": sha, "status": await status(root)}
