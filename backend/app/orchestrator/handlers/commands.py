"""run_code: a sandboxed command, gated by the policy gate."""

from __future__ import annotations

from typing import TYPE_CHECKING

from app.orchestrator import actions as A
from app.orchestrator.context import AgentSpec
from app.capabilities.sandbox.commands import SandboxError, analyze_command, run_command

if TYPE_CHECKING:  # pragma: no cover
    from app.orchestrator.engine import RunRuntime


async def act_run_code(rt: RunRuntime, agent: AgentSpec, a: A.RunCode) -> None:
    rt.mark_work(agent.id)
    cid = await rt._tool_event(agent, "run_code", {"command": a.command, "covered_paths": a.covered_paths,
                                                    "criterion_ids": a.criterion_ids, "whole_project": a.whole_project})
    try:
        plan = analyze_command(a.command)
    except SandboxError as exc:
        await rt.deny(agent, cid, "run_code", f"Command rejected by sandbox: {exc}")
        return
    ok, reason = await rt.guard(agent, "run_code", f"{agent.name} wants to run `{a.command[:80]}`", a.command,
                                  {"command": a.command, "cwd": ".", "outside": plan.outside}, dangerous=bool(plan.outside))
    if not ok:
        await rt.deny(agent, cid, "run_code", reason)
        return
    await rt.set_agent_status(agent.id, "running", f"$ {a.command[:70]}")
    try:
        res = await run_command(a.command, rt.execution.worker_root(agent.id), allow_outside=bool(plan.outside))
        ok = res.ok
        out = f"$ {a.command}\n(exit {res.exit_code}{', timed out' if res.timed_out else ''}, {res.backend})\n{res.output}"
    except SandboxError as exc:
        ok, out = False, f"Command rejected by sandbox: {exc}"
    rt.observe(agent.id, {"tool": "run_code", "ok": ok, "content": out})
    await rt._tool_result(agent, cid, "run_code", ok, out)
