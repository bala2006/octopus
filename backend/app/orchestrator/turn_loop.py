"""One agent turn: prompt build, the model call, the native tool loop or JSON envelope, and tool-round compaction."""

from __future__ import annotations

import asyncio
import json
from sqlalchemy import update
from typing import TYPE_CHECKING, Any

from app.core.config import get_settings
from app.core.run_manager import StopRun
from app.db.session import registry_factory
from app.llm.base import LLMError, LLMOutputTruncated, LLMRequest, ToolCall
from app.llm.router import prepare_request, get_provider
from app.models import Message
from app.orchestrator import actions as A, tools as T
from app.orchestrator.context import AgentSpec, build_turn_prompts, TOOL_RESULT_CHARS, clip
from app.orchestrator.execution import ACTIVE_ATTEMPT

if TYPE_CHECKING:  # pragma: no cover
    from app.orchestrator.engine import RunRuntime


def head_tail(text: str, limit: int) -> str:
    """Keep both ends of a long text: a malformed reply usually breaks at the end."""
    if len(text) <= limit:
        return text
    half = limit // 2
    return text[:half] + f"\n…[{len(text) - limit:,} characters omitted]…\n" + text[-half:]


ROUND_WARNINGS = {5, 1}


KEEP_FULL_ROUNDS = 3  # the latest tool rounds are replayed verbatim; older ones are shortened


OLD_ROUND_CHARS = 1500


COMPACT_MARK = "; re-read the file or re-run the tool if you need it again]"


def _shorten(text: str, limit: int, what: str) -> str:
    if len(text) <= limit or text.endswith(COMPACT_MARK):
        return text
    return f"{text[:limit]}\n…[{what} shortened: {len(text):,} chars, shown in full in an earlier round{COMPACT_MARK}"


def compact_rounds(items: list[dict[str, Any]], rounds: list[int]) -> list[dict[str, Any]]:
    """Keep a long tool loop from re-sending everything every round.

    Each round replays the whole turn so far (up to max_tool_rounds rounds; one read_file result can be 60k characters,
    one write_file call carries the whole file). Rounds older than the last KEEP_FULL_ROUNDS keep their structure,
    reasoning items and call ids, but long tool outputs and long string arguments are shortened. Shortening is idempotent."""
    if len(rounds) <= KEEP_FULL_ROUNDS:
        return items
    cut = rounds[-KEEP_FULL_ROUNDS]
    out = []
    for i, item in enumerate(items):
        if i >= cut:
            out.append(item)
        elif item.get("type") == "function_call_output" and isinstance(item.get("output"), str):
            out.append({**item, "output": _shorten(item["output"], OLD_ROUND_CHARS, "tool output")})
        elif item.get("type") == "function_call" and len(item.get("arguments") or "") > OLD_ROUND_CHARS:
            try:
                args = json.loads(item["arguments"])
            except (TypeError, ValueError):
                out.append(item)
                continue
            if isinstance(args, dict):
                args = {k: _shorten(v, OLD_ROUND_CHARS, k) if isinstance(v, str) else v for k, v in args.items()}
                item = {**item, "arguments": json.dumps(args, ensure_ascii=False)}
            out.append(item)
        else:
            out.append(item)
    return out


def effort_for(rt: RunRuntime, agent: AgentSpec) -> str | None:
    """Run override wins, then the agent's setting; None = let the model use its default."""
    scoped = rt.budget.model_scope == "team" or agent.id == rt.lead_agent_id
    e = rt.budget.reasoning_effort if scoped and rt.budget.reasoning_effort != "default" else str(agent.behavior.get("reasoning_effort") or "default")
    if e == "default":
        if rt.model_for(agent)[0] == "opencode":
            return None  # Auto means the installed worker's advertised default.
        e = get_settings().default_reasoning_effort or "default"
    return None if e in ("default", "") else e


