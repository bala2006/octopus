"""Recoverable text-artifact staging for trusted-host workers, not an OS sandbox."""
from __future__ import annotations

import hashlib
import os
import re
import tempfile
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from pydantic import Field

from app.core.evidence import ArtifactManifest, ExcludedFile, FileDigest, MAX_DIRECTORIES, MAX_FILES, MAX_TEXT_BYTES, MAX_TOTAL_BYTES
from app.services.skill_contracts import Contract, ContractError, content_hash
from app.tools.workspace import IGNORED_DIRS, ProjectFS, WorkspaceError, is_secret


class WorkspaceConflict(ContractError):
    pass


class StageRecord(Contract):
    canonical_root: str
    run_id: str
    attempt_id: str
    stage_path: str
    base: ArtifactManifest
    trust_mode: str = "trusted-host"


class IntegrationChange(Contract):
    path: str
    before: str | None
    after: str | None


class IntegrationJournal(Contract):
    stage_hash: str
    changes: tuple[IntegrationChange, ...]
    status: str = "applying"
    before_content: dict[str, str | None] = Field(default_factory=dict)
    after_content: dict[str, str | None] = Field(default_factory=dict)


def _excluded(path: str) -> bool:
    # Working documents are agent artifacts. Runtime databases, attachment stores
    # and attempts remain excluded, including nested stage directories.
    if path == ".octopus":
        return False  # Traverse only to the specifically admitted work directory.
    if path == ".octopus/work" or path.startswith(".octopus/work/"):
        tail = path.split("/")[2:]
        return any(part.lower() in IGNORED_DIRS for part in tail) or is_secret(path)
    return any(part.lower() in IGNORED_DIRS for part in path.split("/")) or is_secret(path)


def _safe_path(root: Path, relative: str) -> Path:
    try:
        rel, path = ProjectFS(root).resolve(relative)
    except WorkspaceError as exc:
        raise ContractError(str(exc)) from exc
    if _excluded(rel):
        raise ContractError("Staging cannot access protected or dependency content")
    if path.is_symlink() or any(parent.is_symlink() for parent in path.parents if parent != root and parent.is_relative_to(root)):
        raise ContractError("Staging does not support symlink files or directories")
    return path


def _text_snapshot(root: Path, *, strict: bool = False) -> tuple[ArtifactManifest, dict[str, bytes]]:
    files = []
    excluded = []
    contents = {}
    directories_seen = 0
    entries_seen = 0
    total_bytes = 0
    for base, directories, names in os.walk(root, followlinks=False):
        directories_seen += 1
        if directories_seen > MAX_DIRECTORIES:
            raise ContractError("Staging directory limit exceeded")
        relative_base = Path(base).relative_to(root)
        kept = []
        for name in sorted(directories):
            relative = (relative_base / name).as_posix()
            if _excluded(relative):
                continue
            if (Path(base) / name).is_symlink():
                raise ContractError("Staging does not support symlink directories")
            kept.append(name)
        directories[:] = kept
        for name in sorted(names):
            entries_seen += 1
            if entries_seen > MAX_FILES:
                raise ContractError("Staging file limit exceeded")
            relative = (relative_base / name).as_posix()
            if _excluded(relative):
                if strict and is_secret(relative):
                    raise ContractError("Worker created protected or secret content in its stage")
                continue
            path = _safe_path(root, relative)
            if not path.is_file():
                raise ContractError("Stage entry is not a regular file")
            before = path.stat()
            if before.st_size > MAX_TEXT_BYTES:
                if strict:
                    raise ContractError("Worker artifact exceeds text staging limit")
                excluded.append(ExcludedFile(path=relative, reason="outside text staging size limit"))
                continue
            with path.open("rb") as stream:
                raw = stream.read(MAX_TEXT_BYTES + 1)
            after = path.stat()
            if len(raw) > MAX_TEXT_BYTES or (before.st_size, before.st_mtime_ns, before.st_ino) != (after.st_size, after.st_mtime_ns, after.st_ino):
                raise WorkspaceConflict("Project changed during stage capture")
            try:
                text = raw.decode("utf-8")
                if "\x00" in text:
                    raise UnicodeError("binary")
            except UnicodeError as exc:
                if strict:
                    raise ContractError("Binary worker artifacts require a separate reviewed integration path") from exc
                excluded.append(ExcludedFile(path=relative, reason="binary file outside text staging"))
                continue
            files.append(FileDigest(path=relative, sha256=hashlib.sha256(raw).hexdigest(), size=len(raw)))
            total_bytes += len(raw)
            if total_bytes > MAX_TOTAL_BYTES:
                raise ContractError("Staging total text byte limit exceeded")
            contents[relative] = raw
    files.sort(key=lambda file: file.path)
    excluded.sort(key=lambda file: file.path)
    payload = {"files": [file.model_dump() for file in files], "excluded": [file.model_dump() for file in excluded], "scope": "eligible-text"}
    manifest = ArtifactManifest(files=tuple(files), excluded=tuple(excluded), selection=tuple(file.path for file in files), content_hash=content_hash(payload))
    return manifest, contents


