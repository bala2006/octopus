"""One OpenCode invocation per owned Octopus agent turn, using the common executor."""
from __future__ import annotations

import asyncio
import contextlib
import json
from typing import TYPE_CHECKING

from app.plugins.providers.base import Usage
from app.sdk import actions as A
from app.kernel.runtime.context import build_turn_prompts
from app.sdk.evidence import redact_evidence
from app.sdk.execution_contracts import ACTIVE_ATTEMPT
from app.plugins.mcp.worker_bridge import WorkerBridge
from app.plugins.skills.contracts import content_hash
from app.plugins.providers.opencode import OpenCodeError, OpenCodeSession

if TYPE_CHECKING:
    from app.kernel.runtime.context import AgentSpec
    from app.kernel.runtime.engine import RunRuntime


def _prompt_blocks(rt: RunRuntime, agent: AgentSpec, inbox: list[dict], observations: list[dict], bridge: WorkerBridge,
                   memory_context: str) -> list[dict]:
    provider, model = rt.model_for(agent)
    system, user = build_turn_prompts(rt, agent, {message["id"] for message in inbox}, observations,
                                      native=True, memory_context=memory_context)
    system += (f"\n\n## Octopus execution boundary\nYou are {agent.name}, model `{model}` through `{provider}`. "
        f"Act only through the `{bridge.name}` MCP server. It exposes your Octopus-granted tools and applies the current "
        "assignment policy. Do not use OpenCode's own shell, filesystem, subagent, skill, external MCP, or question tools. "
        "Use use_skill for pinned Octopus skills. Do not start independent agents. "
        "After a peer question, wait, finish, or user question ends the invocation, return immediately. "
        "Only the accountable lead can finish the whole chat. Specialists finish only their own work. "
        "Native tool calls do not count as Octopus verification evidence. Never claim a check that you did not execute.")
    blocks = [{"type": "text", "text": system, "annotations": {"audience": ["assistant"]}}, {"type": "text", "text": user}]
    for attachment in rt.attachments:
        if attachment.get("kind") != "image":
            blocks.append({"type": "text", "text": f"Attached file: {attachment.get('filename')}\n{attachment.get('text', '')}"})
    blocks.extend({"type": "image", "data": image["data"], "mimeType": image["mime"]} for image in rt.goal_images())
    return blocks


