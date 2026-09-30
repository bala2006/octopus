"""Minimal Model Context Protocol client used to expose external MCP tools to agents.

Each call opens a short-lived session (connect → initialize → call → close), which keeps the
runtime stateless and robust to server crashes. Supports stdio and streamable-HTTP transports.
"""
from __future__ import annotations

import asyncio
import json
from contextlib import AsyncExitStack
from dataclasses import dataclass, field
from typing import Any

from app.core.config import get_settings
from app.core.security import decrypt_secret
from app.models import McpServer


@dataclass
class McpConfig:
    id: str
    name: str
    transport: str
    command: str = ""
    args: list[str] = field(default_factory=list)
    url: str = ""
    env: dict[str, str] = field(default_factory=dict)
    tools: list[dict[str, Any]] = field(default_factory=list)

    @classmethod
    def from_row(cls, row: McpServer) -> McpConfig:
        env: dict[str, str] = {}
        if row.env_encrypted:
            raw = decrypt_secret(row.env_encrypted)
            if raw:
                env = json.loads(raw)
        return cls(id=row.id, name=row.name, transport=row.transport, command=row.command, args=list(row.args_json or []),
                   url=row.url, env=env, tools=list(row.tools_json or []))


class McpError(RuntimeError):
    pass


async def _open(stack: AsyncExitStack, cfg: McpConfig):  # type: ignore[no-untyped-def]
    from mcp import ClientSession

    if cfg.transport == "http":
        from mcp.client.streamable_http import streamablehttp_client

        if not cfg.url.startswith(("http://", "https://")):
            raise McpError("HTTP MCP server needs an http(s) URL")
        read, write, _ = await stack.enter_async_context(streamablehttp_client(cfg.url, headers=cfg.env or None))
    else:
        if not get_settings().mcp_allow_stdio:
            raise McpError("stdio MCP servers are disabled on this deployment (MCP_ALLOW_STDIO=false)")
        from mcp.client.stdio import StdioServerParameters, stdio_client
        import os

        if not cfg.command:
            raise McpError("stdio MCP server needs a command")
        params = StdioServerParameters(command=cfg.command, args=cfg.args, env={"PATH": os.environ.get("PATH", ""), **cfg.env})
        read, write = await stack.enter_async_context(stdio_client(params))
    session = await stack.enter_async_context(ClientSession(read, write))
    await session.initialize()
    return session


async def list_tools(cfg: McpConfig, timeout: float = 30) -> list[dict[str, Any]]:
    async def go() -> list[dict[str, Any]]:
        async with AsyncExitStack() as stack:
            session = await _open(stack, cfg)
            res = await session.list_tools()
            return [{"name": t.name, "description": (t.description or "")[:500], "input_schema": t.inputSchema or {}} for t in res.tools]

    try:
        return await asyncio.wait_for(go(), timeout)
    except asyncio.TimeoutError as exc:
        raise McpError(f"Timed out connecting to MCP server '{cfg.name}'") from exc
    except McpError:
        raise
    except Exception as exc:
        raise McpError(f"{type(exc).__name__}: {exc}") from exc


async def call_tool(cfg: McpConfig, tool: str, args: dict[str, Any], timeout: float = 60) -> tuple[bool, str]:
    async def go() -> tuple[bool, str]:
        async with AsyncExitStack() as stack:
            session = await _open(stack, cfg)
            res = await session.call_tool(tool, args)
            parts: list[str] = []
            for c in res.content:
                text = getattr(c, "text", None)
                parts.append(text if text is not None else f"[{getattr(c, 'type', 'content')}]")
            if getattr(res, "structuredContent", None) and not parts:
                parts.append(json.dumps(res.structuredContent)[:8000])
            return (not res.isError), "\n".join(parts)[:12000]

    try:
        return await asyncio.wait_for(go(), timeout)
    except asyncio.TimeoutError:
        return False, f"MCP tool '{tool}' timed out after {timeout}s"
    except Exception as exc:
        return False, f"MCP error ({type(exc).__name__}): {exc}"
