"""Typed run-event topics. The values are wire names.

WebSocket clients and the persisted run log depend on them, so each value must match what the kernel, the plugins and the
WebSocket channel send. A test scans the backend for emitted names and checks that every one is a RunTopic.
"""
from __future__ import annotations

from enum import StrEnum


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


# Live only, never persisted.
EPHEMERAL_TOPICS: frozenset[RunTopic] = frozenset({RunTopic.TOKEN_STREAM, RunTopic.THINKING_STREAM})
