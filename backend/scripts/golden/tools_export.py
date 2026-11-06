"""Every action the model can call: LLM-facing name, description, input model schema and the native function schema."""
from __future__ import annotations

from typing import Any

from app.sdk import actions as A
from app.plugins.tools import specs as T
from scripts.golden.canon import dump_json

# Every tool toggle on, so each action appears once in the function list.
ALL_TOOLS_ON: dict[str, bool] = {key: True for key in ("send_message", "file_read", "file_write", "list_files", "terminal",
                                                       "web_search", "calculator", "ask_user", "manage_team", "browser")}


def tools_records() -> list[dict[str, Any]]:
    # A generic MCP server (no tool list) adds the mcp_call function, which is otherwise hidden.
    specs, _ = T.tool_specs(ALL_TOOLS_ON, mcp_servers=[{"name": "golden", "tools": []}])
    by_name = {spec["name"]: spec for spec in specs}
    records = []
    for name in sorted(T.ACTION_MODELS):
        spec = by_name[name]
        records.append({
            "name": name,
            "description": spec["description"],
            "enabled_by": A.ACTION_TOOL.get(name),
            "terminal": name in T.TERMINAL_ACTIONS,
            "input_schema": T.ACTION_MODELS[name].model_json_schema(),
            "parameters": spec["parameters"],
        })
    return records


def tools_json() -> str:
    return dump_json(tools_records())
