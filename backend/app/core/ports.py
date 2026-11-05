"""Capability ports: the handles the orchestrator calls to reach models, the project filesystem and skills.

The orchestrator depends on these Protocols only. It never imports a provider, sandbox or skill module. The built-in
implementations are installed once at startup by ``app.capabilities.bootstrap.install``. Import-linter keeps core from
importing app.capabilities, so this module is the only way in.
"""
from __future__ import annotations

from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any, Protocol

from app.core.llm import LLMChunk, LLMRequest


class CapabilityHandles(Protocol):
    def stream_llm(self, req: LLMRequest, /) -> AsyncIterator[LLMChunk]: ...

    def project_fs(self, root: Path) -> Any: ...

    def builtin_skills(self) -> dict[str, Any]: ...


_handles: CapabilityHandles | None = None


def install(handles: CapabilityHandles) -> None:
    """Set the handles used by every run. Installing again replaces them."""
    global _handles
    _handles = handles


def handles() -> CapabilityHandles:
    if _handles is None:
        raise RuntimeError("Capability handles are not installed. Call app.capabilities.bootstrap.install() before a run starts.")
    return _handles
