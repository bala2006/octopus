"""Pydantic v2 API schemas (source of the generated TypeScript types)."""
from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

EdgeType = Literal["delegate", "review", "debate", "report", "consult"]
RunStatus = Literal["queued", "running", "paused", "awaiting_user", "completed", "failed", "cancelled"]
RunMode = Literal["autonomous", "step", "supervised"]
PermissionLevel = Literal["read_only", "plan", "ask", "danger"]
AgentPermission = Literal["inherit", "read_only", "plan", "ask", "danger"]
TaskStatus = Literal["todo", "in_progress", "in_review", "done", "blocked"]
MessageType = Literal[
    "task", "question", "answer", "proposal", "critique", "agreement", "objection", "decision",
    "review_request", "review_result", "status_update", "artifact_created", "user_interjection",
    "final_report", "chat", "system",
]
DebateStyle = Literal["agreeable", "balanced", "devils_advocate"]


class ORM(BaseModel):
    model_config = ConfigDict(from_attributes=True)


# ---------- auth ----------
class AuthConfig(BaseModel):
    single_user_mode: bool
    demo_mode: bool


class Credentials(BaseModel):
    email: str = Field(min_length=3, max_length=255)
    password: str = Field(min_length=6, max_length=200)


class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"


class UserOut(ORM):
    id: str
    email: str
    created_at: datetime


# ---------- agents ----------
class AgentTools(BaseModel):
    file_read: bool = True
    file_write: bool = True
    list_files: bool = True
    terminal: bool = False  # sandboxed code execution (allowlisted commands)
    web_search: bool = False
    calculator: bool = True
    ask_user: bool = False
    send_message: bool = True
    manage_team: bool = False  # create_agent / update_agent for reports (hiring & org design)
    browser: bool = True  # built-in Playwright browser (Octopus-managed MCP server "browser")
    mcp_servers: list[str] = Field(default_factory=list)  # ids of the user's registered MCP servers

    @model_validator(mode="before")
    @classmethod
    def _legacy(cls, data: Any) -> Any:
        """Accept the older {file_rw, code_exec} shape."""
        if isinstance(data, dict):
            data = dict(data)
            if "file_rw" in data:
                v = bool(data.pop("file_rw"))
                data.setdefault("file_read", v)
                data.setdefault("file_write", v)
            if "code_exec" in data:
                data.setdefault("terminal", bool(data.pop("code_exec")))
        return data


class AgentBehavior(BaseModel):
    assertiveness: float = Field(0.5, ge=0, le=1)
    creativity: float = Field(0.5, ge=0, le=1)
    strictness: float = Field(0.5, ge=0, le=1)
    debate_style: DebateStyle = "balanced"
    max_autonomous_turns: int = Field(12, ge=1, le=200)
    template_key: str = ""


