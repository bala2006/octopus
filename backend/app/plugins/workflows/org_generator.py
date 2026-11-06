"""Generate a company (departments, managers, specialists, channels) from a natural-language prompt.

Uses the connected Azure OpenAI deployment with a strict JSON spec. Without a connected model, generation fails with a clear error.
"""
from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field, ValidationError
from sqlalchemy.ext.asyncio import AsyncSession

from app.foundation.config import get_settings
from app.storage.base import new_id
from app.sdk.llm import LLMError, LLMRequest
from app.sdk.actions import _extract_json
from app.plugins.workflows.deps import deps
from app.plugins.workflows.canvas import department_color
from app.plugins.workflows.templates import layout_departments, wire_org

EDGE_TYPES = {"delegate", "review", "debate", "report", "consult"}
TOOL_KEYS = {"file_read", "file_write", "list_files", "terminal", "web_search", "calculator", "ask_user", "send_message", "manage_team"}


class PersonSpec(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    role: str = Field(min_length=1, max_length=80)
    role_template: str | None = None
    description: str = ""
    system_prompt: str = ""
    tools: list[str] = Field(default_factory=list)


class DeptSpec(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    description: str = ""
    manager: PersonSpec
    members: list[PersonSpec] = Field(default_factory=list, max_length=4)


class LinkSpec(BaseModel):
    source: str = Field(alias="from")
    target: str = Field(alias="to")
    type: str = "consult"
    bidirectional: bool = True
    label: str = ""


class OrgSpec(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = ""
    head: PersonSpec
    departments: list[DeptSpec] = Field(min_length=1, max_length=10)
    links: list[LinkSpec] = Field(default_factory=list)


DESIGNER_PROMPT = """You are an expert organisation designer for AI-agent companies. Design the smallest effective company
for the user's goal. Rules:
- One company head (CEO or founder) who is the entry point.
- 1-5 departments, only the ones the goal really needs. Each department has exactly 1 manager and 0-2 members; give a
  department members only when its work really splits between people. Builders own quality of their own output (they
  run and test what they build), so don't add departments whose only job is to review or coordinate others.
- Each person gets a precise role, a 1-sentence description, a focused system prompt (responsibilities, deliverables
  as files, who to report to) and only the tools they need from: file_read, file_write, list_files, terminal,
  web_search, calculator, ask_user, manage_team. Managers get manage_team.
- Optionally set role_template to one of: {roles}.
- Add cross-department links only where people must collaborate directly
  (types: review, debate, consult, delegate, report).
- Respect the maximum team size: {max_agents} people including the head.
Reply with ONLY this JSON:
{{"name": "...", "description": "...",
  "head": {{"name": "...", "role": "...", "role_template": "ceo", "description": "...", "system_prompt": "...", "tools": [...]}},
  "departments": [{{"name": "...", "description": "...", "manager": {{...person}}, "members": [{{...person}}]}}],
  "links": [{{"from": "<person name>", "to": "<person name>", "type": "review", "bidirectional": true, "label": "..."}}]}}"""


def _person_agent(p: PersonSpec, *, department: str, is_manager: bool, entry: bool = False) -> dict[str, Any]:
    roles = deps.require("roles.builtin").all_roles()
    key = p.role_template if p.role_template in roles else ("department_head" if is_manager else "specialist")
    a = deps.require("roles.builtin").agent_from_role(key, name=p.name, entry=entry, department=department, is_manager=is_manager, role=p.role)
    if p.description:
        a["description"] = p.description
    if p.system_prompt.strip():
        a["system_prompt"] = p.system_prompt.strip() + "\n\n" + (roles[key].system_prompt.split("## When to finish")[-1].strip() if key in roles else "")
    if p.tools:
        tools = {k: False for k in TOOL_KEYS}
        tools.update({t: True for t in p.tools if t in TOOL_KEYS})
        tools["send_message"] = True
        tools["manage_team"] = tools.get("manage_team") or is_manager
        a["tools"] = {**a["tools"], **tools}
    a["id"] = new_id()
    return a


def spec_to_canvas(spec: OrgSpec, max_agents: int) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, dict[str, str]]]:
    used: set[str] = set()

    def uniq(p: PersonSpec) -> PersonSpec:
        base, n = p.name.strip(), 2
        name = base
        while name.lower() in used:
            name, n = f"{base} {n}", n + 1
        used.add(name.lower())
        return p.model_copy(update={"name": name})

    head = _person_agent(uniq(spec.head), department="Executive", is_manager=True, entry=True)
    agents = [head]
    meta = {"Executive": {"color": department_color("Executive"), "description": "Company leadership."}}
    for d in spec.departments:
        if len(agents) >= max_agents:
            break
        mgr = _person_agent(uniq(d.manager), department=d.name, is_manager=True)
        mgr["reports_to"] = head["id"]
        agents.append(mgr)
        meta[d.name] = {"color": department_color(d.name), "description": d.description}
        for m in d.members:
            if len(agents) >= max_agents:
                break
            a = _person_agent(uniq(m), department=d.name, is_manager=False)
            a["reports_to"] = mgr["id"]
            agents.append(a)
    by_name = {a["name"].lower(): a["id"] for a in agents}
    links = [{"src": by_name[ln.source.lower()], "dst": by_name[ln.target.lower()], "type": ln.type if ln.type in EDGE_TYPES else "consult",
              "bidirectional": ln.bidirectional, "label": ln.label} for ln in spec.links
             if ln.source.lower() in by_name and ln.target.lower() in by_name]
    edges = wire_org(agents, head["id"], links)
    layout_departments(agents, head["id"])
    return agents, edges, meta


async def generate_org(rdb: AsyncSession, user_id: str, prompt: str, max_agents: int, provider: str | None, model: str | None) -> tuple[OrgSpec, str, str]:
    """Return (spec, source, warning). Raises LLMError when no model is connected or its design is unusable."""
    s = get_settings()
    req = LLMRequest(provider=provider or s.default_provider, model=model or s.default_model, temperature=0.3, max_tokens=6000, json_mode=True,
                     messages=[{"role": "system", "content": DESIGNER_PROMPT.format(roles=", ".join(sorted(deps.require("roles.builtin").all_roles())), max_agents=max_agents)},
                               {"role": "user", "content": prompt}], metadata={"kind": "summary"})
    req, warn = await deps.require("models.router").prepare_request(rdb, user_id, req)
    text = ""
    try:
        async for ch in deps.require("models.router").stream_with_retry(req):
            text += ch.delta
        spec = OrgSpec.model_validate(_extract_json(text))
    except (ValueError, ValidationError) as exc:
        raise LLMError(f"The model's design could not be used ({str(exc)[:200]}). Try again or describe the team differently.", retryable=False) from exc
    return spec, "ai", warn or ""