async def turn(rt: RunRuntime, aid: str) -> None:
    await rt.execution.owned_turn(aid)


async def _turn(rt: RunRuntime, aid: str) -> None:
    rt.execution.assert_current_attempt()
    agent = rt.agents[aid]
    inbox_ids = [mid for _, mid in rt.mailbox.pop(aid, [])]
    obs = [o for _, o in rt.observations.pop(aid, [])]
    rt.self_turns[aid] = 0 if inbox_ids else rt.self_turns[aid] + 1
    if inbox_ids:
        async with rt.db() as db:
            await db.execute(update(Message).where(Message.id.in_(inbox_ids)).values(read=True))
            await db.commit()
    max_auto = int(agent.behavior.get("max_autonomous_turns", 12))
    if rt.agent_turns[aid] >= max_auto:  # checked BEFORE counting: a skipped turn costs no budget and is visible
        await rt.emit("turn_skipped", {"agent_id": aid, "inbox": inbox_ids, "reason": "max_autonomous_turns", "limit": max_auto})
        await rt.emit("error", {"message": f"{agent.name} exceeded max autonomous turns ({max_auto}); its pending work was dropped.",
                                  "agent_id": aid, "kind": "limit"})
        rt.done_agents.add(aid)
        await rt.set_agent_status(aid, "done")
        return
    rt.turn_no += 1
    rt.agent_turns[aid] += 1
    rt.start_turn_metrics(aid)
    await rt.emit("turn_started", {"agent_id": aid, "turn_no": rt.turn_no, "inbox": inbox_ids})
    await rt.set_agent_status(aid, "thinking", f"Reading {len(inbox_ids)} new message(s)…" if inbox_ids else "Reviewing results…")
    inbox_set = set(inbox_ids)
    inbox = [m for m in rt.history if m["id"] in inbox_set]
    if rt.model_for(agent)[0] == "opencode":
        from app.orchestrator.opencode import opencode_turn
        await opencode_turn(rt, agent, inbox, obs)
        await rt.end_turn(aid)
        return
    try:
        req, native = await rt.build_request(agent, inbox_set, obs)
        if native:
            await rt.native_turn(agent, req, exclude=rt.wf_tool_exclusions(agent))
            await rt.end_turn(aid)
            return
        text = await rt.call_llm_escalating(agent, req)
        parsed = A.parse_envelope(text)
        if not parsed.ok:
            req.messages += [{"role": "assistant", "content": head_tail(text, 6000)},
                             {"role": "user", "content": "Your reply was not valid per the response format ("
                              + "; ".join(parsed.errors) + "). Reply again with ONLY the JSON object."}]
            text = await rt.call_llm_escalating(agent, req)
            parsed = A.parse_envelope(text)
    except LLMOutputTruncated as exc:
        await rt.set_agent_status(aid, "error")
        await rt.emit("error", {"message": f"{agent.name}: reply cut off at the output limit ({req.max_tokens} tokens): {exc}",
                                  "agent_id": aid, "kind": "llm"})
        rt.notice(aid, f"Your previous reply was cut off at the output limit ({req.max_tokens:,} tokens, reasoning included) and "
                         "nothing in it was applied. write_file with \"mode\":\"append\" can build a file across turns.", activate=True)
        await rt.requeue(aid, inbox_ids)
        return
    except (LLMError, asyncio.TimeoutError) as exc:
        if context := ACTIVE_ATTEMPT.get():
            context.error = str(exc)[:2000]
        await rt.set_agent_status(aid, "error")
        await rt.emit("error", {"message": f"{agent.name}: LLM call failed: {exc}", "agent_id": aid, "kind": "llm"})
        back = await rt.requeue(aid, inbox_ids)
        rt.notice(aid, f"Your previous turn failed due to a model error ({exc})."
                         + (" The messages from that turn are shown again under NEW messages." if back else ""), activate=bool(inbox_ids))
        return
    if not parsed.ok:
        await rt.set_agent_status(aid, "error")
        await rt.emit("error", {"message": f"{agent.name} produced an invalid response: {'; '.join(parsed.errors)}", "agent_id": aid, "kind": "parse"})
        await rt.requeue(aid, inbox_ids)
        rt.notice(aid, "Your last reply could not be parsed: " + "; ".join(parsed.errors) + ". Reply with the JSON object only.", activate=True)
        return
    if parsed.thought:
        await rt.emit("thought", {"agent_id": aid, "text": parsed.thought, "turn_no": rt.turn_no})
    for err in parsed.errors:
        rt.notice(aid, f"Ignored invalid action: {err}", activate=False)
    if parsed.errors:  # the agent may believe it acted: make the drop visible in the run, not just in its next prompt
        await rt.emit("error", {"message": f"{agent.name}: ignored {len(parsed.errors)} invalid action(s): {'; '.join(parsed.errors)[:400]}",
                                  "agent_id": aid, "kind": "parse"})
    for action in parsed.actions:
        if rt.stop_requested:
            raise StopRun()
        await rt.execute(agent, action)
        if aid in rt.waiting_peers or action.action in ("delegate", "wait", "request_user_input", "finish"):
            if not (action.action == "finish" and rt._bounced_finish == aid):
                break
        if rt.finished_summary is not None:
            break
    await rt.end_turn(aid)


