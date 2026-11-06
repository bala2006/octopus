"""Loop detection: agents going round in circles.

All state is JSON-serialisable so runs can be persisted and resumed.
"""
from __future__ import annotations

import difflib
import re
from dataclasses import asdict, dataclass, field
from typing import Any


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
