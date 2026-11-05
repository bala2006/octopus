"""Debate and review transcripts: fixed message sequences through the pure state machines in orchestrator/protocols.py.

Each step records its input, the verdict (accept, notices, reason, event) and the full state after the step.
"""
from __future__ import annotations

from typing import Any

from app.orchestrator.protocols import (
    DebateState,
    ReviewState,
    Verdict,
    debate_decided_externally,
    debate_on_message,
    infer_verdict,
    review_on_request,
    review_on_result,
)
from scripts.golden.canon import dump_json

ALICE, BOB = "alice", "bob"
DEV, QA = "dev", "qa"
REQUEST = {"op": "request"}


def _verdict(v: Verdict) -> dict[str, Any]:
    return {"accept": v.accept, "notices": v.notices, "reason": v.reason, "event": v.event}


def _debate(edge_id: str, max_rounds: int, steps: list[dict[str, Any]]) -> dict[str, Any]:
    """A step is either a message ({sender, type, content}) or an outside decision ({external_decision})."""
    state = DebateState(edge_id=edge_id, participants=[ALICE, BOB], max_rounds=max_rounds)
    initial = state.to_dict()
    transcript: list[dict[str, Any]] = []
    for step in steps:
        if "external_decision" in step:
            accepted = debate_decided_externally(state, step["external_decision"])
            verdict = {"accept": accepted, "notices": {}, "reason": "", "event": None}
        else:
            verdict = _verdict(debate_on_message(state, step["sender"], step["type"], step["content"]))
        transcript.append({"input": step, "verdict": verdict, "state": state.to_dict()})
    return {"initial": initial, "steps": transcript}


def debate_records() -> dict[str, Any]:
    return {
        "consensus_then_reopen": _debate("e-debate-1", 3, [
            {"sender": ALICE, "type": "proposal", "content": "Use SQLite for storage\nKeep one file per project."},
            {"sender": BOB, "type": "objection", "content": "Concurrent writes need WAL."},
            {"sender": ALICE, "type": "proposal", "content": "Use SQLite in WAL mode"},
            {"sender": BOB, "type": "agreement", "content": "Agreed."},
            {"sender": ALICE, "type": "agreement", "content": "Agreed."},
            {"sender": BOB, "type": "agreement", "content": "Thanks."},
            {"sender": ALICE, "type": "objection", "content": "Too late to object."},
            {"sender": ALICE, "type": "proposal", "content": "A new question: Postgres instead?"},
            {"sender": BOB, "type": "question", "content": "Is this final?"},
        ]),
        "max_rounds_without_consensus": _debate("e-debate-2", 2, [
            {"sender": ALICE, "type": "proposal", "content": "Option A"},
            {"sender": BOB, "type": "objection", "content": "No, option B"},
            {"sender": ALICE, "type": "proposal", "content": "Compromise C"},
            {"sender": BOB, "type": "objection", "content": "Still no"},
            {"sender": ALICE, "type": "agreement", "content": "Fine."},
        ]),
        "must_open_with_proposal": _debate("e-debate-3", 4, [
            {"sender": BOB, "type": "question", "content": "Can we talk?"},
            {"sender": ALICE, "type": "proposal", "content": "Start"},
            {"sender": BOB, "type": "decision", "content": "Go with A"},
            {"sender": ALICE, "type": "objection", "content": "Closed now"},
        ]),
        "one_sided_agreement_resets_on_objection": _debate("e-debate-4", 4, [
            {"sender": ALICE, "type": "proposal", "content": "P"},
            {"sender": ALICE, "type": "agreement", "content": "I agree"},
            {"sender": BOB, "type": "objection", "content": "Not yet"},
        ]),
        "external_decision": _debate("e-debate-5", 4, [
            {"sender": ALICE, "type": "proposal", "content": "Ship it on Friday"},
            {"external_decision": "Ship it"},
            {"external_decision": "Ship it again"},
        ]),
    }


def _review(max_revisions: int, steps: list[dict[str, Any]]) -> dict[str, Any]:
    """A step is either {op: "request"} or {op: "result", verdict, comments}."""
    state = ReviewState(edge_id="e-review-1", author=DEV, reviewer=QA, max_revisions=max_revisions)
    initial = state.to_dict()
    transcript: list[dict[str, Any]] = []
    for step in steps:
        if step["op"] == "request":
            v = review_on_request(state)
        else:
            v = review_on_result(state, step["verdict"], step.get("comments", []))
        transcript.append({"input": step, "verdict": _verdict(v), "state": state.to_dict()})
    return {"initial": initial, "steps": transcript}


def review_records() -> dict[str, Any]:
    return {
        "infer_verdict": {text: infer_verdict(text) for text in [
            "Changes requested: fix the tests", "needs work", "LGTM", "looks good to me", "Approved", "not approved yet",
            "Rejected", "I have a few thoughts", "The code is fine.",
        ]},
        "scenarios": {
            "approve_first_time": _review(3, [
                REQUEST, {"op": "result", "verdict": "approve", "comments": ["Looks good"]},
            ]),
            "changes_then_approve": _review(3, [
                REQUEST, {"op": "result", "verdict": "request_changes", "comments": ["Add tests", "Fix the typo"]},
                REQUEST, {"op": "result", "verdict": "approve", "comments": []},
            ]),
            "max_revisions": _review(2, [
                REQUEST, {"op": "result", "verdict": "request_changes", "comments": ["A"]},
                REQUEST, {"op": "result", "verdict": "request_changes", "comments": ["B"]},
                REQUEST,
            ]),
            "duplicate_request_while_pending": _review(3, [
                REQUEST, REQUEST, {"op": "result", "verdict": "approve", "comments": []},
            ]),
            "result_without_request": _review(3, [
                {"op": "result", "verdict": "approve", "comments": []},
            ]),
            "new_cycle_after_approval": _review(3, [
                REQUEST, {"op": "result", "verdict": "approve", "comments": []},
                REQUEST, {"op": "result", "verdict": "request_changes", "comments": ["Rename"]},
                REQUEST, {"op": "result", "verdict": "approve", "comments": []},
            ]),
        },
    }


def debate_json() -> str:
    return dump_json(debate_records())


def review_json() -> str:
    return dump_json(review_records())
