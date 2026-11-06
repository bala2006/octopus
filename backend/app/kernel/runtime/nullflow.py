"""The null stand-ins a run uses while the company workflow or the org plugin is disabled: every question gets a neutral answer."""
from __future__ import annotations

from typing import Any


class NullFlow:
    """Stands in for the company workflow plugin. The run is free-form: no phases, no gates, no tool exclusions."""

    def wf_active(self) -> bool:
        return False

    def wf_phase(self) -> dict[str, Any] | None:
        return None

    def wf_enabled_for_run(self) -> bool:
        return False

    def wf_tool_exclusions(self, agent: Any) -> set[str]:
        return set()

    def wf_owner_of_active(self, agent_id: str) -> bool:
        return False

    async def wf_emit(self) -> None:
        return None

    def wf_view(self) -> dict[str, Any]:
        return {}

    def wf_blackboard(self) -> str:
        return ""

    def wf_init(self) -> None:
        return None

    def wf_intake_note(self) -> str:
        return ""

    async def act_set_track(self, agent: Any, a: Any) -> None:
        return None

    async def wf_advance(self) -> None:
        return None

    async def wf_start(self, ph: dict[str, Any], *, extra: str = "") -> None:
        return None

    def wf_brief(self, ph: dict[str, Any]) -> str:
        return ""

    def wf_gate(self, agent: Any, ph: dict[str, Any], a: Any) -> str | None:
        return None

    async def wf_on_finish(self, agent: Any, a: Any) -> str | None:
        return None

    async def nudge_workflow(self) -> bool:
        return False


class NullOrg:
    """Stands in for the org plugin. Nobody manages anyone, and team changes are refused."""

    def manages(self, actor: str, target: str) -> bool:
        return False

    def _snapshot_agent(self, aid: str) -> dict[str, Any] | None:
        return None

    async def _team_guard(self, agent: Any, kind: str, summary: str, details: dict[str, Any]) -> tuple[bool, bool, str]:
        return False, False, "Team changes are unavailable: the org plugin is disabled."

    async def _persist_team(self, **kwargs: Any) -> bool:
        return False

    async def act_list_agents(self, agent: Any, a: Any) -> None:
        return None

    async def act_create_agent(self, agent: Any, a: Any) -> None:
        return None

    async def act_update_agent(self, agent: Any, a: Any) -> None:
        return None
