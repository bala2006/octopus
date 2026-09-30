"""Native client for the Azure OpenAI **v1 API** (``https://<resource>/openai/v1/``).

Works with every endpoint shape the Azure / Foundry portals hand out, e.g.

* ``https://<res>.openai.azure.com``
* ``https://<res>.cognitiveservices.azure.com/openai/v1``
* ``https://<res>.services.ai.azure.com/openai/v1/responses``  → Responses API
* ``https://<res>.services.ai.azure.com/openai/v1/chat/completions`` → Chat Completions API

The model is the *deployment name* (e.g. ``gpt-6-luna``). No ``api-version`` is needed. Parameters a deployment
rejects (``temperature`` on reasoning models, ...) are dropped automatically and remembered.
"""
from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from typing import Any

import httpx

from app.llm.base import LLMChunk, LLMError, LLMRequest, Usage, estimate_tokens

ApiStyle = str  # "responses" | "chat"
_PROTECTED = {"model", "input", "messages", "stream"}
# Reasoning deployments (gpt-6-luna reasons at "medium" effort by default) spend output tokens on thinking before they
# answer; max_output_tokens covers both, so the agent's answer budget gets this much extra room.
REASONING_HEADROOM = 4096
# (base, deployment) → parameters the deployment rejected once; never sent again in this process
_dropped: dict[tuple[str, str], set[str]] = {}


def azure_v1_target(base_url: str | None, extra: dict[str, Any] | None = None) -> tuple[str, ApiStyle] | None:
    """Return ``(v1_base_url, api_style)`` or ``None`` when the legacy (``api-version`` + litellm) path should be used."""
    extra = extra or {}
    opt = (extra.get("api_style") or "auto").lower()
    if not base_url or opt == "legacy":
        return None
    u = base_url.strip().split("?", 1)[0].split("#", 1)[0].rstrip("/")
    if "/openai/deployments/" in u:  # classic per-deployment URL → legacy client
        return None
    style = "responses"
    if u.endswith("/responses"):
        u = u[: -len("/responses")]
    elif u.endswith("/chat/completions"):
        u, style = u[: -len("/chat/completions")], "chat"
    if u.endswith("/openai/v1"):
        pass
    elif u.endswith("/openai"):
        u += "/v1"
    elif u.endswith("/models"):  # Foundry inference URL pasted into the Azure OpenAI card
        u = u[: -len("/models")] + "/openai/v1"
    else:
        u += "/openai/v1"
    if opt in ("responses", "chat"):
        style = opt
    return u, style


def legacy_api_base(base_url: str) -> str:
    """Resource root for litellm's ``azure/`` client (strips ``/openai/...`` paths and query strings)."""
    u = base_url.strip().split("?", 1)[0].rstrip("/")
    return u.split("/openai", 1)[0]


def _body(req: LLMRequest, style: ApiStyle, drop: set[str]) -> dict[str, Any]:
    reasoning = bool(req.extra.get("reasoning_model"))
    if style == "responses":
        body: dict[str, Any] = {
            "model": req.model, "stream": True, "max_output_tokens": req.max_tokens + REASONING_HEADROOM, "store": False,
            "input": [{"role": m.get("role", "user"), "content": m.get("content", "")} for m in req.messages],
        }
        if req.json_mode:
            body["text"] = {"format": {"type": "json_object"}}
    else:
        body = {
            "model": req.model, "stream": True, "messages": req.messages, "max_completion_tokens": req.max_tokens + REASONING_HEADROOM,
            "stream_options": {"include_usage": True},
        }
        if req.json_mode:
            body["response_format"] = {"type": "json_object"}
    if not reasoning:
        body["temperature"] = req.temperature
    for k in drop:
        body.pop(k, None)
    return body


def _rejected_param(status: int, text: str, body: dict[str, Any]) -> str | None:
    """If a 400 is caused by one unsupported parameter, return its name so the call can be retried without it."""
    if status != 400:
        return None
    try:
        err = json.loads(text).get("error") or {}
    except (ValueError, AttributeError):
        err = {}
    param = err.get("param") if isinstance(err, dict) else None
    msg = (err.get("message") if isinstance(err, dict) else None) or text
    if isinstance(param, str) and param in body and param not in _PROTECTED:
        return param
    low = msg.lower()
    if any(w in low for w in ("unsupported", "not supported", "does not support", "unrecognized", "unknown parameter")):
        for k in body:
            if k not in _PROTECTED and any(f"{q}{k}{q}" in msg for q in ("'", '"', "`")):
                return k
        for k in ("temperature", "max_output_tokens", "max_completion_tokens", "store", "stream_options"):
            if k in body and k in low:
                return k
    return None


def _error_message(status: int, text: str) -> str:
    try:
        err = json.loads(text).get("error") or {}
        msg = err.get("message") or text
        code = err.get("code")
    except (ValueError, AttributeError):
        msg, code = text, None
    hint = {
        401: "check the API key (Keys and Endpoint page of the resource)",
        403: "the key / identity has no access to this resource",
        404: "deployment not found: the model must be the exact deployment name (e.g. gpt-6-luna) on this resource",
        429: "rate limited",
    }.get(status)
    parts = [f"Azure OpenAI {status}"]
    if code:
        parts.append(f"[{code}]")
    parts.append(str(msg)[:500])
    if hint:
        parts.append(f"({hint})")
    return " ".join(parts)


