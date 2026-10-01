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

from app.llm.base import LLMChunk, LLMError, LLMOutputTruncated, LLMRequest, ToolCall, Usage, estimate_tokens, output_cap, with_images, chat_continuation, chat_tools, ChatToolAccumulator

ApiStyle = str  # "responses" | "chat"
_PROTECTED = {"model", "input", "messages", "stream", "tools", "tool_choice"}  # never auto-dropped
# Reasoning deployments (gpt-6-luna reasons at "medium" effort by default) spend output tokens on thinking before they
# answer; max_output_tokens covers both, so the agent's answer budget gets extra room. A fixed allowance meant that raising
# the effort silently shrank the space left for the answer, so the headroom scales with the requested effort.
REASONING_HEADROOM = 4096  # default effort ("medium" / unspecified)
HEADROOM_BY_EFFORT = {"none": 0, "minimal": 1024, "low": 2048, "medium": 4096, "high": 8192, "xhigh": 16384, "max": 24576}


def reasoning_headroom(req: LLMRequest) -> int:
    return HEADROOM_BY_EFFORT.get(str(req.extra.get("reasoning_effort") or "").lower(), REASONING_HEADROOM)
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
            "model": req.model, "stream": True, "max_output_tokens": output_cap(req.model, req.max_tokens + reasoning_headroom(req)), "store": False,
            "input": [{"role": m.get("role", "user"), "content": m.get("content", "")} for m in with_images(req.messages, req.images, "responses")]
                     + list(req.continuation),
        }
        if req.tools:  # native function calling: the model emits function_call items instead of a JSON envelope
            body["tools"] = [{"type": "function", "name": t["name"], "description": t.get("description", ""), "parameters": t["parameters"]}
                             for t in req.tools]
            body["tool_choice"] = "auto"
            body["parallel_tool_calls"] = True
            if reasoning or req.extra.get("reasoning_effort"):
                # stateless (store=false): encrypted reasoning comes back so it can be replayed between tool calls
                body["include"] = ["reasoning.encrypted_content"]
        elif req.json_mode:
            body["text"] = {"format": {"type": "json_object"}}
    else:
        body = {
            "model": req.model, "stream": True, "messages": with_images(req.messages, req.images, "chat") + chat_continuation(req.continuation),
            "max_completion_tokens": output_cap(req.model, req.max_tokens + reasoning_headroom(req)),
            "stream_options": {"include_usage": True},
        }
        if req.tools:  # native function calling on Chat Completions too: no JSON envelope to parse or repair
            body["tools"] = chat_tools(req.tools)
            body["tool_choice"] = "auto"
            body["parallel_tool_calls"] = True
        elif req.json_mode:
            body["response_format"] = {"type": "json_object"}
    effort = req.extra.get("reasoning_effort")
    if style == "responses" and (effort or reasoning) and effort != "none" and "reasoning.summary" not in drop:
        # the model's reasoning itself is never returned; its summary is, and that's what the UI shows as "thinking"
        body["reasoning"] = {"summary": "auto"}
    if effort:  # none | low | medium | high | xhigh | max
        if style == "responses":
            body.setdefault("reasoning", {})["effort"] = effort
        else:
            body["reasoning_effort"] = effort
    if not reasoning:
        body["temperature"] = req.temperature
    if req.metadata.get("cache_key"):  # routes calls that share a prompt prefix (one agent's turns) to the same prompt cache
        body["prompt_cache_key"] = str(req.metadata["cache_key"])[:64]
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
    # an unsupported reasoning *summary* must not cost the reasoning effort: drop just the nested field
    if isinstance(body.get("reasoning"), dict) and "summary" in body["reasoning"] and (
            param == "reasoning.summary" or ("summary" in msg.lower() and "reasoning" in msg.lower())):
        return "reasoning.summary"
    if isinstance(param, str) and param in body and param not in _PROTECTED:
        return param
    low = msg.lower()
    if any(w in low for w in ("unsupported", "not supported", "does not support", "unrecognized", "unknown parameter")):
        for k in body:
            if k not in _PROTECTED and any(f"{q}{k}{q}" in msg for q in ("'", '"', "`")):
                return k
        for k in ("temperature", "reasoning", "reasoning_effort", "max_output_tokens", "max_completion_tokens", "store", "stream_options",
                  "prompt_cache_key"):
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


