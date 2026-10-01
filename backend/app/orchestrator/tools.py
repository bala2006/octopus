"""Native function-calling tools for agents, generated from the same Pydantic action models as the JSON envelope.

With a provider that supports it (Azure OpenAI Responses API), agents act through the model's built-in function
calling instead of writing a JSON envelope as text: the model emits structured ``function_call`` items, Octopus runs them
and returns ``function_call_output`` items, and the model keeps working in the same turn until it stops calling tools.
Arguments are validated with the action models, so both paths share one schema and one executor.
"""
from __future__ import annotations

import json
import re
from typing import Any, get_args

from pydantic import BaseModel, TypeAdapter, ValidationError

from app.orchestrator import actions as A

# action name -> model (from the discriminated union)
ACTION_MODELS: dict[str, type[BaseModel]] = {m.model_fields["action"].annotation.__args__[0]: m  # type: ignore[union-attr]
                                             for m in get_args(get_args(A.Action)[0])}

DESCRIPTIONS = {
    "send_message": "Send a message to a teammate you have a channel with (or \"all\"). Tasks you send go on the task board.",
    "write_file": "Create or replace a file in the project with the given content. Parent folders are created. "
                  "mode \"append\" adds to the end of the file instead; partial=true gives you another turn right away.",
    "edit_file": "Change part of an existing file. Each edit replaces old_string (exact current text, including whitespace) with "
                 "new_string; old_string must occur exactly once unless replace_all. Edits apply in order and all succeed or none do.",
    "create_folder": "Create a folder (and its parents) in the project.",
    "move_file": "Move or rename a file or a whole folder inside the project.",
    "read_file": "Read a file from the project. Large files come in pages; the result says which offset to read next.",
    "list_files": "List the files in the project (or under a folder prefix).",
    "run_code": "Run one command in the project's sandboxed terminal, from the project root (e.g. python -m pytest, "
                "node script.js, npm test). There is no shell: quoted arguments may contain any characters, but pipes, "
                "&&, ;, redirects and $(...) only work at the danger permission level. Paths stay inside the project.",
    "mcp_call": "Call a tool on an MCP server granted to you.",
    "delegate": "Hand a piece of work to a teammate you have a delegate channel to. The teammate starts right away; its result "
                "(summary, files changed, task status) comes back as this call's result. Several delegate calls in one reply run "
                "at the same time: only send several together when the pieces are independent and can all start now (no review or "
                "test of something that doesn't exist yet).",
    "search_project": "Search the project's files and the team's working docs (.octopus/work/) for text or a regex; returns "
                      "path:line matches.",
    "update_task_board": "Create tasks (omit key) or update existing ones (status, assignee, description, acceptance criteria).",
    "remember": "Save a long-term memory note that you will see in future runs.",
    "request_user_input": "Ask the user a question and pause until they answer. Offer concrete options and mark the one you recommend.",
    "web_search": "Search the web.",
    "calculate": "Evaluate an arithmetic expression exactly.",
    "create_agent": "Hire a new teammate into the company (you can only grant tools you have yourself).",
    "update_agent": "Change your own configuration (target \"self\") or that of an agent you manage.",
    "list_agents": "See every teammate: department, manager, active/inactive and live status.",
    "use_skill": "Load one of the skills listed in your instructions (a step-by-step playbook for a kind of work: spec, design, "
                 "implementation, testing, review…). The full steps come back; follow them.",
    "set_track": "Company head, at intake only: pick the track for this goal (quick = one coherent deliverable; standard = a "
                 "feature or app; large = several independent parts) and whether a research phase is needed. Octopus then "
                 "briefs each phase owner in order and comes back to you to accept. Ends your turn.",
    "finish": "Report that your part is done, with a summary. For the entry agent this completes the run. In a workflow Test or "
              "Review phase set outcome \"pass\" or \"fail\" (fail sends your findings back to the builder).",
    "wait": "End your turn without acting; you are woken when a new message arrives.",
}
# turn-ending actions: the model is not called again in this turn after one of these
TERMINAL_ACTIONS = {"finish", "wait", "request_user_input", "set_track"}


