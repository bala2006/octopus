"""The tool registry: every action name, the family it belongs to, and the handler that runs it.

The engine dispatches through TOOLS. A family is a module group under handlers/ (files, commands, web, mcp,
memory, skills, messaging, delegation, tasks, team, workflow). Moved from ACTION_HANDLERS in engine.py.
"""
from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from app.kernel.catalog import BUILTIN_MANIFESTS
from app.sdk.manifest import Manifest

from app.plugins.tools import commands as command_actions, delegation as delegation_actions
from app.plugins.tools import files as file_actions, mcp as mcp_actions, memory as memory_actions
from app.plugins.tools import messaging as messaging_actions, skills as skill_actions
from app.plugins.workflows import team_actions, workflow_actions
from app.plugins.tools import web as web_actions
from app.plugins.workflows import task_board

Handler = Callable[..., Awaitable[None]]


FAMILIES: dict[str, dict[str, Handler]] = {
    "commands": {
        "run_code": command_actions.act_run_code,
    },
    "delegation": {
        "delegate": delegation_actions.act_delegate,
    },
    "files": {
        "create_folder": file_actions.act_create_folder,
        "edit_file": file_actions.act_edit_file,
        "list_files": file_actions.act_list_files,
        "move_file": file_actions.act_move_file,
        "read_file": file_actions.act_read_file,
        "search_project": file_actions.act_search_project,
        "write_file": file_actions.act_write_file,
    },
    "mcp": {
        "mcp_call": mcp_actions.act_mcp_call,
    },
    "memory": {
        "remember": memory_actions.act_remember,
    },
    "messaging": {
        "finish": messaging_actions.act_finish,
        "request_user_input": messaging_actions.act_request_user_input,
        "send_message": messaging_actions.act_send_message,
        "wait": messaging_actions.act_wait,
    },
    "skills": {
        "use_skill": skill_actions.act_use_skill,
    },
    "tasks": {
        "update_task_board": task_board.act_update_task_board,
    },
    "team": {
        "create_agent": team_actions.act_create_agent,
        "list_agents": team_actions.act_list_agents,
        "update_agent": team_actions.act_update_agent,
    },
    "web": {
        "calculate": web_actions.act_calculate,
        "web_search": web_actions.act_web_search,
    },
    "workflow": {
        "set_track": workflow_actions.act_set_track,
    },
}

@dataclass(frozen=True)
class ToolPlugin:
    """One tool family: the manifest the catalog lists for it, and the actions it runs."""

    manifest: Manifest
    actions: dict[str, Handler]


_CATALOG = {m.id: m for m in BUILTIN_MANIFESTS}
TOOL_PLUGINS: dict[str, ToolPlugin] = {
    family: ToolPlugin(_CATALOG[f"tool.{family}"], actions) for family, actions in FAMILIES.items()
}


TOOLS: dict[str, Handler] = {name: handler for family in FAMILIES.values() for name, handler in family.items()}


def family_of(action: str) -> str | None:
    return next((fam for fam, members in FAMILIES.items() if action in members), None)
