"""Runtime team management: agents can view the team, hire new agents and edit configurations.

Guardrails:
- ``list_agents`` and ``update_agent`` on *yourself* are always available; hiring and editing others require the
  ``manage_team`` tool and the target must report (transitively) to you or have been hired by you.
- No privilege escalation: hires only get tools the hiring agent has; nobody can grant themselves new tools, raise
  their own turn cap or raise a permission level.
- Permission level: ``read_only`` cannot hire; ``read_only``/``plan`` changes exist for the run only; ``ask`` needs the
  user's approval before changes are saved to the company; ``danger`` saves automatically.
- ``budget.max_agents`` caps the team size; ``budget.persist_team`` controls write-back to the company.
"""
from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any

from sqlalchemy import select

from app.db.base import new_id, utcnow
from app.llm.demo_script import role_category
from app.orchestrator import actions as A
from app.orchestrator.context import AgentSpec
from app.orchestrator.permissions import LEVEL_ORDER, EdgeSpec, allowed_recipients, effective_level

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


class TeamMixin:
    # ------------------------------------------------------------------ helpers
    def manages(self: RunRuntime, actor: str, target: str) -> bool:
        """True if ``target`` reports (transitively) to ``actor``, or ``actor`` hired ``target``."""
        t = self.agents.get(target)
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
            cur = self.agents[cur].reports_to if cur in self.agents else None
        return False

    def _snapshot_agent(self: RunRuntime, aid: str) -> dict[str, Any] | None:
        return next((a for a in self.snapshot["agents"] if a["id"] == aid), None)

    async def _team_guard(self: RunRuntime, agent: AgentSpec, kind: str, summary: str, details: dict[str, Any]) -> tuple[bool, bool, str]:
        """Returns (allowed, persist, reason)."""
        level = self.levels.get(agent.id, self.level)
        persist = self.budget.persist_team and level in ("ask", "danger")
        if level == "read_only" and kind == "create_agent":
            return False, False, "Your permission level is read-only: you cannot hire agents. Recommend the hire to your manager instead."
        if level == "ask" and persist:
            ok, reason = await self.request_approval(agent, kind, summary, json.dumps(details, indent=1)[:6000], details)
            if not ok:
                return False, False, f"The user REJECTED {kind}: {reason or 'no reason given'}"
        return True, persist, ""

    async def _persist_team(self: RunRuntime, *, new_agents: list[dict[str, Any]] | None = None, new_edges: list[dict[str, Any]] | None = None,
                            updates: dict[str, dict[str, Any]] | None = None) -> bool:
        """Write hires / edits back to the company (the canvas reflects them) and bump its revision."""
        from app.models import Agent as AgentRow, Company, Edge as EdgeRow

        async with self.db() as db:
            company = await db.get(Company, self.company_id)
            if company is None:
                return False
            existing = set((await db.execute(select(AgentRow.id).where(AgentRow.company_id == self.company_id))).scalars())
            new_ids = {a["id"] for a in new_agents or []}
            for a in new_agents or []:
                db.add(AgentRow(
                    id=a["id"], company_id=self.company_id, name=a["name"], role=a["role"], description=a.get("description", ""),
                    avatar=a.get("avatar", ""), color=a.get("color", "#6366f1"), system_prompt=a.get("system_prompt", ""),
                    provider=a["provider"], model=a["model"], temperature=a.get("temperature", 0.4), max_tokens=a.get("max_tokens", 2048),
                    tools_json=a.get("tools") or {}, behavior_json=a.get("behavior") or {}, permission_level=a.get("permission_level", "inherit"),
                    department=a.get("department", ""), is_manager=bool(a.get("is_manager")),
                    reports_to=a.get("reports_to") if a.get("reports_to") in existing | new_ids else None,
                    active=a.get("active", True), created_by=a.get("created_by"), is_entry=False,
                    position_x=a.get("position_x", 0), position_y=a.get("position_y", 0)))
            existing |= new_ids
            await db.flush()
            for e in new_edges or []:
                if e["source_agent_id"] in existing and e["target_agent_id"] in existing:
                    db.add(EdgeRow(id=e["id"], company_id=self.company_id, source_agent_id=e["source_agent_id"], target_agent_id=e["target_agent_id"],
                                   bidirectional=e["bidirectional"], type=e["type"], label=e.get("label", ""), config_json=e.get("config") or {}))
            for aid, fields in (updates or {}).items():
                row = await db.get(AgentRow, aid)
                if row is None or row.company_id != self.company_id:
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
    async def act_list_agents(self: RunRuntime, agent: AgentSpec, a: A.ListAgents) -> None:
        cid = await self._tool_event(agent, "list_agents", {"department": a.department})
        await self.set_agent_status(agent.id, "reading", "Checking the team…")
        mine = allowed_recipients(self.edges, agent.id)
        rows = []
        for x in self.agents.values():
            if (not a.include_inactive and not x.active) or (a.department and x.department.lower() != a.department.lower()):
                continue
            st = "inactive" if not x.active else self.status.get(x.id, "idle")
            act = f" ({self.activity[x.id]})" if x.active and self.activity.get(x.id) else ""
            chan = [e.type for e in mine.get(x.id, [])]
            rows.append(
                f"- {x.name}{' (you)' if x.id == agent.id else ''} | {x.role} | dept: {x.department or '-'}{' · manager' if x.is_manager else ''}"
                f" | reports to: {self.names.get(x.reports_to or '', '-')} | status: {st}{act} | turns: {self.agent_turns[x.id]}"
                + (f" | hired by {self.names.get(x.created_by, '?')}" if x.created_by else "")
                + (f" | your channels: {', '.join(chan)}" if chan else ""))
        active = sum(1 for x in self.agents.values() if x.active)
        out = f"Team: {active} active, {len(self.agents) - active} inactive (cap {self.budget.max_agents}).\n" + "\n".join(rows)
        self.observe(agent.id, {"tool": "list_agents", "ok": True, "content": out})
        await self._tool_result(agent, cid, "list_agents", True, out)

    # ------------------------------------------------------------------ create_agent
    async def act_create_agent(self: RunRuntime, agent: AgentSpec, a: A.CreateAgent) -> None:
        from app.prompts.roles import agent_from_role, all_roles
        from app.services.canvas import department_color

        cid = await self._tool_event(agent, "create_agent", {"name": a.name, "role": a.role, "department": a.department})
        if len(self.agents) >= self.budget.max_agents:
            await self.deny(agent, cid, "create_agent", f"Team size cap reached ({self.budget.max_agents}). Reuse or reconfigure existing agents instead.")
            return
        base_name, n = a.name.strip(), 2
        name = base_name
        while any(x.name.lower() == name.lower() for x in self.agents.values()):
            name, n = f"{base_name} {n}", n + 1
        manager_id = (self.resolve_agent(a.reports_to) if a.reports_to else None) or agent.id
        if manager_id != agent.id and not self.manages(agent.id, manager_id):
            await self.deny(agent, cid, "create_agent", f"{self.names[manager_id]} is not in your part of the org; hires must report to you or someone you manage.")
            return
        roles = all_roles()
        key = a.role_template if a.role_template in roles else ("department_head" if a.is_manager else "specialist")
        department = (a.department or ("" if a.is_manager else self.agents[manager_id].department)).strip() or a.role
        base = agent_from_role(key, name=name, role=a.role, department=department, is_manager=a.is_manager)

        requested = _tool_map(a.tools)
        tools: dict[str, Any] = dict(base["tools"])
        if requested is not None:
            tools = {k: (bool(requested.get(k)) if k != "mcp_servers" else v) for k, v in tools.items()}
        tools["send_message"] = True
        tools["manage_team"] = bool(tools.get("manage_team")) or a.is_manager
        dropped = sorted(k for k, v in tools.items() if k not in ("mcp_servers", "send_message") and v is True and not A.tool_enabled(agent.tools, k))
        for k in dropped:
            tools[k] = False
        tools["mcp_servers"] = [m for m in (tools.get("mcp_servers") or []) if m in (agent.tools.get("mcp_servers") or [])]

        mgr_pos = self._snapshot_agent(manager_id) or {}
        siblings = sum(1 for x in self.agents.values() if x.reports_to == manager_id)
        spec_dict: dict[str, Any] = {
            **base, "id": new_id(), "name": name, "tools": tools,
            "provider": a.provider or agent.provider, "model": a.model or agent.model,
            "description": a.description or base["description"], "system_prompt": a.system_prompt.strip() or base["system_prompt"],
            "reports_to": manager_id, "created_by": agent.id, "active": True, "permission_level": "inherit",
            # fan hires out below their manager: 0, -1, +1, -2, +2 … columns; a new row every 5 hires
            "position_x": float(mgr_pos.get("position_x", 0)) + ((siblings % 5 + 1) // 2) * (1 if siblings % 2 == 0 else -1) * 300,
            "position_y": float(mgr_pos.get("position_y", 0)) + 320 + (siblings // 5) * 260,
        }
        new_id_ = spec_dict["id"]
        edges = [_edge(manager_id, new_id_, "delegate", False, f"{department} tasks"), _edge(new_id_, manager_id, "report", False, "Status")]
        reachable = set(allowed_recipients(self.edges, agent.id)) | {agent.id}
        skipped: list[str] = []
        for c in a.connect:
            tid = self.resolve_agent(c.to)
            if tid is None or not (tid in reachable or self.manages(agent.id, tid)):
                skipped.append(c.to)
                continue
            if any(e["type"] == c.type and {e["source_agent_id"], e["target_agent_id"]} == {new_id_, tid} for e in edges):
                continue
            edges.append(_edge(new_id_, tid, c.type, c.bidirectional, c.label))
        details = {"name": name, "role": a.role, "department": department, "reports_to": self.names.get(manager_id), "is_manager": a.is_manager,
                   "tools": sorted(k for k, v in tools.items() if v is True), "model": f"{spec_dict['provider']}/{spec_dict['model']}",
                   "channels": [f"{e['type']}: {self.names.get(e['source_agent_id'], name)} → {self.names.get(e['target_agent_id'], name)}" for e in edges],
                   "system_prompt": spec_dict["system_prompt"][:1500]}
        ok, persist, reason = await self._team_guard(agent, "create_agent", f"{agent.name} wants to hire {name} ({a.role}, {department})", details)
        if not ok:
            await self.deny(agent, cid, "create_agent", reason)
            return
        await self.set_agent_status(agent.id, "tool", f"Hiring {name}…")

        spec = AgentSpec.from_dict(spec_dict, role_category(spec_dict["role"], (spec_dict.get("behavior") or {}).get("template_key", "")))
        self.agents[spec.id] = spec
        self.names[spec.id] = spec.name
        self.levels[spec.id] = effective_level(self.level, "inherit")
        self.status[spec.id] = "idle"
        self.edges.extend(EdgeSpec.from_dict(e) for e in edges)
        self.snapshot["agents"].append({**spec_dict, "company_id": self.company_id})
        self.snapshot["edges"].extend({**e, "company_id": self.company_id} for e in edges)
        self.snapshot["departments"].setdefault(department, {"color": department_color(department), "description": ""})
        self.snapshot_dirty = True
        persisted = await self._persist_team(new_agents=[spec_dict], new_edges=edges) if persist else False
        self.decisions.append(f"{agent.name} hired {name} ({a.role}, {department})")
        await self.emit("agent_created", {"agent": {**spec_dict, "company_id": self.company_id},
                                          "edges": [{**e, "company_id": self.company_id} for e in edges], "created_by": agent.id,
                                          "persisted": persisted, "department": {"name": department, **self.snapshot["departments"][department]}})
        note = f"Hired {name} ({a.role}) in {department}, reporting to {self.names[manager_id]}."
        if dropped:
            note += f" Not granted (you don't have them): {', '.join(dropped)}."
        if skipped:
            note += f" Connections skipped (outside your part of the org): {', '.join(skipped)}."
        if not persisted and self.budget.persist_team:
            note += " This hire exists for this run only (permission level)."
        self.notice(agent.id, note)
        await self._tool_result(agent, cid, "create_agent", True, note)
        if a.brief:
            sender = self.agents.get(manager_id, agent)
            await self._send_one(sender, spec.id, A.SendMessage(action="send_message", to=spec.name, type="task", content=a.brief))

    # ------------------------------------------------------------------ update_agent
    async def act_update_agent(self: RunRuntime, agent: AgentSpec, a: A.UpdateAgent) -> None:
        tgt = a.target.strip()
        target_id = agent.id if tgt.lower() in ("self", "me", "myself", agent.name.lower()) else self.resolve_agent(tgt)
        cid = await self._tool_event(agent, "update_agent", {"target": tgt, "fields": sorted(a.changes.model_dump(exclude_none=True))})
        if target_id is None:
            await self.deny(agent, cid, "update_agent", f"Unknown agent '{tgt}'.")
            return
        is_self = target_id == agent.id
        if not is_self and not (A.tool_enabled(agent.tools, "manage_team") and self.manages(agent.id, target_id)):
            await self.deny(agent, cid, "update_agent", f"You can only reconfigure yourself or agents you manage/hired; {self.names[target_id]} is neither.")
            return
        t, ch = self.agents[target_id], a.changes
        applied: dict[str, Any] = {}
        refused: list[str] = []
        for f in ("name", "role", "description", "department", "temperature", "model"):
            v = getattr(ch, f)
            if v is None or v == getattr(t, f):
                continue
            if f == "name":
                v = v.strip()
                if not v or any(x.name.lower() == v.lower() for x in self.agents.values() if x.id != t.id):
                    refused.append("name (empty or taken)")
                    continue
            applied[f] = v
        if ch.system_prompt and ch.system_prompt.strip() and ch.system_prompt != t.system_prompt:
            applied["system_prompt"] = ch.system_prompt
        if ch.append_to_prompt and ch.append_to_prompt.strip():
            applied["system_prompt"] = (applied.get("system_prompt") or t.system_prompt).rstrip() + "\n\n" + ch.append_to_prompt.strip()
        if ch.behavior:
            b = {**t.behavior, **{k: v for k, v in ch.behavior.items() if k in EDITABLE_BEHAVIOR}}
            if "max_autonomous_turns" in ch.behavior:
                req_turns = int(ch.behavior["max_autonomous_turns"])
                b["max_autonomous_turns"] = min(req_turns, int(t.behavior.get("max_autonomous_turns", 12))) if is_self else max(1, min(200, req_turns))
            if b != t.behavior:
                applied["behavior"] = b
        if ch.tools is not None:
            req = _tool_map(ch.tools) or {}
            tools = dict(t.tools)
            for k, v in req.items():
                if k == "mcp_servers":
                    continue
                if v and not A.tool_enabled(t.tools, k) and (is_self or not A.tool_enabled(agent.tools, k)):
                    refused.append(f"tool {k} ({'you cannot grant yourself new tools' if is_self else 'you cannot grant tools you do not have'})")
                    continue
                tools[k] = bool(v)
            tools["send_message"] = True
            if tools != t.tools:
                applied["tools"] = tools
        if ch.is_manager is not None and ch.is_manager != t.is_manager:
            if is_self:
                refused.append("is_manager (ask your manager)")
            else:
                applied["is_manager"] = ch.is_manager
        if ch.active is not None and ch.active != t.active:
            if is_self and t.is_entry:
                refused.append("active (the entry agent cannot deactivate itself; use finish)")
            elif is_self and ch.active:
                refused.append("active")
            else:
                applied["active"] = ch.active
        if ch.permission_level is not None:
            if LEVEL_ORDER[ch.permission_level] <= LEVEL_ORDER[self.levels.get(target_id, self.level)]:
                applied["permission_level"] = ch.permission_level
            else:
                refused.append("permission_level (can only be lowered)")
        if not applied:
            await self.deny(agent, cid, "update_agent", "Nothing was changed." + (f" Refused: {'; '.join(refused)}." if refused else ""))
            return
        preview = {k: (v[:1500] if isinstance(v, str) else v) for k, v in applied.items()}
        whose = "its own" if is_self else f"{t.name}'s"
        ok, persist, reason = await self._team_guard(agent, "update_agent", f"{agent.name} wants to update {whose} configuration",
                                                     {"target": t.name, "changes": preview, "reason": a.reason})
        if not ok:
            await self.deny(agent, cid, "update_agent", reason)
            return
        old_name = t.name
        for k, v in applied.items():
            setattr(t, k, v)
        self.names[t.id] = t.name
        if "permission_level" in applied:
            self.levels[t.id] = effective_level(self.level, t.permission_level)
        if applied.get("active") is False:
            self.mailbox.pop(t.id, None)
            self.observations.pop(t.id, None)
            self.done_agents.add(t.id)
            await self.set_agent_status(t.id, "done", "Deactivated")
        elif applied.get("active") is True:
            self.done_agents.discard(t.id)
            await self.set_agent_status(t.id, "idle", "Reactivated")
        snap = self._snapshot_agent(t.id)
        if snap is not None:
            snap.update(applied)
        self.snapshot_dirty = True
        persisted = await self._persist_team(updates={t.id: applied}) if persist else False
        summary = ", ".join(k + (f" → {v}" if isinstance(v, (str, int, float, bool)) and k != "system_prompt" and len(str(v)) < 60 else "")
                            for k, v in applied.items())
        await self.emit("agent_updated", {"agent_id": t.id, "by": agent.id, "self": is_self, "changes": preview, "summary": summary,
                                          "reason": a.reason, "persisted": persisted, "old_name": old_name})
        note = f"Updated {'your own' if is_self else t.name + chr(39) + 's'} configuration: {summary}." + (f" Refused: {'; '.join(refused)}." if refused else "")
        self.notice(agent.id, note)
        if not is_self and t.active:
            self.notice(t.id, f"{agent.name} updated your configuration ({summary}). Reason: {a.reason or 'n/a'}")
        await self._tool_result(agent, cid, "update_agent", True, note)
