"""Contract base types, validated execution identities and lead routing. Skills propose work; these contracts cap it."""
from __future__ import annotations

import hashlib
import json
import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class ContractError(ValueError):
    pass


class Contract(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")


def content_hash(value: object) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


class ExecutionPolicy(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    mode: Literal["trusted_host", "restricted"] = "trusted_host"
    capabilities: frozenset[str] = frozenset()
    max_concurrency: int = Field(3, ge=1, le=3)
    max_depth: int = Field(2, ge=0, le=2)


class Assignment(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    version: int = 1
    run_id: str
    request_id: str | None = None
    task_id: str | None = None
    revision: int = Field(1, ge=1)
    owner: str
    lead: str
    provider: str
    model: str
    effort: str = "default"
    workflow: Literal["auto", "explain", "fix", "build", "review"] = "auto"
    original_goal: str
    criteria: tuple[str, ...] = ()
    dependencies: tuple[str, ...] = ()
    write_paths: tuple[str, ...] = ("*",)
    max_turns: int = Field(30, ge=1, le=300)
    workflow_hash: str = ""
    policy: ExecutionPolicy
    skill_hashes: dict[str, str] = Field(default_factory=dict)
    base_manifest: dict[str, str] = Field(default_factory=dict)


def classify_workflow(goal: str) -> str:
    if re.search(r"\b(fix|bug|broken|regression|crash|debug)\b", goal, re.I):
        return "fix"
    if re.search(r"\b(review|audit|inspect changes)\b", goal, re.I):
        return "review"
    if re.search(r"\b(build|create|implement|add|change|remove|refactor|make|write)\b", goal, re.I):
        return "build"
    return "explain"
