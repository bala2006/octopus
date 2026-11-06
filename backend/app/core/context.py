"""Explicit handles a plugin receives when it starts. There is no global lookup. The composition root builds the context."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from app.core.bus import TypedRunBus
from app.core.registry import PluginRegistry


@dataclass(frozen=True)
class PluginContext:
    bus: TypedRunBus
    registry: PluginRegistry
    # Placeholders for handles that later phases wire in. They stay None until then.
    policy: Any | None = None       # core.policy_gate (Phase 2)
    run_manager: Any | None = None  # core.run_manager (Phase 2)
    storage: Any | None = None      # capability.storage (Phase 3)
    models: Any | None = None       # capability.models (Phase 3)
    tools: Any | None = None        # tool dispatch for the capability tool plugins (Phase 3)
    sandbox: Any | None = None      # capability.sandbox (Phase 3)
