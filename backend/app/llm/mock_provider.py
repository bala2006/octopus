"""Offline mock provider for Demo Mode and tests.

- kind == "orchestrator": returns the JSON action envelope from the scripted role policies.
- kind == "chat": returns a role-aware Markdown reply (with a tool-call demo for arithmetic).
- kind == "summary": returns an extractive summary.
Streaming is simulated in small chunks so the UI behaves as with a real model.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
from collections.abc import AsyncIterator

from app.llm.base import LLMChunk, LLMRequest, Usage, estimate_tokens
from app.llm.demo_script import decide

MOCK_PRICE_PER_1K = 0.002  # fictional price so the cost meter is meaningful in demos

ROLE_TIPS: dict[str, list[str]] = {
    "ceo": ["Define the outcome and a single success metric", "Cut scope ruthlessly to hit the date", "Delegate, then inspect the results"],
    "pm": ["Write user stories with testable acceptance criteria", "Keep a prioritised backlog", "Say no to scope creep early"],
    "architect": ["Start from the data model and API contract", "Prefer boring, proven components", "Make security a review gate"],
    "frontend": ["Build accessible components first", "Keep state minimal and derived", "Test the empty/loading/error states"],
    "backend": ["Validate every input at the boundary", "Hash secrets, never log them", "Design idempotent endpoints"],
    "qa": ["Automate the acceptance criteria", "Test edge cases and permissions", "Report exact evidence, never assumptions"],
    "designer": ["Define tokens: color, type, spacing", "Design every state, not just the happy path", "Check contrast and focus order"],
    "devops": ["Make builds reproducible", "Run tests in the pipeline", "Ship small, observable releases"],
}


def _delay() -> float:
    try:
        return float(os.environ.get("MOCK_STREAM_DELAY", "0.012"))
    except ValueError:
        return 0.012


def _chat_reply(req: LLMRequest) -> str:
    meta = req.metadata
    name, role, cat = meta.get("agent_name", "Agent"), meta.get("agent_role", "Assistant"), meta.get("category", "generic")
    last = next((m["content"] for m in reversed(req.messages) if m["role"] == "user"), "")
    if last.startswith("TOOL_RESULT"):
        payload = last.split("\n", 1)[-1]
        return f"The calculator returned **{payload.strip()}**.\n\nLet me know if you want me to break the calculation down."
    expr = re.search(r"(?:calculate|compute|what is)\s+([-+*/().\d\s^%]+)", last, re.I)
    if expr and re.search(r"\d", expr.group(1)):
        return '```tool\n{"name": "calculator", "args": {"expression": "' + expr.group(1).strip().rstrip("?") + '"}}\n```'
    tips = ROLE_TIPS.get(cat, ["Clarify the goal", "Break it into small steps", "Verify the result"])
    quoted = "\n".join("> " + line for line in last.strip().splitlines()[:6]) or "> (empty message)"
    code = ""
    if re.search(r"\b(code|function|example|snippet|api)\b", last, re.I):
        code = ("\n\nHere's a minimal example:\n\n```python\n"
                "def create_todo(store: dict, title: str) -> dict:\n"
                "    title = title.strip()\n"
                "    if not title:\n"
                "        raise ValueError(\"title required\")\n"
                "    todo = {\"id\": len(store) + 1, \"title\": title, \"done\": False}\n"
                "    store[todo[\"id\"]] = todo\n"
                "    return todo\n```")
    memory = meta.get("memory_keys") or []
    mem = f"\n\n_I also remember: {', '.join(memory[:5])}._" if memory else ""
    return (f"Hi, I'm **{name}**, the {role}.\n\nYou wrote:\n{quoted}\n\n"
            f"From a {role} perspective, I'd approach it like this:\n\n"
            + "\n".join(f"{i}. {t}" for i, t in enumerate(tips, 1))
            + code + mem
            + "\n\n*(Demo Mode: this is a scripted reply. Add an API key in Settings to use a real model.)*")


class MockProvider:
    name = "mock"

    async def stream(self, req: LLMRequest) -> AsyncIterator[LLMChunk]:
        kind = req.metadata.get("kind", "chat")
        if kind == "orchestrator":
            text = json.dumps(decide(req.metadata["mock_context"]), indent=1)
        elif kind == "summary":
            text = req.metadata.get("fallback", "")
        elif "mock_script" in req.metadata:
            text = req.metadata["mock_script"]
        else:
            text = _chat_reply(req)
        delay = _delay()
        if delay:
            await asyncio.sleep(delay * 10)
        step = 24 if kind == "orchestrator" else 6
        for i in range(0, len(text), step):
            yield LLMChunk(delta=text[i:i + step])
            if delay:
                await asyncio.sleep(delay)
        prompt_tokens = estimate_tokens("".join(m.get("content", "") for m in req.messages))
        completion_tokens = estimate_tokens(text)
        yield LLMChunk(usage=Usage(prompt_tokens, completion_tokens, (prompt_tokens + completion_tokens) / 1000 * MOCK_PRICE_PER_1K))
