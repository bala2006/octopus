from __future__ import annotations

import json

from fastapi.responses import Response
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.deps import current_user
from app.core.security import decrypt_secret, encrypt_secret, mask_secret
from app.db.base import utcnow
from app.db.session import get_registry_db
from app.llm.base import LLMError, LLMRequest
from app.llm.router import LEGACY_AZURE_ROWS, PROVIDER_CATALOG, is_configured, prepare_request, resolve_credentials, stream_with_retry
from app.models import McpServer, ProviderKey, User
from app.schemas import (
    BrowserStatusOut, BrowserTestOut, FxRateOut,
    McpServerIn, McpServerOut, McpToolOut, ParsedFileOut, ProviderInfo, ProviderKeyIn, ProviderKeyOut, ProviderOptions, SettingsOut,
    TestProviderIn,
    TestProviderOut,
)
from app.services.files import UnsupportedFile, parse_file
from app.tools.mcp_client import McpConfig, McpError, list_tools

router = APIRouter(tags=["settings"])


@router.get("/settings", response_model=SettingsOut)
async def get_settings_view(db: AsyncSession = Depends(get_registry_db), user: User = Depends(current_user)) -> SettingsOut:
    s = get_settings()
    await migrate_legacy_azure(db, user.id)
    rows = (await db.execute(select(ProviderKey).where(ProviderKey.user_id == user.id, ProviderKey.provider.in_(list(PROVIDER_CATALOG))))).scalars().all()
    keys = [key_out(r) for r in rows]
    providers = []
    for name, info in PROVIDER_CATALOG.items():
        key, base, extra = await resolve_credentials(db, user.id, name)
        models = list(extra.get("deployments") or []) or info["models"]
        providers.append(ProviderInfo(provider=name, label=info["label"], models=models, configured=is_configured(name, key, base, extra),
                                      needs_key=info["needs_key"], needs_base=info.get("needs_base", False)))
    return SettingsOut(demo_mode=s.demo_mode, single_user_mode=s.single_user_mode, default_provider=s.default_provider,
                       default_model=s.default_model, sandbox_mode=s.sandbox_mode, providers=providers, keys=keys)


async def migrate_legacy_azure(db: AsyncSession, user_id: str) -> None:
    """Earlier versions had an "Azure AI Foundry" card; credentials pasted there become the Azure OpenAI provider."""
    rows = (await db.execute(select(ProviderKey).where(ProviderKey.user_id == user_id))).scalars().all()
    if any(r.provider == "azure" for r in rows):
        return
    legacy = next((r for r in rows if r.provider in LEGACY_AZURE_ROWS and (r.encrypted_key or r.base_url)), None)
    if legacy is not None:
        legacy.provider = "azure"
        legacy.updated_at = utcnow()
        await db.commit()


def key_out(r: ProviderKey) -> ProviderKeyOut:
    plain = decrypt_secret(r.encrypted_key) if r.encrypted_key else ""
    return ProviderKeyOut(provider=r.provider, masked_key=mask_secret(plain) if plain else "", base_url=r.base_url,
                          options=ProviderOptions(**(r.extra_json or {})), updated_at=r.updated_at)


@router.put("/settings/providers", response_model=ProviderKeyOut)
async def put_key(body: ProviderKeyIn, db: AsyncSession = Depends(get_registry_db), user: User = Depends(current_user)) -> ProviderKeyOut:
    row = (await db.execute(select(ProviderKey).where(ProviderKey.user_id == user.id, ProviderKey.provider == body.provider))).scalar_one_or_none()
    if row is None:
        row = ProviderKey(user_id=user.id, provider=body.provider, encrypted_key="")
        db.add(row)
    if body.api_key:
        row.encrypted_key = encrypt_secret(body.api_key.strip())
    base = body.base_url.strip().rstrip("/")
    if base and not base.startswith(("http://", "https://")):
        raise HTTPException(422, "Endpoint must start with http:// or https://")
    row.base_url = base
    opts = body.options.model_dump()
    opts["deployments"] = [d.strip() for d in opts["deployments"] if d.strip()][:50]
    opts["reasoning_models"] = [d.strip() for d in opts["reasoning_models"] if d.strip()][:50]
    row.extra_json = opts
    row.updated_at = utcnow()
    await db.commit()
    return key_out(row)


