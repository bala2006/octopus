"""Generate a company (departments → managers + specialists → channels) from a natural-language prompt.

Uses the user's configured LLM (Azure / Foundry / …) with a strict JSON spec. When no provider is configured
(Demo Mode) a deterministic keyword-driven designer produces a sensible org so the feature works offline.
"""
from __future__ import annotations

import re
from typing import Any

from pydantic import BaseModel, Field, ValidationError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.db.base import new_id
from app.llm.base import LLMError, LLMRequest
from app.llm.router import prepare_request, stream_with_retry
from app.orchestrator.actions import _extract_json
from app.prompts.roles import agent_from_role, all_roles
from app.services.canvas import department_color
from app.services.templates import layout_departments, wire_org

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


# ------------------------------------------------------------------ offline designer
CATALOG: list[tuple[str, str, tuple[str, str], list[tuple[str, str]], str]] = [
    # (department, trigger regex, (manager role_key, role), [(member role_key, role)], description)
    ("Product", r"app|product|software|platform|saas|tool|website|build|mvp|feature",
     ("head_of_product", "Head of Product"), [("product_manager", "Product Manager"), ("ux_designer", "UX Designer")], "Decides what to build and why."),
    ("Engineering", r"app|software|code|api|web|mobile|platform|saas|build|backend|frontend|mvp|tool|website|game",
     ("eng_manager", "Engineering Manager"), [("fullstack_dev", "Backend Engineer"), ("fullstack_dev", "Frontend Engineer")], "Builds and reviews the software."),
    ("Quality", r"app|software|code|api|web|mobile|platform|saas|build|test|quality|mvp|tool|website|game",
     ("qa_lead", "QA Lead"), [("qa_engineer", "QA Engineer")], "Proves it works."),
    ("Operations", r"deploy|cloud|infra|devops|scale|production|kubernetes|docker|reliab|hosting|launch",
     ("devops_lead", "Head of Operations"), [("sre", "Site Reliability Engineer")], "Ships and runs it."),
    ("Growth", r"market|launch|growth|sales|customer|brand|seo|campaign|audience|go-to-market|gtm",
     ("marketing_lead", "Head of Marketing"), [("content_writer", "Content Writer"), ("growth_analyst", "Growth Analyst")], "Brings it to customers."),
    ("Research", r"research|analy|study|investigat|survey|evaluate|compare|benchmark|data|science",
     ("research_director", "Research Director"), [("researcher", "Researcher"), ("data_analyst", "Data Analyst")], "Finds and weighs the evidence."),
    ("Publishing", r"article|report|book|blog|content|paper|newsletter|documentation|docs|whitepaper",
     ("editor_in_chief", "Editor-in-Chief"), [("writer", "Writer")], "Turns work into clear publications."),
    ("Security", r"security|compliance|privacy|gdpr|hipaa|audit|threat|pentest|soc ?2",
     ("department_head", "Head of Security"), [("specialist", "Security Engineer")], "Keeps it safe and compliant."),
    ("Support", r"support|helpdesk|customer service|onboarding|success",
     ("department_head", "Head of Customer Success"), [("specialist", "Support Specialist")], "Helps customers succeed."),
]
PRIORITY = ["Engineering", "Product", "Quality", "Research", "Publishing", "Growth", "Operations", "Security", "Support"]
FIRST_NAMES = ["Maya", "Omar", "Tess", "Kofi", "Lucia", "Ada", "Hugo", "Iris", "Leo", "Ana", "Sam", "Noah", "Zoe", "Ivan", "Ravi", "Mei",
               "Elif", "Kai", "Yara", "Finn", "Lina", "Theo", "Nia", "Jonas", "Sofia", "Arjun", "Emma", "Mateo", "Hana", "Luca"]


