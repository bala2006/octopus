"""Messaging and control actions: send_message (channels, protocols, loop and limit checks), request_user_input, wait and finish (verify-before-done and the workflow's finish rules)."""

from __future__ import annotations

import re
from typing import TYPE_CHECKING, Any

from app.db.session import registry_factory
from app.capabilities.models.base import LLMError, LLMRequest
from app.capabilities.models.router import prepare_request, stream_with_retry
from app.orchestrator import actions as A
from app.orchestrator.context import AgentSpec, clip
from app.orchestrator.execution import ACTIVE_ATTEMPT
from app.orchestrator.handlers.shared import OPEN_TASK_STATES
from app.orchestrator.permissions import allowed_recipients, find_channel, rejection_reason, EdgeSpec
from app.workflows.boardroom import DebateState, debate_decided_externally, debate_on_message
from app.workflows.review import ReviewState, infer_verdict, review_on_request, review_on_result

if TYPE_CHECKING:  # pragma: no cover
    from app.orchestrator.engine import RunRuntime


DEBATE_PROTOCOL_TYPES = {"proposal", "critique", "objection", "agreement", "decision"}


JUDGE_MAX_TOKENS = 16  # "YES"/"NO" plus slack; 5 often produced no answer at all (reasoning headroom is added on top)


def judge_verdict(text: str) -> bool | None:
    """YES → True, NO → False, anything else (empty, rambling) → None = unknown."""
    t = re.sub(r"[^A-Z]", " ", text.upper()).split()
    if not t:
        return None
    return True if t[0] == "YES" else False if t[0] == "NO" else None


async def reject(rt: RunRuntime, agent: AgentSpec, to_id: str | None, a: A.SendMessage, reason: str, *, retry: bool = True) -> None:
    """``retry=False`` for loop / channel-limit rejections: the agent sees the notice next time it is woken, but the
        rejection itself does not buy it another turn (that just turned a loop into a spin)."""
    rt.rejections += 1
    rt.notice(agent.id, f"Message to {rt.names.get(to_id or '', a.to)} was REJECTED: {reason}", activate=retry)
    await rt.emit("message_rejected", {"from_agent_id": agent.id, "to_agent_id": to_id, "to": a.to, "type": a.type,
                                         "reason": reason, "content": a.content[:300]})


async def act_send_message(rt: RunRuntime, agent: AgentSpec, a: A.SendMessage) -> None:
    to = a.to.strip()
    if to.lower() in ("all", "everyone", "broadcast", "team", "@all"):
        if a.type == "question":
            await rt.reject(agent, None, a, "Consult one named peer at a time; broadcast questions cannot establish an accountable reply.")
            return
        targets = list(allowed_recipients(rt.edges, agent.id))
        if not targets:
            await rt.reject(agent, None, a, "You have no outgoing channels.")
        for tid in targets:
            await rt._send_one(agent, tid, a)
        return
    if to.lower() in ("user", "human", "the user"):
        await rt.reject(agent, None, a, "To contact the user use request_user_input (if enabled) or report to your manager.")
        return
    tid = rt.resolve_agent(to)
    if tid is None:
        await rt.reject(agent, None, a, f"Unknown recipient '{to}'. Allowed: {', '.join(rt.names[r] for r in allowed_recipients(rt.edges, agent.id)) or 'none'}")
        return
    await rt._send_one(agent, tid, a)


