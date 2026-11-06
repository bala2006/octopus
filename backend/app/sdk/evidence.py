"""Revision-bound verification records, with bounded file hashing and scoped coverage.

This module observes files and evaluates records. It never executes a command or
turns an agent's success claim into a trusted tool observation.
"""
from __future__ import annotations

import hashlib
import os
import re
import shlex
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Literal, Protocol

from pydantic import Field

from app.sdk.contracts import Contract, ContractError, content_hash
from app.sdk.paths import IGNORED_DIRS, is_secret

EvidenceStatus = Literal["pass", "fail", "unknown"]
CheckKind = Literal["command", "ui", "review", "source", "human"]
MAX_FILES = 3000
MAX_DIRECTORIES = 12000
MAX_TEXT_BYTES = 1_000_000
MAX_BINARY_BYTES = 4_000_000
MAX_TOTAL_BYTES = 40_000_000
MAX_OUTPUT_CHARS = 12_000


class ProjectPaths(Protocol):
    """Resolves a project-relative path to (relative path, real path) and raises on paths outside the project.

    capabilities/workspace/project_fs.ProjectFS implements it. Core takes the resolver as an argument because the file system layer sits above core.
    """

    def resolve(self, path: str) -> tuple[str, Path]: ...


class FileDigest(Contract):
    path: str
    sha256: str | None
    size: int = 0
    exists: bool = True


class ExcludedFile(Contract):
    path: str
    reason: str
    required: bool = False


class ArtifactManifest(Contract):
    files: tuple[FileDigest, ...]
    excluded: tuple[ExcludedFile, ...] = ()
    selection: tuple[str, ...] | None = None
    complete: bool = True
    content_hash: str


def _excluded_path(relative: str) -> bool:
    parts = relative.replace("\\", "/").split("/")
    return any(part.lower() in IGNORED_DIRS for part in parts) or is_secret(relative)


def capture_manifest(root: Path, paths: Iterable[str] | None = None, *, known_paths: Iterable[str] = (),
                     resolver: ProjectPaths) -> ArtifactManifest:
    """Hash eligible real files. Explicit selections include missing files as tombstones.

    Metadata, dependency directories and secret filenames are never read. Binary
    files are hashed without storing their contents. Limits make ``complete`` false,
    so an incomplete inventory cannot certify a whole-project check.
    """
    root = root.resolve()
    if not root.is_dir():
        raise ContractError("Manifest root must be a project directory")
    fs = resolver
    selection = tuple(sorted(set(paths))) if paths is not None else None
    excluded: list[ExcludedFile] = []
    candidates: list[str] = []
    complete = True
    if selection is not None:
        normalized = []
        for relative in selection:
            rel, _ = fs.resolve(relative)
            if _excluded_path(rel):
                raise ContractError("Evidence selection includes protected or dependency content")
            normalized.append(rel)
        selection = tuple(sorted(set(normalized)))
        candidates = list(selection)
    else:
        visited = 0
        for base, directories, names in os.walk(root, followlinks=False):
            visited += 1
            relative_base = Path(base).relative_to(root)
            kept = []
            for name in sorted(directories):
                relative = (relative_base / name).as_posix()
                if _excluded_path(relative):
                    continue
                if (Path(base) / name).is_symlink():
                    excluded.append(ExcludedFile(path=relative, reason="symlink directory", required=True))
                    complete = False
                    continue
                kept.append(name)
            directories[:] = kept
            if visited > MAX_DIRECTORIES:
                excluded.append(ExcludedFile(path=relative_base.as_posix(), reason="directory limit", required=True))
                complete = False
                break
            for name in sorted(names):
                relative = (relative_base / name).as_posix()
                if not _excluded_path(relative):
                    candidates.append(relative)
                if len(candidates) > MAX_FILES:
                    complete = False
                    break
            if not complete and len(candidates) > MAX_FILES:
                break
    if selection is None:
        for relative in sorted(set(known_paths)):
            rel, _ = fs.resolve(relative)
            if not _excluded_path(rel) and rel not in candidates:
                candidates.append(rel)
    files: list[FileDigest] = []
    total = 0
    for relative in sorted(candidates):
        if len(files) >= MAX_FILES:
            excluded.append(ExcludedFile(path=relative, reason="file count limit", required=True))
            complete = False
            break
        try:
            rel, path = fs.resolve(relative)
            if path.is_symlink() or any(parent.is_symlink() for parent in path.parents if parent != root and parent.is_relative_to(root)):
                raise ContractError("symlink file")
            if not path.exists():
                files.append(FileDigest(path=rel, sha256=None, exists=False))
                continue
            if not path.is_file():
                raise ContractError("not a regular file")
            before = path.stat()
            if before.st_size > MAX_BINARY_BYTES or total + before.st_size > MAX_TOTAL_BYTES:
                raise ContractError("file or total byte limit")
            with path.open("rb") as stream:
                raw = stream.read(MAX_BINARY_BYTES + 1)
            if len(raw) > MAX_BINARY_BYTES:
                raise ContractError("file byte limit")
            try:
                text = raw.decode("utf-8")
                binary = "\x00" in text
            except UnicodeError:
                binary = True
            if not binary and len(raw) > MAX_TEXT_BYTES:
                raise ContractError("text byte limit")
            after = path.stat()
            if (before.st_size, before.st_mtime_ns, before.st_ino) != (after.st_size, after.st_mtime_ns, after.st_ino) or len(raw) != after.st_size:
                raise ContractError("file changed while being hashed")
            total += len(raw)
            files.append(FileDigest(path=rel, sha256=hashlib.sha256(raw).hexdigest(), size=len(raw)))
        except (OSError, ValueError) as exc:
            excluded.append(ExcludedFile(path=relative, reason=str(exc)[:200], required=True))
            complete = False
    payload = {"files": [file.model_dump() for file in files], "selection": selection,
               "excluded": [item.model_dump() for item in excluded], "complete": complete}
    return ArtifactManifest(files=tuple(files), selection=selection, excluded=tuple(excluded), complete=complete, content_hash=content_hash(payload))


