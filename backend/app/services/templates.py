"""Company templates (one-click, fully editable)."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from app.db.base import new_id
from app.prompts.roles import agent_from_role


@dataclass(frozen=True)
class CompanyTemplate:
    key: str
    name: str
    description: str
    agents: list[tuple[str, str, bool, float, float]]  # (local_key, role_key, is_entry, x, y)
    edges: list[tuple[str, str, str, bool, str, dict[str, Any]]]  # (src, dst, type, bidirectional, label, config)


TEMPLATES: dict[str, CompanyTemplate] = {
    "software_startup": CompanyTemplate(
        key="software_startup",
        name="Software Startup",
        description="CEO → PM → Architect → Devs → QA → DevOps, with scope debate, design consults and code reviews.",
        agents=[
            ("ceo", "ceo", True, 560, 0),
            ("pm", "pm", False, 560, 200),
            ("architect", "architect", False, 560, 400),
            ("designer", "designer", False, 40, 600),
            ("frontend", "frontend", False, 320, 600),
            ("backend", "backend", False, 800, 600),
            ("qa", "qa", False, 560, 800),
            ("devops", "devops", False, 560, 1000),
        ],
        edges=[
            ("ceo", "pm", "delegate", False, "Product delivery", {}),
            ("ceo", "pm", "debate", True, "Scope negotiation", {"max_rounds": 4}),
            ("pm", "architect", "delegate", False, "Technical design", {}),
            ("architect", "frontend", "delegate", False, "Frontend tasks", {}),
            ("architect", "backend", "delegate", False, "Backend tasks", {}),
            ("architect", "frontend", "review", True, "Frontend code review", {"max_revisions": 3}),
            ("architect", "backend", "review", True, "Backend code review", {"max_revisions": 3}),
            ("designer", "frontend", "consult", True, "Design consult", {}),
            ("frontend", "qa", "delegate", False, "Frontend QA handoff", {"condition": "only once the code review is approved"}),
            ("backend", "qa", "delegate", False, "Backend QA handoff", {"condition": "only once the code review is approved"}),
            ("qa", "devops", "delegate", False, "Release handoff", {"condition": "only if all tests pass"}),
            ("qa", "pm", "report", False, "Test results", {}),
            ("devops", "pm", "report", False, "Deployment status", {}),
            ("pm", "ceo", "report", False, "Final report", {}),
        ],
    ),
    "small_dev_team": CompanyTemplate(
        key="small_dev_team",
        name="Small Dev Team",
        description="A lean PM, Developer and QA loop with code review.",
        agents=[
            ("pm", "pm", True, 300, 0),
            ("dev", "developer", False, 80, 240),
            ("qa", "qa", False, 520, 240),
        ],
        edges=[
            ("pm", "dev", "delegate", False, "Implementation", {}),
            ("qa", "dev", "review", True, "QA review", {"max_revisions": 3}),
            ("dev", "pm", "report", False, "Progress", {}),
            ("qa", "pm", "report", False, "Test results", {}),
        ],
    ),
    "debate_panel": CompanyTemplate(
        key="debate_panel",
        name="Debate Panel",
        description="Proposer vs Critic in structured rounds, with a Moderator who issues binding decisions.",
        agents=[
            ("proposer", "proposer", True, 60, 220),
            ("critic", "critic", False, 560, 220),
            ("moderator", "moderator", False, 310, 0),
        ],
        edges=[
            ("proposer", "critic", "debate", True, "Structured debate", {"max_rounds": 3}),
            ("moderator", "proposer", "consult", True, "Moderation", {}),
            ("moderator", "critic", "consult", True, "Moderation", {}),
        ],
    ),
    "blank": CompanyTemplate(key="blank", name="Blank Canvas", description="Start from scratch.", agents=[], edges=[]),
}


def build_template(key: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Return (agents, edges) dicts with fresh ids, ready for canvas sync."""
    t = TEMPLATES[key]
    ids: dict[str, str] = {}
    agents: list[dict[str, Any]] = []
    for local, role_key, entry, x, y in t.agents:
        aid = new_id()
        ids[local] = aid
        a = agent_from_role(role_key, entry=entry, x=x, y=y)
        a["id"] = aid
        agents.append(a)
    edges: list[dict[str, Any]] = []
    for src, dst, etype, bidi, label, cfg in t.edges:
        config = {"max_turns": 20, "handoff_instructions": "", "condition": "", "max_rounds": 4, "max_revisions": 3}
        config.update(cfg)
        edges.append({
            "id": new_id(), "source_agent_id": ids[src], "target_agent_id": ids[dst],
            "type": etype, "bidirectional": bidi, "label": label, "config": config,
        })
    return agents, edges