def model_for(rt: RunRuntime, agent: AgentSpec) -> tuple[str, str]:
    if rt.budget.model is not None and (rt.budget.model_scope == "team" or agent.id == rt.lead_agent_id):
        return rt.budget.model.provider, rt.budget.model.model
    return agent.provider, agent.model


async def build_request(rt: RunRuntime, agent: AgentSpec, inbox_ids: set[str], obs: list[dict[str, Any]], *, extra: str = ""
                        ) -> tuple[LLMRequest, bool]:
    """Resolve the model, then build the prompts (native tools or JSON envelope) for one agent turn."""
    aid = agent.id
    inbox = [m for m in rt.history if m["id"] in inbox_ids]
    provider, model = rt.model_for(agent)
    req = LLMRequest(provider=provider, model=model, temperature=agent.temperature, max_tokens=agent.max_tokens,
                     extra={"reasoning_effort": e} if (e := rt.effort_for(agent)) else {}, messages=[], json_mode=True,
                     metadata={"kind": "orchestrator", "turn_context": rt.turn_context(agent, inbox, obs),
                               "cache_key": f"octopus-{rt.run_id[:18]}-{agent.id}"[:64]})
    async with registry_factory()() as rdb:
        req, warn = await prepare_request(rdb, rt.user_id, req)
    if req.provider != provider or req.model != model:
        raise LLMError(f"Configured node model {provider}/{model} is unavailable; choose a connected model. No replacement model was invoked.", retryable=False)
    if warn and aid not in rt.warned:
        rt.warned.add(aid)
        await rt.emit("error", {"message": f"{agent.name}: {warn}", "agent_id": aid, "kind": "warning"})
    native = rt.native_tools_for(req)
    system, user = build_turn_prompts(rt, agent, inbox_ids, obs, native=native,
                                      memory_context=await rt.execution.scoped_context(aid))
    system += (f"\n\n## Runtime identity\nYou are responding as an Octopus AI agent using the `{model}` model through `{provider}`. "
               "If the user asks which model you are, report these configured values accurately. You do not have a physical location.")
    if extra:
        user += "\n\n" + extra
    req.messages = [{"role": "system", "content": system}, {"role": "user", "content": user}]
    if images := rt.goal_images():
        req.images = images
        req.messages[-1]["content"] += (f"\n\n(The user attached {len(images)} image(s) to the goal; they follow this message. "
                                        "Use them as reference for what to build.)")
    rt.seen[aid], rt.seen_turn[aid] = rt.journal_n, rt.turn_no
    return req, native


