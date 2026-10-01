"""Prompt/context construction: meta-prompt, blackboard summary, rolling summaries."""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from app.llm.base import effective_max_tokens
from app.orchestrator.actions import schema_doc
from app.orchestrator.permissions import EdgeSpec, allowed_recipients

EDGE_MEANING = {
    "delegate": "hand off tasks (send `task`)",
    "review": "code/document review loop (`review_request` → `review_result` with verdict)",
    "debate": "structured debate: `proposal`, `objection` (with reasons), compromise `proposal`, `agreement`",
    "report": "report status upward (`status_update`, `final_report`)",
    "consult": "ask questions / give answers (`question`, `answer`)",
}

MSG_TYPES = ("task, question, answer, proposal, critique, agreement, objection, decision, "
             "review_request, review_result, status_update, final_report")
# Model-facing size limits (see docs/MODEL_QUALITY_AUDIT.md). Every cut is marked so the model knows it saw only part.
# gpt-6-luna reads up to 922k input tokens, so these are generous; they only guard against pathological inputs.
TOOL_RESULT_CHARS = 60_000   # one tool result / notice in the prompt (~15k tokens)
RECENT_MSG_CHARS = 8_000     # each message in the "recent conversation" window
SUMMARY_CHARS = 16_000       # extractive summary of older messages


def clip(text: str, limit: int, hint: str = "") -> str:
    """Cut ``text`` to ``limit`` chars with an explicit marker (never a silent cut)."""
    if len(text) <= limit:
        return text
    return text[:limit] + f"\n…[truncated: showing {limit:,} of {len(text):,} characters{'; ' + hint if hint else ''}]"


@dataclass
class AgentSpec:
    id: str
    name: str
    role: str
    description: str
    system_prompt: str
    provider: str
    model: str
    temperature: float
    max_tokens: int
    tools: dict[str, bool]
    behavior: dict[str, Any]
    is_entry: bool
    color: str
    category: str = "generic"
    department: str = ""
    is_manager: bool = False
    reports_to: str | None = None
    active: bool = True
    created_by: str | None = None
    avatar: str = ""
    permission_level: str = "inherit"
    memory: dict[str, str] = field(default_factory=dict)
    mcp: list[dict[str, Any]] = field(default_factory=list)  # [{id, name, tools}]

    @classmethod
    def from_dict(cls, d: dict[str, Any], category: str) -> AgentSpec:
        return cls(id=d["id"], name=d["name"], role=d.get("role", ""), description=d.get("description", ""),
                   system_prompt=d.get("system_prompt", ""), provider=d.get("provider", "mock"), model=d.get("model", "mock/demo"),
                   temperature=float(d.get("temperature", 0.4)), max_tokens=effective_max_tokens(d.get("max_tokens")),
                   tools=d.get("tools") or {}, behavior=d.get("behavior") or {}, is_entry=bool(d.get("is_entry")),
                   color=d.get("color", "#6366f1"), category=category, department=d.get("department") or "",
                   is_manager=bool(d.get("is_manager")), reports_to=d.get("reports_to"), active=d.get("active", True) is not False,
                   created_by=d.get("created_by"), avatar=d.get("avatar") or "", permission_level=d.get("permission_level") or "inherit")

    def to_dict(self) -> dict[str, Any]:
        """Serialise back to the AgentOut-like shape stored in run snapshots."""
        return {"id": self.id, "name": self.name, "role": self.role, "description": self.description, "system_prompt": self.system_prompt,
                "provider": self.provider, "model": self.model, "temperature": self.temperature, "max_tokens": self.max_tokens,
                "tools": self.tools, "behavior": self.behavior, "is_entry": self.is_entry, "color": self.color, "avatar": self.avatar,
                "department": self.department, "is_manager": self.is_manager, "reports_to": self.reports_to, "active": self.active,
                "created_by": self.created_by, "permission_level": self.permission_level}


def render_template(text: str, variables: dict[str, str]) -> str:
    return re.sub(r"\{\{\s*(\w+)\s*\}\}", lambda m: variables.get(m.group(1), m.group(0)), text)


def _level(v: float) -> str:
    return "high" if v >= 0.67 else "low" if v <= 0.33 else "moderate"


def personality(behavior: dict[str, Any]) -> str:
    a, c, s = (float(behavior.get(k, 0.5)) for k in ("assertiveness", "creativity", "strictness"))
    style = behavior.get("debate_style", "balanced")
    style_text = {
        "agreeable": "Seek common ground quickly; object only to clear problems.",
        "balanced": "Weigh arguments on merit; object when warranted, agree when convinced.",
        "devils_advocate": "Actively stress-test ideas and raise the strongest counter-arguments, but agree once concerns are genuinely resolved.",
    }.get(style, "")
    return (f"Assertiveness: {_level(a)}. Creativity: {_level(c)}. Strictness/quality bar: {_level(s)}. "
            f"Debate style: {style.replace('_', ' ')}: {style_text}")


