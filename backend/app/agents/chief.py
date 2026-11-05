"""Chief orchestrator: lead selection, reporting checks, and routing a message to its owner.

Moved out of app.core.contracts in Phase 4. Pure functions over agent dictionaries, no I/O.
"""
from __future__ import annotations

import re


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
