"""Sandboxed access to a project directory for agents.

Guarantees:
- Every path is relative to the project root; absolute paths, ``..`` segments, NUL bytes and
  symlinks that resolve outside the root are rejected (checked on the *real* path).
- Octopus' own data (``.octopus/``) and VCS internals (``.git/``) are never readable or writable by agents, with one
  exception: ``.octopus/work/`` is the agents' place for *working material* (plans, specs, briefs, notes, reviews, QA
  reports), so it stays out of the user's project tree. The database, plans, exports and browser data stay sealed.
- Secret-looking files (``.env``, keys, certificates) are blocked unless the run is in ``danger`` mode.
- In ``plan`` mode writes go to a shadow directory (``.octopus/plans/<run_id>/``); reads prefer the
  shadow copy, so agents see their own planned changes while the project stays untouched.
"""
from __future__ import annotations

import fnmatch
import io
import os
import zipfile
from pathlib import Path, PurePosixPath

from app.core.config import PROJECT_DIRNAME

MAX_FILE_BYTES = 1_000_000
MAX_LIST = 3000
IGNORED_DIRS = {".git", PROJECT_DIRNAME, "node_modules", "__pycache__", ".venv", "venv", ".mypy_cache", ".pytest_cache",
                ".ruff_cache", "dist", "build", ".next", ".turbo", ".idea", ".vscode", ".DS_Store"}
PROTECTED_TOP = {PROJECT_DIRNAME, ".git"}
WORK_DIR = f"{PROJECT_DIRNAME}/work"  # the only agent-accessible subtree of .octopus/
SECRET_PATTERNS = [".env", ".env.*", "*.pem", "*.key", "*.p12", "*.pfx", "id_rsa*", "id_ed25519*", ".npmrc", ".pypirc",
                   ".netrc", "credentials*", "*.keystore", "secrets.*"]
SECRET_ALLOW = {".env.example", ".env.sample", ".env.template"}


class WorkspaceError(ValueError):
    pass


def normalize_path(path: str) -> str:
    p = (path or "").strip().replace("\\", "/")
    if not p:
        raise WorkspaceError("Empty path")
    if "\x00" in p:
        raise WorkspaceError("Invalid path")
    if p.startswith("/") or p.startswith("~") or (len(p) > 1 and p[1] == ":"):
        raise WorkspaceError("Absolute paths are not allowed; use a path relative to the project root")
    parts = [s for s in PurePosixPath(p).parts if s not in ("", ".")]
    if any(s == ".." for s in parts):
        raise WorkspaceError("Path traversal ('..') is not allowed")
    if not parts or len(p) > 400:
        raise WorkspaceError("Invalid path")
    if parts[0] in PROTECTED_TOP and not is_work_path(parts):
        hint = f" (working documents go in {WORK_DIR}/)" if parts[0] == PROJECT_DIRNAME else ""
        raise WorkspaceError(f"'{parts[0]}/' is protected and cannot be accessed by agents{hint}")
    return "/".join(parts)


def is_work_path(parts: tuple[str, ...] | list[str]) -> bool:
    return len(parts) >= 2 and parts[0] == PROJECT_DIRNAME and parts[1] == "work"


def is_secret(rel: str) -> bool:
    name = rel.rsplit("/", 1)[-1]
    if name in SECRET_ALLOW:
        return False
    return any(fnmatch.fnmatch(name, pat) for pat in SECRET_PATTERNS)


