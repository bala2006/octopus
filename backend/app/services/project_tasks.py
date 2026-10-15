"""Bounded, read-only discovery of developer commands from project manifests."""
from __future__ import annotations

import json
import re
from pathlib import Path

from app.tools.workspace import IGNORED_DIRS, ProjectFS, WorkspaceError

MAX_MANIFEST_BYTES = 100_000
SAFE_NAME = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_:-]{0,99}$")


def discover(root: Path) -> dict:
    fs = ProjectFS(root)
    tasks: list[dict] = []
    warnings: list[str] = []
    directories = [root, *sorted((p for p in root.iterdir() if p.is_dir() and not p.is_symlink()
                                and not p.name.startswith(".") and p.name not in IGNORED_DIRS), key=lambda p: p.name)[:40]]

    def readable(directory: Path, name: str) -> Path | None:
        candidate = directory / name
        if not candidate.is_file() or candidate.is_symlink():
            return None
        try:
            _, safe = fs.resolve(candidate.relative_to(root).as_posix())
            return safe if safe.stat().st_size <= MAX_MANIFEST_BYTES else None
        except (WorkspaceError, OSError):
            return None

    def add(directory: Path, name: str, command: str, source: str, kind: str = "task") -> None:
        rel = directory.relative_to(root).as_posix()
        if len(tasks) < 100:
            tasks.append({"id": f"{rel}:{source}:{name}", "name": name, "command": command,
                          "directory": rel, "source": source, "kind": kind})

    for directory in directories:
        manifest = readable(directory, "package.json")
        if manifest:
            try:
                data = json.loads(manifest.read_text(encoding="utf-8"))
                if not isinstance(data, dict):
                    raise ValueError("package.json must be an object")
                declared = str(data.get("packageManager", "")).split("@")[0]
                manager = declared if declared in ("npm", "pnpm", "yarn", "bun") else next(
                    (m for f, m in (("pnpm-lock.yaml", "pnpm"), ("yarn.lock", "yarn"), ("bun.lock", "bun"),
                                   ("bun.lockb", "bun")) if (directory / f).is_file()), "npm")
                scripts = data.get("scripts", {})
                if isinstance(scripts, dict):
                    for name, script in sorted(scripts.items()):
                        if SAFE_NAME.fullmatch(name) and isinstance(script, str) and script.strip():
                            add(directory, name, f'{manager} run "{name}"', "package.json",
                                "server" if name in ("dev", "start", "serve") else "task")
            except (ValueError, UnicodeError, OSError):
                warnings.append(f"Could not read {manifest.relative_to(root)}")
        makefile = readable(directory, "Makefile")
        if makefile:
            try:
                for name in re.findall(r"^([A-Za-z0-9_-]+):(?:\s|$)", makefile.read_text(encoding="utf-8"), re.M):
                    if name in ("build", "test", "check", "lint", "typecheck", "dev", "start", "setup", "test-backend", "test-frontend"):
                        add(directory, name, f"make {name}", "Makefile", "server" if name in ("dev", "start") else "task")
            except (UnicodeError, OSError):
                warnings.append(f"Could not read {makefile.relative_to(root)}")
        if readable(directory, "Cargo.toml"):
            for name in ("build", "test", "check"):
                add(directory, name, f"cargo {name}", "Cargo.toml")
        if readable(directory, "go.mod"):
            for name in ("build", "test", "vet"):
                add(directory, name, f"go {name} ./...", "go.mod")
        if readable(directory, "pytest.ini") or readable(directory, "pyproject.toml") and (directory / "tests").is_dir():
            add(directory, "test", "python -m pytest", "pytest")
    return {"tasks": tasks, "warnings": warnings}