async def _auth_headers(req: LLMRequest) -> dict[str, str]:
    if req.extra.get("auth") == "entra":
        from app.llm.litellm_provider import entra_token_provider

        token = await asyncio.to_thread(entra_token_provider())
        return {"Authorization": f"Bearer {token}"}
    if not req.api_key:
        raise LLMError("Azure OpenAI API key is missing (Settings → Model)", retryable=False)
    return {"api-key": req.api_key}


class AzureV1Provider:
    name = "azure_v1"

    def __init__(self, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self._transport = transport  # tests inject httpx.MockTransport

    async def stream(self, req: LLMRequest) -> AsyncIterator[LLMChunk]:
        target = azure_v1_target(req.base_url, req.extra)
        if target is None:
            raise LLMError("Azure endpoint is not a v1 endpoint", retryable=False)
        base, style = target
        url = f"{base}/{'responses' if style == 'responses' else 'chat/completions'}"
        headers = {**(await _auth_headers(req)), "Content-Type": "application/json", "Accept": "text/event-stream"}
        cache_key = (base, req.model)
        text_parts: list[str] = []
        usage: Usage | None = None
        timeout = httpx.Timeout(connect=20, read=300, write=60, pool=20)
        async with httpx.AsyncClient(timeout=timeout, transport=self._transport) as client:
            for _ in range(4):  # original call + up to 3 "drop the rejected parameter" retries
                body = _body(req, style, _dropped.get(cache_key, set()))
                try:
                    async with client.stream("POST", url, headers=headers, json=body) as resp:
                        if resp.status_code >= 400:
                            text = (await resp.aread()).decode("utf-8", "replace")
                            bad = _rejected_param(resp.status_code, text, body)
                            if bad:
                                _dropped.setdefault(cache_key, set()).add(bad)
                                continue
                            s = resp.status_code
                            raise LLMError(_error_message(s, text), retryable=s in (408, 409, 429) or s >= 500)
                        async for chunk in self._events(resp, style, text_parts):
                            if chunk.usage is not None:
                                usage = chunk.usage
                            else:
                                yield chunk
                    break
                except httpx.HTTPError as exc:
                    raise LLMError(f"Azure OpenAI connection error: {type(exc).__name__}: {exc}", retryable=True) from exc
            else:
                raise LLMError("Azure OpenAI rejected the request parameters", retryable=False)
        if usage is None:
            prompt_text = "".join(str(m.get("content", "")) for m in req.messages)
            usage = Usage(prompt_tokens=estimate_tokens(prompt_text), completion_tokens=estimate_tokens("".join(text_parts)))
        from app.llm.litellm_provider import compute_cost

        usage.cost_usd = compute_cost(req.extra.get("pricing_model") or f"azure/{req.model}", usage.prompt_tokens, usage.completion_tokens)
        yield LLMChunk(usage=usage)

    async def _events(self, resp: httpx.Response, style: ApiStyle, text_parts: list[str]) -> AsyncIterator[LLMChunk]:
        skip_items: set[str] = set()  # output items that aren't the final answer (phase = "commentary")
        async for line in resp.aiter_lines():
            if not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if not data or data == "[DONE]":
                continue
            try:
                ev = json.loads(data)
            except ValueError:
                continue
            if style == "chat":
                for ch in ev.get("choices") or []:
                    content = (ch.get("delta") or {}).get("content")
                    if content:
                        text_parts.append(content)
                        yield LLMChunk(delta=content)
                u = ev.get("usage")
                if u and u.get("prompt_tokens") is not None:
                    yield LLMChunk(usage=Usage(prompt_tokens=u.get("prompt_tokens") or 0, completion_tokens=u.get("completion_tokens") or 0))
                continue
            kind = ev.get("type", "")
            if kind == "response.output_item.added":
                item = ev.get("item") or {}
                if item.get("phase") == "commentary" and item.get("id"):
                    skip_items.add(item["id"])
            elif kind == "response.output_text.delta":
                if ev.get("item_id") in skip_items:
                    continue
                delta = ev.get("delta") or ""
                if delta:
                    text_parts.append(delta)
                    yield LLMChunk(delta=delta)
            elif kind in ("response.completed", "response.incomplete"):
                r = ev.get("response") or {}
                if kind == "response.incomplete" and not text_parts:
                    reason = (r.get("incomplete_details") or {}).get("reason", "incomplete")
                    raise LLMError(f"Azure OpenAI returned no text ({reason}). For reasoning deployments raise the agent's Max tokens.",
                                   retryable=False)
                u = r.get("usage") or {}
                yield LLMChunk(usage=Usage(prompt_tokens=u.get("input_tokens") or 0, completion_tokens=u.get("output_tokens") or 0))
            elif kind == "response.failed":
                err = (ev.get("response") or {}).get("error") or {}
                raise LLMError(f"Azure OpenAI: {err.get('message') or 'response failed'}", retryable=False)
            elif kind == "error":
                msg = ev.get("message") or (ev.get("error") or {}).get("message") or data[:300]
                raise LLMError(f"Azure OpenAI: {msg}", retryable=False)
