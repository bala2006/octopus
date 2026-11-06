"""Task constraints shared by scheduling, tools, persistence and the task board."""
from __future__ import annotations

from pathlib import PurePosixPath
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.sdk.evidence import AcceptanceCriterion


OPEN_TASK_STATES = {"todo", "in_progress", "in_review", "blocked"}
TaskState = Literal["todo", "in_progress", "in_review", "done", "blocked", "cancelled"]
TRANSITIONS = {
    "todo": {"todo", "in_progress", "in_review", "done", "blocked", "cancelled"},
    "in_progress": {"in_progress", "in_review", "done", "blocked", "cancelled"},
    "in_review": {"in_review", "in_progress", "done", "blocked", "cancelled"},
    "blocked": {"blocked", "todo", "in_progress", "cancelled"},
    "done": {"done", "todo"},
    "cancelled": {"cancelled", "todo"},
}


class TaskContract(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    dependencies: tuple[str, ...] = ()
    write_paths: tuple[str, ...] = ("*",)
    max_turns: int = Field(30, ge=1, le=300)
    criteria: tuple[AcceptanceCriterion, ...] = ()
    workflow_hash: str = ""

    @field_validator("write_paths")
    @classmethod
    def valid_paths(cls, paths: tuple[str, ...]) -> tuple[str, ...]:
        for path in paths:
            normalized = path.replace("\\", "/")
            if path != normalized or not path or (path != "*" and (
                PurePosixPath(path).is_absolute() or ".." in PurePosixPath(path).parts
                or ":" in path or "*" in path)):
                raise ValueError("Write scopes must be relative files/directories or '*'")
        return tuple(dict.fromkeys(paths))


def contract(task: dict) -> TaskContract:
    return TaskContract.model_validate(task.get("constraints_json") or {})


def dependency_blockers(task: dict, tasks: dict[str, dict]) -> tuple[str, ...]:
    return tuple(key for key in contract(task).dependencies if key not in tasks or tasks[key]["status"] != "done")


def validate_task(candidate: dict, tasks: dict[str, dict], *, previous: dict | None = None) -> None:
    if previous and candidate["status"] not in TRANSITIONS[previous["status"]]:
        raise ValueError(f"Invalid task transition {previous['status']} → {candidate['status']}")
    graph = {**tasks, candidate["key"]: candidate}
    visited: set[str] = set()
    visiting: set[str] = set()
    def visit(key: str) -> None:
        if key not in graph:
            raise ValueError(f"Unknown dependency {key}")
        if key in visiting:
            raise ValueError("Task dependencies contain a cycle")
        if key in visited:
            return
        visiting.add(key)
        for dependency in contract(graph[key]).dependencies:
            visit(dependency)
        visiting.remove(key)
        visited.add(key)
    visit(candidate["key"])
    if candidate["status"] in ("in_progress", "in_review", "done") and dependency_blockers(candidate, graph):
        raise ValueError("Dependencies must finish before this task can start or complete")


def permits_path(paths: tuple[str, ...], path: str) -> bool:
    normalized = path.replace("\\", "/")
    parts = PurePosixPath(normalized)
    if parts.is_absolute() or ".." in parts.parts or ":" in normalized:
        return False
    return any(scope == "*" or normalized == scope.rstrip("/") or normalized.startswith(scope.rstrip("/") + "/") for scope in paths)
