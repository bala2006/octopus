"""Review gate protocol: a reviewer answers a request with a verdict and comments."""
from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from typing import Any

from app.workflows.protocols import Verdict


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
