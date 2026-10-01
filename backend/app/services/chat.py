"""Direct chat (user ↔ single agent) over WebSocket with streaming, tools, memory, stop and regenerate."""
from __future__ import annotations

import asyncio
import json
import re
import time
from typing import Any

from fastapi import WebSocket
from sqlalchemy import delete, select

from app.db.base import new_id, utcnow
from app.db.session import SessionFactory, registry_factory
from app.core.config import get_settings
from app.llm.base import LLMError, LLMRequest, effective_max_tokens
from app.llm.demo_script import role_category
from app.llm.router import prepare_request, stream_with_retry
from app.models import Agent, AgentMemory, ChatSession, Company, Message
from app.orchestrator.context import clip, render_template, rolling_summary
from app.tools import basic

TOOL_RE = re.compile(r"^\s*```tool\s*(\{.*?\})\s*```", re.S)
MAX_TOOL_ROUNDS = 3
HISTORY_VERBATIM = 24
IMAGE_MESSAGES = 6  # images are sent with the last few messages only


def msg_out(m: Message) -> dict[str, Any]:
    return {"id": m.id, "run_id": m.run_id, "session_id": m.session_id, "sender": m.sender, "from_agent_id": m.from_agent_id,
            "to_agent_id": m.to_agent_id, "edge_id": m.edge_id, "type": m.type, "content": m.content, "meta": m.meta_json or {},
            "turn_no": m.turn_no, "created_at": m.created_at.isoformat()}


def tool_instructions(tools: dict[str, Any]) -> str:
    avail = ['remember {"key": str, "value": str}: save a long-term note about the user/project']
    if tools.get("calculator", True):
        avail.append('calculator {"expression": str}: exact arithmetic')
    if tools.get("web_search"):
        avail.append('web_search {"query": str}: search the web')
    return ("\n\n## Tools\nTo use a tool, reply with ONLY a fenced block and nothing else:\n```tool\n{\"name\": \"<tool>\", \"args\": {...}}\n```\n"
            "You will then receive the result and can answer. Available tools:\n" + "\n".join(f"- {t}" for t in avail))


