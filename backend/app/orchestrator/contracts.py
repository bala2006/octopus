"""Validated execution identities. Skills propose work; these contracts cap it."""
from __future__ import annotations

import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class ExecutionPolicy(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    mode: Literal["trusted_host", "restricted"] = "trusted_host"
    permission: Literal["read_only", "plan", "ask", "auto", "danger"] = "ask"
    capabilities: frozenset[str] = frozenset()
    max_concurrency: int = Field(3, ge=1, le=3)
    max_depth: int = Field(2, ge=0, le=2)


class Assignment(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    version: int = 1
    run_id: str
    request_id: str | None = None
    task_id: str | None = None
    revision: int = Field(1, ge=1)
    owner: str
    lead: str
    provider: str
    model: str
    effort: str = "default"
    workflow: Literal["auto", "explain", "fix", "build", "review"] = "auto"
    original_goal: str
    criteria: tuple[str, ...] = ()
    dependencies: tuple[str, ...] = ()
    write_paths: tuple[str, ...] = ("*",)
    max_turns: int = Field(30, ge=1, le=300)
    workflow_hash: str = ""
    policy: ExecutionPolicy
    skill_hashes: dict[str, str] = Field(default_factory=dict)
    base_manifest: dict[str, str] = Field(default_factory=dict)


def validate_reporting(agents: list[dict]) -> None:
    by_id = {a["id"]: a for a in agents}
    for aid in by_id:
        visited: set[str] = set()
        current: str | None = aid
        while current:
            if current in visited:
                raise ValueError("Agent reporting relationships contain a cycle")
            if current not in by_id:
                raise ValueError("Agent reports to an unknown teammate")
            visited.add(current)
            current = by_id[current].get("reports_to")


def choose_lead(agents: list[dict], previous: str | None = None) -> str:
    eligible = [a for a in agents if a.get("active", True)]
    if previous and any(a["id"] == previous for a in eligible):
        return previous
    entries = [a for a in eligible if a.get("is_entry")]
    candidates = entries or eligible
    if not candidates:
        raise ValueError("No active agent can own this chat")
    return sorted(candidates, key=lambda a: a["id"])[0]["id"]


def route_target(content: str, agents: list[dict], lead: str, explicit: str | None = None) -> str:
    eligible = [a for a in agents if a.get("active", True)]
    if explicit:
        if not any(a["id"] == explicit for a in eligible):
            raise ValueError("Selected agent is inactive or unavailable")
        return explicit
    mention = re.match(r'^\s*@(?:"([^"]+)"|([^\s:]+))', content)
    if mention:
        name = (mention[1] or mention[2]).casefold()
        matches = [a for a in eligible if name in (a["id"].casefold(), a.get("name", "").casefold())]
        if len(matches) != 1:
            raise ValueError("Agent mention is unknown or ambiguous; choose a teammate")
        return matches[0]["id"]
    return lead


def classify_workflow(goal: str) -> str:
    if re.search(r"\b(fix|bug|broken|regression|crash|debug)\b", goal, re.I):
        return "fix"
    if re.search(r"\b(review|audit|inspect changes)\b", goal, re.I):
        return "review"
    if re.search(r"\b(build|create|implement|add|change|remove|refactor|make|write)\b", goal, re.I):
        return "build"
    return "explain"
