"""Sandboxed access to a project directory for agents.

Guarantees:
- Every path is relative to the project root; absolute paths, ``..`` segments, NUL bytes and
  symlinks that resolve outside the root are rejected (checked on the *real* path).
- Octopus' own data (``.octopus/``) and VCS internals (``.git/``) are never readable or writable by agents, with one
  exception: ``.octopus/work/`` is the agents' place for *working material* (plans, specs, briefs, notes, reviews, QA
  reports), so it stays out of the user's project tree. The database, exports and browser data stay sealed.
- Secret-looking files (``.env``, keys, certificates) are always blocked for agents.
"""
from __future__ import annotations

import io
import os
import re
import tempfile
import zipfile
from pathlib import Path, PurePosixPath

from app.foundation.config import PROJECT_DIRNAME
from app.sdk.paths import IGNORED_DIRS, SECRET_ALLOW, SECRET_PATTERNS, is_secret  # noqa: F401 (re-exported)

MAX_FILE_BYTES = 1_000_000
MAX_LIST = 3000
MAX_LIST_DIRECTORIES = 12000
PROTECTED_TOP = {PROJECT_DIRNAME, ".git"}
WORK_DIR = f"{PROJECT_DIRNAME}/work"  # the only agent-accessible subtree of .octopus/


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
    if any(part.lower() in PROTECTED_TOP for part in parts[1:]):
        raise WorkspaceError("Git internals and Octopus metadata are protected inside nested folders too")
    if any(":" in s or s.endswith((".", " ")) or re.fullmatch(r"(?i)(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?", s) for s in parts):
        raise WorkspaceError("Invalid or reserved path component")
    if parts[0].lower() in PROTECTED_TOP and not is_work_path(parts):
        hint = f" (working documents go in {WORK_DIR}/)" if parts[0] == PROJECT_DIRNAME else ""
        raise WorkspaceError(f"'{parts[0]}/' is protected and cannot be accessed by agents{hint}")
    return "/".join(parts)


def is_work_path(parts: tuple[str, ...] | list[str]) -> bool:
    return len(parts) >= 2 and parts[0] == PROJECT_DIRNAME and parts[1] == "work"


