"""Prompt/context construction: meta-prompt, blackboard summary, rolling summaries."""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

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
    memory: dict[str, str] = field(default_factory=dict)
    mcp: list[dict[str, Any]] = field(default_factory=list)  # [{id, name, tools}]

    @classmethod
    def from_dict(cls, d: dict[str, Any], category: str) -> AgentSpec:
        return cls(id=d["id"], name=d["name"], role=d.get("role", ""), description=d.get("description", ""),
                   system_prompt=d.get("system_prompt", ""), provider=d.get("provider", "mock"), model=d.get("model", "mock/demo"),
                   temperature=float(d.get("temperature", 0.4)), max_tokens=int(d.get("max_tokens", 2048)),
                   tools=d.get("tools") or {}, behavior=d.get("behavior") or {}, is_entry=bool(d.get("is_entry")),
                   color=d.get("color", "#6366f1"), category=category)


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


def team_roster(agents: dict[str, AgentSpec]) -> str:
    return "\n".join(f"- {a.name}: {a.role}" + (" (entry)" if a.is_entry else "") for a in agents.values())


def fmt_msg(m: dict[str, Any], names: dict[str, str], me: str, limit: int = 1500) -> str:
    frm = "User" if m["from"] is None else ("you" if m["from"] == me else names.get(m["from"], "?"))
    to = "everyone" if m["to"] is None else ("you" if m["to"] == me else names.get(m["to"], "?"))
    extra = ""
    meta = m.get("meta") or {}
    if meta.get("verdict"):
        extra += f" [verdict: {meta['verdict']}]"
    if meta.get("task_id"):
        extra += f" [task {meta['task_id']}]"
    content = m["content"] if len(m["content"]) <= limit else m["content"][:limit] + " …[truncated]"
    return f"[turn {m['turn']}] {frm} → {to} ({m['type']}){extra}: {content}"


def rolling_summary(older: list[dict[str, Any]], names: dict[str, str], me: str, max_chars: int = 3000) -> str:
    """Extractive summary of older turns (first sentence of each message), newest kept when over budget."""
    lines = []
    for m in older:
        first = re.split(r"(?<=[.!?])\s|\n", m["content"].strip(), maxsplit=1)[0][:160]
        frm = "User" if m["from"] is None else ("you" if m["from"] == me else names.get(m["from"], "?"))
        to = "all" if m["to"] is None else ("you" if m["to"] == me else names.get(m["to"], "?"))
        lines.append(f"- t{m['turn']} {frm}→{to} {m['type']}: {first}")
    out: list[str] = []
    total = 0
    for ln in reversed(lines):
        total += len(ln) + 1
        if total > max_chars:
            out.append(f"- … {len(lines) - len(out)} earlier messages omitted")
            break
        out.append(ln)
    return "\n".join(reversed(out))


def build_system_prompt(agent: AgentSpec, *, company: str, goal: str, agents: dict[str, AgentSpec], edges: list[EdgeSpec]) -> str:
    names = {a.id: a.name for a in agents.values()}
    variables = {"company_name": company, "goal": goal, "team": team_roster(agents), "agent_name": agent.name, "role": agent.role}
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

## Team roster
{team_roster(agents)}

## Your communication channels (you may ONLY message these agents)
{channels}

## Long-term memory notes
{memory}

## Rules
1. Be concise. Do not repeat what others already said; reference it.
2. Challenge weak ideas politely with concrete reasons; converge instead of arguing in circles.
3. Never fabricate tool results, test output or file contents; use tools and report what they return.
4. Write COMPLETE files with write_file (no placeholders). Paths are relative to the project workspace.
5. On debate channels only use proposal / objection / agreement (a debate ends when BOTH sides send `agreement`, or on a `decision`).
6. On review channels: author sends `review_request`; reviewer replies `review_result` with `verdict` "approve" or "request_changes" and itemized `comments`.
7. Delegation: tasks you send become entries on the task board. Keep statuses current with update_task_board.
8. {finish_rule}

## Response format
Reply with ONE JSON object and nothing else:
{{"thought": "<1-2 sentences of private reasoning>", "actions": [ ... ]}}
Message types: {MSG_TYPES}.
Available actions:
{schema_doc(agent.tools, agent.mcp)}
"""


def build_user_prompt(*, agent: AgentSpec, history: list[dict[str, Any]], inbox_ids: set[str], observations: list[dict[str, Any]],
                      blackboard: str, names: dict[str, str], recent_n: int) -> str:
    mine = [m for m in history if m["id"] not in inbox_ids and (m["from"] == agent.id or m["to"] == agent.id or (m["to"] is None and m["from"] is None))]
    older, recent = mine[:-recent_n] if len(mine) > recent_n else [], mine[-recent_n:]
    inbox = [m for m in history if m["id"] in inbox_ids]
    parts = [f"# Blackboard\n{blackboard}"]
    if older:
        parts.append("# Summary of earlier conversation\n" + rolling_summary(older, names, agent.id))
    if recent:
        parts.append("# Recent conversation\n" + "\n".join(fmt_msg(m, names, agent.id, 800) for m in recent))
    parts.append("# NEW messages for you\n" + ("\n".join(fmt_msg(m, names, agent.id) for m in inbox) or "(none)"))
    if observations:
        obs = []
        for o in observations:
            head = f"[{o.get('tool', 'system')}{' OK' if o.get('ok') else ' FAILED' if o.get('ok') is False else ''}]"
            obs.append(f"{head} {o.get('content', '')[:6000]}")
        parts.append("# Tool results & system notices\n" + "\n".join(obs))
    parts.append("Decide your next actions now. Respond with the JSON object only.")
    return "\n\n".join(parts)