def changed_paths(before: ArtifactManifest, after: ArtifactManifest) -> tuple[str, ...]:
    old = {file.path: (file.sha256, file.exists) for file in before.files}
    new = {file.path: (file.sha256, file.exists) for file in after.files}
    return tuple(sorted(path for path in old.keys() | new.keys() if old.get(path) != new.get(path)))


_SECRET_VALUE = re.compile(r"(?i)(\b(?:api[_-]?key|token|access[_-]?token|refresh[_-]?token|password|passwd|secret|authorization|client[_-]?secret)\b[\"']?\s*[:=]\s*)(?:\"[^\"]*\"|'[^']*'|[^\s,;}]+)")
_BEARER = re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+")
_KEY_TOKEN = re.compile(r"\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{15,}|github_pat_[A-Za-z0-9_]{15,}|AKIA[A-Z0-9]{16})\b")
_PEM = re.compile(r"-----BEGIN (?:[A-Z ]*PRIVATE KEY)-----.*?-----END (?:[A-Z ]*PRIVATE KEY)-----", re.S)
_URL_PASSWORD = re.compile(r"(\b[a-zA-Z][a-zA-Z0-9+.-]*://[^\s/:@]+:)[^\s/@]+(@)")


def redact_evidence(text: str) -> str:
    """Best-effort capture filter, not a guarantee that arbitrary output is non-sensitive."""
    value = _PEM.sub("[REDACTED PRIVATE KEY]", text)
    value = _BEARER.sub("Bearer [REDACTED]", value)
    value = _SECRET_VALUE.sub(lambda match: match.group(1) + "[REDACTED]", value)
    value = _KEY_TOKEN.sub("[REDACTED TOKEN]", value)
    value = _URL_PASSWORD.sub(r"\1[REDACTED]\2", value)
    return value[:MAX_OUTPUT_CHARS] + ("\n[Output truncated]" if len(value) > MAX_OUTPUT_CHARS else "")


class VerificationCheck(Contract):
    kind: CheckKind
    name: str = Field(min_length=1, max_length=300)
    tool_call_id: str = ""
    command: str = ""
    exit_code: int | None = None
    scenario: str = ""
    observed: bool = False


class AcceptanceCriterion(Contract):
    id: str = Field(min_length=1)
    description: str
    check_kinds: tuple[CheckKind, ...] = ("command", "ui")
    required_paths: tuple[str, ...] = ()


class RevisionEvidence(Contract):
    id: str
    task_revision: int = Field(ge=1)
    environment_hash: str
    manifest_hash: str
    coverage: tuple[FileDigest, ...]
    whole_project: bool = False
    criterion_ids: tuple[str, ...]
    producer: str
    check: VerificationCheck
    status: EvidenceStatus
    output: str
    captured_at: str
    limitations: tuple[str, ...] = ()


class EvidenceValidity(Contract):
    valid: bool
    status: EvidenceStatus
    reasons: tuple[str, ...] = ()


def command_is_verification(command: str) -> bool:
    try:
        args = shlex.split(command, posix=True)
    except ValueError:
        return False
    if not args or any(token in command for token in (";", "&&", "||", "|", "`", "$(", "\n", "\r")):
        return False
    exe = args[0].replace("\\", "/").rsplit("/", 1)[-1].lower().removesuffix(".exe").removesuffix(".cmd")
    tail = [arg.lower() for arg in args[1:]]
    if exe in {"pytest", "vitest", "jest", "tsc"}:
        return True
    if exe in {"python", "python3"}:
        return len(tail) >= 2 and tail[0] == "-m" and tail[1] in {"pytest", "unittest", "compileall", "py_compile"}
    if exe in {"npm", "pnpm", "yarn"}:
        if tail[:1] == ["run"]:
            tail = tail[1:]
        return bool(tail) and tail[0] in {"test", "build", "lint", "typecheck", "check", "e2e"}
    if exe in {"cargo", "go", "flutter"}:
        return bool(tail) and tail[0] in {"test", "check", "analyze"}
    if exe in {"make", "cmake"}:
        return bool(tail) and tail[0] in {"test", "check", "build", "--build"}
    if exe == "ruff":
        return tail[:1] == ["check"]
    if exe == "node":
        return tail[:1] == ["--check"] and len(tail) == 2
    return False


