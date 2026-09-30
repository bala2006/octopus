"""Company templates built from departments.

A template is a set of **departments**; each department has exactly one **manager** and a few members
(typically 2-3 people in total). ``wire_org`` turns that structure into communication channels:

- manager → member  ``delegate`` ("<dept> tasks")      member → manager ``report``
- head → every other department manager ``delegate``    manager → head ``report``
- department managers ↔ each other ``consult`` (peer coordination)
- plus explicit cross-department ``links`` (reviews, debates, consults between specific people)

The same machinery is used by built-in templates, user templates, the canvas "Add department" builder
and the AI org generator.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from app.db.base import new_id
from app.prompts.roles import agent_from_role, all_roles
from app.services.canvas import department_color

DEFAULT_EDGE_CONFIG = {"max_turns": 20, "handoff_instructions": "", "condition": "", "max_rounds": 4, "max_revisions": 3}


@dataclass(frozen=True)
class Member:
    key: str  # local key inside the template
    role_key: str  # role template
    name: str | None = None
    role: str | None = None
    entry: bool = False
    x: float | None = None
    y: float | None = None


@dataclass(frozen=True)
class Department:
    name: str
    manager: Member
    members: tuple[Member, ...] = ()
    color: str | None = None
    description: str = ""
    reports_to: str | None = None  # local key of the manager this department's head reports to (default: company head)


@dataclass(frozen=True)
class Link:
    src: str
    dst: str
    type: str
    bidirectional: bool = False
    label: str = ""
    config: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class CompanyTemplate:
    key: str
    name: str
    description: str
    departments: tuple[Department, ...]
    links: tuple[Link, ...] = ()
    head: str | None = None  # local key of the company head (usually the CEO / founder)
    auto_wire: bool = True  # False: only explicit links (hand-tuned templates)


def M(key: str, role_key: str, **kw: Any) -> Member:  # noqa: N802 - tiny DSL helper
    return Member(key=key, role_key=role_key, **kw)


TEMPLATES: dict[str, CompanyTemplate] = {
    "software_startup": CompanyTemplate(
        key="software_startup", name="Software Startup",
        description="Executive, Product & Design, Engineering and Quality & Ops: scope debate, design consults, code reviews and QA.",
        head="ceo", auto_wire=False,
        departments=(
            Department("Executive", M("ceo", "ceo", entry=True, x=560, y=0)),
            Department("Product & Design", M("pm", "pm", x=560, y=200), (M("designer", "designer", x=40, y=600),), reports_to="ceo"),
            Department("Engineering", M("architect", "architect", x=560, y=400),
                       (M("frontend", "frontend", x=320, y=600), M("backend", "backend", x=800, y=600)), reports_to="pm"),
            Department("Quality & Ops", M("qa", "qa", x=560, y=800), (M("devops", "devops", x=560, y=1000),), reports_to="architect"),
        ),
        links=(
            Link("ceo", "pm", "delegate", False, "Product delivery"),
            Link("ceo", "pm", "debate", True, "Scope negotiation", {"max_rounds": 4}),
            Link("pm", "architect", "delegate", False, "Technical design"),
            Link("architect", "frontend", "delegate", False, "Frontend tasks"),
            Link("architect", "backend", "delegate", False, "Backend tasks"),
            Link("architect", "frontend", "review", True, "Frontend code review", {"max_revisions": 3}),
            Link("architect", "backend", "review", True, "Backend code review", {"max_revisions": 3}),
            Link("designer", "frontend", "consult", True, "Design consult"),
            Link("frontend", "qa", "delegate", False, "Frontend QA handoff", {"condition": "only once the code review is approved"}),
            Link("backend", "qa", "delegate", False, "Backend QA handoff", {"condition": "only once the code review is approved"}),
            Link("qa", "devops", "delegate", False, "Release handoff", {"condition": "only if all tests pass"}),
            Link("qa", "pm", "report", False, "Test results"),
            Link("devops", "pm", "report", False, "Deployment status"),
            Link("pm", "ceo", "report", False, "Final report"),
        ),
    ),
    "full_company": CompanyTemplate(
        key="full_company", name="Full Company (6 departments)",
        description="Executive, Product, Engineering, Quality, Operations and Growth: each with a manager and 1-2 specialists.",
        head="ceo",
        departments=(
            Department("Executive", M("ceo", "ceo", entry=True), (M("cos", "chief_of_staff"),)),
            Department("Product", M("hop", "head_of_product"), (M("pm", "product_manager"), M("ux", "ux_designer"))),
            Department("Engineering", M("em", "eng_manager"), (M("be", "fullstack_dev", name="Leo", role="Backend Engineer"),
                                                                M("fe", "fullstack_dev", name="Ana", role="Frontend Engineer"))),
            Department("Quality", M("qal", "qa_lead"), (M("qae", "qa_engineer"),)),
            Department("Operations", M("ops", "devops_lead"), (M("sre", "sre"),)),
            Department("Growth", M("mkt", "marketing_lead"), (M("cw", "content_writer"), M("ga", "growth_analyst"))),
        ),
        links=(
            Link("hop", "em", "debate", True, "Scope vs. effort", {"max_rounds": 3}),
            Link("em", "qal", "review", True, "Release review", {"max_revisions": 3}),
            Link("ux", "fe", "consult", True, "Design consult"),
            Link("qal", "ops", "delegate", False, "Release handoff", {"condition": "only if all tests pass"}),
            Link("cw", "pm", "consult", True, "Product facts"),
        ),
    ),
    "self_organizing": CompanyTemplate(
        key="self_organizing", name="Self-organizing Company",
        description="Just a Founder. Give a goal: the Founder designs departments and hires & configures agents as needed during the run.",
        head="founder",
        departments=(Department("Executive", M("founder", "founder", entry=True)),),
    ),
    "research_lab": CompanyTemplate(
        key="research_lab", name="Research Lab",
        description="Research (director, researcher, analyst) and Publishing (editor, writer) with an accuracy review loop.",
        head="dir",
        departments=(
            Department("Research", M("dir", "research_director", entry=True), (M("res", "researcher"), M("ana", "data_analyst"))),
            Department("Publishing", M("ed", "editor_in_chief"), (M("wr", "writer"),)),
        ),
        links=(Link("dir", "ed", "review", True, "Accuracy review", {"max_revisions": 2}),),
    ),
    "small_dev_team": CompanyTemplate(
        key="small_dev_team", name="Small Dev Team",
        description="One team: a PM (manager), a Developer and QA with a code-review loop.", head="pm", auto_wire=False,
        departments=(Department("Team", M("pm", "pm", entry=True, x=300, y=0), (M("dev", "developer", x=80, y=240), M("qa", "qa", x=520, y=240))),),
        links=(
            Link("pm", "dev", "delegate", False, "Implementation"),
            Link("qa", "dev", "review", True, "QA review", {"max_revisions": 3}),
            Link("dev", "pm", "report", False, "Progress"),
            Link("qa", "pm", "report", False, "Test results"),
        ),
    ),
    "debate_panel": CompanyTemplate(
        key="debate_panel", name="Debate Panel",
        description="Proposer vs Critic in structured rounds; a Moderator (manager) issues binding decisions.", head="moderator", auto_wire=False,
        departments=(Department("Panel", M("moderator", "moderator", x=310, y=0), (M("proposer", "proposer", entry=True, x=60, y=220), M("critic", "critic", x=560, y=220))),),
        links=(
            Link("proposer", "critic", "debate", True, "Structured debate", {"max_rounds": 3}),
            Link("moderator", "proposer", "consult", True, "Moderation"),
            Link("moderator", "critic", "consult", True, "Moderation"),
        ),
    ),
    "web_app_studio": CompanyTemplate(
        key="web_app_studio", name="Web App Studio",
        description="Product, Engineering and QA for a browser app. An E2E tester clicks through every feature in the real browser.",
        head="hop",
        departments=(
            Department("Product", M("hop", "head_of_product", entry=True), (M("ux", "ux_designer"),)),
            Department("Engineering", M("em", "eng_manager"), (M("fe", "fullstack_dev", name="Ana", role="Frontend Engineer"),
                                                                M("be", "fullstack_dev", name="Leo", role="Backend Engineer"))),
            Department("Quality", M("qal", "qa_lead"), (M("e2e", "e2e_tester"),)),
        ),
        links=(
            Link("ux", "fe", "consult", True, "Design consult"),
            Link("em", "fe", "review", True, "Code review", {"max_revisions": 3}),
            Link("em", "be", "review", True, "Code review", {"max_revisions": 3}),
            Link("e2e", "fe", "consult", True, "Bug reports"),
        ),
    ),
    "game_studio": CompanyTemplate(
        key="game_studio", name="Indie Game Studio",
        description="A director, a designer, two gameplay programmers and a playtester who plays each build in the browser.",
        head="dir",
        departments=(
            Department("Direction", M("dir", "game_director", entry=True), (M("gd", "game_designer"),)),
            Department("Engineering", M("em", "eng_manager", name="Omar", role="Lead Programmer"),
                       (M("gp1", "gameplay_programmer"), M("gp2", "gameplay_programmer", name="Sara", role="Graphics & UI Programmer"))),
            Department("Playtest", M("qal", "qa_lead", name="Tess", role="QA Lead"), (M("pt", "playtester"),)),
        ),
        links=(
            Link("gd", "gp1", "consult", True, "Mechanics & tuning"),
            Link("dir", "em", "debate", True, "Scope vs. time", {"max_rounds": 3}),
            Link("pt", "gd", "report", False, "Playtest notes"),
            Link("em", "gp1", "review", True, "Code review", {"max_revisions": 2}),
        ),
    ),
    "mobile_app_team": CompanyTemplate(
        key="mobile_app_team", name="Mobile App Team",
        description="Mobile-first web app (installable PWA): research-led product, two mobile devs and QA testing at phone sizes.",
        head="hop",
        departments=(
            Department("Product", M("hop", "head_of_product", entry=True), (M("uxr", "ux_researcher"), M("ux", "ux_designer"))),
            Department("Mobile", M("em", "eng_manager"), (M("m1", "mobile_dev"), M("m2", "mobile_dev", name="Chloe", role="Mobile Web Developer (offline & sync)"))),
            Department("Quality", M("qal", "qa_lead"), (M("e2e", "e2e_tester"),)),
        ),
        links=(Link("ux", "m1", "consult", True, "Design consult"), Link("uxr", "e2e", "consult", True, "Usability checks")),
    ),
    "saas_launch": CompanyTemplate(
        key="saas_launch", name="SaaS Launch",
        description="Build and launch: Product, Engineering, Quality, Marketing and Sales, from PRD to pricing page and launch copy.",
        head="ceo",
        departments=(
            Department("Executive", M("ceo", "ceo", entry=True)),
            Department("Product", M("hop", "head_of_product"), (M("pm", "product_manager"),)),
            Department("Engineering", M("em", "eng_manager"), (M("dev", "fullstack_dev"), M("e2e", "e2e_tester"))),
            Department("Marketing", M("mkt", "marketing_lead"), (M("cw", "content_writer"), M("seo", "seo_specialist"))),
            Department("Sales", M("sales", "sales_lead")),
        ),
        links=(
            Link("hop", "em", "debate", True, "Scope vs. effort", {"max_rounds": 3}),
            Link("cw", "pm", "consult", True, "Product facts"),
            Link("sales", "hop", "consult", True, "Pricing & packaging"),
        ),
    ),
    "data_science_team": CompanyTemplate(
        key="data_science_team", name="Data Science Team",
        description="A lead, a data engineer and an ML engineer, plus an analyst and a writer who turn results into a clear report.",
        head="lead",
        departments=(
            Department("Data Science", M("lead", "data_science_lead", entry=True), (M("de", "data_engineer"), M("ml", "ml_engineer"))),
            Department("Insights", M("ed", "editor_in_chief", name="Hugo", role="Insights Lead"), (M("da", "data_analyst"), M("wr", "writer"))),
        ),
        links=(Link("lead", "ed", "review", True, "Accuracy review", {"max_revisions": 2}), Link("ml", "da", "consult", True, "Metrics")),
    ),
    "security_audit": CompanyTemplate(
        key="security_audit", name="Security Audit",
        description="Audit this project's own code: threat model, findings with fixes, regression tests, and an engineering fix loop.",
        head="sec",
        departments=(
            Department("Security", M("sec", "security_lead", entry=True), (M("appsec", "security_engineer"),)),
            Department("Engineering", M("em", "eng_manager"), (M("dev", "fullstack_dev"),)),
        ),
        links=(Link("appsec", "dev", "review", True, "Fix verification", {"max_revisions": 3}),),
    ),
    "content_studio": CompanyTemplate(
        key="content_studio", name="Content & Marketing Studio",
        description="Creative brief, SEO research, writing and editing: blog posts, landing copy and a launch campaign.",
        head="cd",
        departments=(
            Department("Creative", M("cd", "creative_director", entry=True), (M("seo", "seo_specialist"),)),
            Department("Editorial", M("ed", "editor_in_chief"), (M("cw", "content_writer"), M("wr", "writer"))),
            Department("Analytics", M("mkt", "marketing_lead", name="Lucia", role="Growth Lead"), (M("ga", "growth_analyst"),)),
        ),
        links=(Link("cd", "ed", "review", True, "Brand review", {"max_revisions": 2}), Link("seo", "cw", "consult", True, "Keywords")),
    ),
    "support_desk": CompanyTemplate(
        key="support_desk", name="Customer Support Desk",
        description="Support playbooks, help-centre articles and bug escalation, with a technical writer and a product liaison.",
        head="sup",
        departments=(
            Department("Support", M("sup", "support_lead", entry=True), (M("agent", "support_agent"), M("tw", "technical_writer"))),
            Department("Product", M("hop", "head_of_product"), (M("pm", "product_manager"),)),
        ),
        links=(Link("sup", "hop", "consult", True, "Bug escalation"), Link("tw", "pm", "consult", True, "Product facts")),
    ),
    "blank": CompanyTemplate(key="blank", name="Blank Canvas", description="Start from scratch.", departments=()),
}


def _edge(src: str, dst: str, etype: str, bidi: bool, label: str, cfg: dict[str, Any] | None = None) -> dict[str, Any]:
    return {"id": new_id(), "source_agent_id": src, "target_agent_id": dst, "type": etype, "bidirectional": bidi, "label": label,
            "config": {**DEFAULT_EDGE_CONFIG, **(cfg or {})}}


def wire_org(agents: list[dict[str, Any]], head_id: str | None, links: list[dict[str, Any]] | None = None,
             existing: list[dict[str, Any]] | None = None) -> list[dict[str, Any]]:
    """Derive channels from the org chart (department + manager + reports_to) and add explicit links.
    Duplicate channels (same pair + type, either direction when bidirectional) are skipped."""
    edges: list[dict[str, Any]] = list(existing or [])
    seen: set[tuple[str, str, str]] = set()
    for e in edges:
        seen.add((e["source_agent_id"], e["target_agent_id"], e["type"]))
        if e.get("bidirectional"):
            seen.add((e["target_agent_id"], e["source_agent_id"], e["type"]))

    def add(src: str, dst: str, etype: str, bidi: bool, label: str, cfg: dict[str, Any] | None = None) -> None:
        if src == dst or (src, dst, etype) in seen or (bidi and (dst, src, etype) in seen):
            return
        seen.add((src, dst, etype))
        if bidi:
            seen.add((dst, src, etype))
        edges.append(_edge(src, dst, etype, bidi, label, cfg))

    by_id = {a["id"]: a for a in agents}
    managers = [a for a in agents if a.get("is_manager")]
    for a in agents:
        mgr = by_id.get(a.get("reports_to") or "")
        if not mgr:
            continue
        dept = a.get("department") or mgr.get("department") or "Team"
        same = (a.get("department") or "") == (mgr.get("department") or "")
        add(mgr["id"], a["id"], "delegate", False, f"{dept} tasks" if same else f"{a.get('department') or dept} direction")
        add(a["id"], mgr["id"], "report", False, "Status" if same else f"{a.get('department') or dept} report")
    peers = [m for m in managers if m["id"] != head_id]
    for i, m1 in enumerate(peers):
        for m2 in peers[i + 1:]:
            if m1.get("department") != m2.get("department"):
                add(m1["id"], m2["id"], "consult", True, "Department sync")
    for ln in links or []:
        if ln["src"] in by_id and ln["dst"] in by_id:
            add(ln["src"], ln["dst"], ln["type"], bool(ln.get("bidirectional")), ln.get("label", ""), ln.get("config"))
    return edges


def layout_departments(agents: list[dict[str, Any]], head_id: str | None, origin: tuple[float, float] = (0, 0)) -> None:
    """Column per department: head on top, manager row, members stacked below (in place)."""
    depts: list[str] = []
    for a in agents:
        d = a.get("department") or "Team"
        if a["id"] != head_id and d not in depts:
            depts.append(d)
    col_w, ox, oy = 320, origin[0], origin[1]
    width = max(1, len(depts)) * col_w
    for a in agents:
        if a["id"] == head_id:
            a["position_x"], a["position_y"] = ox + width / 2 - 125, oy
    head_dept = next((a.get("department") for a in agents if a["id"] == head_id), None)
    for ci, d in enumerate(depts):
        x = ox + ci * col_w + 20
        members = [a for a in agents if (a.get("department") or "Team") == d and a["id"] != head_id]
        mgr = [a for a in members if a.get("is_manager")]
        rest = [a for a in members if not a.get("is_manager")]
        y = oy + (230 if head_id else 0)
        if d == head_dept:  # head's own department: members sit beside/below the head
            y = oy + 230
        for a in mgr + rest:
            a["position_x"], a["position_y"] = x, y
            y += 190


def build_from_template(t: CompanyTemplate) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, dict[str, str]]]:
    """Return (agents, edges, departments meta) with fresh ids, ready for canvas sync."""
    ids: dict[str, str] = {}
    agents: list[dict[str, Any]] = []
    positioned = True
    meta: dict[str, dict[str, str]] = {}
    for dept in t.departments:
        meta[dept.name] = {"color": dept.color or department_color(dept.name), "description": dept.description}
        for member, is_mgr in [(dept.manager, True)] + [(m, False) for m in dept.members]:
            aid = new_id()
            ids[member.key] = aid
            a = agent_from_role(member.role_key, name=member.name, entry=member.entry, x=member.x or 0, y=member.y or 0,
                                department=dept.name, is_manager=is_mgr, role=member.role)
            a["id"] = aid
            a["_local"] = member.key
            a["_dept_mgr"] = dept.manager.key
            a["_reports"] = dept.reports_to
            positioned = positioned and member.x is not None
            agents.append(a)
    head_id = ids.get(t.head or "")
    for a in agents:
        if a["_local"] != a["_dept_mgr"]:
            a["reports_to"] = ids[a["_dept_mgr"]]
        elif a["id"] != head_id:
            a["reports_to"] = ids.get(a["_reports"] or "") or head_id
        for k in ("_local", "_dept_mgr", "_reports"):
            a.pop(k)
    links = [{"src": ids[ln.src], "dst": ids[ln.dst], "type": ln.type, "bidirectional": ln.bidirectional, "label": ln.label,
              "config": ln.config} for ln in t.links if ln.src in ids and ln.dst in ids]
    edges = wire_org(agents, head_id, links) if t.auto_wire else [
        _edge(ln["src"], ln["dst"], ln["type"], ln["bidirectional"], ln["label"], ln["config"]) for ln in links]
    if not positioned:
        layout_departments(agents, head_id)
    return agents, edges, meta


def build_template(key: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    agents, edges, _ = build_from_template(TEMPLATES[key])
    return agents, edges


def summarize_departments(agents: list[dict[str, Any]], meta: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for a in agents:
        d = a.get("department") or ""
        if not d:
            continue
        entry = out.setdefault(d, {"name": d, "color": ((meta or {}).get(d) or {}).get("color") or department_color(d), "manager": None, "members": []})
        if a.get("is_manager") and not entry["manager"]:
            entry["manager"] = a["name"]
        else:
            entry["members"].append(a["name"])
    return list(out.values())


def template_summary(t: CompanyTemplate) -> dict[str, Any]:
    roles = all_roles()
    depts = []
    for d in t.departments:
        depts.append({"name": d.name, "color": d.color or department_color(d.name),
                      "manager": d.manager.name or roles[d.manager.role_key].default_name,
                      "members": [m.name or roles[m.role_key].default_name for m in d.members]})
    agents, edges, _ = build_from_template(t)
    return {"key": t.key, "name": t.name, "description": t.description, "agent_count": len(agents), "edge_count": len(edges),
            "source": "builtin", "departments": depts}