async def _send_one(rt: RunRuntime, agent: AgentSpec, tid: str, a: A.SendMessage) -> None:
    if not rt.agents[tid].active:
        await rt.reject(agent, tid, a, f"{rt.names[tid]} is inactive (deactivated). Use list_agents to find an active teammate.")
        return
    edge = find_channel(rt.edges, agent.id, tid, a.type)
    if edge is None:
        await rt.reject(agent, tid, a, rejection_reason(rt.edges, agent.id, tid, a.type, rt.names))
        return
    cfg = edge.config or {}
    max_turns = int(cfg.get("max_turns", 20))
    if rt.edge_counts[edge.id] >= max_turns:
        await rt.reject(agent, tid, a, f"Channel turn limit reached (max_turns={max_turns}). Wrap up or escalate via another channel.",
                          retry=False)
        return
    if rt.loop.check(agent.id, tid, a.type, a.content):
        await rt.reject(agent, tid, a, f"Loop detected: {rt.loop.last_reason}. {rt.names[tid]} already has it. Don't ask again: "
                                         "check the Blackboard (task board, workspace files), do the work yourself, escalate, or finish.",
                          retry=False)
        await rt.emit("error", {"message": f"Loop detector: {agent.name} → {rt.names[tid]}: {rt.loop.last_reason}",
                                  "agent_id": agent.id, "kind": "loop"})
        return
    content, meta = a.content, {}
    notices: dict[str, str] = {}
    protocol_event: dict[str, Any] | None = None
    activating = False
    if edge.type == "debate" and a.type in DEBATE_PROTOCOL_TYPES:
        st = rt.debates.get(edge.id) or DebateState(edge.id, [edge.source, edge.target], max_rounds=int(cfg.get("max_rounds", 4)))
        v = debate_on_message(st, agent.id, a.type, content)
        if not v.accept:
            await rt.reject(agent, tid, a, v.reason)
            return
        rt.debates[edge.id] = st
        notices, protocol_event = v.notices, v.event
        activating = bool(v.event and v.event.get("result") == "max_rounds")
        meta["debate"] = {"round": st.rounds, "max_rounds": st.max_rounds, "status": st.status, "number": st.number}
        if st.status == "consensus" and protocol_event:
            rt.decide(f"Consensus ({rt.names[edge.source]} ↔ {rt.names[edge.target]}): {st.outcome[:240]}", agent.id)
    elif a.type in ("review_request", "review_result"):
        if edge.type == "review":
            author, reviewer = (agent.id, tid) if a.type == "review_request" else (tid, agent.id)
            key = f"{edge.id}:{author}"
            rst = rt.reviews.get(key) or ReviewState(edge.id, author, reviewer, max_revisions=int(cfg.get("max_revisions", 3)))
            if a.type == "review_request":
                v = review_on_request(rst)
            else:
                verdict = a.verdict or infer_verdict(content)
                v = review_on_result(rst, verdict, a.comments)
                meta.update(verdict=verdict, comments=a.comments)
            if not v.accept:
                await rt.reject(agent, tid, a, v.reason)
                return
            rt.reviews[key] = rst
            notices, protocol_event = v.notices, v.event
            activating = bool(v.event and v.event.get("result") == "max_revisions")
            meta["review"] = {"revisions": rst.revisions, "max_revisions": rst.max_revisions, "status": rst.status}
        elif a.type == "review_result":
            meta.update(verdict=a.verdict or infer_verdict(content), comments=a.comments)
        if a.comments:
            content += "\n\n" + "\n".join(f"{i}. {c}" for i, c in enumerate(a.comments, 1))
    if cfg.get("condition") and not await rt.condition_met(agent, edge, a):
        await rt.reject(agent, tid, a, f"Channel condition not met: \"{cfg['condition']}\".")
        return
    if a.type == "question":
        from app.orchestrator.runtime_store import Conflict
        try:
            consultation_id = await rt.runtime_store.consult(agent.id, tid, rt.plan_revision, content)
        except Conflict as exc:
            await rt.reject(agent, tid, a, str(exc))
            return
        meta["consultation_id"] = consultation_id
        rt.waiting_peers[agent.id] = tid
        await rt.set_agent_status(agent.id, "waiting_reply", f"Waiting for {rt.names[tid]}")
    elif a.type in ("answer", "decision", "review_result"):
        answered = await rt.runtime_store.answer(agent.id, tid, content)
        if answered and rt.waiting_peers.get(tid) == agent.id:
            rt.waiting_peers.pop(tid, None)
            await rt.set_agent_status(tid, "waiting", "Peer answer received")
            rt.wake.set()
    if a.type == "task":
        try:
            meta["task_id"] = await rt.link_task(agent.id, tid, a.task_id, content)
        except ValueError as exc:
            await rt.reject(agent, tid, a, str(exc))
            return
    elif a.task_id:
        meta["task_id"] = a.task_id
    rt.edge_counts[edge.id] += 1
    await rt.post_message(sender="agent", from_id=agent.id, to_id=tid, type_=a.type, content=content, edge_id=edge.id, meta=meta)
    await rt.emit("edge_activity", {"edge_id": edge.id, "from_agent_id": agent.id, "to_agent_id": tid, "type": a.type,
                                      "count": rt.edge_counts[edge.id], "max_turns": max_turns})
    if a.type == "decision":
        for d in rt.debates.values():
            if tid in d.participants and debate_decided_externally(d, content):
                await rt.emit("protocol", {"kind": "debate", "result": "decided", "edge_id": d.edge_id, "state": d.to_dict()})
        rt.decide(f"Decision by {agent.name}: {content.splitlines()[0][:240]}", agent.id)
    if a.type == "decision" or (protocol_event and protocol_event.get("result") not in (None, "requested", "round")):
        rt.mark_progress()  # verdicts, consensus and decisions move the run forward; another debate round does not
    if protocol_event:
        state = rt.debates[edge.id].to_dict() if protocol_event["kind"] == "debate" else rt.reviews[f"{edge.id}:{agent.id if a.type == 'review_request' else tid}"].to_dict()
        await rt.emit("protocol", {**protocol_event, "edge_id": edge.id, "state": state})
    for pid, text in notices.items():
        rt.notice(pid, text, activate=activating)


