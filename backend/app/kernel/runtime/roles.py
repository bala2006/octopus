"""Role categories used by the orchestrator to group agents (CEO, PM, engineers, QA...)."""
from __future__ import annotations

import re

ROLE_KEYWORDS: list[tuple[str, tuple[str, ...]]] = [
    ("ceo", ("ceo", "chief executive", "founder")),
    ("pm", ("product manager", "product owner", "pm")),
    ("architect", ("architect",)),
    ("frontend", ("frontend", "front-end", "ui developer")),
    ("backend", ("backend", "back-end")),
    ("qa", ("qa", "quality", "tester", "test engineer")),
    ("designer", ("designer", "ux", "ui/ux")),
    ("devops", ("devops", "sre", "infrastructure", "platform")),
    ("moderator", ("moderator", "judge")),
    ("proposer", ("proposer", "advocate")),
    ("critic", ("critic", "skeptic")),
    ("techlead", ("tech lead", "reviewer")),
    ("developer", ("developer", "engineer", "programmer")),
]


def role_category(role: str, template_key: str = "") -> str:
    if template_key:
        return template_key
    r = role.lower()
    for cat, words in ROLE_KEYWORDS:
        if any(re.search(rf"\b{re.escape(w)}\b", r) for w in words):
            return cat
    return "generic"