def _check_blocker(check: VerificationCheck) -> str | None:
    if not check.observed or not check.tool_call_id:
        return "No trusted execution or inspection observation"
    if check.kind == "command":
        if check.exit_code != 0:
            return "Command did not exit successfully"
        if not command_is_verification(check.command):
            return "Command is not a recognized verification entry point"
    elif not check.scenario.strip():
        return "Inspection needs a concrete interaction or source-review scenario"
    return None


def record_evidence(manifest: ArtifactManifest, *, task_revision: int, environment: object,
                    criterion_ids: Iterable[str], check: VerificationCheck, status: EvidenceStatus,
                    covered_paths: Iterable[str] | None = None, whole_project: bool = False,
                    producer: str, output: str = "") -> RevisionEvidence:
    """Record a trusted runner observation. Agents must not construct ``observed`` themselves.

    Explicit coverage limits what this record can certify. Omitting it certifies no
    files. Whole-project proof requires explicit full coverage and an unselected inventory.
    The caller must capture before/after execution and reject changes during a check.
    """
    inventory = {file.path: file for file in manifest.files}
    covered = set(covered_paths or ())
    limitations = []
    if not covered.issubset(inventory):
        raise ContractError("Evidence coverage contains files outside its manifest")
    if whole_project and (manifest.selection is not None or covered != set(inventory)):
        raise ContractError("Whole-project evidence requires the complete unselected manifest")
    if inventory and not covered:
        limitations.append("No artifact coverage is identified")
    if not manifest.complete:
        limitations.append("Artifact inventory is incomplete")
    if blocker := _check_blocker(check):
        limitations.append(blocker)
    criteria = tuple(sorted(set(criterion_ids)))
    if not criteria:
        limitations.append("No acceptance criterion is identified")
    if not producer.strip():
        limitations.append("No verifier identity is recorded")
    if status == "pass" and limitations:
        status = "unknown"
    safe_check = check.model_copy(update={"name": redact_evidence(check.name), "command": redact_evidence(check.command), "scenario": redact_evidence(check.scenario)})
    captured = datetime.now(timezone.utc).isoformat()
    payload = dict(task_revision=task_revision, environment_hash=content_hash(environment), manifest_hash=manifest.content_hash,
                   coverage=tuple(inventory[path] for path in sorted(covered)), whole_project=whole_project,
                   criterion_ids=criteria, producer=producer, check=safe_check, status=status,
                   output=redact_evidence(output), captured_at=captured, limitations=tuple(limitations))
    identity = content_hash({**payload, "coverage": [file.model_dump() for file in payload["coverage"]], "check": safe_check.model_dump()})
    return RevisionEvidence(id=identity, **payload)


def validate_evidence(evidence: RevisionEvidence, current_manifest: ArtifactManifest, *, task_revision: int,
                      environment: object, criterion: AcceptanceCriterion | str) -> EvidenceValidity:
    criterion_id = criterion if isinstance(criterion, str) else criterion.id
    reasons = list(evidence.limitations)
    if blocker := _check_blocker(evidence.check):
        reasons.append(blocker)
    if evidence.status != "pass":
        reasons.append(f"Recorded result is {evidence.status}")
    if task_revision != evidence.task_revision:
        reasons.append("Task revision changed")
    if content_hash(environment) != evidence.environment_hash:
        reasons.append("Verification environment changed")
    if criterion_id not in evidence.criterion_ids:
        reasons.append("Acceptance criterion is not covered")
    if not current_manifest.complete:
        reasons.append("Current artifact inventory is incomplete")
    current = {file.path: file for file in current_manifest.files}
    for certified in evidence.coverage:
        actual = current.get(certified.path)
        if actual is None or (actual.sha256, actual.exists) != (certified.sha256, certified.exists):
            reasons.append(f"Artifact changed: {certified.path}")
    if evidence.whole_project and current_manifest.content_hash != evidence.manifest_hash:
        reasons.append("Project manifest changed")
    if not isinstance(criterion, str):
        if evidence.check.kind not in criterion.check_kinds:
            reasons.append("Check kind does not satisfy this criterion")
        if not set(criterion.required_paths).issubset({file.path for file in evidence.coverage}):
            reasons.append("Required artifacts are not covered")
    valid = not reasons
    return EvidenceValidity(valid=valid, status=evidence.status if valid or evidence.status == "fail" else "unknown", reasons=tuple(dict.fromkeys(reasons)))