async def condition_met(rt: RunRuntime, agent: AgentSpec, edge: EdgeSpec, a: A.SendMessage) -> bool:
    """Evaluate a natural-language edge condition with a tiny LLM judge call (mock: always satisfied)."""
    cond = edge.config.get("condition", "")
    provider, model = rt.model_for(agent)
    if provider == "opencode":
        rt.notice(agent.id, "This conditional channel needs an explicit reviewed decision; the OpenCode worker cannot invoke a separate provider as judge.")
        return False
    req = LLMRequest(provider=provider, model=model, temperature=0, max_tokens=JUDGE_MAX_TOKENS,
                     extra={"reasoning_effort": "low" if rt.effort_for(agent) != "none" else "none"}, messages=[
        {"role": "system", "content": "You are a strict gatekeeper. Answer only YES or NO."},
        {"role": "user", "content": f"Channel condition: {cond}\nBlackboard:\n{clip(rt.blackboard(), 8000)}\n\n"
                                    f"Message ({a.type}): {clip(a.content, 6000)}\n\nIs the condition satisfied?"}],
        metadata={"kind": "chat", "scripted_reply": "YES"})
    try:
        async with registry_factory()() as rdb:
            req, _ = await prepare_request(rdb, rt.user_id, req)
        out = ""
        async for ch in stream_with_retry(req, retries=1):
            out += ch.delta
            if ch.usage:
                rt.add_usage(agent.id, ch.usage)
        verdict = judge_verdict(out)
        if verdict is not None:
            return verdict
        why = f"unclear answer {out.strip()[:40]!r}" if out.strip() else "no answer"
    except LLMError as exc:
        why = f"judge failed: {exc}"
    await rt.emit("error", {"message": f"Channel condition \"{cond}\" could not be evaluated ({why}); delivery is blocked pending a decision.",
                              "agent_id": agent.id, "kind": "warning"})
    return False


async def act_request_user_input(rt: RunRuntime, agent: AgentSpec, a: A.RequestUserInput) -> None:
    options = [o.model_dump() for o in a.options]
    rec = await rt.post_message(sender="agent", from_id=agent.id, to_id=None, type_="question", content=a.question,
                                  meta={"awaiting_input": True, "options": options, "allow_other": True}, deliver=False)
    rt.awaiting = {"agent_id": agent.id, "question": a.question, "message_id": rec["id"], "options": options, "allow_other": True}
    await rt.set_agent_status(agent.id, "waiting")


def finish_refusal(rt: RunRuntime, agent: AgentSpec) -> str | None:
    """Verify before done (MAST: missing/incomplete verification is a top cause of multi-agent failure). An agent that
        can run code or open a browser, finishing the run or a delegated task while code changed unexercised or a file
        fails its automatic check, is sent back once with what to check. Asking again finishes (it may be unverifiable)."""
    if not rt.budget.verify_before_finish or not (
            agent.is_entry or rt.wf_owner_of_active(agent.id)):
        return None
    can_run = A.tool_enabled(agent.tools, "terminal")
    can_browse = any(m.get("builtin") for m in agent.mcp)
    if not (can_run or can_browse) or not (rt.unverified or rt.broken_files):
        return None
    key = f"{agent.id}|{sorted(rt.unverified)}|{sorted(rt.broken_files)}"
    if key in rt.finish_bounces:
        return None
    rt.finish_bounces.add(key)
    parts = []
    if rt.broken_files:
        parts.append("these files fail their automatic check: " + "; ".join(
            f"{p} ({m.splitlines()[0][:160]})" for p, m in sorted(rt.broken_files.items())))
    if rt.unverified:
        files = ", ".join(sorted(rt.unverified)[:8])
        how = []
        if can_browse and any(p.endswith((".html", ".htm")) for p in rt.unverified):
            how.append(f"open it in your browser ({rt.preview_url()}<path>), check browser_console_messages for errors and try it")
        if can_run:
            how.append("run it or its tests with run_code")
        parts.append(f"{files} changed and nothing has run or opened it since; " + " or ".join(how or ["exercise it"]))
    return ("Not finished yet: verify first. " + "; ".join(parts) + ". Fix what you find, then call `finish` again with "
            "what you checked and what you saw. (If it really can't be verified here, call `finish` again and say so.)")