def team_roster(agents: dict[str, AgentSpec], status: dict[str, str] | None = None) -> str:
    lines = []
    for a in agents.values():
        tags = []
        if a.department:
            tags.append(a.department + (" manager" if a.is_manager else ""))
        if a.is_entry:
            tags.append("entry")
        if not a.active:
            tags.append("INACTIVE")
        elif status:
            tags.append(status.get(a.id, "idle"))
        lines.append(f"- {a.name}: {a.role}" + (f" [{', '.join(tags)}]" if tags else ""))
    return "\n".join(lines)


def sender_name(m: dict[str, Any], names: dict[str, str], me: str) -> str:
    if m["from"] is None:
        return "Octopus" if m.get("sender") == "system" else "User"
    return "you" if m["from"] == me else names.get(m["from"], "?")


def fmt_msg(m: dict[str, Any], names: dict[str, str], me: str, limit: int = 1500) -> str:
    frm = sender_name(m, names, me)
    to = "everyone" if m["to"] is None else ("you" if m["to"] == me else names.get(m["to"], "?"))
    extra = ""
    meta = m.get("meta") or {}
    if meta.get("verdict"):
        extra += f" [verdict: {meta['verdict']}]"
    if meta.get("task_id"):
        extra += f" [task {meta['task_id']}]"
    content = m["content"] if len(m["content"]) <= limit else m["content"][:limit] + f" …[truncated: {limit:,} of {len(m['content']):,} chars]"
    return f"[turn {m['turn']}] {frm} → {to} ({m['type']}){extra}: {content}"


def rolling_summary(older: list[dict[str, Any]], names: dict[str, str], me: str, max_chars: int = SUMMARY_CHARS) -> str:
    """Extractive summary of older turns (first sentence of each message), newest kept when over budget."""
    lines = []
    for m in older:
        first = re.split(r"(?<=[.!?])\s|\n", m["content"].strip(), maxsplit=1)[0][:160]
        frm = sender_name(m, names, me)
        to = "all" if m["to"] is None else ("you" if m["to"] == me else names.get(m["to"], "?"))
        lines.append(f"- t{m['turn']} {frm}→{to} {m['type']}: {first}")
    out: list[str] = []
    total = 0
    for ln in reversed(lines):
        total += len(ln) + 1
        if total > max_chars:
            out.append(f"- … {len(lines) - len(out)} earlier messages omitted (decisions, tasks and files are on the Blackboard)")
            break
        out.append(ln)
    return "\n".join(reversed(out))


def org_variables(agent: AgentSpec, agents: dict[str, AgentSpec]) -> dict[str, str]:
    mgr = agents.get(agent.reports_to or "")
    reports = [a.name for a in agents.values() if a.reports_to == agent.id and a.active]
    return {"department": agent.department or "company", "manager": mgr.name if mgr else "the user",
            "reports": ", ".join(reports) or "nobody yet"}


def browser_note(agent: AgentSpec, preview_url: str) -> str:
    if not any(m.get("builtin") for m in agent.mcp):
        return ""
    where = f" The project is served at {preview_url}<path> (e.g. {preview_url}index.html)." if preview_url else ""
    return ("\n## Browser\nYou have a real browser (MCP server \"browser\", your own tab)." + where +
            " Open pages with browser_navigate, then read them with browser_snapshot and interact via the element refs it returns"
            ' (browser_click / browser_type with "target": "<ref>").' " Check browser_console_messages for errors. Use it to test what the team builds.")


