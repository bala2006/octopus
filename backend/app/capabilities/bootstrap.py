"""Installs the built-in capabilities (models, project filesystem, skills) into the core ports.

Call ``install()`` once at startup, before any run starts. ``app.main`` does this.
"""
from __future__ import annotations

from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

from app.capabilities.models.router import stream_with_retry
from app.capabilities.skills import library as skill_library
from app.capabilities.workspace.project_fs import ProjectFS
from app.core import ports
from app.core.llm import LLMChunk, LLMRequest


class BuiltinCapabilities:
    def stream_llm(self, req: LLMRequest, /) -> AsyncIterator[LLMChunk]:
        return stream_with_retry(req)

    def project_fs(self, root: Path) -> Any:
        return ProjectFS(root)

    def builtin_skills(self) -> dict[str, Any]:
        return skill_library.builtin_skills()


def install() -> None:
    ports.install(BuiltinCapabilities())
