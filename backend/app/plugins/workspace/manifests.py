"""Artifact manifests for a project folder.

Core builds the manifest from a resolver that reads files. This module supplies the project filesystem
(``ProjectFS``) as that resolver, so callers that only have a folder path can build a manifest in one call.
"""
from __future__ import annotations

from collections.abc import Iterable
from pathlib import Path

from app.plugins.workspace.project_fs import ProjectFS
from app.sdk import evidence as _core
from app.sdk.evidence import ArtifactManifest


def capture_manifest(root: Path, paths: Iterable[str] | None = None, *, known_paths: Iterable[str] = ()) -> ArtifactManifest:
    return _core.capture_manifest(root, paths, known_paths=known_paths, resolver=ProjectFS(Path(root)))
