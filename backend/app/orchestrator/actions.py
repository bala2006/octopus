"""Structured action schema that agents must use, and a robust parser for LLM output."""
from __future__ import annotations

import json
import re
from typing import Annotated, Any, Literal, Union

from pydantic import AliasChoices, model_validator, BaseModel, Field, TypeAdapter, ValidationError, field_validator

AgentMessageType = Literal[
    "task", "question", "answer", "proposal", "critique", "agreement", "objection", "decision",
    "review_request", "review_result", "status_update", "final_report",
]

TYPE_ALIASES = {
    "agree": "agreement", "object": "objection", "propose": "proposal", "propose_compromise": "proposal",
    "compromise": "proposal", "counter_proposal": "proposal", "review": "review_request", "report": "status_update",
    "status": "status_update", "reply": "answer", "response": "answer", "ask": "question", "delegate": "task",
    "approve": "review_result", "request_changes": "review_result", "feedback": "critique",
}


class SendMessage(BaseModel):
    action: Literal["send_message"]
    to: str = Field(min_length=1, max_length=120)
    type: AgentMessageType = "answer"
    content: str = Field(min_length=1, max_length=40000)
    task_id: str | None = None
    verdict: Literal["approve", "request_changes"] | None = None
    comments: list[str] = Field(default_factory=list)

    @field_validator("type", mode="before")
    @classmethod
    def _alias(cls, v: Any) -> Any:
        return TYPE_ALIASES.get(str(v).lower(), str(v).lower()) if isinstance(v, str) else v

    @field_validator("verdict", mode="before")
    @classmethod
    def _verdict(cls, v: Any) -> Any:
        if isinstance(v, str):
            v = v.lower().replace(" ", "_").replace("-", "_")
            if v in ("approved", "lgtm", "accept"):
                return "approve"
            if v in ("changes_requested", "reject", "request_change", "changes"):
                return "request_changes"
        return v


class WriteFile(BaseModel):
    """Write a file. ``mode="append"`` adds to the end of the file, so a large file can be built in parts across turns."""
    action: Literal["write_file"]
    path: str = Field(min_length=1, max_length=300)
    content: str = Field(max_length=1_000_000)
    note: str = ""
    mode: Literal["overwrite", "append"] = "overwrite"
    partial: bool = False  # more parts follow: the agent gets another turn to append the next one

    @field_validator("mode", mode="before")
    @classmethod
    def _mode_alias(cls, v: Any) -> Any:
        if isinstance(v, str):
            v = v.strip().lower()
            return {"write": "overwrite", "replace": "overwrite", "create": "overwrite", "w": "overwrite",
                    "a": "append", "add": "append", "continue": "append"}.get(v, v)
        return v


class CreateFolder(BaseModel):
    action: Literal["create_folder"]
    path: str = Field(min_length=1, max_length=300)
    note: str = ""


class MoveFile(BaseModel):
    """Move or rename a file or a whole folder inside the project (organise files)."""
    action: Literal["move_file"]
    source: str = Field(min_length=1, max_length=300, validation_alias=AliasChoices("source", "from", "src", "path"))
    destination: str = Field(min_length=1, max_length=300, validation_alias=AliasChoices("destination", "to", "dst", "target"))
    note: str = ""


class ReadFile(BaseModel):
    action: Literal["read_file"]
    path: str
    offset: int = Field(0, ge=0)  # character offset: large files are returned in pages


class ListFiles(BaseModel):
    action: Literal["list_files"]
    prefix: str = ""


class RunCode(BaseModel):
    action: Literal["run_code"]
    command: str = Field(min_length=1, max_length=500)


class McpCall(BaseModel):
    action: Literal["mcp_call"]
    server: str = Field(min_length=1, max_length=80)
    tool: str = Field(min_length=1, max_length=120)
    arguments: dict[str, Any] = Field(default_factory=dict)


class TaskItem(BaseModel):
    key: str | None = None
    title: str | None = None
    description: str | None = None
    assignee: str | None = None
    status: Literal["todo", "in_progress", "in_review", "done", "blocked"] | None = None
    acceptance_criteria: str | list[str] | None = None

    @field_validator("key", mode="before")
    @classmethod
    def _id_alias(cls, v: Any) -> Any:
        return str(v) if v is not None else v


class UpdateTaskBoard(BaseModel):
    action: Literal["update_task_board"]
    tasks: list[TaskItem] = Field(min_length=1, max_length=50)


class Remember(BaseModel):
    action: Literal["remember"]
    key: str = Field(min_length=1, max_length=200)
    value: str = Field(max_length=5000)


