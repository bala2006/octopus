"""Project Git status, patches, and explicit staging without a shell or external diff drivers."""
from __future__ import annotations

import asyncio
import os
from pathlib import Path

from app.tools.sandbox import command_environment
from app.tools.workspace import ProjectFS, WorkspaceError

MAX_GIT_BYTES = 250_000


async def git(root: Path, *args: str) -> str:
    env = {**command_environment(root), "GIT_OPTIONAL_LOCKS": "0", "GIT_TERMINAL_PROMPT": "0",
           "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull}
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
            fs.resolve(path)
            if original:
                fs.resolve(original)
        except WorkspaceError:
            continue
        files.append({"path": path, "status": code, "original_path": original})
    return {"branch": branch or "Detached HEAD", "files": files}


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
