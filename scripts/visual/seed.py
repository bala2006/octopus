#!/usr/bin/env python3
"""Deterministic project data for the visual baseline.

Creates three projects in an isolated Octopus home:

* ``acme-web``: a company from the ``software_startup`` template, chat sessions, four runs (one finished
  brief, one finished build, one run paused on an approval, one paused on a question), artifacts, tasks, usage.
* ``notes-app``: a company from the ``solo_engineer`` template with no runs (empty activity state).
* ``empty-team``: a company with no agents (empty canvas state).

Projects, companies, and agents go through the public API, in process (no server needed). Run rows, run events,
messages, artifacts, tasks, and chat sessions are written straight into each project's SQLite database with fixed
ids and fixed timestamps. No model is called: the runs are recorded histories.

Every id is ``uuid5`` of a stable name, and every timestamp is before ``CLOCK``, the browser clock that capture.py
freezes. Bump ``SEED_VERSION`` whenever the seeded content changes, because it is recorded in the manifest.

Usage (capture.py runs this for you):
    python seed.py --home DIR --projects-root DIR --info FILE
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import shutil
import sys
import tempfile
import uuid
import warnings
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
BACKEND = HERE.parents[1] / "backend"

SEED_VERSION = "1"
CLOCK = "2026-01-15T12:00:00Z"  # the frozen browser clock; every seeded timestamp is earlier than this
DEFAULT_PROJECTS_ROOT = Path(tempfile.gettempdir()) / "octopus-visual" / "projects"
SEED_EMAIL = "demo@octopus.local"  # settings.single_user_email, the user every request resolves to


def app_env(home: Path, projects_root: Path) -> dict[str, str]:
    """Environment for the backend (seed and server). Machine-specific variables are dropped so the screens do not
    depend on the developer's shell: provider keys, Octopus overrides, browser and dialog helpers, and .env files
    (the caller also runs the backend from an empty working directory)."""
    drop = ("KEY", "TOKEN", "SECRET", "PASSWORD", "AZURE", "OPENAI", "ANTHROPIC", "GEMINI", "OLLAMA", "OCTOPUS",
            "PLAYWRIGHT", "BROWSER", "FOLDER_BRIDGE", "HOST_DIR", "PUBLIC_URL", "OPENCODE", "DEFAULT_", "MCP_", "NATIVE_",
            "SANDBOX", "SINGLE_USER", "REGISTRY", "WORKSPACE_", "RATE_LIMIT", "LOG_")
    env = {k: v for k, v in os.environ.items() if not any(t in k.upper() for t in drop)}
    env.update({
        "OCTOPUS_HOME": str(home),
        "WORKSPACE_ALLOWED_ROOTS": json.dumps([str(projects_root)]),
        "BROWSER_ENABLED": "false",
        "NATIVE_DIALOGS": "false",
        "MCP_ALLOW_STDIO": "false",
        "SINGLE_USER_MODE": "true",
        "RATE_LIMIT_PER_MINUTE": "100000",
        "LOG_LEVEL": "WARNING",
    })
    return env


def fid(name: str) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"octopus-visual/{SEED_VERSION}/{name}"))


def ts(text: str) -> datetime:
    """Naive UTC, the same shape as ``app.db.base.utcnow()``."""
    return datetime.fromisoformat(text)


def iso(value: datetime) -> str:
    return value.isoformat()


# --------------------------------------------------------------------------- project files on disk
INDEX_V1 = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Acme Web</title>
  <link rel="stylesheet" href="styles.css" />
</head>
<body>
  <header class="hero">
    <h1>Acme Web</h1>
    <p>Ship your product page in minutes.</p>
    <a class="cta" href="#features">Explore features</a>
  </header>
  <section id="features">
    <h2>Features</h2>
    <ul>
      <li>Fast static hosting</li>
      <li>Built-in analytics</li>
      <li>One-click deploys</li>
    </ul>
  </section>
</body>
</html>
"""