class AgentBase(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    role: str = Field("", max_length=120)
    description: str = ""
    avatar: str = ""
    color: str = Field("#6366f1", pattern=r"^#[0-9a-fA-F]{6}$")
    system_prompt: str = ""
    provider: str = "mock"
    model: str = "mock/demo"
    temperature: float = Field(0.4, ge=0, le=2)
    max_tokens: int = Field(2048, ge=64, le=64000)
    tools: AgentTools = Field(default_factory=AgentTools)
    behavior: AgentBehavior = Field(default_factory=AgentBehavior)
    permission_level: AgentPermission = "inherit"
    department: str = Field("", max_length=80)
    is_manager: bool = False
    reports_to: str | None = None
    active: bool = True
    created_by: str | None = None
    is_entry: bool = False
    position_x: float = 0
    position_y: float = 0


class AgentIn(AgentBase):
    id: str | None = None


class AgentPatch(BaseModel):
    name: str | None = None
    role: str | None = None
    description: str | None = None
    avatar: str | None = None
    color: str | None = None
    system_prompt: str | None = None
    provider: str | None = None
    model: str | None = None
    temperature: float | None = None
    max_tokens: int | None = None
    tools: AgentTools | None = None
    behavior: AgentBehavior | None = None
    permission_level: AgentPermission | None = None
    department: str | None = None
    is_manager: bool | None = None
    reports_to: str | None = None
    active: bool | None = None
    is_entry: bool | None = None
    position_x: float | None = None
    position_y: float | None = None


class AgentOut(AgentBase):
    id: str
    company_id: str


# ---------- edges ----------
class EdgeConfig(BaseModel):
    max_turns: int = Field(20, ge=1, le=500)
    handoff_instructions: str = ""
    condition: str = ""
    max_rounds: int = Field(4, ge=1, le=50)  # debate
    max_revisions: int = Field(3, ge=1, le=50)  # review


class EdgeBase(BaseModel):
    source_agent_id: str
    target_agent_id: str
    bidirectional: bool = False
    type: EdgeType = "delegate"
    label: str = ""
    config: EdgeConfig = Field(default_factory=EdgeConfig)

    @field_validator("target_agent_id")
    @classmethod
    def _no_self_loop(cls, v: str, info: Any) -> str:
        if info.data.get("source_agent_id") == v:
            raise ValueError("Self-loops are not allowed")
        return v


class EdgeIn(EdgeBase):
    id: str | None = None


class EdgeOut(EdgeBase):
    id: str
    company_id: str


# ---------- companies / canvas ----------
class CompanyIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str = ""


class CompanyPatch(BaseModel):
    name: str | None = None
    description: str | None = None


class CompanyOut(ORM):
    id: str
    name: str
    description: str
    created_at: datetime
    updated_at: datetime
    agent_count: int = 0


class DepartmentMeta(BaseModel):
    color: str = Field("#6366f1", pattern=r"^#[0-9a-fA-F]{6}$")
    description: str = ""


class CanvasState(BaseModel):
    agents: list[AgentIn]
    edges: list[EdgeIn]
    viewport: dict[str, float] | None = None
    departments: dict[str, DepartmentMeta] | None = None
    revision: int | None = None  # optimistic concurrency: must match the server's current revision


class CanvasOut(BaseModel):
    company: CompanyOut
    agents: list[AgentOut]
    edges: list[EdgeOut]
    viewport: dict[str, float] | None = None
    departments: dict[str, DepartmentMeta] = Field(default_factory=dict)
    revision: int = 0


class CanvasExport(BaseModel):
    format: str = "octopus.company/v1"
    name: str
    description: str = ""
    agents: list[AgentIn]
    edges: list[EdgeIn]
    departments: dict[str, DepartmentMeta] = Field(default_factory=dict)


class DepartmentSummary(BaseModel):
    name: str
    color: str
    manager: str | None
    members: list[str]


class TemplateOut(BaseModel):
    key: str
    name: str
    description: str
    agent_count: int
    edge_count: int
    source: Literal["builtin", "user"] = "builtin"
    departments: list[DepartmentSummary] = Field(default_factory=list)
    updated_at: datetime | None = None


class UserTemplateIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str = ""
    company_id: str | None = None  # snapshot an existing company …
    spec: CanvasExport | None = None  # … or provide the spec directly (import)


class GenerateCompanyIn(BaseModel):
    prompt: str = Field(min_length=3, max_length=4000)
    max_agents: int = Field(14, ge=2, le=40)
    provider: str | None = None
    model: str | None = None


class GenerateCompanyOut(BaseModel):
    spec: CanvasExport
    departments: list[DepartmentSummary]
    source: Literal["ai", "demo"]
    warning: str = ""


class RoleTemplateOut(BaseModel):
    key: str
    role: str
    default_name: str
    color: str
    avatar: str
    description: str
    system_prompt: str
    tools: AgentTools


class InstantiateTemplateIn(BaseModel):
    template_key: str
    name: str | None = None


# ---------- sessions / messages ----------
class SessionIn(BaseModel):
    company_id: str
    title: str = "New chat"
    mode: Literal["direct", "company"] = "direct"
    agent_id: str | None = None


class SessionPatch(BaseModel):
    title: str


class SessionOut(ORM):
    id: str
    company_id: str
    agent_id: str | None
    title: str
    mode: str
    created_at: datetime


class MessageOut(ORM):
    id: str
    run_id: str | None
    session_id: str | None
    sender: str
    from_agent_id: str | None
    to_agent_id: str | None
    edge_id: str | None
    type: str
    content: str
    meta: dict[str, Any] = Field(default_factory=dict, validation_alias="meta_json")
    turn_no: int
    created_at: datetime


class ParsedFileOut(BaseModel):
    filename: str
    chars: int
    text: str
    truncated: bool


# ---------- runs ----------
class RunBudget(BaseModel):
    max_turns: int = Field(60, ge=1, le=2000)
    max_tokens: int = Field(400_000, ge=1000)
    max_cost_usd: float = Field(2.0, ge=0)
    timeout_s: int = Field(900, ge=10, le=86400)
    loop_threshold: float = Field(0.92, ge=0.5, le=1.0)
    max_loop_strikes: int = Field(3, ge=1, le=20)
    context_recent: int = Field(10, ge=2, le=100)
    force_mock: bool = False  # Demo Mode: every agent uses the scripted offline mock provider
    max_agents: int = Field(24, ge=1, le=100)  # team size cap including agents hired during the run
    persist_team: bool = True  # save agents hired / edited during the run back to the company


class RunCreate(BaseModel):
    company_id: str
    goal: str = Field(min_length=1, max_length=20000)
    session_id: str | None = None
    mode: RunMode = "autonomous"
    permission_level: PermissionLevel | None = None  # defaults to the workspace default
    budget: RunBudget = Field(default_factory=RunBudget)
    attachments: list[dict[str, str]] = Field(default_factory=list)


class RunOut(ORM):
    id: str
    company_id: str
    session_id: str | None
    goal: str
    status: str
    mode: str
    permission_level: str
    budget: dict[str, Any] = Field(default_factory=dict, validation_alias="budget_json")
    tokens_used: int
    cost_usd: float
    turns: int
    halt_reason: str
    summary: str
    created_at: datetime
    started_at: datetime | None
    ended_at: datetime | None


class RunDetail(RunOut):
    snapshot: dict[str, Any] = Field(default_factory=dict, validation_alias="snapshot_json")
    state: dict[str, Any] = Field(default_factory=dict, validation_alias="state_json")
    report_md: str


class InterjectIn(BaseModel):
    content: str = Field(min_length=1, max_length=20000)
    to_agent_id: str | None = None


class ApprovalIn(BaseModel):
    approval_id: str
    approved: bool
    reason: str = ""
    scope: Literal["once", "always"] = "once"  # "always": auto-approve this action kind for this agent for the rest of the run


class RunEventOut(ORM):
    id: int
    run_id: str
    type: str
    payload: dict[str, Any] = Field(default_factory=dict, validation_alias="payload_json")
    created_at: datetime


class TaskOut(ORM):
    id: str
    run_id: str
    key: str
    title: str
    description: str
    assignee_agent_id: str | None
    status: str
    acceptance_criteria: str
    created_by: str | None
    updated_at: datetime


class ArtifactOut(ORM):
    id: str
    run_id: str
    path: str
    version: int
    planned: bool = False
    author_agent_id: str | None
    change_note: str
    created_at: datetime
    size: int = 0


class ArtifactContentOut(ArtifactOut):
    content: str


# ---------- memory ----------
class MemoryIn(BaseModel):
    key: str = Field(min_length=1, max_length=200)
    value: str


class MemoryOut(ORM):
    id: str
    agent_id: str
    key: str
    value: str
    updated_at: datetime


# ---------- settings ----------
ProviderName = Literal["azure"]


class ProviderOptions(BaseModel):
    api_version: str = ""  # Azure OpenAI (legacy API only)
    api_style: Literal["auto", "responses", "chat", "legacy"] = "auto"  # Azure OpenAI: v1 Responses / v1 Chat / legacy api-version
    auth: Literal["key", "entra"] = "key"  # Azure: API key or Microsoft Entra ID (az login / managed identity)
    deployments: list[str] = Field(default_factory=list)  # Azure deployment / Foundry model names shown in pickers
    reasoning_models: list[str] = Field(default_factory=list)  # deployments that need max_completion_tokens (o-series, gpt-5)
    deployment_type: Literal["global", "data_zone", "regional"] = "global"  # Data Zone / regional deployments cost +10%
    pricing: dict[str, float] = Field(default_factory=dict)  # USD per 1M tokens override: input / cached_input / cache_write / output


class ProviderKeyIn(BaseModel):
    provider: ProviderName
    api_key: str = ""  # empty = keep the stored key
    base_url: str = ""
    options: ProviderOptions = Field(default_factory=ProviderOptions)


class ProviderKeyOut(BaseModel):
    provider: str
    masked_key: str
    base_url: str
    options: ProviderOptions
    updated_at: datetime


class ProviderInfo(BaseModel):
    provider: str
    label: str
    models: list[str]
    configured: bool
    needs_key: bool
    needs_base: bool = False


class SettingsOut(BaseModel):
    demo_mode: bool
    single_user_mode: bool
    default_provider: str
    default_model: str
    sandbox_mode: str
    providers: list[ProviderInfo]
    keys: list[ProviderKeyOut]


class BrowserStatusOut(BaseModel):
    enabled: bool
    status: str  # stopped | starting | installing | ready | error
    error: str = ""
    browser: str = ""
    package: str = ""
    tools: list[str] = Field(default_factory=list)
    node: bool = True  # npx found


class BrowserTestOut(BaseModel):
    ok: bool
    detail: str
    latency_ms: int = 0


class TestProviderIn(BaseModel):
    provider: str
    model: str


class TestProviderOut(BaseModel):
    ok: bool
    detail: str
    latency_ms: int = 0


# ---------- workspaces (project directories) ----------
class WorkspaceIn(BaseModel):
    path: str = Field(min_length=1, max_length=1000)
    name: str | None = Field(None, max_length=200)
    default_permission: PermissionLevel = "ask"


class NativeOpenIn(BaseModel):
    default_permission: PermissionLevel = "ask"


class NativeDialogOut(BaseModel):
    available: bool
    method: str = ""
    reason: str = ""


class WorkspacePatch(BaseModel):
    name: str | None = Field(None, max_length=200)
    default_permission: PermissionLevel | None = None


class WorkspaceOut(ORM):
    id: str
    name: str
    path: str
    default_permission: str
    created_at: datetime
    last_opened_at: datetime
    exists: bool = True
    existing_project: bool = False


class NativeOpenOut(BaseModel):
    cancelled: bool
    workspace: WorkspaceOut | None = None


class DirEntryOut(BaseModel):
    name: str
    path: str
    is_project: bool
    is_git: bool


class BrowseOut(BaseModel):
    path: str | None
    parent: str | None
    entries: list[DirEntryOut]
    roots: list[str]


class MkdirIn(BaseModel):
    parent: str
    name: str = Field(min_length=1, max_length=120)


class FileNode(BaseModel):
    path: str
    size: int
    modified: bool = False  # changed by agents in the selected run
    planned: bool = False


class ProjectTreeOut(BaseModel):
    root: str  # absolute path of the project folder
    name: str
    files: list[FileNode]
    truncated: bool = False


class FileContentOut(BaseModel):
    path: str
    content: str
    size: int


class RevertIn(BaseModel):
    path: str
    to_version: int = 0  # 0 = state before the run touched the file


# ---------- MCP servers ----------
class McpServerIn(BaseModel):
    name: str = Field(min_length=1, max_length=80, pattern=r"^[A-Za-z0-9_\-. ]+$")
    transport: Literal["stdio", "http"] = "stdio"
    command: str = ""  # stdio: executable, e.g. "npx"
    args: list[str] = Field(default_factory=list)  # stdio args, e.g. ["-y", "@modelcontextprotocol/server-everything"]
    url: str = ""  # http: streamable-HTTP endpoint
    env: dict[str, str] = Field(default_factory=dict)  # stored encrypted
    enabled: bool = True


class McpToolOut(BaseModel):
    name: str
    description: str = ""
    input_schema: dict[str, Any] = Field(default_factory=dict)


class McpServerOut(BaseModel):
    id: str
    name: str
    transport: str
    command: str
    args: list[str]
    url: str
    env_keys: list[str]
    enabled: bool
    tools: list[McpToolOut] = Field(default_factory=list)
    last_error: str = ""
    updated_at: datetime