@router.delete("/settings/providers/{provider}", status_code=204, response_class=Response, response_model=None)
async def delete_key(provider: str, db: AsyncSession = Depends(get_registry_db), user: User = Depends(current_user)) -> None:
    row = (await db.execute(select(ProviderKey).where(ProviderKey.user_id == user.id, ProviderKey.provider == provider))).scalar_one_or_none()
    if row:
        await db.delete(row)
        await db.commit()


@router.post("/settings/providers/test", response_model=TestProviderOut)
async def test_provider(body: TestProviderIn, db: AsyncSession = Depends(get_registry_db), user: User = Depends(current_user)) -> TestProviderOut:
    # generous budget: reasoning deployments (gpt-5+, o-series) spend output tokens on thinking before "pong"
    req = LLMRequest(provider=body.provider, model=body.model, max_tokens=1024, temperature=0,
                     messages=[{"role": "user", "content": "Reply with the single word: pong"}], metadata={"kind": "chat", "mock_script": "pong"})
    import time

    t0 = time.monotonic()
    try:
        req, warn = await prepare_request(db, user.id, req)
        if warn and req.provider == "mock" and body.provider != "mock":  # not connected: fell back to the demo mock
            return TestProviderOut(ok=False, detail=warn)
        if req.model in (req.extra.get("reasoning_models") or []):
            req.extra["reasoning_model"] = True
        out = ""
        async for ch in stream_with_retry(req, retries=0):
            out += ch.delta
        return TestProviderOut(ok=True, detail=f"Model replied: {out.strip()[:80]!r}" + (f". Note: {warn}" if warn else ""),
                               latency_ms=int((time.monotonic() - t0) * 1000))
    except LLMError as exc:
        return TestProviderOut(ok=False, detail=str(exc)[:500], latency_ms=int((time.monotonic() - t0) * 1000))


# ---------------- currency display (costs are stored in USD; the UI converts with real rates)
@router.get("/settings/fx", response_model=FxRateOut)
async def fx_rate(currency: str = "USD", user: User = Depends(current_user)) -> FxRateOut:
    import httpx

    from app.services.fx import usd_to

    try:
        r = await usd_to(currency)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    except httpx.HTTPError as exc:
        raise HTTPException(503, f"Exchange rates are unavailable right now ({type(exc).__name__}); costs are shown in USD") from exc
    return FxRateOut(currency=r.currency, rate=r.rate, date=r.date, source=r.source, stale=r.stale)


# ---------------- built-in browser (Playwright MCP managed by Octopus)
def _browser_status() -> BrowserStatusOut:
    import shutil

    from app.services.browser import browser

    s = get_settings()
    return BrowserStatusOut(enabled=s.browser_enabled, status=browser.status, error=browser.error, browser=browser._browser_arg(),
                            package=s.playwright_mcp_package, tools=[t["name"] for t in browser.tool_list()], node=bool(shutil.which("npx")))


@router.get("/settings/browser", response_model=BrowserStatusOut)
async def browser_status(user: User = Depends(current_user)) -> BrowserStatusOut:
    return _browser_status()


@router.post("/settings/browser/test", response_model=BrowserTestOut)
async def browser_test(user: User = Depends(current_user)) -> BrowserTestOut:
    """Start the browser if needed, open a test page in a throwaway tab and read it back."""
    import time

    from app.services.browser import browser

    t0 = time.monotonic()
    page = "data:text/html,<title>Octopus</title><h1>Browser ready</h1>"
    ok, out = await browser.call("settings-test", user.id, "browser_navigate", {"url": page})
    if ok:
        ok, out = await browser.call("settings-test", user.id, "browser_snapshot", {})
        ok = ok and "Browser ready" in out
    await browser.close_run("settings-test")
    ms = int((time.monotonic() - t0) * 1000)
    return BrowserTestOut(ok=ok, detail="Opened a page and read it back" if ok else out[:400], latency_ms=ms)