def build_system_prompt(agent: AgentSpec, *, company: str, goal: str, agents: dict[str, AgentSpec], edges: list[EdgeSpec],
                        status: dict[str, str] | None = None, preview_url: str = "", native: bool = False) -> str:
    names = {a.id: a.name for a in agents.values()}
    variables = {"company_name": company, "goal": goal, "team": team_roster(agents), "agent_name": agent.name, "role": agent.role,
                 **org_variables(agent, agents)}
    base = render_template(agent.system_prompt or f"You are {agent.name}, {agent.role} at {company}.", variables)
    allowed = allowed_recipients(edges, agent.id)
    channel_lines = []
    for rid, es in allowed.items():
        for e in es:
            arrow = "↔" if e.bidirectional else "→"
            cfg = e.config or {}
            extra = ""
            if cfg.get("handoff_instructions"):
                extra += f" Handoff instructions: {cfg['handoff_instructions']}."
            if cfg.get("condition"):
                extra += f" Condition: only use this channel {cfg['condition']}."
            label = f" \"{e.label}\"" if e.label else ""
            channel_lines.append(f"- {names.get(rid, rid)} ({agents[rid].role}) via {e.type}{label} [you {arrow} them]: {EDGE_MEANING.get(e.type, '')}.{extra}")
    channels = "\n".join(channel_lines) or "- (none) You cannot message anyone; use tools and `finish`."
    memory = "\n".join(f"- {k}: {v}" for k, v in agent.memory.items()) or "- (empty)"
    finish_rule = ("You are an ENTRY agent: when the goal is achieved, call `finish` with a summary; this completes the whole run."
                   if agent.is_entry else "Call `finish` when your part is done; you may be re-activated if new messages arrive.")
    return f"""{base}

# Operating rules (Octopus runtime)
## Personality
{personality(agent.behavior)}

## Team roster (live status)
{team_roster(agents, status)}

## Your communication channels (you may ONLY message these agents)
{channels}

## Long-term memory notes
{memory}{browser_note(agent, preview_url)}

## Rules
1. Be concise. Do not repeat what others already said; reference it. The Blackboard (task board, workspace files) is always
   current: check it instead of asking a teammate whether something exists or is done, and never re-send a request they
   already have (repeats are blocked as loops). If you are waiting on someone, `wait`.
2. Challenge weak ideas politely with concrete reasons; converge instead of arguing in circles.
3. Never fabricate tool results, test output or file contents; use tools and report what they return.
4. Files: paths are relative to the project workspace. The project folder holds what the user asked for; working material
   for the team (plans, specs, notes, reviews and the like) can go under `.octopus/work/` so it stays out of the user's
   project. Files that existed before Octopus touched them are the user's, and changes to them are pointed out to the user.
   A reply can be up to {agent.max_tokens:,} tokens (reasoning included). `write_file` replaces a whole file (`"mode":"append"`
   adds to its end); `edit_file` changes part of an existing file by exact text replacement.
5. On debate channels only use proposal / objection / agreement (a debate ends when BOTH sides send `agreement`, or on a `decision`).
6. On review channels: author sends `review_request`; reviewer replies `review_result` with `verdict` "approve" or "request_changes" and itemized `comments`.
7. Delegation: tasks you send become entries on the task board. Keep statuses current with update_task_board.
8. {finish_rule}
9. Team: use `list_agents` to see who is active/idle/done. You may refine your own configuration with `update_agent`
   (target "self"). {"You can hire teammates (`create_agent`) and reconfigure/deactivate agents you manage. Hire only for real capability gaps and keep departments to 2-3 people." if agent.tools.get("manage_team") else "Ask your manager if the team lacks a skill."}

{response_format(agent, native)}"""


def response_format(agent: AgentSpec, native: bool) -> str:
    if native:  # the tools themselves carry names, descriptions and argument schemas
        return (f"## Acting\nYou act by calling your tools. Each call's result comes back to you within this turn, so you can "
                f"read, run, check and continue as far as you choose; several independent calls can go in one reply. The turn "
                f"ends when you stop calling tools, call `wait` or `finish`, or ask the user. Message types: {MSG_TYPES}.\n")
    return ("## Response format\nReply with ONE JSON object and nothing else:\n"
            '{"thought": "<1-2 sentences of private reasoning>", "actions": [ ... ]}\n'
            f"Message types: {MSG_TYPES}.\nAvailable actions:\n{schema_doc(agent.tools, agent.mcp)}\n")


def build_user_prompt(*, agent: AgentSpec, history: list[dict[str, Any]], inbox_ids: set[str], observations: list[dict[str, Any]],
                      blackboard: str, names: dict[str, str], recent_n: int, native: bool = False) -> str:
    mine = [m for m in history if m["id"] not in inbox_ids and (m["from"] == agent.id or m["to"] == agent.id or (m["to"] is None and m["from"] is None))]
    older, recent = mine[:-recent_n] if len(mine) > recent_n else [], mine[-recent_n:]
    inbox = [m for m in history if m["id"] in inbox_ids]
    parts = [f"# Blackboard\n{blackboard}"]
    if older:
        parts.append("# Summary of earlier conversation\n" + rolling_summary(older, names, agent.id))
    if recent:
        parts.append("# Recent conversation\n" + "\n".join(fmt_msg(m, names, agent.id, RECENT_MSG_CHARS) for m in recent))
    parts.append("# NEW messages for you\n" + ("\n".join(fmt_msg(m, names, agent.id) for m in inbox) or "(none)"))
    if observations:
        obs = []
        for o in observations:
            head = f"[{o.get('tool', 'system')}{' OK' if o.get('ok') else ' FAILED' if o.get('ok') is False else ''}]"
            hint = "read_file with a larger offset for the rest" if o.get("tool") == "read_file" else ""
            obs.append(f"{head} {clip(str(o.get('content', '')), TOOL_RESULT_CHARS, hint)}")
        parts.append("# Tool results & system notices\n" + "\n".join(obs))
    parts.append("Decide what to do next." if native else "Decide your next actions now. Respond with the JSON object only.")
    return "\n\n".join(parts)