async def wf_finish_refusal(rt: RunRuntime, agent: AgentSpec, a: A.Finish) -> str | None:
    """Workflow rules for `finish`: the head accepts at the end; a phase owner closes its phase (gate checked)."""
    if not rt.wf_active():
        return None
    ph = rt.wf_phase()
    if ph is None:
        return None
    if agent.is_entry and ph["key"] == "intake":  # answered without a build (e.g. a question): no workflow needed
        rt.wf.update({"ended": True, "reason": "finished at intake"})
        await rt.wf_emit()
        return None
    if agent.is_entry and ph["key"] == "accept":  # the head signs off: the run completes
        ph.update({"status": "done", "summary": (a.summary or "")[:2000]})
        rt.wf["ended"] = True
        await rt.wf_emit()
        return None
    if agent.id == rt.lead_agent_id:
        if rt.wf.get("head_bounced") == ph["key"]:
            rt.wf.update({"ended": True, "reason": f"head finished during {ph['key']}"})
            return None
        rt.wf["head_bounced"] = ph["key"]
        return (f"The workflow is in the {ph['key']} phase ({rt.names.get(ph['owner'], '?')} is on it). Wait for it to come "
                "back to you for acceptance (call `wait`). Finishing now would end the run unfinished; call finish again only "
                "if that is really what you want.")
    if rt.wf_owner_of_active(agent.id):
        return await rt.wf_on_finish(agent, a)
    return None


async def act_finish(rt: RunRuntime, agent: AgentSpec, a: A.Finish) -> None:
    rt._bounced_finish = None
    was_phase_owner = rt.wf_owner_of_active(agent.id)
    context = ACTIVE_ATTEMPT.get()
    if context and context.workspace is not None and not context.integrated:
        context.pending_finish = a
        return
    if agent.id == rt.lead_agent_id and any(t["status"] != "blocked" for t in rt.open_tasks()) and not rt.wf_active():
        rt.notice(agent.id, "Specialist assignments are still open. Their results must be integrated before acceptance.", activate=False)
        return
    if (why := rt.finish_refusal(agent)) or (why := await rt.wf_finish_refusal(agent, a)):
        rt._bounced_finish = agent.id
        rt.notice(agent.id, why, activate=True)
        return
    if was_phase_owner:
        return  # wf_on_finish already made the ordered handoff.
    if rt.mode == "supervised":
        ok, reason = await rt.request_approval(agent, "finish", f"{agent.name} wants to finish", a.summary, {"summary": a.summary})
        if not ok:
            rt.notice(agent.id, f"The user did not accept finishing yet: {reason or 'keep going'}", activate=True)
            return
    if agent.id == rt.lead_agent_id:
        rt.finished_summary = a.summary or f"{agent.name} finished."
        await rt.post_message(sender="agent", from_id=agent.id, to_id=None, type_="final_report",
                                content=rt.finished_summary, deliver=False)
    else:
        rt.done_agents.add(agent.id)
        reported = False
        attempt = ACTIVE_ATTEMPT.get()
        for task in list(rt.tasks.values()):
            if attempt and attempt.assignment.task_id and task["key"] != attempt.assignment.task_id:
                continue
            if task.get("assignee") == agent.id and task["status"] in OPEN_TASK_STATES:
                task["status"] = "blocked" if a.outcome == "fail" else "done"
                await rt.save_task(task)
                parent = task.get("created_by") or rt.lead_agent_id
                if parent in rt.agents and parent != agent.id:
                    await rt.post_message(sender="agent", from_id=agent.id, to_id=parent,
                        type_="status_update", content=a.summary or "Specialist finished without a summary.",
                        meta={"task_id": task["key"], "delegation_result": True, "outcome": a.outcome})
                    reported = True
        if not reported and not rt.wf_owner_of_active(agent.id):
            await rt.post_message(sender="agent", from_id=agent.id, to_id=rt.lead_agent_id,
                type_="status_update", content=a.summary or "Specialist finished.", meta={"direct_request_result": True})
        rt.mark_progress()
        rt.log(agent.id, f"finished: {(a.summary or '')[:300]}")
        await rt.emit("agent_finished", {"agent_id": agent.id, "summary": a.summary})


async def act_wait(rt: RunRuntime, agent: AgentSpec, a: A.Wait) -> None:
    return None