async def opencode_turn(rt: RunRuntime, agent: AgentSpec, inbox: list[dict], observations: list[dict]) -> None:
    context = ACTIVE_ATTEMPT.get()
    if context is None or context.assignment.owner != agent.id:
        raise OpenCodeError("OpenCode needs an owned current agent attempt")
    rt.execution.assert_current_attempt()
    if context.assignment.policy.mode != "trusted_host":
        raise OpenCodeError("This OpenCode runner does not provide restricted OS isolation")
    root = rt.execution.worker_root(agent.id)
    provider, model = rt.model_for(agent)
    effort = rt.effort_for(agent) or "default"
    memory_context = await rt.execution.scoped_context(agent.id)
    signature = content_hash({"root": str(root.resolve()), "revision": context.assignment.revision, "model": model, "effort": effort,
                              "policy": context.assignment.policy.model_dump(mode="json"), "skills": context.assignment.skill_hashes,
                              "guidance": rt.pinned_guidance.get("content_hash"), "role": agent.to_dict(),
                              "memory_access": content_hash(memory_context)})
    previous = rt.worker_sessions.get(agent.id) or {}
    if previous.get("signature") == signature and previous.get("state") == "recovery_required":
        raise OpenCodeError("Previous OpenCode prompt acceptance or side effects are uncertain. Reconcile it and start a revised request; it will not be resent automatically.")
    prior_session = previous.get("session_id") if previous.get("signature") == signature else None
    accumulated_cost = float(previous.get("cost_usd", 0)) if prior_session else 0.0
    session_cost = accumulated_cost
    text: list[str] = []
    tool_names: dict[str, str] = {}
    started_tools: set[str] = set()
    completed_tools: set[str] = set()
    native_violation = asyncio.Event()

    async def permission(params: dict) -> dict:
        rt.execution.assert_current_attempt()
        call = params.get("toolCall") or {}
        approved = bridge.grants_acp_call(call) and call.get("kind") not in {"execute", "edit", "delete", "move"}
        options = params.get("options") or []
        choice = next((item for item in options if item.get("kind") == ("allow_once" if approved else "reject_once")), None)
        return {"outcome": {"outcome": "selected", "optionId": choice["optionId"]}} if choice else {"outcome": {"outcome": "cancelled"}}

    async def update_event(event: dict) -> None:
        nonlocal session_cost
        rt.execution.assert_current_attempt()
        kind = event.get("sessionUpdate")
        if kind in {"agent_message_chunk", "agent_thought_chunk"}:
            block = event.get("content") or {}
            delta = block.get("text", "") if block.get("type") == "text" else ""
            if delta:
                if kind == "agent_message_chunk":
                    text.append(delta)
                await rt.emit("token_stream" if kind == "agent_message_chunk" else "thinking_stream",
                              {"agent_id": agent.id, "delta": redact_evidence(delta), "turn_no": rt.turn_no})
        elif kind in {"tool_call", "tool_call_update"}:
            cid = event.get("toolCallId") or "unknown"
            title = tool_names.setdefault(cid, str(event.get("title") or event.get("kind") or "OpenCode tool"))
            if kind == "tool_call" and cid not in started_tools:
                started_tools.add(cid)
                await rt.emit("tool_call", {"call_id": "acp-" + cid, "agent_id": agent.id, "tool": "OpenCode: " + redact_evidence(title),
                    "args": {"source": "acp", "brokered": False}, "turn_no": rt.turn_no})
            if event.get("status") in {"completed", "failed"} and cid not in completed_tools:
                completed_tools.add(cid)
                await rt.emit("tool_result", {"call_id": "acp-" + cid, "agent_id": agent.id, "tool": "OpenCode: " + redact_evidence(title),
                    "ok": event.get("status") == "completed", "output": redact_evidence(json.dumps(event.get("content") or [], ensure_ascii=False))})
            if event.get("kind") in {"execute", "edit", "delete", "move"}:
                native_violation.set()
        elif kind == "usage_update":
            cost = event.get("cost") or {}
            if cost.get("currency") == "USD":
                session_cost = float(cost.get("amount", session_cost))

    async with WorkerBridge(rt, agent) as bridge:
        async with OpenCodeSession(root, update_event, permission) as session:
            await session.open(prior_session, model, effort, False, mcp_servers=[bridge.config()])
            rt.worker_sessions[agent.id] = {"session_id": session.session_id, "signature": signature, "state": "running", "cost_usd": accumulated_cost}
            await rt.save()
            blocks = _prompt_blocks(rt, agent, inbox, observations, bridge, memory_context)
            prompt = asyncio.create_task(session.prompt(blocks), name=f"opencode-turn-{agent.id}")
            cancelled = False
            try:
                while not prompt.done():
                    await asyncio.wait({prompt}, timeout=.1)
                    rt.execution.assert_current_attempt()
                    if native_violation.is_set():
                        raise OpenCodeError("OpenCode used a native mutation tool outside the Octopus broker. Review possible side effects before retrying.")
                    if rt.paused:
                        raise OpenCodeError("OpenCode invocation interrupted by pause. Reconcile possible side effects before resuming this assignment.")
                    if rt.active_now() > rt.budget.timeout_s:
                        raise OpenCodeError("OpenCode exceeded this request's active-time budget")
                    if bridge.yielded.is_set() and not cancelled and not prompt.done():
                        await session.send({"method": "session/cancel", "params": {"sessionId": session.session_id}})
                        cancelled = True
                result = await prompt
                rt.execution.assert_current_attempt()
                if native_violation.is_set():
                    raise OpenCodeError("OpenCode native mutation needs side-effect reconciliation")
                if result.get("stopReason") == "cancelled" and not bridge.yielded.is_set():
                    raise OpenCodeError("OpenCode cancelled the invocation. No interrupted prompt was automatically resent.")
                usage = result.get("usage") or {}
                input_tokens = int(usage.get("inputTokens", 0))
                rt.add_usage(agent.id, Usage(prompt_tokens=input_tokens,
                    completion_tokens=max(0, int(usage.get("totalTokens", input_tokens + int(usage.get("outputTokens", 0)))) - input_tokens),
                    reasoning_tokens=int(usage.get("thoughtTokens", 0)), cost_usd=max(0, session_cost - accumulated_cost)))
                await rt.usage_event()
                rt.worker_sessions[agent.id].update(state="ready", cost_usd=session_cost, broker_calls=bridge.calls)
                answer = "".join(text).strip()
                if not bridge.yielded.is_set() and answer:
                    await rt.execute(agent, A.Finish(action="finish", summary=redact_evidence(answer)))
                    if context.assignment.lead != agent.id or rt._bounced_finish == agent.id:
                        await rt.post_message(sender="agent", from_id=agent.id, to_id=None, type_="answer", content=redact_evidence(answer), deliver=False)
                elif answer and bridge.yield_reason != "finish":
                    await rt.post_message(sender="agent", from_id=agent.id, to_id=None, type_="answer", content=redact_evidence(answer), deliver=False)
                elif not bridge.yielded.is_set():
                    rt.notice(agent.id, "OpenCode returned no answer or terminal action. Inspect the task state before continuing.", activate=False)
                await rt.save()
            except BaseException:
                rt.worker_sessions[agent.id].update(state="recovery_required", broker_calls=bridge.calls)
                with contextlib.suppress(Exception):
                    await asyncio.shield(rt.save())
                if not prompt.done():
                    prompt.cancel()
                    await asyncio.gather(prompt, return_exceptions=True)
                raise
            finally:
                if not prompt.done():
                    prompt.cancel()
                    await asyncio.gather(prompt, return_exceptions=True)
