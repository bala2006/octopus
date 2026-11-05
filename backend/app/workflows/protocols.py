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


_STOP = set("""a an the and or but if then so to of in on at by for with from into onto as is are was were be been being do does did
have has had i me my we our you your he she it its they them their this that these those there here what which who whom when where why how
please can could would should will shall may might must just also now ready any all some more most very still yet not no
let know send us get give about up out over again once only own same than too don ok okay thanks thank hi hello""".split())
# Message kinds whose *intent* repeats when an agent keeps asking. Tasks are excluded: delegating similar-but-distinct work
# ("implement the login endpoint …" / "implement the logout endpoint …") shares most of its vocabulary legitimately.
ASK_TYPES = {"question", "status_update"}
MIN_INTENT_WORDS = 6  # shorter messages are compared character-wise only (too little signal for word overlap)


def _stem(w: str) -> str:
    for suf in ("ing", "ed", "es", "s"):
        if w.endswith(suf) and len(w) - len(suf) >= 4:
            return w[: -len(suf)]
    return w


def content_words(s: str) -> set[str]:
    return {_stem(w) for w in re.findall(r"[a-z0-9]+", s.lower()) if w not in _STOP and len(w) > 2}


def intent_similarity(a: str, b: str) -> float:
    """Overlap of the content words of two messages (|A∩B| / min(|A|,|B|)).

    LLM agents repeat an ask by *rewording* it ("send me the completed track brief …" → "please deliver the compact track
    brief now …"); a character-level ratio stays well under any sane threshold for those, while their content words
    barely change."""
    wa, wb = content_words(a), content_words(b)
    if min(len(wa), len(wb)) < MIN_INTENT_WORDS:
        return 0.0
    return len(wa & wb) / min(len(wa), len(wb))


@dataclass
class LoopDetector:
    """Detects agents going round in circles.

    * near-identical text on the same sender → recipient pair (character similarity ≥ ``threshold``),
    * the same *request* reworded on that pair (content-word overlap ≥ ``semantic_threshold``, asks only),
    * a message travelling back to someone who already sent it (A → B → … → A), across different pairs.

    Strikes are counted per sender and survive pause/resume. After a human resumes a loop-paused run, a single new strike
    pauses it again (``acknowledged`` remembers how many strikes the human has already seen)."""

    threshold: float = 0.92
    window: int = 12
    max_strikes: int = 3
    semantic_threshold: float = 0.66
    recent: dict[str, list[str]] = field(default_factory=dict)  # "src>dst" -> signatures
    strikes: dict[str, int] = field(default_factory=dict)
    trail: list[list[str]] = field(default_factory=list)  # [src, dst, signature] across all pairs (cycle detection)
    acknowledged: int = 0
    hot: bool = False  # resumed after a loop pause: the next strike alerts again
    last_reason: str = ""

    def check(self, src: str, dst: str, mtype: str, content: str) -> bool:
        """Return True when the message is a loop (it should not be delivered)."""
        key = f"{src}>{dst}"
        history = self.recent.setdefault(key, [])
        sig = f"{mtype}:{content}"
        reason = ""
        if any(similarity(sig, h) >= self.threshold for h in history):
            reason = "near-identical to a recent message on this channel"
        elif mtype in ASK_TYPES and any(h.split(":", 1)[0] in ASK_TYPES and intent_similarity(content, h.split(":", 1)[1]) >= self.semantic_threshold
                                        for h in history):
            reason = "the same request, reworded, was already sent to this teammate"
        elif mtype in ASK_TYPES and len(content) >= 40 and any(
                s == dst and similarity(sig, h) >= self.threshold for s, _, h in self.trail):
            reason = "this message is circling back to an agent who already sent it"
        self.last_reason = reason
        if reason:
            self.strikes[src] = self.strikes.get(src, 0) + 1
            return True
        history.append(sig)
        del history[:-self.window]
        self.trail.append([src, dst, sig])
        del self.trail[:-40]
        return False

    def total_strikes(self) -> int:
        return sum(self.strikes.values())

    def escalate(self) -> bool:
        new = self.total_strikes() - self.acknowledged
        return new >= (1 if self.hot else self.max_strikes)

    def acknowledge(self, *, hot: bool = True) -> None:
        """A human has seen the strikes so far. ``hot``: they resumed a loop-paused run, so alert on the very next strike;
        otherwise (a new follow-up request) the usual ``max_strikes`` new strikes are needed."""
        self.acknowledged = self.total_strikes()
        self.hot = hot
        if not hot:  # new information from the user: re-delegating similar work is expected, so compare from scratch
            self.recent, self.trail = {}, []

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> LoopDetector:
        known = {f for f in cls.__dataclass_fields__}
        return cls(**{k: v for k, v in d.items() if k in known})
