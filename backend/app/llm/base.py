"""Provider-agnostic LLM interface."""
from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any, Protocol


@dataclass
class Usage:
    prompt_tokens: int = 0  # all input tokens (includes cached + cache-write tokens), as reported by the provider
    completion_tokens: int = 0  # all output tokens (includes reasoning tokens)
    cost_usd: float = 0.0
    cached_tokens: int = 0  # input tokens served from the prompt cache
    cache_write_tokens: int = 0  # input tokens written to the prompt cache
    reasoning_tokens: int = 0  # subset of completion_tokens spent on reasoning
    cost_breakdown: dict[str, float] = field(default_factory=dict)  # input / cached_input / cache_write / output (USD)
    priced: bool = False  # True when real per-token rates were applied
    estimated: bool = False  # True when the provider reported no usage and tokens were estimated

    @property
    def total_tokens(self) -> int:
        return self.prompt_tokens + self.completion_tokens

    def as_dict(self) -> dict[str, Any]:
        return {"input_tokens": self.prompt_tokens, "output_tokens": self.completion_tokens, "cached_tokens": self.cached_tokens,
                "cache_write_tokens": self.cache_write_tokens, "reasoning_tokens": self.reasoning_tokens,
                "total_tokens": self.total_tokens, "cost_usd": self.cost_usd, "cost_breakdown": dict(self.cost_breakdown),
                "estimated": self.estimated}


# Output budget per reply. Azure documents 128,000 max output tokens for the GPT-6 family (gpt-6-luna, gpt-6-sol,
# gpt-6-astra, gpt-6.1-sol) and that this cap covers reasoning AND visible output; hitting it returns an incomplete reply
# with no answer. Output is billed per generated token, so the model maximum costs nothing extra: agents default to it.
# https://learn.microsoft.com/en-us/azure/ai-services/openai/overview (Max Output Tokens column)
MODEL_MAX_OUTPUT_TOKENS: dict[str, int] = {"gpt-6-luna": 128_000, "gpt-6-sol": 128_000, "gpt-6-astra": 128_000, "gpt-6.1-sol": 128_000,
                                           "gpt-5.6-luna": 128_000, "gpt-5.6-sol": 128_000, "gpt-5.6-terra": 128_000}
MAX_AGENT_MAX_TOKENS = 128_000
DEFAULT_AGENT_MAX_TOKENS = MAX_AGENT_MAX_TOKENS
CODE_AGENT_MAX_TOKENS = MAX_AGENT_MAX_TOKENS
# Answer budgets saved by earlier versions (2048 default, 8192/16384 defaults, 32768/64000 automatic escalations):
# treated as "not chosen by the user" and upgraded to the model maximum.
LEGACY_MAX_TOKENS = {2048, 8192, 16384, 32768, 64000}


def output_cap(model: str, requested: int) -> int:
    """The max_output_tokens to send: the agent's budget, never above what the deployment's model allows."""
    limit = MODEL_MAX_OUTPUT_TOKENS.get((model or "").lower(), MAX_AGENT_MAX_TOKENS)
    return max(1, min(requested, limit))


def effective_max_tokens(value: int | None) -> int:
    return DEFAULT_AGENT_MAX_TOKENS if not value or value in LEGACY_MAX_TOKENS else int(value)


@dataclass
class LLMRequest:
    provider: str
    model: str
    messages: list[dict[str, str]]
    temperature: float = 0.4
    max_tokens: int = DEFAULT_AGENT_MAX_TOKENS
    api_key: str | None = None
    base_url: str | None = None
    json_mode: bool = False
    extra: dict[str, Any] = field(default_factory=dict)  # provider options, e.g. Azure api_version / Entra auth
    metadata: dict[str, Any] = field(default_factory=dict)  # consumed by the mock provider only
    # Native function calling: tool definitions ({name, description, parameters: JSON schema}) and, for the follow-up calls
    # of a tool loop, the provider-native items to append after `messages` (previous output items + tool outputs).
    tools: list[dict[str, Any]] = field(default_factory=list)
    continuation: list[dict[str, Any]] = field(default_factory=list)
    # Images ({mime, data: base64}) shown with the first user message (vision input); providers add them in their own format.
    images: list[dict[str, str]] = field(default_factory=list)


def with_images(messages: list[dict[str, Any]], images: list[dict[str, str]], style: str) -> list[dict[str, Any]]:
    """``messages`` with ``images`` attached to the first user message, as content parts.

    ``style`` "responses" (Azure/OpenAI Responses API: input_text / input_image) or "chat" (Chat Completions and litellm:
    text / image_url). Messages stay plain strings everywhere else in Octopus; only the request body carries parts."""
    if not images:
        return messages
    out = list(messages)
    i = next((n for n, m in enumerate(out) if m.get("role") == "user" and isinstance(m.get("content"), str)), None)
    if i is None:
        return messages
    urls = [f"data:{im.get('mime') or 'image/png'};base64,{im.get('data', '')}" for im in images if im.get("data")]
    text = out[i]["content"]
    if style == "responses":
        parts: list[dict[str, Any]] = [{"type": "input_text", "text": text}] + [{"type": "input_image", "image_url": u} for u in urls]
    else:
        parts = [{"type": "text", "text": text}] + [{"type": "image_url", "image_url": {"url": u}} for u in urls]
    out[i] = {**out[i], "content": parts}
    return out


@dataclass
class ToolCall:
    id: str  # call id to answer with a tool output
    name: str
    arguments: str  # JSON text


@dataclass
class LLMChunk:
    delta: str = ""
    usage: Usage | None = None  # set on the final chunk
    thinking: str = ""  # streamed reasoning summary (what the model is thinking about), shown live in the UI
    tool_started: str = ""  # a function call began (its name): for live status
    tool_delta: str = ""  # streamed function-call arguments: for live status only, not part of the answer text
    tool_calls: list[ToolCall] | None = None  # final chunk of a tool-enabled call
    items: list[dict[str, Any]] | None = None  # the response's output items, to replay in the next call of the loop


@dataclass
class LLMResult:
    text: str = ""
    thinking: str = ""  # reasoning summary of this call
    tool_calls: list[ToolCall] = field(default_factory=list)
    items: list[dict[str, Any]] = field(default_factory=list)


class LLMError(Exception):
    def __init__(self, message: str, *, retryable: bool = True) -> None:
        super().__init__(message)
        self.retryable = retryable


class LLMOutputTruncated(LLMError):
    """The reply hit the output-token limit before it was complete (any text produced so far is unusable as-is).

    Not retried blindly by ``stream_with_retry``: the caller decides whether to retry with a larger budget."""

    def __init__(self, message: str, *, partial: str = "") -> None:
        super().__init__(message, retryable=False)
        self.partial = partial


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
