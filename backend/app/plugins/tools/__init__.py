"""Tool plugins: the actions agents can call. Each family is one plugin and can be switched off on its own."""
from __future__ import annotations

from collections.abc import Mapping

from app.sdk.manifest import Manifest
from app.sdk.plugin import RunMethod, ServicePlugin, ToolHandler

def _files_methods() -> Mapping[str, RunMethod]:
    from app.plugins.tools import files as m
    return {name: getattr(m, name) for name in ("act_search_project", "act_write_file", "act_edit_file", "commit_file", "_commit_file", "_write_checked_file", "publish_file", "check_written", "written_by_octopus", "act_create_folder", "act_move_file", "act_read_file", "act_list_files",)}


def _files_tools() -> Mapping[str, ToolHandler]:
    from app.plugins.tools import files as m
    return {"create_folder": m.act_create_folder, "edit_file": m.act_edit_file, "list_files": m.act_list_files, "move_file": m.act_move_file, "read_file": m.act_read_file, "search_project": m.act_search_project, "write_file": m.act_write_file}


def _commands_methods() -> Mapping[str, RunMethod]:
    from app.plugins.tools import commands as m
    return {name: getattr(m, name) for name in ("act_run_code",)}


def _commands_tools() -> Mapping[str, ToolHandler]:
    from app.plugins.tools import commands as m
    return {"run_code": m.act_run_code}


def _web_methods() -> Mapping[str, RunMethod]:
    from app.plugins.tools import web as m
    return {name: getattr(m, name) for name in ("act_calculate", "act_web_search",)}


def _web_tools() -> Mapping[str, ToolHandler]:
    from app.plugins.tools import web as m
    return {"calculate": m.act_calculate, "web_search": m.act_web_search}


def _mcp_methods() -> Mapping[str, RunMethod]:
    from app.plugins.tools import browser as browser_tool, mcp as m
    return {"load_mcp": m.load_mcp, "act_mcp_call": m.act_mcp_call, "_browser_action": browser_tool._browser_action}


def _mcp_tools() -> Mapping[str, ToolHandler]:
    from app.plugins.tools import mcp as m
    return {"mcp_call": m.act_mcp_call}


def _memory_methods() -> Mapping[str, RunMethod]:
    from app.plugins.tools import memory as m
    return {name: getattr(m, name) for name in ("act_remember",)}


def _memory_tools() -> Mapping[str, ToolHandler]:
    from app.plugins.tools import memory as m
    return {"remember": m.act_remember}


def _skills_methods() -> Mapping[str, RunMethod]:
    from app.plugins.tools import skills as m
    return {name: getattr(m, name) for name in ("act_use_skill",)}


def _skills_tools() -> Mapping[str, ToolHandler]:
    from app.plugins.tools import skills as m
    return {"use_skill": m.act_use_skill}


def _messaging_methods() -> Mapping[str, RunMethod]:
    from app.plugins.tools import messaging as m
    return {name: getattr(m, name) for name in ("reject", "act_send_message", "_send_one", "condition_met", "act_request_user_input", "finish_refusal", "wf_finish_refusal", "act_finish", "act_wait",)}


def _messaging_tools() -> Mapping[str, ToolHandler]:
    from app.plugins.tools import messaging as m
    return {"finish": m.act_finish, "request_user_input": m.act_request_user_input, "send_message": m.act_send_message, "wait": m.act_wait}


def _delegation_methods() -> Mapping[str, RunMethod]:
    from app.plugins.tools import delegation as m
    return {name: getattr(m, name) for name in ("brief_text", "act_delegate", "delegate",)}


def _delegation_tools() -> Mapping[str, ToolHandler]:
    from app.plugins.tools import delegation as m
    return {"delegate": m.act_delegate}


PLUGINS = (
    ServicePlugin(
        Manifest(id="tool.files", slot="tool", kind="tool family", version="1.0.0", title="File tools",
                 description="Read, search, write, edit, move and create files inside the project folder.",
                 provides=('tools.files',), requires=(), optional=('workspace.checks',), permissions=('fs_read', 'fs_write'), emits=('artifact_updated', 'file_moved', 'folder_created')),
        tools={"files": _files_tools}, run_methods=_files_methods),
    ServicePlugin(
        Manifest(id="tool.commands", slot="tool", kind="tool family", version="1.0.0", title="Command tool",
                 description="run_code: run a command in the sandbox, after approval.",
                 provides=('tools.commands',), requires=('sandbox.exec',), optional=(), permissions=('exec',), emits=()),
        tools={"commands": _commands_tools}, run_methods=_commands_methods),
    ServicePlugin(
        Manifest(id="tool.web", slot="tool", kind="tool family", version="1.0.0", title="Web tools",
                 description="web_search and calculate.",
                 provides=('tools.web',), requires=(), optional=(), permissions=('network',), emits=()),
        tools={"web": _web_tools}, run_methods=_web_methods),
    ServicePlugin(
        Manifest(id="tool.mcp", slot="tool", kind="tool family", version="1.0.0", title="MCP tool",
                 description="mcp_call: use the MCP servers granted to an agent and the built-in browser.",
                 provides=('tools.mcp',), requires=('mcp.client',), optional=('browser.sessions',), permissions=('network', 'exec'), emits=('browser_action',)),
        tools={"mcp": _mcp_tools}, run_methods=_mcp_methods),
    ServicePlugin(
        Manifest(id="tool.memory", slot="tool", kind="tool family", version="1.0.0", title="Memory tool",
                 description="remember: propose a note for scoped memory.",
                 provides=('tools.memory',), requires=('memory.scoped',), optional=(), permissions=('db',), emits=()),
        tools={"memory": _memory_tools}, run_methods=_memory_methods),
    ServicePlugin(
        Manifest(id="tool.skills", slot="tool", kind="tool family", version="1.0.0", title="Skills tool",
                 description="use_skill: load a pinned skill or one of its resources.",
                 provides=('tools.skills',), requires=(), optional=(), permissions=(), emits=()),
        tools={"skills": _skills_tools}, run_methods=_skills_methods),
    ServicePlugin(
        Manifest(id="tool.messaging", slot="tool", kind="tool family", version="1.0.0", title="Messaging tools",
                 description="send_message, wait, finish and request_user_input: how agents talk to each other and to the user.",
                 provides=('tools.messaging',), requires=('models.router',), optional=('workflow.debate', 'workflow.review'), permissions=('db',), emits=('message_created', 'edge_activity', 'protocol'), required=True),
        tools={"messaging": _messaging_tools}, run_methods=_messaging_methods),
    ServicePlugin(
        Manifest(id="tool.delegation", slot="tool", kind="tool family", version="1.0.0", title="Delegation tool",
                 description="delegate: hand a coherent deliverable to a teammate with a brief.",
                 provides=('tools.delegation',), requires=('tools.messaging',), optional=(), permissions=(), emits=()),
        tools={"delegation": _delegation_tools}, run_methods=_delegation_methods),
)
