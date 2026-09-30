"""Provider selection, key resolution and retry-with-backoff streaming."""
from __future__ import annotations

import asyncio
import random
from collections.abc import AsyncIterator, Callable

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.logging import get_logger
from app.core.security import decrypt_secret
from app.llm.base import LLMChunk, LLMError, LLMProvider, LLMRequest
from app.llm.azure_v1 import AzureV1Provider, azure_v1_target
from app.llm.litellm_provider import LiteLLMProvider
from app.llm.mock_provider import MockProvider
from app.models import ProviderKey

log = get_logger("llm")

# Octopus is wired to a single real provider: Azure OpenAI (v1 API) with the gpt-6-luna deployment.
# "mock" is the offline Demo Mode model used when Azure isn't configured (or a run forces it).
DEFAULT_DEPLOYMENT = "gpt-6-luna"
PROVIDER_CATALOG: dict[str, dict] = {
    "mock": {"label": "Demo (mock, offline)", "needs_key": False, "models": ["mock/demo"]},
    "azure": {"label": "Azure OpenAI", "needs_key": True, "needs_base": True, "models": [DEFAULT_DEPLOYMENT]},
}
# Rows saved by earlier versions for other providers; the Azure credentials may live under "azure_ai" (Foundry card).
LEGACY_AZURE_ROWS = ("azure_ai",)

# Providers can be overridden (tests inject scripted providers).
_override: LLMProvider | None = None


def set_provider_override(provider: LLMProvider | None) -> None:
    global _override
    _override = provider


def get_provider(name: str, req: LLMRequest | None = None) -> LLMProvider:
    if _override is not None:
        return _override
    if name == "mock":
        return MockProvider()
    if name == "azure" and req is not None and azure_v1_target(req.base_url, req.extra) is not None:
        return AzureV1Provider()  # Azure OpenAI v1 API (Responses / Chat Completions), no api-version needed
    return LiteLLMProvider()


async def resolve_credentials(db: AsyncSession, user_id: str, provider: str) -> tuple[str | None, str | None, dict]:
    """Return (api_key, base_url, extra). Stored (encrypted) keys win over env keys. Never sent to the client.

    ``db`` must be a *registry* session.
    """
    s = get_settings()
    row = (await db.execute(select(ProviderKey).where(ProviderKey.user_id == user_id, ProviderKey.provider == provider))).scalar_one_or_none()
    if row is None and provider == "azure":  # credentials entered on the old "Azure AI Foundry" card
        for legacy in LEGACY_AZURE_ROWS:
            row = (await db.execute(select(ProviderKey).where(ProviderKey.user_id == user_id, ProviderKey.provider == legacy))).scalar_one_or_none()
            if row is not None:
                break
    key = decrypt_secret(row.encrypted_key) if row and row.encrypted_key else None
    base = (row.base_url if row else "") or None
    extra = dict(row.extra_json or {}) if row else {}
    env_keys = {"openai": s.openai_api_key, "anthropic": s.anthropic_api_key, "gemini": s.gemini_api_key,
                "azure": s.azure_api_key, "azure_ai": s.azure_ai_api_key}
    env_bases = {"azure": s.azure_api_base, "azure_ai": s.azure_ai_api_base, "ollama": s.ollama_base_url}
    key = key or env_keys.get(provider)
    base = base or env_bases.get(provider)
    if provider == "azure":
        extra.setdefault("api_version", s.azure_api_version)
    if provider in ("azure", "azure_ai") and not row and s.azure_use_entra:
        extra.setdefault("auth", "entra")
    return key, base, extra


def allowed_models(extra: dict) -> list[str]:
    """Deployment names the user configured, else the default deployment."""
    return [d for d in (extra.get("deployments") or []) if d] or [DEFAULT_DEPLOYMENT]


def is_configured(provider: str, key: str | None, base: str | None, extra: dict) -> bool:
    info = PROVIDER_CATALOG.get(provider, {})
    if info.get("needs_base") and not base:
        return False
    if extra.get("auth") == "entra":
        return True
    return bool(key) or not info.get("needs_key", True)


async def prepare_request(db: AsyncSession, user_id: str, req: LLMRequest) -> tuple[LLMRequest, str | None]:
    """Fill credentials (``db`` is a registry session). In demo mode, fall back to the mock provider when
    a provider isn't configured. Returns (request, warning)."""
    if req.provider == "mock":
        return req, None
    req.provider = "azure"  # the only real provider; agents saved with openai/anthropic/azure_ai/... are routed here too
    key, base, extra = await resolve_credentials(db, user_id, req.provider)
    if not is_configured(req.provider, key, base, extra):
        if get_settings().demo_mode:
            req.provider, req.model = "mock", "mock/demo"
            return req, "Azure OpenAI is not connected (Settings → Model); using the Demo Mode mock."
        raise LLMError(f"Provider '{req.provider}' is not configured", retryable=False)
    req.api_key, req.base_url = key, base
    req.extra = {**extra, **req.extra}
    allowed = allowed_models(extra)
    if req.model not in allowed:  # e.g. gpt-4.1-mini from older templates → the configured deployment
        req.model = allowed[0]
    if req.model in (extra.get("reasoning_models") or []):
        req.extra["reasoning_model"] = True
    return req, None


async def stream_with_retry(
    req: LLMRequest, *, retries: int = 3, base_delay: float = 0.8, on_retry: Callable[[int, str], None] | None = None,
) -> AsyncIterator[LLMChunk]:
    """Stream with exponential backoff. Retries only if the failure happened before any token was yielded."""
    provider = get_provider(req.provider, req)
    attempt = 0
    while True:
        yielded = False
        try:
            async for chunk in provider.stream(req):
                yielded = True
                yield chunk
            return
        except LLMError as exc:
            attempt += 1
            if yielded or not exc.retryable or attempt > retries:
                raise
            delay = base_delay * (2 ** (attempt - 1)) + random.uniform(0, 0.3)
            log.warning("llm_retry", attempt=attempt, delay=round(delay, 2), error=str(exc))
            if on_retry:
                on_retry(attempt, str(exc))
            await asyncio.sleep(delay)