class ChatConnection:
    def __init__(self, ws: WebSocket, session_id: str, user_id: str, sf: SessionFactory) -> None:
        self.ws, self.session_id, self.user_id, self.sf = ws, session_id, user_id, sf
        self.task: asyncio.Task[None] | None = None

    async def send(self, type_: str, data: dict[str, Any]) -> None:
        try:
            await self.ws.send_json({"type": type_, "data": data})
        except Exception:
            pass

    async def handle(self, event: dict[str, Any]) -> None:
        kind = event.get("type")
        if kind == "stop":
            if self.task and not self.task.done():
                self.task.cancel()
            return
        if self.task and not self.task.done():
            await self.send("error", {"message": "A response is already streaming; stop it first."})
            return
        if kind == "user_message":
            from app.services.images import ImageError, parse_images

            content = str(event.get("content", "")).strip()
            atts = event.get("attachments") or []
            try:
                images = parse_images(event.get("images"))
            except ImageError as exc:
                await self.send("error", {"message": f"Image not sent: {exc}"})
                return
            if not content and not atts and not images:
                return
            self.task = asyncio.create_task(self.respond(content[:20000], atts, images))
        elif kind == "regenerate":
            self.task = asyncio.create_task(self.regenerate())

    async def _context(self) -> tuple[ChatSession, Agent, Company]:
        async with self.sf() as db:
            s = await db.get(ChatSession, self.session_id)
            if s is None or s.agent_id is None:
                raise LLMError("This session has no agent", retryable=False)
            agent = await db.get(Agent, s.agent_id)
            company = await db.get(Company, s.company_id)
            if agent is None or company is None:
                raise LLMError("Agent no longer exists", retryable=False)
            return s, agent, company

    async def regenerate(self) -> None:
        async with self.sf() as db:
            msgs = (await db.execute(select(Message).where(Message.session_id == self.session_id, Message.run_id.is_(None))
                                     .order_by(Message.created_at.desc()).limit(10))).scalars().all()
            last_user = next((m for m in msgs if m.sender == "user"), None)
            if last_user is None:
                await self.send("error", {"message": "Nothing to regenerate"})
                return
            removed = [m.id for m in msgs if m.sender == "agent" and m.created_at >= last_user.created_at]
            if removed:
                await db.execute(delete(Message).where(Message.id.in_(removed)))
                await db.commit()
        for mid in removed:
            await self.send("message_deleted", {"id": mid})
        await self.generate()

    async def respond(self, content: str, attachments: list[dict[str, Any]], images: list[dict[str, str]] | None = None) -> None:
        s, agent, _ = await self._context()
        att_meta = [{"filename": str(a.get("filename", "file"))[:200], "chars": len(str(a.get("text", "")))} for a in attachments[:5]]
        full = content
        for a in attachments[:5]:
            full += f"\n\n--- Attached file: {a.get('filename', 'file')} ---\n" + clip(str(a.get('text', '')), 30000)
        async with self.sf() as db:
            m = Message(id=new_id(), session_id=self.session_id, sender="user", to_agent_id=agent.id, type="chat", content=full,
                        meta_json={"attachments": att_meta, "display": content, **({"images": images} if images else {})},
                        read=True, created_at=utcnow())
            db.add(m)
            if s.title in ("New chat", "") and content:
                s2 = await db.get(ChatSession, self.session_id)
                if s2:
                    s2.title = content[:60]
            await db.commit()
        await self.send("message_created", {"message": msg_out(m)})
        await self.generate()

    async def _history(self, agent: Agent) -> list[dict[str, str]]:
        async with self.sf() as db:
            msgs = (await db.execute(select(Message).where(Message.session_id == self.session_id, Message.run_id.is_(None))
                                     .order_by(Message.created_at))).scalars().all()
        conv = [{"role": "user" if m.sender == "user" else "assistant", "content": m.content or "(image)",
                 **({"images": [i["data_url"] for i in (m.meta_json or {}).get("images", [])]} if (m.meta_json or {}).get("images") else {})}
                for m in msgs if m.type in ("chat", "answer")]
        for c in conv[:-IMAGE_MESSAGES]:  # older images are not re-sent on every reply (the text around them stays)
            c.pop("images", None)
        if len(conv) > HISTORY_VERBATIM:
            older = conv[:-HISTORY_VERBATIM]
            recs = [{"from": None if c["role"] == "user" else agent.id, "to": agent.id if c["role"] == "user" else None,
                     "type": "chat", "content": c["content"], "turn": i} for i, c in enumerate(older)]
            summary = rolling_summary(recs, {agent.id: agent.name}, agent.id)
            conv = [{"role": "user", "content": "Summary of our earlier conversation:\n" + summary},
                    {"role": "assistant", "content": "Understood."}] + conv[-HISTORY_VERBATIM:]
        return conv

    async def generate(self) -> None:
        s, agent, company = await self._context()
        async with self.sf() as db:
            mem = (await db.execute(select(AgentMemory).where(AgentMemory.agent_id == agent.id))).scalars().all()
        memory = {r.key: r.value for r in mem}
        tools = agent.tools_json or {}
        mgr = next((x for x in company.agents if x.id == agent.reports_to), None)
        variables = {"company_name": company.name, "goal": "(direct conversation with the user)", "agent_name": agent.name,
                     "role": agent.role, "team": ", ".join(f"{a.name} ({a.role})" for a in company.agents),
                     "department": agent.department or "company", "manager": mgr.name if mgr else "the user",
                     "reports": ", ".join(x.name for x in company.agents if x.reports_to == agent.id) or "nobody yet"}
        system = render_template(agent.system_prompt or f"You are {agent.name}, {agent.role}.", variables)
        system += ("\n\n## Direct chat mode\nYou are chatting directly with the user (not with teammates). Ignore the JSON action "
                   "schema here and reply in clear GitHub-flavoured Markdown; use fenced code blocks with language tags.")
        if memory:
            system += "\n\n## Long-term memory\n" + "\n".join(f"- {k}: {v}" for k, v in memory.items())
        system += tool_instructions(tools)
        messages = [{"role": "system", "content": system}] + await self._history(agent)

        mid = new_id()
        started = time.monotonic()
        tool_calls: list[dict[str, Any]] = []
        total_tokens, total_cost, text = 0, 0.0, ""
        detail = {"input_tokens": 0, "cached_tokens": 0, "cache_write_tokens": 0, "output_tokens": 0, "reasoning_tokens": 0}
        provider, model, warning = agent.provider, agent.model, None
        await self.send("stream_start", {"message_id": mid, "agent_id": agent.id})
        await self.send("status", {"message_id": mid, "phase": "thinking", "detail": f"{agent.name} is thinking…"})
        stopped = False
        try:
            for _round in range(MAX_TOOL_ROUNDS + 1):
                effort = str((agent.behavior_json or {}).get("reasoning_effort") or "default")
                if effort == "default":
                    effort = get_settings().default_reasoning_effort or "default"
                req = LLMRequest(provider=agent.provider, model=agent.model, messages=messages, temperature=agent.temperature,
                                 extra={} if effort == "default" else {"reasoning_effort": effort},
                                 max_tokens=effective_max_tokens(agent.max_tokens),
                                 metadata={"kind": "chat", "agent_name": agent.name, "agent_role": agent.role,
                                           "category": role_category(agent.role, (agent.behavior_json or {}).get("template_key", "")),
                                           "memory_keys": list(memory)})
                async with registry_factory()() as rdb:
                    req, warning = await prepare_request(rdb, self.user_id, req)
                provider, model = req.provider, req.model
                text = ""
                async for chunk in stream_with_retry(req):
                    if chunk.delta:
                        if not text:
                            await self.send("status", {"message_id": mid, "phase": "writing", "detail": f"{agent.name} is typing…",
                                                       "model": f"{req.provider}/{req.model}"})
                        text += chunk.delta
                        await self.send("token_stream", {"message_id": mid, "delta": chunk.delta})
                    if chunk.usage:
                        u = chunk.usage
                        total_tokens += u.total_tokens
                        total_cost += u.cost_usd
                        for k, v in (("input_tokens", u.prompt_tokens), ("cached_tokens", u.cached_tokens),
                                     ("cache_write_tokens", u.cache_write_tokens), ("output_tokens", u.completion_tokens),
                                     ("reasoning_tokens", u.reasoning_tokens)):
                            detail[k] += v
                match = TOOL_RE.match(text)
                if not match or _round == MAX_TOOL_ROUNDS:
                    break
                call = self._parse_tool(match.group(1))
                await self.send("stream_reset", {"message_id": mid})
                await self.send("status", {"message_id": mid, "phase": "tool", "detail": f"Using {call['name']}…", "call": call})
                result = await self._run_tool(agent, call, memory)
                tool_calls.append({**call, "result": result})
                await self.send("tool_call", {"message_id": mid, "call": tool_calls[-1]})
                messages += [{"role": "assistant", "content": text},
                             {"role": "user", "content": f"TOOL_RESULT {call['name']}\n{result}"}]
        except asyncio.CancelledError:
            stopped = True
        except LLMError as exc:
            await self.send("error", {"message": f"LLM error: {exc}", "message_id": mid})
            if not text:
                return
        meta = {"provider": provider, "model": model, "tokens": total_tokens, "cost_usd": round(total_cost, 8), "usage": detail,
                "tool_calls": tool_calls, "duration_ms": int((time.monotonic() - started) * 1000), "stopped": stopped}
        if warning:
            meta["warning"] = warning
        async with self.sf() as db:
            m = Message(id=mid, session_id=self.session_id, sender="agent", from_agent_id=agent.id, type="chat",
                        content=text or "_(stopped)_", meta_json=meta, read=True, created_at=utcnow())
            db.add(m)
            await db.commit()
        await self.send("stream_end", {"message": msg_out(m)})

    @staticmethod
    def _parse_tool(raw: str) -> dict[str, Any]:
        try:
            d = json.loads(raw)
            return {"name": str(d.get("name", "")), "args": d.get("args") or {}}
        except json.JSONDecodeError:
            return {"name": "invalid", "args": {}}

    async def _run_tool(self, agent: Agent, call: dict[str, Any], memory: dict[str, str]) -> str:
        name, args = call["name"], call["args"]
        tools = agent.tools_json or {}
        try:
            if name == "calculator" and tools.get("calculator", True):
                return basic.calculate(str(args.get("expression", "")))
            if name == "web_search" and tools.get("web_search"):
                return await basic.web_search(str(args.get("query", "")))
            if name == "remember":
                key, value = str(args.get("key", ""))[:200], str(args.get("value", ""))[:5000]
                if not key:
                    return "error: key required"
                async with self.sf() as db:
                    row = (await db.execute(select(AgentMemory).where(AgentMemory.agent_id == agent.id, AgentMemory.key == key))).scalar_one_or_none()
                    if row:
                        row.value = value
                    else:
                        db.add(AgentMemory(agent_id=agent.id, key=key, value=value))
                    await db.commit()
                memory[key] = value
                return f"saved '{key}'"
            return f"error: tool '{name}' is not available"
        except (ValueError, SyntaxError, ZeroDivisionError, TypeError) as exc:
            return f"error: {exc}"
