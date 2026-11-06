"""Runtime team management: agents can view the team, hire new agents and edit configurations.

Guardrails:
- ``list_agents`` and ``update_agent`` on *yourself* are always available; hiring and editing others require the
  ``manage_team`` tool and the target must report (transitively) to you or have been hired by you.
- No privilege escalation: hires only get tools the hiring agent has; nobody can grant themselves new tools, raise
  their own turn cap.
- Approval: in ``ask`` mode hires and changes need the user's approval before they are saved to the company. In ``auto``
  mode (Approve for me) they are saved without asking.
- ``budget.max_agents`` caps the team size; ``budget.persist_team`` controls write-back to the company.
"""
from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any


from app.db.base import new_id, utcnow
from app.db.repositories import AgentRepository, CompanyRepository, EdgeRepository
from app.capabilities.models.base import DEFAULT_AGENT_MAX_TOKENS
from app.orchestrator import actions as A
from app.orchestrator.context import AgentSpec

if TYPE_CHECKING:  # pragma: no cover
    from app.orchestrator.engine import RunRuntime

EDGE_CFG = {"max_turns": 20, "handoff_instructions": "", "condition": "", "max_rounds": 4, "max_revisions": 3}
EDITABLE_BEHAVIOR = {"assertiveness", "creativity", "strictness", "debate_style", "max_autonomous_turns"}


def _tool_map(spec: Any) -> dict[str, bool] | None:
    if spec is None:
        return None
    if isinstance(spec, list):
        return {str(k): True for k in spec}
    return {str(k): bool(v) for k, v in dict(spec).items()}


def _edge(src: str, dst: str, etype: str, bidi: bool, label: str) -> dict[str, Any]:
    return {"id": new_id(), "source_agent_id": src, "target_agent_id": dst, "type": etype, "bidirectional": bidi, "label": label,
            "config": dict(EDGE_CFG)}


class OrgService:
    """Team management for one run. ``self.rt`` is the RunRuntime that owns the agents and the company."""

    def __init__(self, rt: RunRuntime) -> None:
        self.rt = rt

    # ------------------------------------------------------------------ helpers
    def manages(self, actor: str, target: str) -> bool:
        """True if ``target`` reports (transitively) to ``actor``, or ``actor`` hired ``target``."""
        t = self.rt.agents.get(target)
        if t is None:
            return False
        if t.created_by == actor:
            return True
        seen: set[str] = set()
        cur = t.reports_to
        while cur and cur not in seen:
            if cur == actor:
                return True
            seen.add(cur)
            cur = self.rt.agents[cur].reports_to if cur in self.rt.agents else None
        return False

    def _snapshot_agent(self, aid: str) -> dict[str, Any] | None:
        return next((a for a in self.rt.snapshot["agents"] if a["id"] == aid), None)

    async def _team_guard(self, agent: AgentSpec, kind: str, summary: str, details: dict[str, Any]) -> tuple[bool, bool, str]:
        """Returns (allowed, persist, reason)."""
        persist = self.rt.budget.persist_team
        if self.rt.level == "ask" and persist:
            ok, reason = await self.rt.request_approval(agent, kind, summary, json.dumps(details, indent=1)[:6000], details)
            if not ok:
                return False, False, f"The user REJECTED {kind}: {reason or 'no reason given'}"
        return True, persist, ""

    async def _persist_team(self, *, new_agents: list[dict[str, Any]] | None = None, new_edges: list[dict[str, Any]] | None = None,
                            updates: dict[str, dict[str, Any]] | None = None) -> bool:
        """Write hires / edits back to the company (the canvas reflects them) and bump its revision."""
        from app.models import Agent as AgentRow, Edge as EdgeRow

        async with self.rt.db() as db:
            company = await CompanyRepository(db).get(self.rt.company_id)
            if company is None:
                return False
            existing = await AgentRepository(db).ids_in_company(self.rt.company_id)
            new_ids = {a["id"] for a in new_agents or []}
            for a in new_agents or []:
                AgentRepository(db).add(AgentRow(
                    id=a["id"], company_id=self.rt.company_id, name=a["name"], role=a["role"], description=a.get("description", ""),
                    avatar=a.get("avatar", ""), color=a.get("color", "#6366f1"), system_prompt=a.get("system_prompt", ""),
                    provider=a["provider"], model=a["model"], temperature=a.get("temperature", 0.4), max_tokens=a.get("max_tokens") or DEFAULT_AGENT_MAX_TOKENS,
                    tools_json=a.get("tools") or {}, behavior_json=a.get("behavior") or {},
                    department=a.get("department", ""), is_manager=bool(a.get("is_manager")),
                    reports_to=a.get("reports_to") if a.get("reports_to") in existing | new_ids else None,
                    active=a.get("active", True), created_by=a.get("created_by"), is_entry=False,
                    position_x=a.get("position_x", 0), position_y=a.get("position_y", 0)))
            existing |= new_ids
            await db.flush()
            for e in new_edges or []:
                if e["source_agent_id"] in existing and e["target_agent_id"] in existing:
                    EdgeRepository(db).add(EdgeRow(id=e["id"], company_id=self.rt.company_id, source_agent_id=e["source_agent_id"], target_agent_id=e["target_agent_id"],
                                   bidirectional=e["bidirectional"], type=e["type"], label=e.get("label", ""), config_json=e.get("config") or {}))
            for aid, fields in (updates or {}).items():
                row = await AgentRepository(db).get(aid)
                if row is None or row.company_id != self.rt.company_id:
                    continue
                for k, v in fields.items():
                    col = {"tools": "tools_json", "behavior": "behavior_json"}.get(k, k)
                    if hasattr(row, col):
                        setattr(row, col, v)
            company.revision = (company.revision or 0) + 1
            company.updated_at = utcnow()
            await db.commit()
        return True

    # ------------------------------------------------------------------ list_agents
    async def act_list_agents(self, agent: AgentSpec, a: A.ListAgents) -> None:
        from app.orchestrator.handlers import team_actions
        await team_actions.act_list_agents(self.rt, agent, a)

    # ------------------------------------------------------------------ create_agent
    async def act_create_agent(self, agent: AgentSpec, a: A.CreateAgent) -> None:
        from app.orchestrator.handlers import team_actions
        await team_actions.act_create_agent(self.rt, agent, a)

    # ------------------------------------------------------------------ update_agent
    async def act_update_agent(self, agent: AgentSpec, a: A.UpdateAgent) -> None:
        from app.orchestrator.handlers import team_actions
        await team_actions.act_update_agent(self.rt, agent, a)