# ---------------- MCP servers
def mcp_out(r: McpServer) -> McpServerOut:
    env_keys: list[str] = []
    if r.env_encrypted:
        raw = decrypt_secret(r.env_encrypted)
        env_keys = sorted(json.loads(raw).keys()) if raw else []
    return McpServerOut(id=r.id, name=r.name, transport=r.transport, command=r.command, args=list(r.args_json or []), url=r.url,
                        env_keys=env_keys, enabled=r.enabled, tools=[McpToolOut(**t) for t in (r.tools_json or [])],
                        last_error=r.last_error, updated_at=r.updated_at)


async def _owned_mcp(server_id: str, db: AsyncSession, user: User) -> McpServer:
    r = await db.get(McpServer, server_id)
    if r is None or r.user_id != user.id:
        raise HTTPException(404, "MCP server not found")
    return r


async def _refresh(r: McpServer) -> None:
    try:
        r.tools_json = await list_tools(McpConfig.from_row(r))
        r.last_error = ""
    except McpError as exc:
        r.last_error = str(exc)[:1000]


@router.get("/mcp-servers", response_model=list[McpServerOut])
async def list_mcp(db: AsyncSession = Depends(get_registry_db), user: User = Depends(current_user)) -> list[McpServerOut]:
    rows = (await db.execute(select(McpServer).where(McpServer.user_id == user.id).order_by(McpServer.name))).scalars().all()
    return [mcp_out(r) for r in rows]


def _apply_mcp(r: McpServer, body: McpServerIn, keep_env: bool) -> None:
    if body.transport == "stdio" and not body.command:
        raise HTTPException(422, "stdio servers need a command")
    if body.transport == "http" and not body.url.startswith(("http://", "https://")):
        raise HTTPException(422, "http servers need an http(s) URL")
    r.name, r.transport, r.command, r.args_json, r.url, r.enabled = body.name.strip(), body.transport, body.command.strip(), body.args, body.url.strip(), body.enabled
    if body.env or not keep_env:
        r.env_encrypted = encrypt_secret(json.dumps(body.env)) if body.env else ""


@router.post("/mcp-servers", response_model=McpServerOut, status_code=201)
async def create_mcp(body: McpServerIn, db: AsyncSession = Depends(get_registry_db), user: User = Depends(current_user)) -> McpServerOut:
    if (await db.execute(select(McpServer).where(McpServer.user_id == user.id, McpServer.name == body.name.strip()))).scalar_one_or_none():
        raise HTTPException(409, "An MCP server with that name already exists")
    r = McpServer(user_id=user.id)
    _apply_mcp(r, body, keep_env=False)
    await _refresh(r)
    db.add(r)
    await db.commit()
    await db.refresh(r)
    return mcp_out(r)


@router.put("/mcp-servers/{server_id}", response_model=McpServerOut)
async def update_mcp(server_id: str, body: McpServerIn, db: AsyncSession = Depends(get_registry_db), user: User = Depends(current_user)) -> McpServerOut:
    r = await _owned_mcp(server_id, db, user)
    _apply_mcp(r, body, keep_env=True)
    await _refresh(r)
    await db.commit()
    await db.refresh(r)
    return mcp_out(r)


@router.post("/mcp-servers/{server_id}/refresh", response_model=McpServerOut)
async def refresh_mcp(server_id: str, db: AsyncSession = Depends(get_registry_db), user: User = Depends(current_user)) -> McpServerOut:
    r = await _owned_mcp(server_id, db, user)
    await _refresh(r)
    await db.commit()
    await db.refresh(r)
    return mcp_out(r)


@router.delete("/mcp-servers/{server_id}", status_code=204, response_class=Response, response_model=None)
async def delete_mcp(server_id: str, db: AsyncSession = Depends(get_registry_db), user: User = Depends(current_user)) -> None:
    r = await _owned_mcp(server_id, db, user)
    await db.delete(r)
    await db.commit()


# ---------------- attachments
@router.post("/files/parse", response_model=ParsedFileOut)
async def parse_upload(file: UploadFile = File(...), user: User = Depends(current_user)) -> ParsedFileOut:
    data = await file.read(10 * 1024 * 1024 + 1)
    if len(data) > 10 * 1024 * 1024:
        raise HTTPException(413, "File too large (max 10MB)")
    try:
        text, truncated = parse_file(file.filename or "file", data)
    except UnsupportedFile as exc:
        raise HTTPException(415, str(exc)) from exc
    return ParsedFileOut(filename=file.filename or "file", chars=len(text), text=text, truncated=truncated)