def _inline(schema: dict[str, Any]) -> dict[str, Any]:
    """Resolve $ref/$defs and drop titles so every function has a self-contained, compact JSON schema."""
    defs = schema.pop("$defs", {})

    def walk(node: Any, mapping: bool = False) -> Any:
        """``mapping``: node is a ``properties`` dict, whose keys are field names (a field may be called "title")."""
        if isinstance(node, dict):
            if not mapping and "$ref" in node:
                target = defs[node["$ref"].rsplit("/", 1)[-1]]
                return walk({**{k: v for k, v in node.items() if k != "$ref"}, **target})
            if mapping:
                return {k: walk(v) for k, v in node.items()}
            return {k: walk(v, mapping=k == "properties") for k, v in node.items() if not (k == "title" and isinstance(v, str))}
        if isinstance(node, list):
            return [walk(x) for x in node]
        return node

    return walk(schema)


def action_schema(name: str) -> dict[str, Any]:
    s = _inline(ACTION_MODELS[name].model_json_schema(mode="validation"))
    s.get("properties", {}).pop("action", None)
    s["required"] = [r for r in s.get("required", []) if r != "action"]
    s["type"] = "object"
    return s


def _enabled(name: str, tools: dict[str, Any]) -> bool:
    if name == "mcp_call":
        return False  # MCP tools are exposed one function per tool (below)
    key = A.ACTION_TOOL.get(name)
    return key is None or A.tool_enabled(tools, key)


_SAFE = re.compile(r"[^a-zA-Z0-9_-]+")


def mcp_function_name(server: str, tool: str) -> str:
    return (f"mcp__{_SAFE.sub('_', server)}__{_SAFE.sub('_', tool)}")[:64]


def tool_specs(enabled_tools: dict[str, Any], mcp_servers: list[dict[str, Any]] | None = None
               ) -> tuple[list[dict[str, Any]], dict[str, tuple[str, str]]]:
    """Function tools for one agent ({name, description, parameters}) and the MCP name map (function -> (server, tool))."""
    specs = [{"name": n, "description": DESCRIPTIONS.get(n, (m.__doc__ or n).strip()), "parameters": action_schema(n)}
             for n, m in ACTION_MODELS.items() if _enabled(n, enabled_tools)]
    mcp_map: dict[str, tuple[str, str]] = {}
    generic = False
    for srv in mcp_servers or []:
        tools = srv.get("tools") or []
        if not tools:
            generic = True
            continue
        for t in tools:
            fn = mcp_function_name(srv["name"], t["name"])
            mcp_map[fn] = (srv["name"], t["name"])
            params = dict(t.get("input_schema") or {})
            params.setdefault("type", "object")
            params.setdefault("properties", {})
            specs.append({"name": fn, "description": f"[{srv['name']}] {(t.get('description') or t['name'])[:900]}", "parameters": params})
    if generic:
        specs.append({"name": "mcp_call", "description": DESCRIPTIONS["mcp_call"], "parameters": action_schema("mcp_call")})
    return specs, mcp_map


_adapter: TypeAdapter[Any] = TypeAdapter(A.Action)


def parse_tool_call(name: str, arguments: str, mcp_map: dict[str, tuple[str, str]] | None = None) -> tuple[Any | None, str | None]:
    """Function call -> validated action, or (None, error message for the model)."""
    try:
        args = json.loads(arguments or "{}")
    except json.JSONDecodeError as exc:
        return None, f"arguments are not valid JSON ({exc.msg} at position {exc.pos})"
    if not isinstance(args, dict):
        return None, "arguments must be a JSON object"
    if mcp_map and name in mcp_map:
        server, tool = mcp_map[name]
        return A.McpCall(action="mcp_call", server=server, tool=tool, arguments=args), None
    if name not in ACTION_MODELS:
        return None, f"unknown tool '{name}'"
    try:
        return _adapter.validate_python({**args, "action": name}), None
    except ValidationError as exc:
        errs = "; ".join(f"{'.'.join(str(x) for x in e.get('loc', []))}: {e.get('msg')}" for e in exc.errors()[:5])
        return None, f"invalid arguments: {errs}"
