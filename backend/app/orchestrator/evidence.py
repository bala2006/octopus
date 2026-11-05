"""Compatibility shim. The evidence contracts moved to app.core.evidence in Phase 2 (slice B). Removed in Phase 8.

capture_manifest keeps its old signature here. It binds the project file system (tools/workspace.ProjectFS), which core
must not import, so old callers keep working unchanged.
"""
from pathlib import Path
from typing import Iterable

from app.core import evidence as _core
from app.core.evidence import (  # noqa: F401
    MAX_BINARY_BYTES,
    MAX_DIRECTORIES,
    MAX_FILES,
    MAX_OUTPUT_CHARS,
    MAX_TEXT_BYTES,
    MAX_TOTAL_BYTES,
    ArtifactManifest,
    AcceptanceCriterion,
    CheckKind,
    EvidenceStatus,
    EvidenceValidity,
    ExcludedFile,
    FileDigest,
    RevisionEvidence,
    VerificationCheck,
    changed_paths,
    command_is_verification,
    record_evidence,
    redact_evidence,
    validate_evidence,
)
from app.tools.workspace import ProjectFS


def capture_manifest(root: Path, paths: Iterable[str] | None = None, *, known_paths: Iterable[str] = ()) -> ArtifactManifest:
    return _core.capture_manifest(root, paths, known_paths=known_paths, resolver=ProjectFS(Path(root)))
