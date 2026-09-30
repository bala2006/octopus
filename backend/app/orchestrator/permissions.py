"""Edge-based communication permissions (enforced server-side)."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

DEBATE_TYPES = {"proposal", "critique", "agreement", "objection", "decision", "question", "answer"}

PREFERRED: dict[str, list[str]] = {
    "proposal": ["debate"], "critique": ["debate", "review"], "agreement": ["debate"], "objection": ["debate"],
    "decision": ["debate", "consult", "delegate", "report"],
    "review_request": ["review"], "review_result": ["review"],
    "task": ["delegate"], "status_update": ["report"], "final_report": ["report"],
    "question": ["consult", "delegate", "report", "review"], "answer": ["consult", "report", "delegate", "review"],
}


@dataclass
class EdgeSpec:
    id: str
    source: str
    target: str
    type: str = "delegate"
    bidirectional: bool = False
    label: str = ""
    config: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> EdgeSpec:
        return cls(id=d["id"], source=d["source_agent_id"], target=d["target_agent_id"], type=d.get("type", "delegate"),
                   bidirectional=bool(d.get("bidirectional")), label=d.get("label", ""), config=d.get("config") or {})

    def allows(self, src: str, dst: str) -> bool:
        return (self.source == src and self.target == dst) or (self.bidirectional and self.source == dst and self.target == src)

    def other(self, agent_id: str) -> str:
        return self.target if self.source == agent_id else self.source


def channels_between(edges: list[EdgeSpec], src: str, dst: str) -> list[EdgeSpec]:
    return [e for e in edges if e.allows(src, dst)]


def find_channel(edges: list[EdgeSpec], src: str, dst: str, msg_type: str) -> EdgeSpec | None:
    """Pick the edge a message travels on, or None if the sender may not message the recipient."""
    if src == dst:
        return None
    cands = channels_between(edges, src, dst)
    if not cands:
        return None
    for etype in PREFERRED.get(msg_type, []):
        for e in cands:
            if e.type == etype:
                return e
    for e in cands:  # debate edges only carry debate-protocol messages
        if e.type != "debate" or msg_type in DEBATE_TYPES:
            return e
    return None


def rejection_reason(edges: list[EdgeSpec], src: str, dst: str, msg_type: str, names: dict[str, str]) -> str:
    if src == dst:
        return "You cannot message yourself."
    if any(e.allows(dst, src) for e in edges) and not channels_between(edges, src, dst):
        return f"The channel with {names.get(dst, dst)} is one-way ({names.get(dst, dst)} → you); you cannot initiate messages to them."
    if channels_between(edges, src, dst):
        return f"'{msg_type}' messages are not allowed on your debate channel with {names.get(dst, dst)}; use proposal/objection/agreement."
    return f"You have no communication channel with {names.get(dst, dst)}. Only message your allowed recipients."


def allowed_recipients(edges: list[EdgeSpec], agent_id: str) -> dict[str, list[EdgeSpec]]:
    out: dict[str, list[EdgeSpec]] = {}
    for e in edges:
        if e.source == agent_id:
            out.setdefault(e.target, []).append(e)
        elif e.bidirectional and e.target == agent_id:
            out.setdefault(e.source, []).append(e)
    return out


def inbound_senders(edges: list[EdgeSpec], agent_id: str) -> set[str]:
    s: set[str] = set()
    for e in edges:
        if e.target == agent_id:
            s.add(e.source)
        elif e.bidirectional and e.source == agent_id:
            s.add(e.target)
    return s


# ---------------------------------------------------------------- permission levels
LEVEL_ORDER = {"read_only": 0, "plan": 1, "ask": 2, "danger": 3}
LEVEL_LABEL = {"read_only": "read-only", "plan": "plan", "ask": "ask", "danger": "danger"}
DANGEROUS = {"write_file", "run_code", "mcp_call"}


def effective_level(run_level: str, agent_level: str | None) -> str:
    """The run's level caps everything; an agent override can only be *more* restrictive."""
    run_level = run_level if run_level in LEVEL_ORDER else "ask"
    if not agent_level or agent_level == "inherit" or agent_level not in LEVEL_ORDER:
        return run_level
    return min(run_level, agent_level, key=LEVEL_ORDER.__getitem__)
