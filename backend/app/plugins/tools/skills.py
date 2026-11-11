"""use_skill: load a pinned skill or one of its resources."""

from __future__ import annotations

from typing import TYPE_CHECKING

from app.sdk import actions as A
from app.sdk.agents import AgentSpec

if TYPE_CHECKING:  # pragma: no cover
    from app.sdk.run import RunContext


async def act_use_skill(rt: RunContext, agent: AgentSpec, a: A.UseSkill) -> None:
    cid = await rt._tool_event(agent, "use_skill", {"name": a.name})
    key = a.name.strip().lower()
    sk = rt.skills.get(key) or next((s for s in rt.skills.values() if key in s.name), None)
    if sk is None:
        out = f"No skill named '{a.name}'. Available: {', '.join(sorted(rt.skills)) or 'none'}"
        rt.observe(agent.id, {"tool": "use_skill", "ok": False, "content": out})
        await rt._tool_result(agent, cid, "use_skill", False, out)
        return
    if a.resource:
        bundle = rt.pinned_skills.get(sk.name, {})
        document = next((d for d in bundle.get("documents", []) if d["path"] == a.resource), None)
        out = document["content"] if document else "Resource is not present in the pinned skill bundle"
        rt.observe(agent.id, {"tool": "use_skill", "ok": document is not None, "content": out})
        await rt._tool_result(agent, cid, "use_skill", document is not None, out)
        return
    await rt.set_agent_status(agent.id, "reading", f"Following the {sk.name} skill…")
    rt.log(agent.id, f"uses the {sk.name} skill")
    resources = ", ".join(d["path"] for d in rt.pinned_skills.get(sk.name, {}).get("documents", []) if d["path"] != "SKILL.md")
    rt.observe(agent.id, {"tool": "use_skill", "ok": True, "content": f"# Skill: {sk.name}\n{sk.description}\n\n{sk.body}\nPinned resources (load using use_skill resource): {resources or 'none'}"})
    await rt._tool_result(agent, cid, "use_skill", True, sk.name)