class Choice(BaseModel):
    label: str = Field(min_length=1, max_length=200)
    description: str = Field("", max_length=500)
    recommended: bool = False

    @model_validator(mode="before")
    @classmethod
    def _from_str(cls, data: Any) -> Any:
        return {"label": data} if isinstance(data, str) else data


class RequestUserInput(BaseModel):
    """Ask the user. Always offer 2-5 concrete options (mark the best one recommended); the user can also type their own answer."""
    action: Literal["request_user_input"]
    question: str = Field(min_length=1)
    options: list[Choice] = Field(default_factory=list, max_length=6)

    @model_validator(mode="after")
    def _one_recommended(self) -> "RequestUserInput":
        rec = [o for o in self.options if o.recommended]
        if self.options and not rec:
            self.options[0].recommended = True  # there is always a suggested answer
        for extra in rec[1:]:
            extra.recommended = False
        return self


class WebSearch(BaseModel):
    action: Literal["web_search"]
    query: str = Field(min_length=1, max_length=300)


class Calculate(BaseModel):
    action: Literal["calculate"]
    expression: str = Field(min_length=1, max_length=200)


ToolSpec = Union[dict[str, bool], list[str]]


class ConnectSpec(BaseModel):
    to: str = Field(min_length=1, max_length=120)
    type: Literal["delegate", "review", "debate", "report", "consult"] = "consult"
    bidirectional: bool = True
    label: str = ""


class CreateAgent(BaseModel):
    """Hire a new agent into the running company."""

    action: Literal["create_agent"]
    name: str = Field(min_length=1, max_length=60)
    role: str = Field(min_length=1, max_length=80)
    department: str = Field("", max_length=80)
    description: str = Field("", max_length=500)
    system_prompt: str = Field("", max_length=20000)
    role_template: str | None = None
    tools: ToolSpec | None = None
    is_manager: bool = False
    provider: str | None = None
    model: str | None = None
    reports_to: str | None = None  # name; default = the hiring agent
    connect: list[ConnectSpec] = Field(default_factory=list, max_length=8)
    brief: str | None = Field(None, max_length=8000)  # first task, delivered over the new delegate channel


class AgentChanges(BaseModel):
    name: str | None = Field(None, max_length=60)
    role: str | None = Field(None, max_length=80)
    description: str | None = Field(None, max_length=500)
    system_prompt: str | None = Field(None, max_length=20000)
    append_to_prompt: str | None = Field(None, max_length=4000)
    department: str | None = Field(None, max_length=80)
    is_manager: bool | None = None
    active: bool | None = None
    temperature: float | None = Field(None, ge=0, le=2)
    model: str | None = None
    max_tokens: int | None = Field(None, ge=256, le=128_000)  # answer budget per turn (raise it for large files)
    tools: ToolSpec | None = None
    behavior: dict[str, Any] | None = None
    permission_level: Literal["read_only", "plan", "ask", "danger"] | None = None


class UpdateAgent(BaseModel):
    """Edit your own configuration (target "self") or that of an agent you manage/hired."""

    action: Literal["update_agent"]
    target: str = "self"
    changes: AgentChanges
    reason: str = Field("", max_length=1000)


class ListAgents(BaseModel):
    action: Literal["list_agents"]
    include_inactive: bool = True
    department: str | None = None


class Finish(BaseModel):
    action: Literal["finish"]
    summary: str = ""


class Wait(BaseModel):
    action: Literal["wait"]


Action = Annotated[
    Union[SendMessage, WriteFile, CreateFolder, MoveFile, ReadFile, ListFiles, RunCode, McpCall, UpdateTaskBoard, Remember, RequestUserInput,
          WebSearch, Calculate, CreateAgent, UpdateAgent, ListAgents, Finish, Wait],
    Field(discriminator="action"),
]
_adapter: TypeAdapter[Any] = TypeAdapter(Action)

ACTION_ALIASES = {"message": "send_message", "send": "send_message", "write": "write_file", "read": "read_file",
                  "execute": "run_code", "run": "run_code", "terminal": "run_code", "tasks": "update_task_board", "done": "finish",
                  "ask_user": "request_user_input", "search": "web_search", "calculator": "calculate", "ls": "list_files",
                  "mcp": "mcp_call", "call_tool": "mcp_call", "hire": "create_agent", "spawn_agent": "create_agent",
                  "add_agent": "create_agent", "update_self": "update_agent", "edit_agent": "update_agent", "configure_agent": "update_agent",
                  "mkdir": "create_folder", "make_dir": "create_folder", "create_directory": "create_folder", "mkdir_p": "create_folder",
                  "move": "move_file", "rename": "move_file", "mv": "move_file", "rename_file": "move_file", "team": "list_agents", "roster": "list_agents", "view_agents": "list_agents"}

