"""Local Git branch, worktree, and project virtual-environment controls."""
from __future__ import annotations

import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path

from app.foundation.config import get_settings
from app.plugins.workspace import git as git_review
from app.sdk.projectfs import WorkspaceError


def _environment_file(root: Path) -> Path:
    return root / ".octopus" / "local-environment.json"


def environments(root: Path) -> list[dict[str, str]]:
    """Return project virtual environments that can run on this local backend."""
    found: list[dict[str, str]] = []
    for name in (".venv", "venv", "env"):
        folder = root / name
        executable = folder / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
        if folder.is_dir() and executable.is_file():
            found.append({"id": f"venv:{name}", "label": f"Python ({name})", "path": name})
    return found


def selected_environment(root: Path) -> str | None:
    try:
        value = json.loads(_environment_file(root).read_text(encoding="utf-8")).get("selected")
    except (OSError, json.JSONDecodeError, AttributeError):
        return None
    return value if any(item["id"] == value for item in environments(root)) else None


def environment_directory(root: Path) -> Path | None:
    chosen = selected_environment(root)
    if not chosen:
        return None
    name = chosen.removeprefix("venv:")
    folder = (root / name).resolve()
    if folder.parent != root.resolve():
        return None
    return folder


def save_environment(root: Path, value: str | None) -> str | None:
    available = environments(root)
    if value is not None and not any(item["id"] == value for item in available):
        raise WorkspaceError("That local Python environment is no longer available. Refresh and choose again.")
    path = _environment_file(root)
    path.parent.mkdir(exist_ok=True)
    path.write_text(json.dumps({"selected": value}, indent=2) + "\n", encoding="utf-8")
    return value


async def inspect(root: Path) -> dict:
    result: dict = {"repository": False, "branch": "", "branches": [], "dirty_count": 0,
                    "worktrees": [], "environments": environments(root), "selected_environment": selected_environment(root)}
    try:
        await git_review.require_root(root)
    except WorkspaceError:
        return result
    current = (await git_review.git(root, "branch", "--show-current")).strip() or "Detached HEAD"
    branches = (await git_review.git(root, "for-each-ref", "--format=%(refname:short)", "refs/heads")).splitlines()
    status = await git_review.git(root, "status", "--porcelain=v1", "-z", "--untracked-files=all")
    dirty_count = sum(1 for entry in status.split("\x00") if entry)
    raw_worktrees = (await git_review.git(root, "worktree", "list", "--porcelain")).splitlines()
    worktrees: list[dict[str, str]] = []
    current_worktree: dict[str, str] = {}
    for line in [*raw_worktrees, ""]:
        if not line:
            if current_worktree:
                worktrees.append(current_worktree)
                current_worktree = {}
            continue
        key, _, value = line.partition(" ")
        if key == "worktree":
            current_worktree["path"] = value
        elif key == "branch":
            current_worktree["branch"] = value.removeprefix("refs/heads/")
        elif key == "detached":
            current_worktree["branch"] = "Detached HEAD"
    result.update(repository=True, branch=current, branches=branches, dirty_count=dirty_count, worktrees=worktrees)
    return result


async def switch_branch(root: Path, branch: str) -> None:
    await git_review.require_root(root)
    branches = (await git_review.git(root, "for-each-ref", "--format=%(refname:short)", "refs/heads")).splitlines()
    if branch not in branches:
        raise WorkspaceError("Only existing local branches can be selected here.")
    current = (await git_review.git(root, "branch", "--show-current")).strip()
    if branch == current:
        return
    changes = await git_review.git(root, "status", "--porcelain=v1", "-z", "--untracked-files=all")
    if any(changes.split("\x00")):
        raise WorkspaceError("This repository has local changes. Commit or stash them before switching the current folder's branch, or enable New worktree to keep those files untouched.")
    await git_review.git(root, "switch", "--no-guess", "--", branch)


async def create_worktree(root: Path, base_branch: str, workspace_id: str) -> tuple[Path, str]:
    """Create a sibling worktree on a new branch based on an existing local branch."""
    await git_review.require_root(root)
    branches = (await git_review.git(root, "for-each-ref", "--format=%(refname:short)", "refs/heads")).splitlines()
    if base_branch not in branches:
        raise WorkspaceError("Choose an existing local branch as the worktree starting point.")

    safe_stem = re.sub(r"[^A-Za-z0-9._-]+", "-", base_branch).strip(".-_")[:36] or "branch"
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    suffix = workspace_id.replace("-", "")[:8]
    branch = f"octopus/{safe_stem}-{stamp}-{suffix}"
    # Sibling directories keep Git's metadata pointer outside the checked-out source tree.
    shelf = root.parent / ".octopus-worktrees"
    parent = shelf / root.name
    if shelf.is_symlink() or parent.is_symlink():
        raise WorkspaceError("The local worktree folder cannot be a symbolic link.")
    resolved_parent = parent.resolve()
    if resolved_parent == root.resolve() or root.resolve() in resolved_parent.parents or root.parent.resolve() not in resolved_parent.parents:
        raise WorkspaceError("Could not choose a safe sibling folder for this worktree.")
    if not any(resolved_parent == allowed or allowed in resolved_parent.parents for allowed in get_settings().allowed_roots()):
        raise WorkspaceError("The local worktree must stay inside Octopus' shared local folders.")
    parent.mkdir(parents=True, exist_ok=True)
    target = parent / f"{safe_stem}-{stamp}-{suffix}"
    if target.exists():
        raise WorkspaceError("That worktree folder already exists. Try again.")
    await git_review.git(root, "worktree", "add", "-b", branch, str(target), base_branch)
    return target.resolve(), branch
