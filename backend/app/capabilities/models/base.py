"""Provider-agnostic LLM interface: the provider protocol. The contract types live in app.core.llm and are
re-exported here so provider modules keep their imports."""
from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any, Protocol

from app.core.llm import (  # noqa: F401 (re-exported)
    MODEL_MAX_OUTPUT_TOKENS,
    CODE_AGENT_MAX_TOKENS, DEFAULT_AGENT_MAX_TOKENS, LEGACY_MAX_TOKENS, LLMChunk, LLMError, LLMOutputTruncated, LLMRequest, LLMResult, MAX_AGENT_MAX_TOKENS, ToolCall, Usage, effective_max_tokens, output_cap, with_images,
)


class LLMProvider(Protocol):
    name: str

    def stream(self, req: LLMRequest) -> AsyncIterator[LLMChunk]: ...


def estimate_tokens(text: str) -> int:
    return max(1, len(text) // 4)


# ---------------------------------------------------------------- native function calling on Chat Completions
# The engine's tool loop speaks Responses-API items (function_call / function_call_output / message / reasoning).
# Chat Completions (Azure chat style, litellm) gets the same loop through these two translations, so no provider has to
# fall back to the JSON envelope (and its parse/repair failures) just because it lacks the Responses API.

def chat_tools(tools: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [{"type": "function", "function": {"name": t["name"], "description": t.get("description", ""), "parameters": t["parameters"]}}
            for t in tools]


def chat_continuation(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Responses-style continuation items → Chat Completions messages (assistant tool_calls + tool results)."""
    out: list[dict[str, Any]] = []
    for it in items:
        kind = it.get("type")
        if kind == "message" and it.get("role", "assistant") == "assistant":
            text = "".join(p.get("text", "") for p in it.get("content") or [] if isinstance(p, dict))
            out.append({"role": "assistant", "content": text})
        elif kind == "function_call":
            call = {"id": it.get("call_id") or it.get("id") or "", "type": "function",
                    "function": {"name": it.get("name", ""), "arguments": it.get("arguments") or "{}"}}
            last = out[-1] if out else None
            if last and last["role"] == "assistant":  # one assistant turn: its text and all of its calls
                last.setdefault("tool_calls", []).append(call)
                if not last.get("content"):
                    last["content"] = None
            else:
                out.append({"role": "assistant", "content": None, "tool_calls": [call]})
        elif kind == "function_call_output":
            out.append({"role": "tool", "tool_call_id": it.get("call_id", ""), "content": str(it.get("output", ""))})
    return out


class ChatToolAccumulator:
    """Collects streamed ``delta.tool_calls`` fragments (by index) into finished calls and replayable items."""

    def __init__(self) -> None:
        self.calls: dict[int, dict[str, str]] = {}

    def add(self, fragments: list[Any]) -> list[str]:
        """Feed one delta's tool_call fragments (dicts or objects); returns names of calls that just started."""
        started = []
        for f in fragments or []:
            get = (lambda k, f=f: f.get(k)) if isinstance(f, dict) else (lambda k, f=f: getattr(f, k, None))
            idx = int(get("index") or 0)
            fn = get("function") or {}
            fget = (lambda k, fn=fn: fn.get(k)) if isinstance(fn, dict) else (lambda k, fn=fn: getattr(fn, k, None))
            c = self.calls.setdefault(idx, {"id": "", "name": "", "arguments": ""})
            if get("id"):
                c["id"] = get("id")
            if fget("name"):
                if not c["name"]:
                    started.append(fget("name"))
                c["name"] += fget("name")
            if fget("arguments"):
                c["arguments"] += fget("arguments")
        return started

    def result(self, text: str) -> tuple[list[ToolCall], list[dict[str, Any]]]:
        calls, items = [], []
        if text:
            items.append({"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": text}]})
        for i in sorted(self.calls):
            c = self.calls[i]
            cid = c["id"] or f"call_{i}"
            calls.append(ToolCall(id=cid, name=c["name"], arguments=c["arguments"] or "{}"))
            items.append({"type": "function_call", "call_id": cid, "name": c["name"], "arguments": c["arguments"] or "{}"})
        return calls, items