# tool toggle required for each action (absent => always available). mcp_call is gated per server.
ACTION_TOOL = {"send_message": "send_message", "write_file": "file_write", "create_folder": "file_write", "move_file": "file_write", "read_file": "file_read", "list_files": "list_files",
               "run_code": "terminal", "request_user_input": "ask_user", "web_search": "web_search", "calculate": "calculator",
               "create_agent": "manage_team"}
TOOL_DEFAULTS = {"send_message": True, "file_read": True, "file_write": True, "list_files": True, "calculator": True, "browser": True}


def tool_enabled(tools: dict[str, Any], key: str) -> bool:
    if key == "file_read" and "file_rw" in tools and "file_read" not in tools:
        return bool(tools["file_rw"])
    if key == "file_write" and "file_rw" in tools and "file_write" not in tools:
        return bool(tools["file_rw"])
    if key == "terminal" and "code_exec" in tools and "terminal" not in tools:
        return bool(tools["code_exec"])
    return bool(tools.get(key, TOOL_DEFAULTS.get(key, False)))


MAX_ACTIONS = 20  # per reply


class ParseResult(BaseModel):
    thought: str = ""
    actions: list[Any] = Field(default_factory=list)
    errors: list[str] = Field(default_factory=list)
    ok: bool = True


def _extract_json(text: str) -> Any:
    t = text.strip()
    fence = re.search(r"```(?:json)?\s*(.*?)```", t, re.S)
    candidates = [t]
    if fence:
        candidates.insert(0, fence.group(1).strip())
    for c in candidates:
        try:
            return json.loads(c)
        except json.JSONDecodeError:
            pass
    dec = json.JSONDecoder()
    for i, ch in enumerate(t):
        if ch in "{[":
            try:
                obj, _ = dec.raw_decode(t[i:])
                return obj
            except json.JSONDecodeError:
                continue
    raise ValueError("No JSON object found in the reply")


def parse_envelope(text: str) -> ParseResult:
    try:
        data = _extract_json(text)
    except ValueError as exc:
        return ParseResult(ok=False, errors=[str(exc)])
    if isinstance(data, list):
        data = {"actions": data}
    if not isinstance(data, dict):
        return ParseResult(ok=False, errors=["Top-level JSON must be an object with 'actions'"])
    raw = data.get("actions")
    if raw is None and "action" in data:
        raw = [data]
    if not isinstance(raw, list):
        return ParseResult(ok=False, errors=["'actions' must be a list"])
    res = ParseResult(thought=str(data.get("thought", ""))[:2000])
    if len(raw) > MAX_ACTIONS:
        res.errors.append(f"only the first {MAX_ACTIONS} of {len(raw)} actions were run; send the rest next turn")
    for i, item in enumerate(raw[:MAX_ACTIONS]):
        if not isinstance(item, dict):
            res.errors.append(f"actions[{i}] is not an object")
            continue
        item = dict(item)
        name = str(item.get("action") or item.get("tool") or item.get("name") or "").lower()
        item["action"] = ACTION_ALIASES.get(name, name)
        if item["action"] == "update_agent" and "changes" not in item:  # tolerate flat {"action":"update_self","role":...}
            item = {"action": "update_agent", "target": item.pop("target", "self"), "reason": item.pop("reason", ""),
                    "changes": {k: v for k, v in item.items() if k != "action"}}
        if item["action"] == "send_message" and "type" in item and str(item["type"]).lower() in ("approve", "request_changes") and "verdict" not in item:
            item["verdict"] = item["type"]
        try:
            res.actions.append(_adapter.validate_python(item))
        except ValidationError as exc:
            first = exc.errors()[0]
            loc = ".".join(str(x) for x in first.get("loc", []))
            res.errors.append(f"actions[{i}] ({item['action'] or '?'}) invalid: {loc} {first.get('msg')}")
    if not res.actions and res.errors:
        res.ok = False
    return res