def offline_spec(prompt: str, max_agents: int) -> OrgSpec:
    p = prompt.lower()
    chosen = [c for c in CATALOG if re.search(c[1], p)]
    if not chosen:
        chosen = [c for c in CATALOG if c[0] in ("Product", "Engineering", "Quality")]
    chosen.sort(key=lambda c: PRIORITY.index(c[0]))
    mobile = bool(re.search(r"mobile|ios|android", p))
    names = iter(FIRST_NAMES)
    budget = max_agents - 1  # minus the head
    chosen = chosen[: max(1, budget // 2)]  # every department needs at least a manager + 1 member
    # fair allocation: 1 manager + 1 member per department first, then extra members in priority order
    alloc = {c[0]: 1 for c in chosen}
    budget -= 2 * len(chosen)
    for extra in range(1, 4):
        for c in chosen:
            if budget > 0 and len(c[3]) > extra:
                alloc[c[0]] += 1
                budget -= 1
    depts: list[DeptSpec] = []
    for dept, _, (mk, mrole), members, desc in chosen:
        people = [PersonSpec(name=next(names), role=mrole, role_template=mk)]
        for rk, role in members[: alloc[dept]]:
            if mobile and role == "Frontend Engineer":
                role = "Mobile Engineer"
            people.append(PersonSpec(name=next(names), role=role, role_template=rk))
        depts.append(DeptSpec(name=dept, description=desc, manager=people[0], members=people[1:]))
    title = re.sub(r"[^\w\s-]", "", prompt).strip().split("\n")[0][:48] or "New venture"
    head = PersonSpec(name="Ava", role="CEO", role_template="ceo", description="Owns the goal and the final outcome.")
    links: list[LinkSpec] = []
    by = {d.name: d for d in depts}
    if "Product" in by and "Engineering" in by:
        links.append(LinkSpec(**{"from": by["Product"].manager.name, "to": by["Engineering"].manager.name, "type": "debate", "label": "Scope vs. effort"}))
    if "Engineering" in by and "Quality" in by:
        links.append(LinkSpec(**{"from": by["Engineering"].manager.name, "to": by["Quality"].manager.name, "type": "review", "label": "Release review"}))
    if "Research" in by and "Publishing" in by:
        links.append(LinkSpec(**{"from": by["Research"].manager.name, "to": by["Publishing"].manager.name, "type": "review", "label": "Accuracy review"}))
    if "Quality" in by and "Operations" in by:
        links.append(LinkSpec(**{"from": by["Quality"].manager.name, "to": by["Operations"].manager.name, "type": "delegate", "bidirectional": False, "label": "Release handoff"}))
    return OrgSpec(name=f"{title.title()} Co.", description=f"Generated for: {prompt[:200]}", head=head, departments=depts, links=links)


# ------------------------------------------------------------------ spec → canvas
def _person_agent(p: PersonSpec, *, department: str, is_manager: bool, entry: bool = False) -> dict[str, Any]:
    roles = all_roles()
    key = p.role_template if p.role_template in roles else ("department_head" if is_manager else "specialist")
    a = agent_from_role(key, name=p.name, entry=entry, department=department, is_manager=is_manager, role=p.role)
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
    """Return (spec, source, warning)."""
    s = get_settings()
    req = LLMRequest(provider=provider or s.default_provider, model=model or s.default_model, temperature=0.3, max_tokens=6000, json_mode=True,
                     messages=[{"role": "system", "content": DESIGNER_PROMPT.format(roles=", ".join(sorted(all_roles())), max_agents=max_agents)},
                               {"role": "user", "content": prompt}], metadata={"kind": "summary"})
    try:
        req, warn = await prepare_request(rdb, user_id, req)
    except LLMError as exc:
        return offline_spec(prompt, max_agents), "demo", str(exc)
    if req.provider == "mock":
        return offline_spec(prompt, max_agents), "demo", warn or ""
    text = ""
    try:
        async for ch in stream_with_retry(req):
            text += ch.delta
        spec = OrgSpec.model_validate(_extract_json(text))
        return spec, "ai", ""
    except (LLMError, ValueError, ValidationError) as exc:
        return offline_spec(prompt, max_agents), "demo", f"The model's design could not be used ({str(exc)[:200]}); used the offline designer."
