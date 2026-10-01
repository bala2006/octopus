"""LiteLLM-backed provider: Azure OpenAI, Azure AI Foundry, OpenAI, Anthropic, Gemini, Ollama, ..."""
from __future__ import annotations

from collections.abc import AsyncIterator
from functools import lru_cache
from typing import Any

from app.llm.base import LLMChunk, LLMError, LLMOutputTruncated, LLMRequest, Usage, estimate_tokens, output_cap, with_images
from app.llm.azure_v1 import legacy_api_base

PREFIX = {
    "azure": "azure/", "azure_ai": "azure_ai/", "openai": "openai/", "anthropic": "anthropic/", "gemini": "gemini/",
    "ollama": "ollama_chat/", "openrouter": "openrouter/", "groq": "groq/", "mistral": "mistral/",
}
DEFAULT_AZURE_API_VERSION = "2024-10-21"
AZURE_SCOPE = "https://cognitiveservices.azure.com/.default"


def litellm_model_name(provider: str, model: str) -> str:
    prefix = PREFIX.get(provider, "")
    if not prefix or model.startswith(prefix) or (provider == "ollama" and model.startswith("ollama")):
        return model
    return prefix + model


@lru_cache(maxsize=1)
def entra_token_provider():  # type: ignore[no-untyped-def]
    """Microsoft Entra ID token provider (uses `az login`, managed identity, env credentials, ...)."""
    try:
        from azure.identity import DefaultAzureCredential, get_bearer_token_provider
    except ImportError as exc:  # pragma: no cover
        raise LLMError("azure-identity is not installed", retryable=False) from exc
    return get_bearer_token_provider(DefaultAzureCredential(exclude_interactive_browser_credential=True), AZURE_SCOPE)


def build_kwargs(req: LLMRequest) -> dict[str, Any]:
    model = litellm_model_name(req.provider, req.model)
    kwargs: dict[str, Any] = {
        "model": model, "messages": with_images(req.messages, req.images, "chat"), "temperature": req.temperature,
        "max_tokens": output_cap(req.model, req.max_tokens), "stream": True, "stream_options": {"include_usage": True},
    }
    if req.base_url:
        kwargs["api_base"] = legacy_api_base(req.base_url) if req.provider == "azure" else req.base_url
    auth = req.extra.get("auth", "key")
    if req.provider in ("azure", "azure_ai"):
        if req.provider == "azure":
            kwargs["api_version"] = req.extra.get("api_version") or DEFAULT_AZURE_API_VERSION
        if auth == "entra":
            if req.provider == "azure":
                kwargs["azure_ad_token_provider"] = entra_token_provider()
            else:
                kwargs["api_key"] = entra_token_provider()()  # bearer token for Foundry model inference endpoints
        elif req.api_key:
            kwargs["api_key"] = req.api_key
        if req.extra.get("reasoning_model"):  # o-series / gpt-5 style deployments reject temperature & max_tokens
            kwargs.pop("temperature", None)
            kwargs["max_completion_tokens"] = kwargs.pop("max_tokens")
    elif req.api_key:
        kwargs["api_key"] = req.api_key
    if req.extra.get("reasoning_effort"):
        kwargs["reasoning_effort"] = req.extra["reasoning_effort"]
    if req.json_mode and req.provider in {"openai", "azure", "groq", "mistral", "openrouter"}:
        kwargs["response_format"] = {"type": "json_object"}
    return kwargs


def compute_cost(model: str, prompt_tokens: int, completion_tokens: int) -> float:
    try:
        import litellm

        p, c = litellm.cost_per_token(model=model, prompt_tokens=prompt_tokens, completion_tokens=completion_tokens)
        return float(p + c)
    except Exception:  # unknown pricing (Azure deployment names, local models)
        return 0.0


class LiteLLMProvider:
    name = "litellm"

    async def stream(self, req: LLMRequest) -> AsyncIterator[LLMChunk]:
        try:
            import litellm
        except ImportError as exc:  # pragma: no cover
            raise LLMError("litellm is not installed", retryable=False) from exc
        litellm.drop_params = True  # tolerate params unsupported by a given deployment
        kwargs = build_kwargs(req)
        text_parts: list[str] = []
        usage: Usage | None = None
        length_cut = False
        try:
            response = await litellm.acompletion(**kwargs)
            async for chunk in response:  # type: ignore[union-attr]
                choices = getattr(chunk, "choices", None) or []
                if choices:
                    delta = getattr(choices[0], "delta", None)
                    content = getattr(delta, "content", None) if delta else None
                    if content:
                        text_parts.append(content)
                        yield LLMChunk(delta=content)
                    if getattr(choices[0], "finish_reason", None) == "length":
                        length_cut = True
                u = getattr(chunk, "usage", None)
                if u and getattr(u, "prompt_tokens", None) is not None:
                    usage = Usage(prompt_tokens=u.prompt_tokens or 0, completion_tokens=u.completion_tokens or 0)
        except LLMError:
            raise
        except Exception as exc:
            status = getattr(exc, "status_code", None)
            retryable = status is None or status in (408, 409, 429) or (isinstance(status, int) and status >= 500)
            if status in (400, 401, 403, 404):
                retryable = False
            raise LLMError(f"{type(exc).__name__}: {str(exc)[:600]}", retryable=retryable) from exc

        if usage is None:
            prompt_text = "".join(m.get("content", "") for m in req.messages)
            usage = Usage(prompt_tokens=estimate_tokens(prompt_text), completion_tokens=estimate_tokens("".join(text_parts)))
        from app.llm.pricing import apply, rates_for

        if rates_for(req.model, req.extra):
            apply(usage, req.model, req.extra)
        else:
            usage.cost_usd = compute_cost(req.extra.get("pricing_model") or kwargs["model"], usage.prompt_tokens, usage.completion_tokens)
        yield LLMChunk(usage=usage)
        if length_cut:
            raise LLMOutputTruncated(f"The model stopped at the output limit (finish_reason=length) after {len(''.join(text_parts))} characters",
                                     partial="".join(text_parts))