INDEX_V2 = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Acme Web</title>
  <link rel="stylesheet" href="styles.css" />
</head>
<body>
  <header class="hero">
    <h1>Acme Web</h1>
    <p>Ship your product page in minutes.</p>
    <a class="cta" href="#pricing">See pricing</a>
  </header>
  <section id="features">
    <h2>Features</h2>
    <ul>
      <li>Fast static hosting</li>
      <li>Built-in analytics</li>
      <li>One-click deploys</li>
    </ul>
  </section>
  <section id="pricing">
    <h2>Pricing</h2>
    <div class="plan">Starter · $0</div>
    <div class="plan">Team · $29 / month</div>
  </section>
</body>
</html>
"""

STYLES_V1 = """:root { --accent: #6d5efc; --ink: #1d1b2a; }
body { margin: 0; font-family: system-ui, sans-serif; color: var(--ink); }
.hero { padding: 96px 24px; text-align: center; background: #f5f4ff; }
.cta { display: inline-block; margin-top: 16px; padding: 12px 20px; background: var(--accent); color: #fff; border-radius: 8px; text-decoration: none; }
section { padding: 48px 24px; max-width: 880px; margin: 0 auto; }
"""

STYLES_V2 = STYLES_V1 + """.cta:focus-visible { outline: 3px solid #1d1b2a; outline-offset: 3px; }
.plan { border: 1px solid #e4e2f5; border-radius: 12px; padding: 16px; margin: 12px 0; }
"""

README = """# Acme Web

Marketing site for the Acme launch. Static HTML and CSS, no build step.

Open `index.html` in a browser to preview it.
"""

BRAND_BRIEF = """# Acme brand brief

Tone: calm, direct, a little playful.
Primary colour: violet #6d5efc.
Audience: small product teams that ship every week.
"""

NOTES_README = "# Notes App\n\nPersonal notes with search. Work in progress.\n"


# --------------------------------------------------------------------------- scenario
PROJECTS: list[dict[str, Any]] = [
    {"key": "acme-web", "name": "Acme Web", "dir": "acme-web", "last_opened": "2026-01-14 10:00:00",
     "company": {"name": "Acme Web team", "template": "software_startup", "created": "2026-01-08 09:00:00"}},
    {"key": "notes-app", "name": "Notes App", "dir": "notes-app", "last_opened": "2026-01-13 10:00:00",
     "company": {"name": "Notes team", "template": "solo_engineer", "created": "2026-01-10 09:00:00"}},
    {"key": "empty-team", "name": "Empty Team", "dir": "empty-team", "last_opened": "2026-01-12 10:00:00",
     "company": {"name": "Empty team", "template": None, "created": "2026-01-11 09:00:00"}},
]

# Agent titles from the software_startup template (role field). Names come from the template.
ROLE_TITLES = {"ceo": "CEO", "pm": "Product Manager", "designer": "UI/UX Designer", "architect": "Software Architect",
               "frontend": "Frontend Developer", "backend": "Backend Developer", "qa": "QA Engineer", "devops": "DevOps Engineer"}


def write_project_files(root: Path, key: str) -> None:
    if key == "acme-web":
        files = {"index.html": INDEX_V2, "styles.css": STYLES_V1, "README.md": README, "docs/brand-brief.md": BRAND_BRIEF}
    elif key == "notes-app":
        files = {"README.md": NOTES_README}
    else:
        files = {"README.md": "# Empty Team\n"}
    for rel, text in files.items():
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8", newline="\n")


# --------------------------------------------------------------------------- payload helpers
def message_payload(m: Any) -> dict[str, Any]:
    """Same keys as Engine.announce_message (the message_created event)."""
    return {"id": m.id, "run_id": m.run_id, "session_id": m.session_id, "sender": m.sender, "from_agent_id": m.from_agent_id,
            "to_agent_id": m.to_agent_id, "edge_id": m.edge_id, "type": m.type, "content": m.content, "meta": m.meta_json or {},
            "turn_no": m.turn_no, "created_at": iso(m.created_at)}


def usage(tokens: int, cost: float, turns: int, per_agent: dict[str, int], seconds: float, llm_calls: int) -> dict[str, Any]:
    """Same keys as Engine.usage_event (the usage_update event)."""
    return {"tokens": tokens, "cost_usd": round(cost, 8), "turns": turns, "max_turns": 60, "max_tokens": 400_000,
            "max_cost_usd": 2.0, "per_agent": per_agent, "active_seconds": round(seconds, 1), "timeout_s": 900,
            "per_agent_cost": {k: round(v * cost / max(tokens, 1), 6) for k, v in per_agent.items()},
            "input_tokens": int(tokens * 0.7), "cached_tokens": int(tokens * 0.2), "cache_write_tokens": 0,
            "output_tokens": tokens - int(tokens * 0.7), "reasoning_tokens": 0, "llm_calls": llm_calls, "estimated_calls": 0,
            "cost_breakdown": {"input": round(cost * 0.6, 6), "output": round(cost * 0.4, 6)}}


class Feed:
    """Writes run events and messages with fixed offsets from the run start. ``seq`` is the event row id."""

    def __init__(self, db: Any, run: Any, start: datetime, key: str) -> None:
        self.db, self.run, self.t0, self.key, self.n = db, run, start, key, 0

    def _at(self, seconds: int) -> datetime:
        return self.t0 + timedelta(seconds=seconds)

    def event(self, type_: str, data: dict[str, Any], at: int) -> None:
        from app.models import RunEvent
        self.db.add(RunEvent(run_id=self.run.id, type=type_, payload_json=data, created_at=self._at(at)))

    def message(self, sender: str, frm: str | None, to: str | None, type_: str, content: str, at: int, *,
                meta: dict[str, Any] | None = None, turn: int = 0, session_id: str | None = None,
                run_id: str | None = None, emit: bool = True) -> Any:
        from app.models import Message
        self.n += 1
        m = Message(id=fid(f"{self.key}:message:{self.n}"), run_id=run_id, session_id=session_id, sender=sender, from_agent_id=frm,
                    to_agent_id=to, edge_id=None, type=type_, content=content, meta_json=meta or {}, turn_no=turn, read=True,
                    created_at=self._at(at))
        self.db.add(m)
        if emit:
            self.event("message_created", {"message": message_payload(m)}, at)
        return m


def tool_pair(feed: Feed, key: str, agent: str, tool: str, args: dict[str, Any], output: str, at: int) -> None:
    call = fid(f"{feed.key}:call:{key}")
    feed.event("tool_call", {"call_id": call, "agent_id": agent, "tool": tool, "args": args}, at)
    feed.event("tool_result", {"call_id": call, "agent_id": agent, "tool": tool, "ok": True, "output": output}, at + 4)


def artifact(feed: Feed, db: Any, run: Any, path: str, version: int, content: str, author: str, at: int,
             previous: str | None, note: str) -> None:
    from app.models import Artifact
    db.add(Artifact(id=fid(f"{feed.key}:artifact:{path}:{version}"), run_id=run.id, path=path, content=content,
                    previous_content=previous, version=version, deleted=False, author_agent_id=author, change_note=note,
                    created_at=feed._at(at)))
    feed.event("artifact_updated", {"artifact": {"path": path, "version": version, "author_agent_id": author,
                                                 "created": version == 1, "deleted": False, "size": len(content.encode()),
                                                 "change_note": note}}, at)


def task_event(feed: Feed, run: Any, key: str, title: str, status: str, assignee: str | None, at: int,
               description: str = "", criteria: str = "") -> None:
    """One task_updated event per status change (the reducer keeps the latest state per task key)."""
    feed.event("task_updated", {"task": {"id": fid(f"{feed.key}:task:{key}"), "run_id": run.id, "key": key, "title": title,
                                         "description": description, "assignee": assignee, "status": status,
                                         "acceptance_criteria": criteria, "created_by": None, "constraints_json": {}}}, at)


def task_row(db: Any, feed: Feed, run: Any, key: str, title: str, status: str, assignee: str | None, at: int,
             description: str = "", criteria: str = "") -> None:
    """The tasks table keeps one row per task, in its final state."""
    from app.models import Task
    db.add(Task(id=fid(f"{feed.key}:task:{key}"), run_id=run.id, key=key, title=title, description=description,
                assignee_agent_id=assignee, status=status, acceptance_criteria=criteria, constraints_json={},
                created_by=None, updated_at=feed._at(at)))


def run_row(company_id: str, key: str, session_id: str | None, goal: str, status: str, start: datetime, tokens: int,
            cost: float, turns: int, summary: str, report: str, snapshot: dict[str, Any], ended: bool) -> Any:
    from app.models import Run
    return Run(id=fid(f"run:{key}"), company_id=company_id, session_id=session_id, goal=goal, status=status, mode="autonomous",
               permission_level="ask",
               budget_json={"max_turns": 60, "max_tokens": 400_000, "max_cost_usd": 2.0, "timeout_s": 900,
                            "reasoning_effort": "xhigh", "verify_before_finish": False, "workflow": "off"},
               snapshot_json=snapshot, state_json={"status": status, "turn_no": turns},
               tokens_used=tokens, cost_usd=cost, turns=turns, halt_reason="", summary=summary, report_md=report,
               created_at=start - timedelta(seconds=10), started_at=start,
               ended_at=start + timedelta(seconds=680) if ended else None)


# --------------------------------------------------------------------------- scenario data written per project
async def seed_acme(db: Any, company: Any, sessions: dict[str, str], agents: dict[str, Any], snapshot: dict[str, Any]) -> dict[str, str]:
    from app.models import Artifact, ChatSession, Message  # noqa: F401  (registers tables)

    ceo, pm, architect = agents["ceo"].id, agents["pm"].id, agents["architect"].id
    design, lena, backend, sam, noah = agents["designer"].id, agents["frontend"].id, agents["backend"].id, agents["qa"].id, agents["devops"].id
    db.add(ChatSession(id=sessions["scope"], company_id=company.id, agent_id=None, title="Landing page scope", mode="company",
                       created_at=ts("2026-01-13 16:00:00")))
    db.add(ChatSession(id=sessions["quick"], company_id=company.id, agent_id=lena, title="Hero section CSS", mode="direct",
                       created_at=ts("2026-01-14 08:50:00")))
    await db.flush()

    # chat threads (messages without a run)
    thread = Feed(db, None, ts("2026-01-13 16:00:00"), "chat-scope")
    thread.message("user", None, None, "chat", "We need a landing page for the Acme launch. Keep it simple.", 0, session_id=sessions["scope"], emit=False)
    thread.message("agent", pm, None, "chat", "Got it. One page: hero, features, pricing. I'll write the scope and pass it to Marcus.", 90, session_id=sessions["scope"], emit=False)
    thread.message("agent", ceo, None, "chat", "Agreed. Let's ship it this week. Tell me when you want the first draft.", 150, session_id=sessions["scope"], emit=False)
    thread.message("user", None, None, "chat", "Please draft a short brand brief first.", 900, session_id=sessions["scope"], emit=False)
    thread.message("agent", pm, None, "chat", "On it. The brief will be in the project files shortly.", 960, session_id=sessions["scope"], emit=False)
    quick = Feed(db, None, ts("2026-01-14 08:50:00"), "chat-quick")
    quick.message("user", None, lena, "chat", "Which CSS approach should we use for the hero section?", 0, session_id=sessions["quick"], emit=False)
    quick.message("agent", lena, None, "chat", "Plain CSS with custom properties keeps the bundle small. We don't need a framework for one page.", 40, session_id=sessions["quick"], emit=False)
    quick.message("user", None, lena, "chat", "Good. Use that.", 120, session_id=sessions["quick"], emit=False)
    quick.message("agent", lena, None, "chat", "Done. The accent colour is a variable at the top of styles.css.", 150, session_id=sessions["quick"], emit=False)

    # R0: finished brief, January 9
    r0_start = ts("2026-01-09 10:00:00")
    r0 = run_row(company.id, "brief", None, "Draft the brand brief", "completed", r0_start, 42_310, 0.18, 4,
                 "Brand brief is in docs/brand-brief.md.", "# Team recap\n\nDrafted the brand brief.", snapshot, True)
    db.add(r0); await db.flush()
    f = Feed(db, r0, r0_start, "brief")
    f.event("run_status", {"status": "running", "reason": "", "awaiting": None, "pending_approval": None}, 0)
    f.message("user", None, pm, "task", "Draft a short brand brief for Acme: tone, colours, audience.", 3, turn=0, run_id=r0.id)
    f.event("agent_status", {"agent_id": pm, "status": "working", "activity": "Writing the brief"}, 6)
    tool_pair(f, "brief-write", pm, "write_file", {"path": "docs/brand-brief.md"}, "Wrote docs/brand-brief.md", 40)
    artifact(f, db, r0, "docs/brand-brief.md", 1, BRAND_BRIEF, pm, 42, None, "First draft of the brand brief")
    f.message("agent", pm, ceo, "status_update", "Brief drafted: tone, violet primary colour, audience. Ready for the landing page.", 60, turn=1, run_id=r0.id)
    f.event("usage_update", usage(42_310, 0.18, 4, {pm: 42_310}, 95, 4), 90)
    task_row(db, f, r0, "T-1", "Brand brief", "done", pm, 60, "Tone, colours, and audience", "Brief is in docs/brand-brief.md")
    f.event("run_status", {"status": "completed", "reason": "", "summary": "Brand brief is in docs/brand-brief.md.", "final": True}, 680)

    # R1: finished landing page, January 14 (timeline + artifacts + tasks + tools)
    r1_start = ts("2026-01-14 09:30:00")
    r1_summary = "Landing page is ready in index.html and styles.css. QA passed after one focus-style fix."
    r1 = run_row(company.id, "landing", sessions["scope"], "Build the Acme landing page with a pricing section", "completed", r1_start,
                 84_210, 0.42, 9, r1_summary, "# Team recap\n\nBuilt the Acme landing page: hero, features, and pricing. "
                 "QA checked the page on mobile widths.", snapshot, True)
    db.add(r1); await db.flush()
    f = Feed(db, r1, r1_start, "landing")
    f.event("run_status", {"status": "running", "reason": "", "awaiting": None, "pending_approval": None}, 0)
    f.message("user", None, ceo, "task", "Build the Acme landing page: hero, three features, and a pricing section. One static page.", 3, turn=0, run_id=r1.id)
    f.event("agent_status", {"agent_id": ceo, "status": "working", "activity": "Planning the page"}, 8)
    f.message("agent", ceo, pm, "task", "Scope a single landing page with a hero, three features, and two pricing plans.", 20, turn=1, run_id=r1.id)
    f.message("agent", pm, architect, "task", "Technical design: static HTML and CSS, no build step.", 45, turn=2, run_id=r1.id)
    f.message("agent", architect, lena, "task", "Frontend tasks: index.html and styles.css. Mobile first.", 70, turn=3, run_id=r1.id)
    task_event(f, r1, "T-1", "Page structure", "in_progress", lena, 95, "Hero, features, and layout in index.html", "Renders without errors")
    f.event("agent_status", {"agent_id": lena, "status": "working", "activity": "Writing index.html"}, 100)
    tool_pair(f, "build", lena, "run_code", {"command": "npm run build"}, "Build complete in 1.2s", 120)
    artifact(f, db, r1, "index.html", 1, INDEX_V1, lena, 150, None, "Hero and features")
    artifact(f, db, r1, "styles.css", 1, STYLES_V1, lena, 175, None, "Base layout and accent colour")
    task_event(f, r1, "T-1", "Page structure", "done", lena, 195, "Hero, features, and layout in index.html", "Renders without errors")
    task_event(f, r1, "T-2", "Pricing section", "in_progress", lena, 200, "Two plans on the page", "Plans are readable on mobile")
    f.message("agent", lena, sam, "task", "Ready for QA: index.html and styles.css. Please check mobile widths.", 240, turn=4, run_id=r1.id)
    f.event("usage_update", usage(40_000, 0.2, 4, {ceo: 6_000, pm: 9_000, architect: 9_000, lena: 16_000}, 210, 9), 180)
    f.message("agent", sam, pm, "review_result", "Pricing renders on mobile widths. No console errors. Add a focus style to the CTA.", 275, turn=5, run_id=r1.id)
    tool_pair(f, "qa", sam, "run_code", {"command": "npx playwright test --project=mobile"}, "2 tests passed", 290)
    artifact(f, db, r1, "index.html", 2, INDEX_V2, lena, 310, INDEX_V1, "Pricing plans and CTA target")
    artifact(f, db, r1, "styles.css", 2, STYLES_V2, lena, 318, STYLES_V1, "Focus style for the CTA, plan cards")
    task_event(f, r1, "T-2", "Pricing section", "done", lena, 330, "Two plans on the page", "Plans are readable on mobile")
    f.message("agent", pm, ceo, "status_update", "Landing page is ready: index.html and styles.css. QA passed.", 345, turn=6, run_id=r1.id)
    f.event("usage_update", usage(84_210, 0.42, 9, {ceo: 9_800, pm: 17_400, architect: 14_100, lena: 31_900, sam: 11_010}, 610, 14), 600)
    f.event("run_status", {"status": "completed", "reason": "", "summary": r1_summary, "final": True}, 680)
    task_row(db, f, r1, "T-1", "Page structure", "done", lena, 195, "Hero, features, and layout in index.html", "Renders without errors")
    task_row(db, f, r1, "T-2", "Pricing section", "done", lena, 330, "Two plans on the page", "Plans are readable on mobile")

    # R2: paused on an approval card (write_file), January 14 morning
    r2_start = ts("2026-01-14 10:02:05")
    approval_id = fid("run:approval:approval-1")
    preview = ("--- index.html\n+++ index.html\n@@ -17,6 +17,21 @@\n   </section>\n+  <section id=\"contact\">\n+    <h2>Contact</h2>\n"
               "+    <form action=\"/contact\" method=\"post\">\n+      <input name=\"email\" type=\"email\" required />\n"
               "+      <textarea name=\"message\" required></textarea>\n+      <button type=\"submit\">Send</button>\n+    </form>\n+  </section>\n")
    pending = {"id": approval_id, "agent_id": lena, "kind": "write_file",
               "summary": "Edit index.html: add a contact form", "preview": preview,
               "details": {"path": "index.html", "old": "  </section>\n</body>", "new": "  </section>\n  <section id=\"contact\">...</section>\n</body>",
                           "note": "Adds a contact section after pricing."}, "level": "ask"}
    r2 = run_row(company.id, "approval", None, "Add a contact form to the landing page", "awaiting_user", r2_start, 19_400, 0.12, 4,
                 "", "", snapshot, False)
    db.add(r2); await db.flush()
    f = Feed(db, r2, r2_start, "approval")
    f.event("run_status", {"status": "running", "reason": "", "awaiting": None, "pending_approval": None}, 0)
    f.message("user", None, ceo, "task", "Add a contact form under the pricing section: name, email, and message.", 3, turn=0, run_id=r2.id)
    f.message("agent", ceo, lena, "task", "Add a contact section to index.html after pricing.", 10, turn=1, run_id=r2.id)
    f.event("agent_status", {"agent_id": lena, "status": "working", "activity": "Editing index.html"}, 14)
    f.event("approval_requested", pending, 60)
    f.event("agent_status", {"agent_id": lena, "status": "awaiting_approval", "activity": "Edit index.html: add a contact form"}, 60)
    f.event("run_status", {"status": "awaiting_user", "reason": "Approval needed: Edit index.html: add a contact form",
                           "awaiting": None, "pending_approval": pending}, 60)

    # R3: paused on a question card (request_user_input), January 14 afternoon
    r3_start = ts("2026-01-14 11:15:00")
    question = "Should the Acme site go on static hosting or a container?"
    options = [{"label": "Static hosting", "description": "Cheapest and fastest. No server to maintain.", "recommended": True},
               {"label": "Container", "description": "Needed later if the site gets server features.", "recommended": False}]
    r3 = run_row(company.id, "question", None, "Choose a hosting option for the launch", "awaiting_user", r3_start, 12_600, 0.07, 3,
                 "", "", snapshot, False)
    db.add(r3); await db.flush()
    f = Feed(db, r3, r3_start, "question")
    f.event("run_status", {"status": "running", "reason": "", "awaiting": None, "pending_approval": None}, 0)
    f.message("user", None, ceo, "task", "Decide where the launch site should be hosted before we deploy.", 3, turn=0, run_id=r3.id)
    f.message("agent", ceo, noah, "task", "Compare static hosting with a container for the Acme site. Recommend one.", 15, turn=1, run_id=r3.id)
    f.event("agent_status", {"agent_id": noah, "status": "working", "activity": "Comparing hosting options"}, 40)
    qmsg = f.message("agent", noah, None, "question", question, 120, turn=2, run_id=r3.id,
                     meta={"awaiting_input": True, "options": options, "allow_other": True})
    awaiting = {"agent_id": noah, "question": question, "message_id": qmsg.id, "options": options, "allow_other": True}
    f.event("agent_status", {"agent_id": noah, "status": "waiting", "activity": "Waiting for your answer"}, 120)
    f.event("run_status", {"status": "awaiting_user", "reason": "Waiting for your answer", "awaiting": awaiting,
                           "pending_approval": None}, 120)

    return {"scope": sessions["scope"], "quick": sessions["quick"], "complete": r1.id, "brief": r0.id, "approval": r2.id,
            "question": r3.id}


async def seed(home: Path, projects_root: Path) -> dict[str, Any]:
    import httpx
    from sqlalchemy import select

    from app.core.config import get_settings
    from app.db.migrate import upgrade_registry
    from app.db.session import dispose_all, project_factory, registry_engine, registry_factory
    from app.main import app
    from app.models import Agent, Company, Workspace
    from app.schemas import CanvasOut
    from app.services.canvas import snapshot

    upgrade_registry(get_settings().registry_database_url)
    info: dict[str, Any] = {"seed_version": SEED_VERSION, "clock": CLOCK, "projects": {}}

    if projects_root.exists():
        shutil.rmtree(projects_root)
    projects_root.mkdir(parents=True)

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://seed.local") as api:
        r = await api.put("/api/v1/settings/approval-mode", json={"approval_mode": "ask"})
        r.raise_for_status()
        for spec in PROJECTS:
            root = projects_root / spec["dir"]
            root.mkdir(parents=True)
            write_project_files(root, spec["key"])
            r = await api.post("/api/v1/workspaces", json={"path": str(root), "name": spec["name"]})
            r.raise_for_status()
            ws_id = r.json()["id"]
            base = f"/api/v1/w/{ws_id}"
            comp = spec["company"]
            if comp["template"]:
                r = await api.post(f"{base}/companies/from-template", json={"template_key": comp["template"], "name": comp["name"]})
            else:
                r = await api.post(f"{base}/companies", json={"name": comp["name"]})
            r.raise_for_status()
            canvas = CanvasOut.model_validate(r.json())
            company_id = canvas.company.id
            if comp["template"]:
                canvas = await remap_ids(api, base, canvas)

            sf = await project_factory(str(root), root)
            async with sf() as db:
                company = await db.get(Company, company_id)
                company.created_at = ts(comp["created"])
                company.updated_at = ts(comp["created"])
                await db.flush()
                agents = {a.role: a for a in (await db.execute(select(Agent).where(Agent.company_id == company_id))).scalars().all()}
                snap = snapshot(company)
                ids: dict[str, Any] = {"company_id": company_id, "workspace_id": ws_id, "agents": {
                    key: agents[title].id for key, title in ROLE_TITLES.items() if title in agents}}
                if spec["key"] == "acme-web":
                    by_key = {key: agents[title] for key, title in ROLE_TITLES.items()}
                    ids.update(await seed_acme(db, company, {"scope": fid("session:scope"), "quick": fid("session:quick")}, by_key, snap))
                    ids["sessions"] = {"scope": fid("session:scope"), "quick": fid("session:quick")}
                await db.commit()
            info["projects"][spec["key"]] = {"name": spec["name"], "path": str(root), **ids}

            # registry row: fixed created and last-opened times, so the welcome list order is the same on every run
            async with registry_factory()() as rdb:
                w = await rdb.get(Workspace, ws_id)
                w.created_at = ts("2026-01-08 08:00:00")
                w.last_opened_at = ts(spec["last_opened"])
                await rdb.commit()
    await dispose_all()
    await registry_engine().dispose()
    return info


async def remap_ids(api: Any, base: str, canvas: Any) -> Any:
    """Replace random template ids with ids derived from each agent's role, so every run uses the same ids."""
    from app.schemas import AgentIn, CanvasOut, EdgeIn

    key_of = {a.id: f"agent:{a.role}:{a.name}" for a in canvas.agents}
    new_id = {old: fid(key) for old, key in key_of.items()}
    agents = []
    for a in canvas.agents:
        data = AgentIn.model_validate(a.model_dump(mode="json")).model_dump(mode="json")
        data["id"] = new_id[a.id]
        data["reports_to"] = new_id.get(a.reports_to) if a.reports_to else None
        agents.append(data)
    edges = []
    for e in canvas.edges:
        data = EdgeIn.model_validate(e.model_dump(mode="json")).model_dump(mode="json")
        # the id must come from the remapped agent ids: the template's own ids are random on every run
        data["source_agent_id"] = new_id[e.source_agent_id]
        data["target_agent_id"] = new_id[e.target_agent_id]
        data["id"] = fid(f"edge:{data['source_agent_id']}:{data['target_agent_id']}:{e.type}")
        edges.append(data)
    body = {"agents": agents, "edges": edges, "viewport": canvas.viewport,
            "departments": {k: v.model_dump(mode="json") for k, v in canvas.departments.items()}, "revision": canvas.revision}
    r = await api.put(f"{base}/companies/{canvas.company.id}/canvas", json=body)
    r.raise_for_status()
    return CanvasOut.model_validate(r.json())


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--home", required=True, type=Path, help="OCTOPUS_HOME for this capture (fresh directory)")
    parser.add_argument("--projects-root", type=Path, default=DEFAULT_PROJECTS_ROOT, help="directory that holds the seeded projects")
    parser.add_argument("--info", required=True, type=Path, help="where to write the seed info JSON")
    args = parser.parse_args()

    # Canvas sync (app code) deletes the template edges through the ORM after the agents' ON DELETE CASCADE already
    # removed them. SQLAlchemy warns about the zero-row count; the seed does not depend on it.
    warnings.filterwarnings("ignore", message="DELETE statement on table")
    args.home.mkdir(parents=True, exist_ok=True)
    os.environ.update(app_env(args.home, args.projects_root))
    sys.path.insert(0, str(BACKEND))
    os.chdir(args.home)  # no .env files are read from the repository
    info = asyncio.run(seed(args.home, args.projects_root))
    args.info.write_text(json.dumps(info, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"seeded {len(info['projects'])} projects (seed version {SEED_VERSION})")


if __name__ == "__main__":
    main()
