"""create_agent, update_agent and list_agents, moved out of TeamMixin. Phase 5 moves them again."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from app.db.base import new_id
from app.orchestrator import actions as A
from app.orchestrator.context import AgentSpec
from app.orchestrator.permissions import allowed_recipients, EdgeSpec
from app.orchestrator.roles import role_category
from app.orchestrator.team import _edge, _tool_map, EDITABLE_BEHAVIOR

if TYPE_CHECKING:  # pragma: no cover
    from app.orchestrator.engine import RunRuntime


async def act_list_agents(rt: RunRuntime, agent: AgentSpec, a: A.ListAgents) -> None:
    cid = await rt._tool_event(agent, "list_agents", {"department": a.department})
    await rt.set_agent_status(agent.id, "reading", "Checking the team…")
    mine = allowed_recipients(rt.edges, agent.id)
    rows = []
    for x in rt.agents.values():
        if (not a.include_inactive and not x.active) or (a.department and x.department.lower() != a.department.lower()):
            continue
        st = "inactive" if not x.active else rt.status.get(x.id, "idle")
        act = f" ({rt.activity[x.id]})" if x.active and rt.activity.get(x.id) else ""
        chan = [e.type for e in mine.get(x.id, [])]
        rows.append(
            f"- {x.name}{' (you)' if x.id == agent.id else ''} | {x.role} | dept: {x.department or '-'}{' · manager' if x.is_manager else ''}"
            f" | reports to: {rt.names.get(x.reports_to or '', '-')} | status: {st}{act} | turns: {rt.agent_turns[x.id]}"
            + (f" | hired by {rt.names.get(x.created_by, '?')}" if x.created_by else "")
            + (f" | your channels: {', '.join(chan)}" if chan else ""))
    active = sum(1 for x in rt.agents.values() if x.active)
    out = f"Team: {active} active, {len(rt.agents) - active} inactive (cap {rt.budget.max_agents}).\n" + "\n".join(rows)
    rt.observe(agent.id, {"tool": "list_agents", "ok": True, "content": out})
    await rt._tool_result(agent, cid, "list_agents", True, out)


async def act_create_agent(rt: RunRuntime, agent: AgentSpec, a: A.CreateAgent) -> None:
    from app.prompts.roles import agent_from_role, all_roles
    from app.services.canvas import department_color

    cid = await rt._tool_event(agent, "create_agent", {"name": a.name, "role": a.role, "department": a.department})
    if len(rt.agents) >= rt.budget.max_agents:
        await rt.deny(agent, cid, "create_agent", f"Team size cap reached ({rt.budget.max_agents}). Reuse or reconfigure existing agents instead.")
        return
    base_name, n = a.name.strip(), 2
    name = base_name
    while any(x.name.lower() == name.lower() for x in rt.agents.values()):
        name, n = f"{base_name} {n}", n + 1
    manager_id = (rt.resolve_agent(a.reports_to) if a.reports_to else None) or agent.id
    if manager_id != agent.id and not rt.manages(agent.id, manager_id):
        await rt.deny(agent, cid, "create_agent", f"{rt.names[manager_id]} is not in your part of the org; hires must report to you or someone you manage.")
        return
    roles = all_roles()
    key = a.role_template if a.role_template in roles else ("department_head" if a.is_manager else "specialist")
    department = (a.department or ("" if a.is_manager else rt.agents[manager_id].department)).strip() or a.role
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

    mgr_pos = rt._snapshot_agent(manager_id) or {}
    siblings = sum(1 for x in rt.agents.values() if x.reports_to == manager_id)
    spec_dict: dict[str, Any] = {
        **base, "id": new_id(), "name": name, "tools": tools,
        "provider": a.provider or agent.provider, "model": a.model or agent.model,
        "description": a.description or base["description"], "system_prompt": a.system_prompt.strip() or base["system_prompt"],
        "reports_to": manager_id, "created_by": agent.id, "active": True,
        # fan hires out below their manager: 0, -1, +1, -2, +2 … columns; a new row every 5 hires
        "position_x": float(mgr_pos.get("position_x", 0)) + ((siblings % 5 + 1) // 2) * (1 if siblings % 2 == 0 else -1) * 300,
        "position_y": float(mgr_pos.get("position_y", 0)) + 320 + (siblings // 5) * 260,
    }
    new_id_ = spec_dict["id"]
    edges = [_edge(manager_id, new_id_, "delegate", False, f"{department} tasks"), _edge(new_id_, manager_id, "report", False, "Status")]
    reachable = set(allowed_recipients(rt.edges, agent.id)) | {agent.id}
    skipped: list[str] = []
    for c in a.connect:
        tid = rt.resolve_agent(c.to)
        if tid is None or not (tid in reachable or rt.manages(agent.id, tid)):
            skipped.append(c.to)
            continue
        if any(e["type"] == c.type and {e["source_agent_id"], e["target_agent_id"]} == {new_id_, tid} for e in edges):
            continue
        edges.append(_edge(new_id_, tid, c.type, c.bidirectional, c.label))
    details = {"name": name, "role": a.role, "department": department, "reports_to": rt.names.get(manager_id), "is_manager": a.is_manager,
               "tools": sorted(k for k, v in tools.items() if v is True), "model": f"{spec_dict['provider']}/{spec_dict['model']}",
               "channels": [f"{e['type']}: {rt.names.get(e['source_agent_id'], name)} → {rt.names.get(e['target_agent_id'], name)}" for e in edges],
               "system_prompt": spec_dict["system_prompt"][:1500]}
    ok, persist, reason = await rt._team_guard(agent, "create_agent", f"{agent.name} wants to hire {name} ({a.role}, {department})", details)
    if not ok:
        await rt.deny(agent, cid, "create_agent", reason)
        return
    await rt.set_agent_status(agent.id, "tool", f"Hiring {name}…")

    spec = AgentSpec.from_dict(spec_dict, role_category(spec_dict["role"], (spec_dict.get("behavior") or {}).get("template_key", "")))
    rt.agents[spec.id] = spec
    rt.names[spec.id] = spec.name
    rt.status[spec.id] = "idle"
    rt.edges.extend(EdgeSpec.from_dict(e) for e in edges)
    rt.snapshot["agents"].append({**spec_dict, "company_id": rt.company_id})
    rt.snapshot["edges"].extend({**e, "company_id": rt.company_id} for e in edges)
    rt.snapshot["departments"].setdefault(department, {"color": department_color(department), "description": ""})
    rt.snapshot_dirty = True
    persisted = await rt._persist_team(new_agents=[spec_dict], new_edges=edges) if persist else False
    rt.decide(f"{agent.name} hired {name} ({a.role}, {department})", agent.id)
    await rt.emit("agent_created", {"agent": {**spec_dict, "company_id": rt.company_id},
                                      "edges": [{**e, "company_id": rt.company_id} for e in edges], "created_by": agent.id,
                                      "persisted": persisted, "department": {"name": department, **rt.snapshot["departments"][department]}})
    note = f"Hired {name} ({a.role}) in {department}, reporting to {rt.names[manager_id]}."
    if dropped:
        note += f" Not granted (you don't have them): {', '.join(dropped)}."
    if skipped:
        note += f" Connections skipped (outside your part of the org): {', '.join(skipped)}."
    if not persisted and rt.budget.persist_team:
        note += " This hire exists for this run only (it was not approved for saving)."
    rt.notice(agent.id, note)
    await rt._tool_result(agent, cid, "create_agent", True, note)
    if a.brief:
        sender = rt.agents.get(manager_id, agent)
        await rt._send_one(sender, spec.id, A.SendMessage(action="send_message", to=spec.name, type="task", content=a.brief))


async def act_update_agent(rt: RunRuntime, agent: AgentSpec, a: A.UpdateAgent) -> None:
    tgt = a.target.strip()
    target_id = agent.id if tgt.lower() in ("self", "me", "myself", agent.name.lower()) else rt.resolve_agent(tgt)
    cid = await rt._tool_event(agent, "update_agent", {"target": tgt, "fields": sorted(a.changes.model_dump(exclude_none=True))})
    if target_id is None:
        await rt.deny(agent, cid, "update_agent", f"Unknown agent '{tgt}'.")
        return
    is_self = target_id == agent.id
    if not is_self and not (A.tool_enabled(agent.tools, "manage_team") and rt.manages(agent.id, target_id)):
        await rt.deny(agent, cid, "update_agent", f"You can only reconfigure yourself or agents you manage/hired; {rt.names[target_id]} is neither.")
        return
    t, ch = rt.agents[target_id], a.changes
    applied: dict[str, Any] = {}
    refused: list[str] = []
    for f in ("name", "role", "description", "department", "temperature", "model", "max_tokens"):
        v = getattr(ch, f)
        if v is None or v == getattr(t, f):
            continue
        if f == "name":
            v = v.strip()
            if not v or any(x.name.lower() == v.lower() for x in rt.agents.values() if x.id != t.id):
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
    if not applied:
        await rt.deny(agent, cid, "update_agent", "Nothing was changed." + (f" Refused: {'; '.join(refused)}." if refused else ""))
        return
    preview = {k: (v[:1500] if isinstance(v, str) else v) for k, v in applied.items()}
    whose = "its own" if is_self else f"{t.name}'s"
    ok, persist, reason = await rt._team_guard(agent, "update_agent", f"{agent.name} wants to update {whose} configuration",
                                                 {"target": t.name, "changes": preview, "reason": a.reason})
    if not ok:
        await rt.deny(agent, cid, "update_agent", reason)
        return
    old_name = t.name
    for k, v in applied.items():
        setattr(t, k, v)
    rt.names[t.id] = t.name
    if applied.get("active") is False:
        rt.mailbox.pop(t.id, None)
        rt.observations.pop(t.id, None)
        rt.done_agents.add(t.id)
        await rt.set_agent_status(t.id, "done", "Deactivated")
    elif applied.get("active") is True:
        rt.done_agents.discard(t.id)
        await rt.set_agent_status(t.id, "idle", "Reactivated")
    snap = rt._snapshot_agent(t.id)
    if snap is not None:
        snap.update(applied)
    rt.snapshot_dirty = True
    persisted = await rt._persist_team(updates={t.id: applied}) if persist else False
    summary = ", ".join(k + (f" → {v}" if isinstance(v, (str, int, float, bool)) and k != "system_prompt" and len(str(v)) < 60 else "")
                        for k, v in applied.items())
    await rt.emit("agent_updated", {"agent_id": t.id, "by": agent.id, "self": is_self, "changes": preview, "summary": summary,
                                      "reason": a.reason, "persisted": persisted, "old_name": old_name})
    note = f"Updated {'your own' if is_self else t.name + chr(39) + 's'} configuration: {summary}." + (f" Refused: {'; '.join(refused)}." if refused else "")
    rt.notice(agent.id, note)
    if not is_self and t.active:
        rt.notice(t.id, f"{agent.name} updated your configuration ({summary}). Reason: {a.reason or 'n/a'}")
    await rt._tool_result(agent, cid, "update_agent", True, note)