def _record_path(root: Path, run_id: str, attempt_id: str) -> Path:
    for value in (run_id, attempt_id):
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,99}", value) or re.fullmatch(r"(?i)(con|prn|aux|nul|com[1-9]|lpt[1-9])", value):
            raise ContractError("Invalid run or attempt identifier")
    directory = root / ".octopus" / "attempts" / run_id / attempt_id
    if not directory.is_relative_to(root):  # ids are validated above, so this is lexical
        raise ContractError("Attempt storage escapes the canonical project")
    cursor = directory
    while cursor != root:
        if cursor.is_symlink():
            raise ContractError("Attempt storage cannot be symlinked")
        cursor = cursor.parent
    return directory / "stage.json"


def _write_json(path: Path, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, name = tempfile.mkstemp(prefix=".state-", dir=path.parent)
    temporary = Path(name)
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as stream:
            stream.write(value)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def load_stage(root: Path, run_id: str, attempt_id: str) -> tuple[Path, ArtifactManifest]:
    root = root.resolve()
    metadata = _record_path(root, run_id, attempt_id)
    if not metadata.is_file() or metadata.stat().st_size > 2_000_000:
        raise ContractError("Attempt stage record is missing or too large")
    record = StageRecord.model_validate_json(metadata.read_text(encoding="utf-8"))
    stage = metadata.parent / "files"
    if (record.canonical_root != str(root) or record.run_id != run_id or record.attempt_id != attempt_id
            or record.stage_path != str(stage) or not stage.is_dir() or stage.is_symlink()):
        raise ContractError("Attempt stage identity does not match its canonical project")
    return stage, record.base


def create_stage(root: Path, run_id: str, attempt_id: str) -> tuple[Path, ArtifactManifest]:
    """Create once, or reopen the recorded stage without overwriting worker edits.

    Only eligible UTF-8 project text is copied. Dependencies and private Octopus
    state stay at the canonical root; commands needing them must be capability-
    checked by the caller rather than silently changing cwd back to canonical.
    """
    root = root.resolve()
    if not root.is_dir():
        raise ContractError("Canonical project must exist")
    metadata = _record_path(root, run_id, attempt_id)
    if metadata.exists():
        return load_stage(root, run_id, attempt_id)
    stage = metadata.parent / "files"
    if stage.exists():
        raise WorkspaceConflict("Incomplete stage exists without a record; reconcile it before retrying")
    base, contents = _text_snapshot(root)
    stage.mkdir(parents=True, exist_ok=False)
    for relative, raw in contents.items():
        target = _safe_path(stage, relative)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(raw)
    record = StageRecord(canonical_root=str(root), run_id=run_id, attempt_id=attempt_id, stage_path=str(stage), base=base)
    _write_json(metadata, record.model_dump_json())
    return stage, base


@contextmanager
def _integration_lock(root: Path) -> Iterator[None]:
    # OS locks are released on process exit, even when the lock file remains.
    directory = root / ".octopus" / "attempts"
    directory.mkdir(parents=True, exist_ok=True)
    lock = directory / "integration.lock"
    if directory.is_symlink() or lock.is_symlink() or not directory.resolve().is_relative_to(root):
        raise ContractError("Integration lock path is unsafe")
    with lock.open("a+b") as stream:
        if stream.seek(0, os.SEEK_END) == 0:
            stream.write(b"0")
            stream.flush()
        stream.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            raise WorkspaceConflict("Another integration owns this project") from exc
        try:
            yield
        finally:
            stream.seek(0)
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


def _current_hash(root: Path, relative: str) -> str | None:
    path = _safe_path(root, relative)
    if not path.exists():
        return None
    if not path.is_file() or path.stat().st_size > MAX_TEXT_BYTES:
        raise WorkspaceConflict(f"Canonical target changed type or size: {relative}")
    return hashlib.sha256(path.read_bytes()).hexdigest()


def integrate(stage: Path, root: Path, base: ArtifactManifest, *, write_paths: tuple[str, ...] = ("*",)) -> tuple[str, ...]:
    """Integrate an owned stage with conflict checks and a restartable apply journal.

    The lock serializes Octopus integrations. Trusted-host processes can still write
    absolute canonical paths; this function is not containment against such writes.
    A crash may leave a partial apply. Repeating this call reconciles only files
    whose hashes match the recorded before/after states, without guessing.
    """
    original_stage = stage.absolute()
    for ancestor in [original_stage, *original_stage.parents]:
        if ancestor.is_symlink():
            raise ContractError("Attempt path cannot be symlinked")
    root, stage = root.resolve(), stage.resolve()
    attempt_directory = stage.parent
    metadata = attempt_directory / "stage.json"
    if stage.name != "files" or not metadata.is_file() or not metadata.resolve().is_relative_to(root / ".octopus" / "attempts"):
        raise ContractError("Only a recorded attempt stage can be integrated")
    record = StageRecord.model_validate_json(metadata.read_text(encoding="utf-8"))
    if record.canonical_root != str(root) or record.stage_path != str(stage) or record.base != base:
        raise ContractError("Integration base or project identity does not match the pinned stage")
    expected_path = _record_path(root, record.run_id, record.attempt_id)
    if expected_path != metadata:
        raise ContractError("Stage record is outside its owned attempt")
    for ancestor in [stage, *stage.parents]:
        if ancestor == root:
            break
        if ancestor.is_symlink():
            raise ContractError("Attempt path cannot be symlinked")
    current_stage, contents = _text_snapshot(stage, strict=True)
    before = {file.path: file.sha256 for file in base.files}
    after = {file.path: file.sha256 for file in current_stage.files}
    changes = tuple(IntegrationChange(path=path, before=before.get(path), after=after.get(path))
                    for path in sorted(before.keys() | after.keys()) if before.get(path) != after.get(path))
    from app.core.task_contracts import permits_path
    denied = [change.path for change in changes if not permits_path(write_paths, change.path)]
    if denied:
        raise WorkspaceConflict("Worker changed files outside its task write scope: " + ", ".join(denied))
    journal_path = attempt_directory / "integration.json"
    with _integration_lock(root):
        journal = IntegrationJournal.model_validate_json(journal_path.read_text(encoding="utf-8")) if journal_path.exists() else None
        if journal and (journal.stage_hash != current_stage.content_hash or journal.changes != changes):
            raise WorkspaceConflict("Worker stage changed after integration began; create a new attempt")
        for change in changes:
            actual = _current_hash(root, change.path)
            allowed = {change.after} if journal and journal.status == "applied" else {change.before, change.after} if journal else {change.before}
            if actual not in allowed:
                raise WorkspaceConflict(f"Canonical file changed since the attempt base: {change.path}")
        if journal and journal.status == "applied":
            return tuple(change.path for change in changes)
        if journal is None:
            originals = {change.path: (_safe_path(root, change.path).read_bytes().decode("utf-8")
                                      if change.before is not None else None) for change in changes}
            if any(hashlib.sha256(originals[change.path].encode("utf-8")).hexdigest() != change.before
                   for change in changes if originals[change.path] is not None):
                raise WorkspaceConflict("Canonical file changed while capturing original artifact content")
            journal = IntegrationJournal(stage_hash=current_stage.content_hash, changes=changes, before_content=originals,
                after_content={change.path: contents[change.path].decode("utf-8") if change.after is not None else None
                               for change in changes})
        _write_json(journal_path, journal.model_dump_json())
        for change in changes:
            actual = _current_hash(root, change.path)
            if actual == change.after:
                continue
            if actual != change.before:
                raise WorkspaceConflict(f"Canonical file changed during integration: {change.path}")
            target = _safe_path(root, change.path)
            if change.after is None:
                target.unlink(missing_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                handle, name = tempfile.mkstemp(prefix=f".{target.name}.", suffix=".octopus-tmp", dir=target.parent)
                temporary = Path(name)
                try:
                    with os.fdopen(handle, "wb") as stream:
                        stream.write(contents[change.path])
                        stream.flush()
                        os.fsync(stream.fileno())
                    if _current_hash(root, change.path) != change.before:
                        raise WorkspaceConflict(f"Canonical file changed during integration: {change.path}")
                    if target.exists():
                        os.chmod(temporary, target.stat().st_mode)
                    os.replace(temporary, target)
                finally:
                    temporary.unlink(missing_ok=True)
        _write_json(journal_path, journal.model_copy(update={"status": "applied"}).model_dump_json())
    return tuple(change.path for change in changes)


def integration_status(root: Path, run_id: str, attempt_id: str) -> IntegrationJournal | None:
    """Inspect recovery state; ``integrate`` safely resumes a journal marked applying."""
    stage, _ = load_stage(root, run_id, attempt_id)
    path = stage.parent / "integration.json"
    if not path.exists():
        return None
    if path.is_symlink() or path.stat().st_size > 12 * MAX_TOTAL_BYTES + 2_000_000:
        raise ContractError("Unsafe integration journal")
    return IntegrationJournal.model_validate_json(path.read_text(encoding="utf-8"))
