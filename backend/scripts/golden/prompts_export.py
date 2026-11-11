"""System prompt of every built-in role, built by the real turn-prompt path (app.kernel.runtime.context.build_turn_prompts).

Each role sits in one fixed team: a CEO lead, the role under test, a direct report and a peer. The run is held in memory. Its
project database is a fresh, migrated SQLite file that holds only the company, the team and the run rows, so the scoped memory
section is read from an empty store with a valid identity.
"""
from __future__ import annotations

import tempfile
from pathlib import Path
from typing import Any

from sqlalchemy.ext.asyncio import async_sessionmaker

from app.storage.migrate import upgrade_project
from app.storage.session import make_engine, project_url
from app.storage.models import Agent, Company, Run
from app.kernel.runtime.context import build_turn_prompts
from app.kernel.run_manager import ProjectRef
from app.kernel.runtime.engine import RunRuntime
from app.plugins.roles.prompts import agent_from_role, all_roles

GOAL = "Build a small todo web app"
COMPANY = "Golden Co"
USER_ID, COMPANY_ID, RUN_ID, WORKSPACE_ID = "golden-user", "golden-company", "golden-run", "golden-workspace"
PROVIDER, MODEL = "azure", "gpt-6-luna"  # fixed here: agent_from_role reads the environment default
NATIVE = True  # the function-calling format used with the Azure provider


def _member(aid: str, key: str, *, name: str | None = None, department: str = "Golden Dept", reports_to: str | None = None,
            **kw: Any) -> dict[str, Any]:
    spec = agent_from_role(key, name=name, department=department, **kw)
    return {**spec, "id": aid, "provider": PROVIDER, "model": MODEL, "active": True, "created_by": None, "reports_to": reports_to}


def _team(subject_key: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    lead = _member("lead", "ceo", name="Ava", entry=True, department="Executive", is_manager=True)
    subject = _member("subject", subject_key, name="Subj", reports_to="lead")
    report = _member("report", "developer", name="Rae", reports_to="subject")
    peer = _member("peer", "qa", name="Quinn", department="Quality", reports_to="lead")
    edges = [
        {"id": "e-1", "source_agent_id": "lead", "target_agent_id": "subject", "type": "delegate", "bidirectional": False, "config": {}},
        {"id": "e-2", "source_agent_id": "subject", "target_agent_id": "lead", "type": "report", "bidirectional": False, "config": {}},
        {"id": "e-3", "source_agent_id": "subject", "target_agent_id": "report", "type": "delegate", "bidirectional": False, "config": {}},
        {"id": "e-4", "source_agent_id": "subject", "target_agent_id": "peer", "type": "review", "bidirectional": False, "config": {}},
        {"id": "e-5", "source_agent_id": "report", "target_agent_id": "subject", "type": "report", "bidirectional": False, "config": {}},
    ]
    return [lead, subject, report, peer], edges


def _run(agents: list[dict[str, Any]], edges: list[dict[str, Any]]) -> Run:
    return Run(id=RUN_ID, company_id=COMPANY_ID, session_id=None, goal=GOAL, status="queued", mode="autonomous",
               permission_level="auto", budget_json={}, state_json={}, tokens_used=0, cost_usd=0.0, turns=0,
               snapshot_json={"company": {"name": COMPANY}, "agents": agents, "edges": edges, "departments": {}})


async def _seed(sf: async_sessionmaker, agents: list[dict[str, Any]]) -> None:
    """Scoped memory checks that the company, an active agent and the run exist in the project database."""
    async with sf() as db:
        db.add(Company(id=COMPANY_ID, user_id=USER_ID, name=COMPANY))
        for a in agents:
            db.add(Agent(id=a["id"], company_id=COMPANY_ID, name=a["name"], role=a["role"], active=True))
        db.add(_run(agents, []))
        await db.commit()


async def _system_prompt(role_key: str, root: Path, sf: async_sessionmaker) -> str:
    agents, edges = _team(role_key)
    runtime = RunRuntime(_run(agents, edges), USER_ID, ProjectRef(workspace_id=WORKSPACE_ID, root=root, sf=sf))
    subject = runtime.agents["subject"]
    memory = await runtime.execution.scoped_context(subject.id)
    system, _user = build_turn_prompts(runtime, subject, set(), [], native=NATIVE, memory_context=memory)
    return system


async def prompt_texts() -> dict[str, str]:
    """Role key -> system prompt text, for every built-in role (roles.py and roles_org.py)."""
    texts: dict[str, str] = {}
    with tempfile.TemporaryDirectory(prefix="golden-prompts-") as tmp:
        root = Path(tmp)
        (root / ".octopus").mkdir()
        upgrade_project(project_url(root))
        engine = make_engine(project_url(root))
        try:
            sf = async_sessionmaker(engine, expire_on_commit=False)
            team, _edges = _team("developer")
            await _seed(sf, team)
            for key in sorted(all_roles()):
                texts[key] = await _system_prompt(key, root, sf)
        finally:
            await engine.dispose()
    return texts
