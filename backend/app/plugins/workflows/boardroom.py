"""Debate (boardroom) protocol: when a discussion is settled, who is next, and how the room decides."""
from __future__ import annotations

import math
from dataclasses import asdict, dataclass, field
from typing import Any

from app.plugins.workflows.protocols import Verdict


# ------------------------------------------------------------------ debate
@dataclass
class DebateState:
    edge_id: str
    participants: list[str]
    max_rounds: int = 4
    status: str = "open"  # open | consensus | decided | max_rounds
    messages: int = 0
    agreed: list[str] = field(default_factory=list)
    topic: str = ""
    history: list[dict[str, str]] = field(default_factory=list)
    outcome: str = ""
    number: int = 1

    @property
    def rounds(self) -> int:
        return math.ceil(self.messages / 2)

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["rounds"] = self.rounds
        return d

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> DebateState:
        d = {k: v for k, v in d.items() if k != "rounds"}
        return cls(**d)


def debate_on_message(st: DebateState, sender: str, mtype: str, content: str) -> Verdict:
    """Apply a message to the debate. Consensus requires *both* participants to emit `agreement`
    after the latest proposal/objection (explicit, not heuristic)."""
    other = next(p for p in st.participants if p != sender)
    if st.status == "max_rounds":
        return Verdict(False, reason="This debate hit its round limit without consensus. Escalate to a decision-maker or accept the latest proposal via another channel.")
    if st.status in ("consensus", "decided"):
        if mtype == "proposal":  # a new proposal opens a new debate on the same channel
            st.status, st.messages, st.agreed, st.history, st.outcome = "open", 0, [], [], ""
            st.number += 1
        elif mtype == "agreement":
            return Verdict(True)  # courtesy acknowledgement, no state change
        else:
            return Verdict(False, reason=f"The debate is closed ({st.status}). Start a new one with a `proposal` if needed.")
    if st.messages == 0 and mtype not in ("proposal", "decision"):
        return Verdict(False, reason="Open a debate with a `proposal` first.")
    if not st.topic and mtype == "proposal":
        st.topic = content.strip().split("\n")[0][:160]
    st.messages += 1
    st.history.append({"from": sender, "type": mtype, "content": content[:300]})
    v = Verdict(True)
    if mtype in ("proposal", "objection", "critique"):
        st.agreed = []
    elif mtype == "agreement":
        if sender not in st.agreed:
            st.agreed.append(sender)
        if set(st.agreed) >= set(st.participants):
            st.status = "consensus"
            st.outcome = next((h["content"] for h in reversed(st.history) if h["type"] == "proposal"), content)[:500]
            msg = "Consensus reached: both sides explicitly agreed. The debate is closed; act on the agreed position."
            v.notices = {p: msg for p in st.participants}
            v.event = {"kind": "debate", "result": "consensus"}
            return v
        v.notices = {other: "Your counterpart agreed. If you also accept the latest position, reply with `agreement` to close the debate."}
    elif mtype == "decision":
        st.status = "decided"
        st.outcome = content[:500]
        v.notices = {p: "A decision was issued; the debate is closed." for p in st.participants}
        v.event = {"kind": "debate", "result": "decided"}
        return v
    if st.rounds >= st.max_rounds and st.messages % 2 == 0:
        st.status = "max_rounds"
        msg = (f"The debate reached max_rounds={st.max_rounds} without consensus. It is now closed. "
               "Escalate (e.g. ask a moderator/manager for a decision) or proceed with the latest proposal.")
        v.notices = {p: msg for p in st.participants}
        v.event = {"kind": "debate", "result": "max_rounds"}
    else:
        v.notices.setdefault(other, f"Debate round {st.rounds}/{st.max_rounds}: respond with `agreement`, `objection` (with reasons) or a compromise `proposal`.")
    return v


def debate_decided_externally(st: DebateState, decision: str) -> bool:
    if st.status == "open":
        st.status = "decided"
        st.outcome = decision[:500]
        return True
    return False
