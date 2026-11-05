"""Catalog of the components in the refactor plan's section 4 mapping, one manifest per table row.

This file only describes the code. No manifest changes wiring. At runtime, channels read their manifest through
app.channels.catalog_manifest, and app/agents/roles imports its VERSION constant. Nothing reads the registry table yet.

Status:
- built: the component exists in the code now.
- partly: the component exists, but the plan's target form is incomplete.
- planned: no code yet, or the component is not wired yet.

provides and requires name capabilities, not other plugin ids. A requirement points only at the same layer or a
lower one: channel > agent > workflow > capability > core.
"""
from __future__ import annotations

from app.core.manifest import Manifest

VERSION = "1.0.0"  # catalog version; a plugin bumps its own version when its contract changes

BUILTIN_MANIFESTS: tuple[Manifest, ...] = (
    # Channels: how a user or client reaches Octopus.
    Manifest(id="channel.api_ws", layer="channel", kind="api", version=VERSION,
             provides=("http.api", "ws.events"),
             requires=("run.lifecycle", "storage.repositories", "bus.events"), status="built"),
    Manifest(id="channel.web_shell", layer="channel", kind="ui", version=VERSION,
             provides=("ui.shell",), requires=("http.api",), status="built"),
    Manifest(id="channel.cli", layer="channel", kind="cli", version=VERSION,
             provides=("cli.dev",), requires=("http.api",), status="partly"),
    Manifest(id="channel.chat_apps", layer="channel", kind="chat", version=VERSION,
             provides=("chat.apps",), requires=(), status="planned"),

    # Agents: who does the work.
    Manifest(id="agent.chief", layer="agent", kind="orchestrator", version=VERSION,
             provides=("agents.lead",),
             requires=("workflow.company", "workflow.org", "agents.product", "agents.engineering",
                       "agents.design_ops", "agents.qa", "agents.custom", "contracts.task"),
             status="built"),
    Manifest(id="agent.product_architect", layer="agent", kind="roles", version=VERSION,
             provides=("agents.product",), requires=(), status="built"),
    Manifest(id="agent.engineers", layer="agent", kind="roles", version=VERSION,
             provides=("agents.engineering",), requires=(), status="built"),
    Manifest(id="agent.designer_devops", layer="agent", kind="roles", version=VERSION,
             provides=("agents.design_ops",), requires=(), status="built"),
    Manifest(id="agent.qa_critic", layer="agent", kind="roles", version=VERSION,
             provides=("agents.qa",), requires=(), status="built"),
    Manifest(id="agent.custom_roles", layer="agent", kind="roles", version=VERSION,
             provides=("agents.custom",), requires=("storage.repositories",), status="built"),

    # Workflows: how agents coordinate.
    Manifest(id="workflow.boardroom", layer="workflow", kind="protocol", version=VERSION,
             provides=("workflow.debate",), requires=("bus.events",), status="built"),
    Manifest(id="workflow.review_gates", layer="workflow", kind="protocol", version=VERSION,
             provides=("workflow.review",), requires=("bus.events",), status="built"),
    Manifest(id="workflow.task_board", layer="workflow", kind="board", version=VERSION,
             provides=("workflow.tasks",), requires=("bus.events", "storage.repositories"), status="built"),
    Manifest(id="workflow.company", layer="workflow", kind="workflow", version=VERSION,
             provides=("workflow.company",),
             requires=("workflow.debate", "workflow.review", "workflow.tasks", "policy.gate", "bus.events"),
             status="built"),
    Manifest(id="workflow.org_hiring", layer="workflow", kind="org", version=VERSION,
             provides=("workflow.org",), requires=("policy.gate", "storage.repositories"), status="built"),

    # Capabilities: tools and services that the layers above call.
    Manifest(id="capability.models", layer="capability", kind="provider", version=VERSION,
             provides=("models.providers",), requires=(), status="built"),
    Manifest(id="capability.file_tools", layer="capability", kind="tools", version=VERSION,
             provides=("tools.files",), requires=("policy.gate",), status="built"),
    Manifest(id="capability.skills", layer="capability", kind="skills", version=VERSION,
             provides=("skills.library",), requires=("storage.repositories",), status="built"),
    Manifest(id="capability.mcp", layer="capability", kind="tools", version=VERSION,
             provides=("tools.mcp",), requires=("policy.gate",), status="built"),
    Manifest(id="capability.browser", layer="capability", kind="browser", version=VERSION,
             provides=("browser.sessions",), requires=("policy.gate", "bus.events"), status="built"),
    Manifest(id="capability.sandbox", layer="capability", kind="sandbox", version=VERSION,
             provides=("sandbox.exec",), requires=("policy.gate",), status="built"),
    Manifest(id="capability.storage", layer="capability", kind="storage", version=VERSION,
             provides=("storage.repositories",), requires=(), status="built"),
    Manifest(id="capability.memory", layer="capability", kind="memory", version=VERSION,
             provides=("memory.scoped",), requires=("storage.repositories",), status="built"),
    Manifest(id="capability.team_log", layer="capability", kind="log", version=VERSION,
             provides=("team.log",), requires=("bus.events", "storage.repositories"), status="built"),
    Manifest(id="capability.git_worktrees", layer="capability", kind="workspace", version=VERSION,
             provides=("workspace.git",), requires=(), status="built"),
    Manifest(id="capability.preview", layer="capability", kind="preview", version=VERSION,
             provides=("workspace.preview",), requires=(), status="built"),
    Manifest(id="capability.versions", layer="capability", kind="artifacts", version=VERSION,
             provides=("artifacts.versions",), requires=("storage.repositories",), status="built"),

    # Core: the bottom layer. Core requires only core.
    Manifest(id="core.bus", layer="core", kind="bus", version=VERSION,
             provides=("bus.events",), requires=(), status="built"),
    Manifest(id="core.policy_gate", layer="core", kind="policy", version=VERSION,
             provides=("policy.gate",), requires=("bus.events",), status="built"),
    Manifest(id="core.task_contracts", layer="core", kind="contracts", version=VERSION,
             provides=("contracts.task",), requires=(), status="built"),
    Manifest(id="core.run_manager", layer="core", kind="run", version=VERSION,
             provides=("run.lifecycle",),
             requires=("bus.events", "policy.gate", "contracts.task"), status="built"),
    Manifest(id="core.plugin_contract", layer="core", kind="contract", version=VERSION,
             provides=("plugins.contract",), requires=(), status="planned"),
    Manifest(id="core.plugin_registry", layer="core", kind="registry", version=VERSION,
             provides=("plugins.registry",), requires=("plugins.contract",), status="planned"),
)
