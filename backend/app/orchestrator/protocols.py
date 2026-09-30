"""Debate and review protocol state machines, plus loop detection.

All state is JSON-serialisable so runs can be persisted and resumed.
"""
from __future__ import annotations

import difflib
import math
import re
from dataclasses import asdict, dataclass, field
from typing import Any


@dataclass
class Verdict:
    accept: bool
    notices: dict[str, str] = field(default_factory=dict)  # agent_id -> notice
    reason: str = ""
    event: dict[str, Any] | None = None


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


# ------------------------------------------------------------------ review
@dataclass
class ReviewState:
    edge_id: str
    author: str
    reviewer: str
    max_revisions: int = 3
    status: str = "idle"  # idle | pending | changes_requested | approved | max_revisions
    revisions: int = 0
    cycles: int = 0
    history: list[dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> ReviewState:
        return cls(**d)


def infer_verdict(content: str) -> str:
    c = content.lower()
    if re.search(r"request(ed)?[ _]changes|needs? (work|changes)|not approved|reject", c):
        return "request_changes"
    if re.search(r"\bapprov|lgtm|looks good", c):
        return "approve"
    return "request_changes"


def review_on_request(st: ReviewState) -> Verdict:
    if st.status == "max_revisions":
        return Verdict(False, reason="Max revisions already reached for this review; proceed with the last version or escalate.")
    if st.status == "approved":
        st.revisions, st.cycles = 0, st.cycles + 1  # a new review cycle for a new change
    if st.status == "pending":
        return Verdict(True, notices={st.author: "A review is already pending; wait for the result instead of re-requesting."})
    st.status = "pending"
    st.history.append({"event": "review_request"})
    return Verdict(True, event={"kind": "review", "result": "requested"})


def review_on_result(st: ReviewState, verdict: str, comments: list[str]) -> Verdict:
    if st.status not in ("pending", "changes_requested"):
        return Verdict(False, reason="There is no pending review request from this author to respond to.")
    st.history.append({"event": "review_result", "verdict": verdict, "comments": comments})
    if verdict == "approve":
        st.status = "approved"
        return Verdict(True, event={"kind": "review", "result": "approved"},
                       notices={st.author: "Your change was APPROVED. Proceed to the next step (e.g. hand off to QA)."})
    st.revisions += 1
    if st.revisions >= st.max_revisions:
        st.status = "max_revisions"
        msg = f"Review reached max_revisions={st.max_revisions}. Treat the current version as accepted with outstanding comments, record them, and move on."
        return Verdict(True, event={"kind": "review", "result": "max_revisions"}, notices={st.author: msg, st.reviewer: msg})
    st.status = "changes_requested"
    return Verdict(True, event={"kind": "review", "result": "changes_requested"},
                   notices={st.author: f"Changes requested (revision {st.revisions}/{st.max_revisions}). Address every comment, then send a new review_request."})


# ------------------------------------------------------------------ loop detection
def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", s.lower()).strip()


def similarity(a: str, b: str) -> float:
    a, b = _norm(a), _norm(b)
    if not a or not b:
        return 0.0
    m = difflib.SequenceMatcher(None, a, b, autojunk=False)
    if m.quick_ratio() < 0.5:
        return m.quick_ratio()
    return m.ratio()


@dataclass
class LoopDetector:
    threshold: float = 0.92
    window: int = 6
    max_strikes: int = 3
    recent: dict[str, list[str]] = field(default_factory=dict)  # "src>dst" -> contents
    strikes: dict[str, int] = field(default_factory=dict)

    def check(self, src: str, dst: str, mtype: str, content: str) -> bool:
        """Return True when the message is a near-duplicate of a recent one on the same pair (a loop)."""
        key = f"{src}>{dst}"
        history = self.recent.setdefault(key, [])
        sig = f"{mtype}:{content}"
        is_loop = any(similarity(sig, h) >= self.threshold for h in history)
        if is_loop:
            self.strikes[src] = self.strikes.get(src, 0) + 1
        else:
            history.append(sig)
            del history[:-self.window]
        return is_loop

    def total_strikes(self) -> int:
        return sum(self.strikes.values())

    def escalate(self) -> bool:
        return self.total_strikes() >= self.max_strikes

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> LoopDetector:
        return cls(**d)