class ProjectFS:
    def __init__(self, root: Path, *, shadow: Path | None = None, allow_secrets: bool = False) -> None:
        self.root = root.resolve()
        self.shadow = shadow.resolve() if shadow else None
        self.allow_secrets = allow_secrets
        if self.shadow:
            self.shadow.mkdir(parents=True, exist_ok=True)

    def _inside(self, base: Path, rel: str) -> Path:
        full = base / rel
        # resolve the deepest existing ancestor so symlinked parents are checked too
        probe = full
        while not probe.exists() and probe != base:
            probe = probe.parent
        real = probe.resolve()
        if real != base and base not in real.parents:
            raise WorkspaceError("Path escapes the project directory (symlink or traversal)")
        if full.exists() and full.is_symlink():
            target = full.resolve()
            if target != base and base not in target.parents:
                raise WorkspaceError("Symlink points outside the project directory")
        return full

    def resolve(self, path: str) -> tuple[str, Path]:
        rel = normalize_path(path)
        if not self.allow_secrets and is_secret(rel):
            raise WorkspaceError(f"'{rel}' looks like a secrets file; access requires danger mode")
        return rel, self._inside(self.root, rel)

    def target_for_write(self, path: str) -> tuple[str, Path]:
        rel, real = self.resolve(path)
        if self.shadow:
            return rel, self._inside(self.shadow, rel)
        return rel, real

    def current(self, path: str) -> str | None:
        """Current content as the agent sees it (shadow first in plan mode)."""
        rel, real = self.resolve(path)
        if self.shadow:
            sh = self._inside(self.shadow, rel)
            if sh.is_file():
                return sh.read_text(encoding="utf-8", errors="replace")
        return real.read_text(encoding="utf-8", errors="replace") if real.is_file() else None

    def current_file(self, path: str) -> tuple[str, Path] | None:
        """Real file on disk for ``path`` (shadow first in plan mode), for serving binary assets such as images."""
        rel, real = self.resolve(path)
        if self.shadow:
            sh = self._inside(self.shadow, rel)
            if sh.is_file():
                return rel, sh
        return (rel, real) if real.is_file() else None

    def original(self, path: str) -> str | None:
        rel, real = self.resolve(path)
        return real.read_text(encoding="utf-8", errors="replace") if real.is_file() else None

    def write(self, path: str, content: str) -> str:
        rel, target = self.target_for_write(path)
        data = content.encode("utf-8")
        if len(data) > MAX_FILE_BYTES:
            raise WorkspaceError("File too large (max 1MB)")
        if target.exists() and target.is_dir():
            raise WorkspaceError(f"'{rel}' is a directory")
        target.parent.mkdir(parents=True, exist_ok=True)
        tmp = target.with_name(f".{target.name}.octopus-tmp")
        tmp.write_bytes(data)
        os.replace(tmp, target)  # atomic
        return rel

    def read(self, path: str) -> str:
        content = self.current(path)
        if content is None:
            raise WorkspaceError(f"File not found: {normalize_path(path)}")
        return content[:MAX_FILE_BYTES]

    def list(self, prefix: str = "") -> list[str]:
        out: set[str] = set()
        for base in [self.root] + ([self.shadow] if self.shadow else []):
            start = base
            if prefix:
                rel = normalize_path(prefix)
                start = self._inside(base, rel)
                if not start.is_dir():
                    continue
            for dirpath, dirnames, filenames in os.walk(start):
                dirnames[:] = [d for d in dirnames if d not in IGNORED_DIRS and not os.path.islink(os.path.join(dirpath, d))]
                for f in filenames:
                    rel = os.path.relpath(os.path.join(dirpath, f), base).replace("\\", "/")
                    if f.endswith((".pyc", ".octopus-tmp")) or (not self.allow_secrets and is_secret(rel)):
                        continue
                    out.add(rel)
                    if len(out) >= MAX_LIST:
                        return sorted(out)
        return sorted(out)

    def list_work(self) -> list[str]:
        """The agents' working documents (``.octopus/work/``), as project-relative paths."""
        try:
            return self.list(WORK_DIR)
        except WorkspaceError:
            return []

    def make_dir(self, path: str) -> str:
        """Create a folder (and its parents) inside the project; in plan mode it goes to the plan shadow."""
        rel, target = self.target_for_write(path)
        if target.exists() and not target.is_dir():
            raise WorkspaceError(f"'{rel}' already exists and is a file")
        target.mkdir(parents=True, exist_ok=True)
        return rel

    def move(self, src: str, dst: str) -> tuple[str, str, list[str]]:
        """Move/rename a file or folder inside the project. Returns (src, dst, moved file paths relative to the project)."""
        if self.shadow:
            raise WorkspaceError("Plan mode: files can't be moved; write the new file with write_file instead")
        s_rel, s_real = self.resolve(src)
        d_rel, d_real = self.resolve(dst)
        if s_rel == WORK_DIR:
            raise WorkspaceError(f"'{WORK_DIR}' itself can't be moved; move the files inside it")
        if not s_real.exists():
            raise WorkspaceError(f"Not found: {s_rel}")
        if s_real.is_symlink():
            raise WorkspaceError("Symlinks can't be moved")
        if d_real.exists() and d_real.is_dir() and not s_real.is_dir():  # move a file into a folder
            d_rel, d_real = self.resolve(f"{d_rel}/{s_real.name}")
        if d_real.exists():
            raise WorkspaceError(f"'{d_rel}' already exists")
        if s_real.is_dir() and (d_real == s_real or s_real in d_real.parents):
            raise WorkspaceError("Can't move a folder into itself")
        moved = [f"{d_rel}/{os.path.relpath(os.path.join(dp, f), s_real)}".replace("\\", "/") for dp, _, fs in os.walk(s_real) for f in fs] \
            if s_real.is_dir() else [d_rel]
        if not self.allow_secrets and any(is_secret(m) for m in moved):
            raise WorkspaceError("That move would touch a secrets file; it requires danger mode")
        d_real.parent.mkdir(parents=True, exist_ok=True)
        os.replace(s_real, d_real)
        return s_rel, d_rel, moved

    def zip_bytes(self, paths: list[str] | None = None, extra: dict[str, str] | None = None) -> bytes:
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            for rel in paths if paths is not None else self.list():
                try:
                    content = self.current(rel)
                except WorkspaceError:
                    continue
                if content is not None:
                    zf.writestr(rel, content)
            for name, content in (extra or {}).items():
                zf.writestr(name, content)
        return buf.getvalue()
