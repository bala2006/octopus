"""Provider-agnostic LLM interface."""
from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any, Protocol


@dataclass
class Usage:
    prompt_tokens: int = 0
    completion_tokens: int = 0
    cost_usd: float = 0.0

    @property
    def total_tokens(self) -> int:
        return self.prompt_tokens + self.completion_tokens


@dataclass
class LLMRequest:
    provider: str
    model: str
    messages: list[dict[str, str]]
    temperature: float = 0.4
    max_tokens: int = 2048
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


class LLMProvider(Protocol):
    name: str

    def stream(self, req: LLMRequest) -> AsyncIterator[LLMChunk]: ...


def estimate_tokens(text: str) -> int:
    return max(1, len(text) // 4)
