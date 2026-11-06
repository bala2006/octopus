"""Workflow plugins: the task board, the debate and review protocols, org and hiring, the company workflow."""
from __future__ import annotations

from collections.abc import Callable, Mapping

from app.plugins.workflows.deps import deps
from app.sdk.manifest import Manifest
from app.sdk.plugin import RunMethod, ServicePlugin, ToolHandler

TASK_BOARD_METHODS = ("open_tasks", "task_ready", "task_line", "open_task_owners", "link_task", "child_task_contract", "create_task",
                      "save_task", "act_update_task_board")
ORG_METHODS = ("manages", "_snapshot_agent", "_team_guard", "_persist_team", "act_list_agents", "act_create_agent", "act_update_agent")
FLOW_METHODS = ("wf_active", "wf_phase", "wf_enabled_for_run", "wf_tool_exclusions", "wf_owner_of_active", "wf_emit", "wf_view",
                "wf_blackboard", "wf_init", "wf_intake_note", "act_set_track", "wf_advance", "wf_start", "wf_brief", "wf_gate",
                "wf_on_finish", "nudge_workflow")


def _delegating(owner: str, name: str) -> RunMethod:
    """A run method that calls the same-named method on the run's workflow object (``rt.org`` or ``rt.flow``)."""

    def method(rt, *args, **kwargs):  # type: ignore[no-untyped-def]
        return getattr(getattr(rt, owner), name)(*args, **kwargs)

    method.__name__ = name
    return method


def _task_board():
    from app.plugins.workflows import task_board
    return task_board


def _task_board_tools() -> Mapping[str, ToolHandler]:
    from app.plugins.workflows import task_board
    return {"update_task_board": task_board.act_update_task_board}


def _task_board_methods() -> Mapping[str, RunMethod]:
    from app.plugins.workflows import task_board
    return {name: getattr(task_board, name) for name in TASK_BOARD_METHODS}


def _boardroom():
    from app.plugins.workflows import boardroom
    return boardroom


def _review():
    from app.plugins.workflows import review
    return review


def _org():
    from app.plugins.workflows import org
    return org


def _org_methods() -> Mapping[str, RunMethod]:
    return {name: _delegating("org", name) for name in ORG_METHODS}


def _company():
    from app.plugins.workflows import company
    return company


def _flow_methods() -> Mapping[str, RunMethod]:
    return {name: _delegating("flow", name) for name in FLOW_METHODS}


def _team_tools() -> Mapping[str, ToolHandler]:
    from app.plugins.workflows import team_actions
    return {"create_agent": team_actions.act_create_agent, "list_agents": team_actions.act_list_agents,
            "update_agent": team_actions.act_update_agent}


def _workflow_tools() -> Mapping[str, ToolHandler]:
    from app.plugins.workflows import workflow_actions
    return {"set_track": workflow_actions.act_set_track}


PLUGINS = (
    ServicePlugin(
        Manifest(id="workflow.task_board", slot="workflow", kind="board", version="1.0.0", title="Task board",
                 description="Tasks with owners, dependencies, scopes and states, and the update_task_board action.",
                 provides=("workflow.tasks", "tools.tasks"), requires=(), permissions=("db",), emits=("task_updated",), required=True),
        services={"workflow.tasks": _task_board}, tools={"tasks": _task_board_tools}, run_methods=_task_board_methods, deps=deps),
    ServicePlugin(
        Manifest(id="workflow.boardroom", slot="workflow", kind="protocol", version="1.0.0", title="Boardroom (debate)",
                 description="Structured debate on debate channels: proposals, objections, consensus or a decision.",
                 provides=("workflow.debate",), requires=(), emits=("protocol",)),
        services={"workflow.debate": _boardroom}),
    ServicePlugin(
        Manifest(id="workflow.review", slot="workflow", kind="protocol", version="1.0.0", title="Review gates",
                 description="Review requests and verdicts with a bounded number of revisions.",
                 provides=("workflow.review",), requires=(), emits=("protocol",)),
        services={"workflow.review": _review}),
    ServicePlugin(
        Manifest(id="workflow.org", slot="workflow", kind="org", version="1.0.0", title="Org and hiring",
                 description="Hiring, reconfiguring and routing inside the org chart, under the approval setting.",
                 provides=("workflow.org",), requires=("roles.builtin",), optional=("models.router",), permissions=("db",),
                 emits=("agent_created", "agent_updated")),
        services={"workflow.org": _org}, run_methods=_org_methods, deps=deps),
    ServicePlugin(
        Manifest(id="workflow.company", slot="workflow", kind="workflow", version="1.0.0", title="Company workflow",
                 description="Phases, owners, gates and bounded rework for a run (intake, plan, build, review, ship).",
                 provides=("workflow.company",), requires=(), emits=("workflow_updated", "workflow_checkpoint")),
        services={"workflow.company": _company}, run_methods=_flow_methods, deps=deps),
    ServicePlugin(
        Manifest(id="tool.team", slot="tool", kind="tool family", version="1.0.0", title="Team tools",
                 description="list_agents, create_agent and update_agent.",
                 provides=("tools.team",), requires=("workflow.org", "tools.messaging"), permissions=("db",)),
        tools={"team": _team_tools}, deps=deps),
    ServicePlugin(
        Manifest(id="tool.workflow", slot="tool", kind="tool family", version="1.0.0", title="Workflow tools",
                 description="set_track: choose the workflow track after intake.",
                 provides=("tools.workflow",), requires=("workflow.company",)),
        tools={"workflow": _workflow_tools}),
)