def schema_doc(enabled_tools: dict[str, Any], mcp_servers: list[dict[str, Any]] | None = None) -> str:
    """Human-readable action schema injected into every agent's prompt (only enabled tools)."""
    lines = []
    if tool_enabled(enabled_tools, "send_message"):
        lines.append('{"action":"send_message","to":"<teammate name | all>","type":"<message type>","content":"...",'
                     ' "task_id":"T-1 (optional)","verdict":"approve|request_changes (review_result only)","comments":["..."]}')
    lines += [
        '{"action":"update_task_board","tasks":[{"key":"T-1 (omit to create)","title":"...","description":"...",'
        '"assignee":"<name>","status":"todo|in_progress|in_review|done|blocked","acceptance_criteria":"..."}]}',
        '{"action":"remember","key":"...","value":"..."}  (long-term memory note)',
    ]
    if tool_enabled(enabled_tools, "list_files"):
        lines.append('{"action":"list_files","prefix":"optional/dir"}')
    if tool_enabled(enabled_tools, "file_read"):
        lines.append('{"action":"read_file","path":"relative/path.ext","offset":0}  (big files come in pages; the result says which offset to read next)')
    if tool_enabled(enabled_tools, "file_write"):
        lines.append('{"action":"write_file","path":"relative/path.ext","content":"<FULL file content>","note":"why"}  (parent folders are created for you)')
        lines.append('{"action":"write_file","path":"relative/path.ext","mode":"append","content":"<next part>","partial":true}  (only for a file '
                     'too big for one reply: write the first part with "partial":true, then append the rest one part per turn; '
                     '"partial":true gives you another turn, leave it out on the last part)')
        lines.append('{"action":"create_folder","path":"src/components"}  (organise the project into folders)')
        lines.append('{"action":"move_file","source":"old/path.ext","destination":"new/folder/path.ext"}  (move or rename a file or a whole folder)')
    if tool_enabled(enabled_tools, "terminal"):
        lines.append('{"action":"run_code","command":"python -m unittest discover -s tests -v"}  (sandboxed terminal; allowlisted: python, node, npm test, pytest)')
    if tool_enabled(enabled_tools, "web_search"):
        lines.append('{"action":"web_search","query":"..."}')
    if tool_enabled(enabled_tools, "calculator"):
        lines.append('{"action":"calculate","expression":"(12*7)/3"}')
    if tool_enabled(enabled_tools, "ask_user"):
        lines.append('{"action":"request_user_input","question":"...","options":[{"label":"best choice","description":"why","recommended":true},'
                     '{"label":"alternative"},{"label":"another alternative"}]}  (pauses the run until the user answers; ALWAYS give 2-5 concrete '
                     'options and mark exactly one recommended; the user may also type a different answer)')
    lines.append('{"action":"list_agents","include_inactive":true}  (see every teammate: department, manager, active/inactive, live status)')
    lines.append('{"action":"update_agent","target":"self","changes":{"system_prompt"|"append_to_prompt"|"role"|"description"|"temperature"|"max_tokens"|"behavior"|"tools":...},"reason":"why"}'
                 '  (refine your OWN configuration; you cannot grant yourself new tools)')
    if tool_enabled(enabled_tools, "manage_team"):
        lines.append('{"action":"create_agent","name":"...","role":"...","department":"...","is_manager":false,"role_template":"optional",'
                     '"system_prompt":"focused prompt","tools":["file_read","file_write"],"reports_to":"<name, default you>",'
                     '"connect":[{"to":"<name>","type":"review|consult|debate|delegate|report","bidirectional":true}],"brief":"first task"}'
                     '  (hire a teammate; you can only grant tools you have yourself)')
        lines.append('{"action":"update_agent","target":"<name of an agent you manage or hired>","changes":{...,"active":false},"reason":"..."}'
                     '  (reconfigure or deactivate your reports)')
    for srv in mcp_servers or []:
        tools = srv.get("tools") or []
        if srv.get("builtin"):  # compact: name(required args, optional args)
            def sig(t: dict[str, Any]) -> str:
                props = list((t.get("input_schema") or {}).get("properties", {}))
                req = set((t.get("input_schema") or {}).get("required") or [])
                return f"{t['name']}(" + ", ".join(p if p in req else f"{p}?" for p in props[:6]) + ")"
            lines.append(f'{{"action":"mcp_call","server":"{srv["name"]}","tool":"browser_navigate","arguments":{{"url":"..."}}}}  '
                         f'your browser tab. Tools: ' + "; ".join(sig(t) for t in tools[:22]) +
                         '. "target" is the element ref from browser_snapshot (e.g. "e12").')
            continue
        listing = "; ".join(f"{t['name']}: {t.get('description', '')[:120]} args={json.dumps(t.get('input_schema', {}).get('properties', {}))[:300]}"
                            for t in tools[:25]) or "(tool list unavailable)"
        lines.append(f'{{"action":"mcp_call","server":"{srv["name"]}","tool":"<tool name>","arguments":{{...}}}}  MCP server "{srv["name"]}" tools: {listing}')
    lines += ['{"action":"finish","summary":"what you delivered"}', '{"action":"wait"}  (nothing to do until new messages arrive)']
    return "\n".join("- " + ln for ln in lines)