def usage_from_responses(u: dict[str, Any]) -> Usage:
    """Responses API usage → Usage (input_tokens includes cached + cache-write tokens; output includes reasoning)."""
    i, o = u.get("input_tokens_details") or {}, u.get("output_tokens_details") or {}
    return Usage(prompt_tokens=u.get("input_tokens") or 0, completion_tokens=u.get("output_tokens") or 0,
                 cached_tokens=i.get("cached_tokens") or 0, cache_write_tokens=i.get("cache_write_tokens") or 0,
                 reasoning_tokens=o.get("reasoning_tokens") or 0)


class AzureV1Provider:
    name = "azure_v1"

    @staticmethod
    def supports_native_tools(req: LLMRequest) -> bool:
        return supports_native_tools(req)

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
        out_items: dict[int, dict[str, Any]] = {}  # output_index -> finished output item (responses API)
        chat_calls = ChatToolAccumulator()  # chat completions: streamed tool_call fragments
        usage: Usage | None = None
        truncated: LLMOutputTruncated | None = None
        timeout = httpx.Timeout(connect=20, read=360, write=60, pool=20)  # the engine's idle timeout (300s) fires first, with a clearer message
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
                        try:
                            async for chunk in self._events(resp, style, text_parts, out_items, chat_calls):
                                if chunk.usage is not None:
                                    usage = chunk.usage
                                else:
                                    yield chunk
                        except LLMOutputTruncated as exc:  # still bill the tokens, then report the truncation
                            truncated = exc
                    break
                except httpx.HTTPError as exc:
                    raise LLMError(f"Azure OpenAI connection error: {type(exc).__name__}: {exc}", retryable=True) from exc
            else:
                raise LLMError("Azure OpenAI rejected the request parameters", retryable=False)
        if usage is None:
            prompt_text = "".join(str(m.get("content", "")) for m in req.messages)
            usage = Usage(prompt_tokens=estimate_tokens(prompt_text), completion_tokens=estimate_tokens("".join(text_parts)), estimated=True)
        from app.llm.pricing import apply

        apply(usage, req.model, req.extra)  # exact Azure usage × deployment rates (Settings → Model → Pricing)
        yield LLMChunk(usage=usage)
        if req.tools and style == "chat":
            calls, items = chat_calls.result("".join(text_parts))
            yield LLMChunk(tool_calls=calls, items=items)
        elif req.tools:
            items = [out_items[i] for i in sorted(out_items)]
            calls = [ToolCall(id=it.get("call_id") or it.get("id") or "", name=it.get("name", ""), arguments=it.get("arguments") or "{}")
                     for it in items if it.get("type") == "function_call"]
            yield LLMChunk(tool_calls=calls, items=items)
        if truncated is not None:
            raise truncated

    async def _events(self, resp: httpx.Response, style: ApiStyle, text_parts: list[str],
                      out_items: dict[int, dict[str, Any]] | None = None,
                      chat_calls: ChatToolAccumulator | None = None) -> AsyncIterator[LLMChunk]:
        skip_items: set[str] = set()  # output items that aren't the final answer (phase = "commentary")
        length_cut = False  # chat completions: finish_reason == "length"
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
                    frags = (ch.get("delta") or {}).get("tool_calls")
                    if frags and chat_calls is not None:
                        for name in chat_calls.add(frags):
                            yield LLMChunk(tool_started=name)
                        args = "".join(((f.get("function") or {}).get("arguments") or "") for f in frags)
                        if args:
                            yield LLMChunk(tool_delta=args)
                    if ch.get("finish_reason") == "length":
                        length_cut = True
                u = ev.get("usage")
                if u and u.get("prompt_tokens") is not None:
                    pd, cd = u.get("prompt_tokens_details") or {}, u.get("completion_tokens_details") or {}
                    yield LLMChunk(usage=Usage(prompt_tokens=u.get("prompt_tokens") or 0, completion_tokens=u.get("completion_tokens") or 0,
                                               cached_tokens=pd.get("cached_tokens") or 0, cache_write_tokens=pd.get("cache_write_tokens") or 0,
                                               reasoning_tokens=cd.get("reasoning_tokens") or 0))
                continue
            kind = ev.get("type", "")
            if kind == "response.output_item.added":
                item = ev.get("item") or {}
                if item.get("phase") == "commentary" and item.get("id"):
                    skip_items.add(item["id"])
                if item.get("type") == "function_call":
                    yield LLMChunk(tool_started=item.get("name", ""))
            elif kind == "response.reasoning_summary_text.delta":
                if ev.get("delta"):
                    yield LLMChunk(thinking=ev["delta"])
            elif kind == "response.reasoning_summary_part.done":
                yield LLMChunk(thinking="\n\n")  # paragraph break between summary parts
            elif kind == "response.function_call_arguments.delta":
                if ev.get("delta"):
                    yield LLMChunk(tool_delta=ev["delta"])
            elif kind == "response.output_item.done":
                if out_items is not None and ev.get("item"):
                    out_items[int(ev.get("output_index", len(out_items)))] = ev["item"]
            elif kind == "response.output_text.delta":
                if ev.get("item_id") in skip_items:
                    continue
                delta = ev.get("delta") or ""
                if delta:
                    text_parts.append(delta)
                    yield LLMChunk(delta=delta)
            elif kind in ("response.completed", "response.incomplete"):
                r = ev.get("response") or {}
                if kind == "response.incomplete":
                    reason = (r.get("incomplete_details") or {}).get("reason", "incomplete")
                    if reason == "max_output_tokens":  # a cut-off reply is never usable: report it so the caller can raise the budget
                        yield LLMChunk(usage=usage_from_responses(r.get("usage") or {}))
                        raise LLMOutputTruncated(
                            f"Azure OpenAI stopped at the output limit (max_output_tokens) after {len(''.join(text_parts))} characters"
                            + ("" if text_parts else " without any answer text (reasoning used the whole budget)"),
                            partial="".join(text_parts))
                    if not text_parts:
                        raise LLMError(f"Azure OpenAI returned no text ({reason}).", retryable=False)
                yield LLMChunk(usage=usage_from_responses(r.get("usage") or {}))
            elif kind == "response.failed":
                err = (ev.get("response") or {}).get("error") or {}
                raise LLMError(f"Azure OpenAI: {err.get('message') or 'response failed'}", retryable=False)
            elif kind == "error":
                msg = ev.get("message") or (ev.get("error") or {}).get("message") or data[:300]
                raise LLMError(f"Azure OpenAI: {msg}", retryable=False)
        if length_cut:
            raise LLMOutputTruncated(f"Azure OpenAI stopped at the output limit (finish_reason=length) after "
                                     f"{len(''.join(text_parts))} characters", partial="".join(text_parts))


def supports_native_tools(req: LLMRequest) -> bool:
    """Native function calling: always on the Responses API (the default for v1 endpoints). Chat Completions only allows
    function calling with reasoning disabled on gpt-6 models, so there it is used whenever reasoning is off; only a
    reasoning deployment on a chat-only endpoint keeps the JSON envelope."""
    target = azure_v1_target(req.base_url, req.extra)
    if not target:
        return False
    if target[1] == "responses":
        return True
    return not req.extra.get("reasoning_model") and req.extra.get("reasoning_effort") in (None, "", "none")
