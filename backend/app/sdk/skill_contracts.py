"""Skill and workflow contracts: the pinned inputs a run records, and the workflow catalog the kernel schedules from.

Loading or pinning a bundle never executes its scripts. A digest identifies content; it does not establish trust.
The plugin that reads skill folders from disk lives in app.plugins.skills; these types are what the kernel persists.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

from pydantic import Field

from app.sdk.contracts import Contract, ContractError, content_hash

WorkflowName = Literal["auto", "explain", "fix", "build", "review"]
Strategy = Literal["solo", "arena", "swarm"]


@dataclass(frozen=True)
class Skill:
    name: str
    description: str
    body: str
    roles: tuple[str, ...] = field(default_factory=tuple)
    phases: tuple[str, ...] = field(default_factory=tuple)
    source: str = "builtin"  # builtin | modified | custom | project


class PinnedDocument(Contract):
    path: str
    sha256: str
    content: str
    kind: Literal["skill", "reference", "script", "guidance"]


class SkillBundle(Contract):
    id: str
    version: str
    origin: str
    description: str
    body: str
    content_hash: str
    documents: tuple[PinnedDocument, ...] = ()
    remote_references: tuple[str, ...] = ()
    required_capabilities: tuple[str, ...] = ()
    # A digest identifies content. It does not establish trust or grant permissions.
    reviewed: bool = False


class PinnedGuidance(Contract):
    content: str
    content_hash: str
    documents: tuple[PinnedDocument, ...]


class WorkflowStep(Contract):
    key: str
    purpose: str
    skill: str
    required_outputs: tuple[str, ...] = ()
    check_kinds: tuple[Literal["command", "ui", "review", "source", "human"], ...] = ()
    independent_owner: bool = False


class WorkflowSpec(Contract):
    name: WorkflowName
    version: str = "1"
    strategy: Strategy = "solo"
    max_workers: int = Field(default=1, ge=1, le=4)
    max_rework: int = Field(default=2, ge=0, le=3)
    requires_selection: bool = False
    steps: tuple[WorkflowStep, ...]
    content_hash: str


def workflow_spec(name: WorkflowName, *, strategy: Strategy = "solo") -> WorkflowSpec:
    if name not in {"auto", "explain", "fix", "build", "review"} or strategy not in {"solo", "arena", "swarm"}:
        raise ContractError("Unknown workflow or execution strategy")
    definitions = {
        "auto": (("classify", "Select a concrete workflow and acceptance criteria", ("selected_workflow",), (), False),),
        "explain": (("inspect", "Inspect authoritative sources", ("source_references",), ("source",), False),
                    ("answer", "Answer the request and state uncertainty", ("answer",), ("source", "review"), False)),
        "fix": (("reproduce", "Observe the reported failure before editing", ("reproduction",), ("command", "ui"), False),
                ("implement", "Fix the demonstrated root cause", ("change_manifest",), (), False),
                ("verify", "Repeat the reproduction and relevant checks on the resulting revision", ("verification",), ("command", "ui"), False)),
        "build": (("acceptance", "Define observable acceptance criteria", ("acceptance_criteria",), (), False),
                  ("design", "Choose a design and name ownership", ("design",), ("source", "review"), False),
                  ("implement", "Produce owned changes", ("change_manifest",), (), False),
                  ("verify", "Exercise the integrated result against its criteria", ("verification",), ("command", "ui", "human"), False)),
        "review": (("inspect", "Inspect the artifact and relevant surrounding behavior", ("source_references",), ("source",), True),
                   ("review", "Return evidenced findings or a scoped clean verdict", ("review_report",), ("review", "command", "ui"), True)),
    }
    steps = tuple(WorkflowStep(key=key, purpose=purpose, skill=f"pstack-{name}", required_outputs=outputs,
                               check_kinds=kinds, independent_owner=independent) for key, purpose, outputs, kinds, independent in definitions[name])
    payload = dict(name=name, version="1", strategy=strategy, max_workers=1 if strategy == "solo" else 3,
                   max_rework=2, requires_selection=name == "auto", steps=steps)
    return WorkflowSpec(**payload, content_hash=content_hash({**payload, "steps": [step.model_dump() for step in steps]}))
