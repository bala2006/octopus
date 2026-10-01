"""Project workspaces: user-selected directories whose app data lives in ``<dir>/.octopus/``.

Layout::

    <project>/
      .octopus/
        project.json      # {id, name, created_at, app, schema}
        octopus.db        # companies, agents, edges, sessions, runs, messages, events, tasks, artifacts, memory
        work/             # agents' working material: plans, specs, briefs, notes, reviews, QA reports
        plans/<run_id>/   # shadow files written in "plan" permission mode
        exports/          # company exports / run reports (on demand)
        browser/          # screenshots / traces from the agents' browser (Playwright MCP)
        README.md         # what this folder is
        .gitignore        # "*": git ignores the whole folder, like .venv
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from app.core.config import PROJECT_DIRNAME, get_settings
from app.db.base import new_id

FORBIDDEN_DIRS = {"/", "/bin", "/boot", "/dev", "/etc", "/lib", "/lib64", "/proc", "/root", "/run", "/sbin", "/sys", "/usr", "/var"}


class ProjectPathError(ValueError):
    pass


def allowed_roots() -> list[Path]:
    return [Path(r).expanduser().resolve() for r in get_settings().workspace_allowed_roots]


def validate_project_dir(raw: str, *, must_exist: bool = True, any_root: bool = False) -> Path:
    """``any_root``: the user picked the folder in their own OS dialog, so the allowed-roots list doesn't apply."""
    if not raw or not raw.strip():
        raise ProjectPathError("Choose a directory")
    p = Path(raw.strip()).expanduser()
    if not p.is_absolute():
        raise ProjectPathError("Use an absolute path")
    p = p.resolve()
    if str(p) in FORBIDDEN_DIRS:
        raise ProjectPathError("System directories cannot be used as projects")
    home = get_settings().octopus_home.resolve()
    if p == home or home in p.parents:
        raise ProjectPathError("The Octopus data directory cannot be a project")
    if PROJECT_DIRNAME in p.parts:
        raise ProjectPathError(f"Pick the project folder, not its {PROJECT_DIRNAME} directory")
    roots = allowed_roots()
    if not any_root and not any(p == r or r in p.parents for r in roots):
        raise ProjectPathError("Directory is outside the allowed roots: " + ", ".join(str(r) for r in roots))
    if must_exist and not p.is_dir():
        raise ProjectPathError("Directory does not exist")
    if must_exist and not os.access(p, os.R_OK | os.W_OK | os.X_OK):
        raise ProjectPathError("Octopus needs read/write access to this directory")
    return p


@dataclass
class ProjectMeta:
    id: str
    name: str
    created_at: str
    existing: bool


GITIGNORE = "# Managed by Octopus. Everything in this folder is local app data.\n*\n"
README = """# .octopus

This folder is created and managed by Octopus, like `.git` for git. It holds everything Octopus knows about
this project: companies (agent teams), chats, run history, file versions and plans.

- `project.json`  project id and name
- `octopus.db`    companies, agents, channels, chats, runs, events, tasks, artifact history
- `work/`         the agents' working documents (specs, plans, briefs, reviews, QA notes); your project folder
                  only gets the deliverables you asked for
- `plans/`        files proposed in Plan mode (applied to the project only when you approve)
- `exports/`      exported companies and run reports
- `browser/`      screenshots and traces from the agents' browser

Deleting this folder resets the project in Octopus (including the agents' working documents in `work/`);
your own files are never stored here.
Git ignores this folder automatically (see `.gitignore` in here).
"""


def ensure_layout(root: Path) -> Path:
    """Create or repair ``<root>/.octopus`` (idempotent, runs every time a project is opened)."""
    data_dir = root / PROJECT_DIRNAME
    data_dir.mkdir(exist_ok=True)
    for sub in ("work", "plans", "exports", "browser"):
        (data_dir / sub).mkdir(exist_ok=True)
    gi = data_dir / ".gitignore"
    if not gi.exists() or gi.read_text(errors="ignore").strip() in ("", "# Octopus local data\noctopus.db*\nplans/"):
        gi.write_text(GITIGNORE)
    rd = data_dir / "README.md"
    if not rd.exists():
        rd.write_text(README)
    return data_dir


def init_project(root: Path, name: str | None = None) -> ProjectMeta:
    """Create (or re-open) ``<root>/.octopus``. Re-opening keeps all existing data and repairs missing pieces."""
    data_dir = ensure_layout(root)
    meta_file = data_dir / "project.json"
    if meta_file.is_file():
        try:
            d = json.loads(meta_file.read_text())
            return ProjectMeta(id=d["id"], name=d.get("name") or root.name, created_at=d.get("created_at", ""), existing=True)
        except (json.JSONDecodeError, KeyError):
            pass  # corrupted → rewrite below, DB (if any) is kept
    meta = {"id": new_id(), "name": name or root.name, "created_at": datetime.now(timezone.utc).isoformat(), "app": "octopus", "schema": 1}
    meta_file.write_text(json.dumps(meta, indent=2))
    return ProjectMeta(id=meta["id"], name=meta["name"], created_at=meta["created_at"], existing=False)


def rename_project(root: Path, name: str) -> None:
    f = root / PROJECT_DIRNAME / "project.json"
    try:
        d = json.loads(f.read_text())
        d["name"] = name
        f.write_text(json.dumps(d, indent=2))
    except (OSError, json.JSONDecodeError):
        pass


@dataclass
class DirEntry:
    name: str
    path: str
    is_project: bool
    is_git: bool


def browse(raw: str | None, show_hidden: bool = False) -> tuple[Path | None, Path | None, list[DirEntry]]:
    """List sub-directories. With no path, list the allowed roots. Returns (current, parent, entries)."""
    roots = allowed_roots()
    if not raw:
        return None, None, [DirEntry(r.name or str(r), str(r), (r / PROJECT_DIRNAME).is_dir(), (r / ".git").exists()) for r in roots if r.is_dir()]
    cur = Path(raw).expanduser().resolve()
    if not any(cur == r or r in cur.parents for r in roots):
        raise ProjectPathError("Outside the allowed roots")
    if not cur.is_dir():
        raise ProjectPathError("Not a directory")
    entries: list[DirEntry] = []
    try:
        for child in sorted(cur.iterdir(), key=lambda c: c.name.lower()):
            if not child.is_dir() or child.is_symlink():
                continue
            if child.name.startswith(".") and not show_hidden:
                continue
            if child.name in (PROJECT_DIRNAME, "node_modules", "__pycache__"):
                continue
            entries.append(DirEntry(child.name, str(child), (child / PROJECT_DIRNAME).is_dir(), (child / ".git").exists()))
            if len(entries) >= 500:
                break
    except PermissionError as exc:
        raise ProjectPathError("Permission denied") from exc
    parent = cur.parent if any(cur.parent == r or r in cur.parent.parents for r in roots) and cur not in roots else None
    return cur, parent, entries


def make_dir(parent: str, name: str) -> Path:
    if not name or "/" in name or "\\" in name or name in (".", "..") or name.startswith("."):
        raise ProjectPathError("Invalid folder name")
    base = validate_project_dir(parent)
    target = base / name
    if target.exists():
        raise ProjectPathError("A folder with that name already exists")
    target.mkdir()
    return target
