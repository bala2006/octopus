"""Typed run-event topics and a typed wrapper over the existing run event bus.

The topic values are wire names. WebSocket clients and the persisted run log depend on them, so each value must
match what the orchestrator package and api/ws.py send. Nothing here changes behavior: the wrapper forwards
every call to the EventBus it was given.
"""
from __future__ import annotations

import asyncio
from collections.abc import Callable
from contextlib import AbstractAsyncContextManager
from enum import StrEnum
from typing import Any, Protocol


class RunTopic(StrEnum):
    """Run event names. Each value is the wire name, so changing a value breaks clients and replay."""

    # Listed in the run socket docstring in api/ws.py.
    SNAPSHOT = "snapshot"
    AGENT_STATUS = "agent_status"
    AGENT_ACTIVITY = "agent_activity"  # in the docstring, but no emitter in backend/app today
    TOKEN_STREAM = "token_stream"
    THOUGHT = "thought"
    MESSAGE_CREATED = "message_created"
    MESSAGE_REJECTED = "message_rejected"
    EDGE_ACTIVITY = "edge_activity"
    TOOL_CALL = "tool_call"
    TOOL_RESULT = "tool_result"
    TASK_UPDATED = "task_updated"
    ARTIFACT_UPDATED = "artifact_updated"
    USAGE_UPDATE = "usage_update"
    PROTOCOL = "protocol"
    APPROVAL_REQUESTED = "approval_requested"
    APPROVAL_RESOLVED = "approval_resolved"
    TURN_STARTED = "turn_started"
    RUN_STATUS = "run_status"
    ERROR = "error"
    PING = "ping"
    THINKING_STREAM = "thinking_stream"
    BROWSER_ACTION = "browser_action"

    # Emitted by orchestrator code, but missing from the api/ws.py docstring.
    AGENT_CREATED = "agent_created"
    AGENT_UPDATED = "agent_updated"
    AGENT_FINISHED = "agent_finished"
    FILE_MOVED = "file_moved"
    FOLDER_CREATED = "folder_created"
    INTEGRATION_COMPLETED = "integration_completed"
    PLAN_REVISED = "plan_revised"
    RUN_CONTINUED = "run_continued"
    TURN_SKIPPED = "turn_skipped"
    WORKFLOW_CHECKPOINT = "workflow_checkpoint"
    WORKFLOW_UPDATED = "workflow_updated"

    # Sent directly by api/ws.py after replay. Never persisted.
    REPLAY_DONE = "replay_done"


# Live only, never persisted. Must equal EPHEMERAL in orchestrator/bus.py (a test checks this).
EPHEMERAL_TOPICS: frozenset[RunTopic] = frozenset({RunTopic.TOKEN_STREAM, RunTopic.THINKING_STREAM})

SessionFactoryLike = Callable[[], AbstractAsyncContextManager[Any]]


class RunEventBus(Protocol):
    """Structural type of orchestrator.bus.EventBus. Core names this shape instead of importing the class,
    because app.core may not import app.orchestrator."""

    def subscribe(self, run_id: str) -> asyncio.Queue[dict[str, Any]]: ...

    def unsubscribe(self, run_id: str, q: asyncio.Queue[dict[str, Any]]) -> None: ...

    def relay(self, event: dict[str, Any]) -> None: ...

    async def publish(self, run_id: str, type_: str, data: dict[str, Any], sf: SessionFactoryLike) -> dict[str, Any]: ...


class TypedRunBus:
    """Typed view of an existing EventBus. It keeps no state and forwards each call unchanged.

    The composition root builds it, for example TypedRunBus(orchestrator.bus.bus). The only added check is in
    publish(): the topic must be a known RunTopic, and an unknown name raises ValueError before anything is sent.
    """

    def __init__(self, inner: RunEventBus) -> None:
        self._inner = inner

    def subscribe(self, run_id: str) -> asyncio.Queue[dict[str, Any]]:
        return self._inner.subscribe(run_id)

    def unsubscribe(self, run_id: str, q: asyncio.Queue[dict[str, Any]]) -> None:
        self._inner.unsubscribe(run_id, q)

    def relay(self, event: dict[str, Any]) -> None:
        self._inner.relay(event)

    async def publish(self, run_id: str, topic: RunTopic, data: dict[str, Any], sf: SessionFactoryLike) -> dict[str, Any]:
        return await self._inner.publish(run_id, RunTopic(topic).value, data, sf)