class ProjectFS:
    def __init__(self, root: Path) -> None:
        self.root = root.resolve()

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
        if is_secret(rel):
            raise WorkspaceError(f"'{rel}' looks like a secrets file; agents cannot read or change it")
        full = self._inside(self.root, rel)
        # A link inside the project must not expose protected metadata or secrets.
        actual = full.resolve().relative_to(self.root).as_posix()
        normalize_path(actual)
        if is_secret(actual):
            raise WorkspaceError("Symlink points to a secrets file")
        return rel, full

    def current(self, path: str) -> str | None:
        """Current content on disk."""
        rel, real = self.resolve(path)
        return real.read_text(encoding="utf-8", errors="replace") if real.is_file() else None

    def current_file(self, path: str) -> tuple[str, Path] | None:
        """Real file on disk for ``path``, for serving binary assets such as images."""
        rel, real = self.resolve(path)
        return (rel, real) if real.is_file() else None

    def original(self, path: str) -> str | None:
        rel, real = self.resolve(path)
        return real.read_text(encoding="utf-8", errors="replace") if real.is_file() else None

    def write(self, path: str, content: str) -> str:
        rel, target = self.resolve(path)
        data = content.encode("utf-8")
        if len(data) > MAX_FILE_BYTES:
            raise WorkspaceError("File too large (max 1MB)")
        if target.exists() and target.is_dir():
            raise WorkspaceError(f"'{rel}' is a directory")
        target.parent.mkdir(parents=True, exist_ok=True)
        fd, name = tempfile.mkstemp(prefix=f".{target.name}.", suffix=".octopus-tmp", dir=target.parent)
        tmp = Path(name)
        try:
            with os.fdopen(fd, "wb") as stream:
                stream.write(data)
            if target.exists():
                os.chmod(tmp, target.stat().st_mode)
            os.replace(tmp, target)
        finally:
            tmp.unlink(missing_ok=True)
        return rel

    def read(self, path: str) -> str:
        content = self.current(path)
        if content is None:
            raise WorkspaceError(f"File not found: {normalize_path(path)}")
        return content[:MAX_FILE_BYTES]

    def list(self, prefix: str = "") -> list[str]:
        out: set[str] = set()
        visited_dirs = 0
        inspected_entries = 0
        for base in [self.root]:
            start = base
            if prefix:
                rel = normalize_path(prefix)
                start = self._inside(base, rel)
                if not start.is_dir():
                    continue
            pending = [start]
            while pending:
                directory = pending.pop()
                visited_dirs += 1
                if visited_dirs > MAX_LIST_DIRECTORIES:
                    return sorted(out)
                try:
                    with os.scandir(directory) as entries:
                        for entry in entries:
                            inspected_entries += 1
                            if inspected_entries > MAX_LIST + MAX_LIST_DIRECTORIES:
                                return sorted(out)
                            try:
                                if entry.is_symlink():
                                    continue
                                if entry.is_dir(follow_symlinks=False):
                                    if entry.name.lower() not in IGNORED_DIRS:
                                        pending.append(Path(entry.path))
                                    continue
                                if not entry.is_file(follow_symlinks=False):
                                    continue
                                rel = os.path.relpath(entry.path, base).replace("\\", "/")
                                if entry.name.endswith((".pyc", ".octopus-tmp")) or is_secret(rel):
                                    continue
                                out.add(rel)
                                if len(out) >= MAX_LIST:
                                    return sorted(out)
                            except OSError:
                                continue
                except OSError:
                    continue
        return sorted(out)

    def search(self, query: str, *, regex: bool = False, prefix: str = "", max_results: int = 80) -> tuple[list[str], int, int]:
        """``path:line: text`` matches across text files (project + working docs). Returns (matches, total, files searched).

        Literal queries are case-insensitive unless they contain an uppercase letter ("smart case")."""
        flags = 0 if regex or any(c.isupper() for c in query) else re.IGNORECASE
        try:
            pat = re.compile(query if regex else re.escape(query), flags)
        except re.error as exc:
            raise WorkspaceError(f"Invalid regex: {exc}") from exc
        prefix = prefix.strip().strip("/")
        files = self.list(prefix) + ([] if prefix else self.list_work())
        out: list[str] = []
        total = 0
        for rel in files:
            try:
                content = self.current(rel)
            except WorkspaceError:
                continue
            if content is None or len(content) > 2 * MAX_FILE_BYTES or "\x00" in content[:4096]:
                continue  # binary or huge
            for i, line in enumerate(content.splitlines(), 1):
                if pat.search(line):
                    total += 1
                    if len(out) < max_results:
                        out.append(f"{rel}:{i}: {line.strip()[:240]}")
        return out, total, len(files)

    def list_work(self) -> list[str]:
        """The agents' working documents (``.octopus/work/``), as project-relative paths."""
        try:
            return self.list(WORK_DIR)
        except WorkspaceError:
            return []

    def make_dir(self, path: str) -> str:
        """Create a folder (and its parents) inside the project."""
        rel, target = self.resolve(path)
        if target.exists() and not target.is_dir():
            raise WorkspaceError(f"'{rel}' already exists and is a file")
        target.mkdir(parents=True, exist_ok=True)
        return rel

    def move(self, src: str, dst: str) -> tuple[str, str, list[str]]:
        """Move/rename a file or folder inside the project. Returns (src, dst, moved file paths relative to the project)."""
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
        if any(is_secret(m) for m in moved):
            raise WorkspaceError("That move would touch a secrets file")
        d_real.parent.mkdir(parents=True, exist_ok=True)
        os.replace(s_real, d_real)
        return s_rel, d_rel, moved

    def zip_bytes(self, paths: list[str] | None = None, extra: dict[str, str] | None = None) -> bytes:
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            for rel in paths if paths is not None else self.list():
                try:
                    current = self.current_file(rel)
                except WorkspaceError:
                    continue
                if current is not None:
                    zf.write(current[1], arcname=rel)
            for name, content in (extra or {}).items():
                zf.writestr(name, content)
        return buf.getvalue()
