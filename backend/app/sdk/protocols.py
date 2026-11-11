"""State of the coordination protocols. The kernel persists these with a run; workflow plugins hold the rules that change them."""
from __future__ import annotations

import math
from dataclasses import asdict, dataclass, field
from typing import Any


@dataclass
class Verdict:
    """What a protocol says about one message: deliver it or not, and whom to notify."""

    accept: bool
    notices: dict[str, str] = field(default_factory=dict)  # agent_id -> notice
    reason: str = ""
    event: dict[str, Any] | None = None


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
