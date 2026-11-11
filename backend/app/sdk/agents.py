"""The runtime's view of an agent, and the role categories used to group agents (CEO, PM, engineers, QA...)."""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from app.sdk.llm import effective_max_tokens

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


@dataclass
class AgentSpec:
    id: str
    name: str
    role: str
    description: str
    system_prompt: str
    provider: str
    model: str
    temperature: float
    max_tokens: int
    tools: dict[str, bool]
    behavior: dict[str, Any]
    is_entry: bool
    color: str
    category: str = "generic"
    department: str = ""
    is_manager: bool = False
    reports_to: str | None = None
    active: bool = True
    created_by: str | None = None
    avatar: str = ""
    memory: dict[str, str] = field(default_factory=dict)
    mcp: list[dict[str, Any]] = field(default_factory=list)  # [{id, name, tools}]

    @classmethod
    def from_dict(cls, d: dict[str, Any], category: str) -> AgentSpec:
        return cls(id=d["id"], name=d["name"], role=d.get("role", ""), description=d.get("description", ""),
                   system_prompt=d.get("system_prompt", ""), provider=d.get("provider", "azure"), model=d.get("model", "gpt-6-luna"),
                   temperature=float(d.get("temperature", 0.4)), max_tokens=effective_max_tokens(d.get("max_tokens")),
                   tools=d.get("tools") or {}, behavior=d.get("behavior") or {}, is_entry=bool(d.get("is_entry")),
                   color=d.get("color", "#6366f1"), category=category, department=d.get("department") or "",
                   is_manager=bool(d.get("is_manager")), reports_to=d.get("reports_to"), active=d.get("active", True) is not False,
                   created_by=d.get("created_by"), avatar=d.get("avatar") or "")

    def to_dict(self) -> dict[str, Any]:
        """Serialise back to the AgentOut-like shape stored in run snapshots."""
        return {"id": self.id, "name": self.name, "role": self.role, "description": self.description, "system_prompt": self.system_prompt,
                "provider": self.provider, "model": self.model, "temperature": self.temperature, "max_tokens": self.max_tokens,
                "tools": self.tools, "behavior": self.behavior, "is_entry": self.is_entry, "color": self.color, "avatar": self.avatar,
                "department": self.department, "is_manager": self.is_manager, "reports_to": self.reports_to, "active": self.active,
                "created_by": self.created_by}