def native_tools_for(rt: RunRuntime, req: LLMRequest) -> bool:
    """Use the model's own function calling when the provider supports it (Azure Responses API); otherwise the JSON envelope."""
    if not get_settings().native_tools:
        return False
    check = getattr(get_provider(req.provider, req), "supports_native_tools", None)
    return bool(check and check(req))


async def native_turn(rt: RunRuntime, agent: AgentSpec, req: LLMRequest, *, exclude: set[str] | frozenset[str] = frozenset()) -> str:
    """One turn as a tool loop: the model calls tools, gets each result back, and keeps going until it stops calling tools
        (or ends the turn with wait / finish / a question for the user). Errors are returned to the model as tool results."""
    aid = agent.id
    specs, mcp_map = T.tool_specs(agent.tools, agent.mcp)
    req.tools = [t for t in specs if t["name"] not in exclude]
    req.json_mode = False
    req.continuation = []
    return await rt._tool_loop(agent, req, mcp_map)


async def _tool_loop(rt: RunRuntime, agent: AgentSpec, req: LLMRequest, mcp_map: dict[str, tuple[str, str]]) -> str:
    aid = agent.id
    last_text = ""
    rounds: list[int] = []  # where each round's items start in req.continuation
    for rnd in range(rt.budget.max_tool_rounds):
        if rt.stop_requested:
            raise StopRun()
        if rnd and (rt.paused or rt.limit_reason(turns=False)):
            break  # pause / budget are honoured between rounds too; the turn ends cleanly
        res = await rt.call_llm_escalating_result(agent, req)
        if res.text.strip():
            last_text = res.text.strip()
            await rt.emit("thought", {"agent_id": aid, "text": last_text[:4000], "turn_no": rt.turn_no})
        if not res.tool_calls:
            legacy = A.parse_envelope(res.text) if res.text.lstrip().startswith(("{", "```")) else None
            if legacy and legacy.ok and legacy.actions:  # the model answered with an old-style envelope: honour it
                for action in legacy.actions:
                    await rt.execute(agent, action)
                    if rt.finished_summary is not None:
                        break
            break
        outputs: list[dict[str, Any]] = []
        ended = False
        # several delegations in one reply are independent work: run those teammates at the same time
        delegations = [c for c in res.tool_calls if c.name == "delegate"]
        ran: dict[str, tuple[str, bool]] = {}
        if len(delegations) > 1:
            rt.metrics["parallel_delegations"] += len(delegations)
            done = await asyncio.gather(*(rt.run_tool_call(agent, c, mcp_map) for c in delegations))
            ran = {c.id: r for c, r in zip(delegations, done)}
            ended = any(result[1] for result in ran.values())
        for call in res.tool_calls:
            if call.id in ran:
                out, _ = ran[call.id]
            elif ended:
                out = "Not run: an earlier call in this reply ended your turn."
            else:
                out, ended = await rt.run_tool_call(agent, call, mcp_map)
            outputs.append({"type": "function_call_output", "call_id": call.id, "output": out})
        left = rt.budget.max_tool_rounds - rnd - 1
        if outputs and not ended and left in ROUND_WARNINGS:  # a turn that silently runs out leaves its task half done
            outputs[-1]["output"] += (f"\n\n[Octopus] {left} tool round{'s' if left != 1 else ''} left in this turn. "
                                      + ("Stop exploring: finish the deliverable with what you have, then call `finish` "
                                         "with what's done and what's open." if left > 1 else
                                         "This is your last call: call `finish` now with what's done and what's open."))
        # replay the response (encrypted reasoning included) and answer every call, as the Responses API expects
        replay = [i for i in res.items if not (i.get("type") == "reasoning" and not i.get("encrypted_content"))]
        rounds.append(len(req.continuation))
        req.continuation = compact_rounds([*req.continuation, *replay, *outputs], rounds)
        if ended:
            break
    else:
        await rt.emit("error", {"kind": "warning", "agent_id": aid,
                                  "message": f"{agent.name} used all {rt.budget.max_tool_rounds} tool rounds of this turn"})
    return last_text


