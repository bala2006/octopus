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


# Answer budget per agent turn. 2048 was too small for any single file of real size (a JSON write_file envelope
# for a ~300-line HTML game is already ~6k tokens); code-writing roles get CODE_AGENT_MAX_TOKENS.
DEFAULT_AGENT_MAX_TOKENS = 8192
CODE_AGENT_MAX_TOKENS = 16384
MAX_AGENT_MAX_TOKENS = 64000


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


@dataclass
class LLMChunk:
    delta: str = ""
    usage: Usage | None = None  # set on the final chunk


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