async def run_tool_call(rt: RunRuntime, agent: AgentSpec, call: ToolCall, mcp_map: dict[str, tuple[str, str]]) -> tuple[str, bool]:
    """Run one function call through the normal action executor. Returns (result text for the model, turn ended?).

        The executors report back through notices/observations (the envelope path shows those in the next prompt); here
        they are taken out and returned as the call's output instead, so the agent sees them immediately."""
    aid = agent.id
    action, err = T.parse_tool_call(call.name, call.arguments, mcp_map)
    if action is None:
        await rt.emit("error", {"message": f"{agent.name}: {call.name}: {err}", "agent_id": aid, "kind": "parse"})
        return f"Error: {err}. Nothing was done; call the tool again with corrected arguments.", False
    if action.action == "delegate":
        if not A.tool_enabled(agent.tools, "send_message"):
            return "Error: delegating needs the Messaging tool, which you don't have.", False
        result = await rt.delegate(agent, action)
        return clip(result, TOOL_RESULT_CHARS), not result.startswith("Not delegated:")
    before = len(rt.observations.get(aid, []))
    known_calls = set(rt.observed_checks)
    await rt.execute(agent, action)
    produced = rt.observations.get(aid, [])[before:]
    if produced:
        del rt.observations[aid][before:]
        if not rt.observations[aid]:
            rt.observations.pop(aid)
    lines = []
    for o in (o for _, o in produced):
        tag = "" if o.get("tool") == "system" else f"[{o.get('tool')}{' OK' if o.get('ok') else ' FAILED' if o.get('ok') is False else ''}] "
        lines.append(tag + str(o.get("content", "")))
    name = action.action
    observed_ids = [cid for cid, value in rt.observed_checks.items() if cid not in known_calls and value["agent_id"] == aid]
    if observed_ids:
        if not lines:
            lines.extend(f"[{rt.observed_checks[cid]['tool']} {'OK' if rt.observed_checks[cid]['ok'] else 'FAILED'}] "
                         + rt.observed_checks[cid]["summary"] for cid in observed_ids)
        lines.append("Observed tool_call_ids: " + ", ".join(observed_ids))
    if not lines:
        if name == "update_task_board":
            lines.append("Task board:\n" + "\n".join(f"- {rt.task_line(t)}" for t in rt.tasks.values()))
        elif name == "send_message":
            lines.append(f"Sent to {action.to}.")
        else:
            lines.append("Done.")
    bounced = name == "finish" and rt._bounced_finish == aid  # sent back to verify: the turn goes on
    if bounced:
        rt._bounced_finish = None
    ended = not bounced and (name in T.TERMINAL_ACTIONS or rt.finished_summary is not None or aid in rt.done_agents
                             or aid in rt.waiting_peers or bool(rt.awaiting and rt.awaiting.get("agent_id") == aid))
    return clip("\n".join(lines), TOOL_RESULT_CHARS), ended


async def end_turn(rt: RunRuntime, aid: str) -> None:
    if rt.progress_turn == rt.turn_no:  # productive turn: the agent may keep working on its own results
        rt.self_turns[aid] = 0
    if aid in rt.waiting_peers:
        await rt.set_agent_status(aid, "waiting_reply", "Waiting for a peer answer")
    elif aid in rt.done_agents:
        await rt.set_agent_status(aid, "done", "Finished")
    elif rt.mailbox.get(aid):
        await rt.set_agent_status(aid, "waiting", f"{len(rt.mailbox[aid])} message(s) queued")
    elif rt.awaiting and rt.awaiting.get("agent_id") == aid:
        await rt.set_agent_status(aid, "waiting", "Waiting for your answer")
    else:
        await rt.set_agent_status(aid, "idle", "Waiting for messages")
