"""Shared content, palette and timeline for the Octopus pitch artifacts.

Used by:
  build_pptx.py  - imports the palette
  build_audio.py - imports the scene timeline so the score matches the video length
  render_video.py- imports the scene timeline and on-screen copy

The pitch is Octopus ("Your AI company, in one folder") prepared for Vivek.
"""

from __future__ import annotations

# ---------------------------------------------------------------------------
# Brand palette (matches docs/brand: warm neutrals + terracotta / olive / steel)
# ---------------------------------------------------------------------------
PALETTE = {
    "bg": "#1F1E1D",
    "bg_deep": "#141413",
    "panel": "#2C2C2C",
    "line": "#444442",
    "text": "#F5F4EE",
    "text_soft": "#E9E8E5",
    "muted": "#A9A69E",
    "dim": "#8A8780",
    "accent": "#D97756",   # terracotta
    "olive": "#6B8440",
    "steel": "#66839A",
    "cream": "#FAF9F5",
}

DECK_TITLE = "Octopus - Your AI company, in one folder"
DECK_SUBTITLE = "Pitch prepared for Vivek"

# ---------------------------------------------------------------------------
# Video timeline
# ---------------------------------------------------------------------------
FPS = 60
WIDTH, HEIGHT = 1920, 1080
TRANSITION = 0.9  # seconds of overlap between consecutive scenes

# On-screen copy for the video (condensed from the deck).
VIDEO_SCENES: list[dict] = [
    {
        "id": "hero",
        "kind": "hero",
        "dur": 7.5,
        "kicker": "PITCH \u00b7 PREPARED FOR VIVEK",
        "title": "Octopus",
        "subtitle": "Your AI company, in one folder.",
        "chips": ["Local-first", "Azure OpenAI gpt-6-luna", "Demo Mode \u00b7 no keys"],
    },
    {
        "id": "problem",
        "kind": "bullets",
        "dur": 7.0,
        "kicker": "THE PROBLEM",
        "title": "Software is a team sport.\nAI tooling forgot that.",
        "bullets": [
            {"h": "One chat window", "d": "Every AI coding tool is a single agent with no structure."},
            {"h": "You are the middleware", "d": "Planning, review and QA live in your head \u2014 you relay every message."},
            {"h": "No control surface", "d": "What ran, what it changed, what it cost: nobody can say."},
        ],
    },
    {
        "id": "idea",
        "kind": "bullets",
        "dur": 7.5,
        "kicker": "THE IDEA",
        "title": "A small company of AI agents.",
        "bullets": [
            {"h": "Pick a folder, pick a team, give it a goal", "d": "CEO \u00b7 PM \u00b7 engineers \u00b7 reviewer \u00b7 QA \u2014 wired with typed channels."},
            {"h": "They do the work", "d": "Plan, debate, delegate, write real files, review each other, run the tests."},
            {"h": "You stay the boss", "d": "Watch it live, approve the risky steps, keep the conversation going."},
        ],
        "sub": "Everything lives in <folder>/.octopus/ \u2014 like .git.",
    },
    {
        "id": "how",
        "kind": "steps",
        "dur": 7.5,
        "kicker": "HOW A RUN WORKS",
        "title": "Goal in. Software out.",
        "steps": [
            "Goal to entry agent",
            "Plan & debate",
            "Build real files",
            "Review + tests",
            "Ship & report",
        ],
        "sub": "One runtime per run \u00b7 validated JSON actions \u00b7 channels enforced server-side \u00b7 every event replayable",
    },
    {
        "id": "product",
        "kind": "cards4",
        "dur": 7.5,
        "kicker": "PRODUCT",
        "title": "A whole product, not a demo.",
        "cards": [
            {"t": "Org canvas", "d": "14 templates, departments, delegate / report / review / debate / consult channels."},
            {"t": "Live run", "d": "Animated graph, message feed, task board, approvals, pause, interject, replay."},
            {"t": "Runs are chats", "d": "Type \u201cadd a dark mode toggle\u201d \u2014 same run, same team, full history."},
            {"t": "Artifacts", "d": "Every file version diffed, revertable, zippable \u2014 plus a live preview."},
        ],
    },
    {
        "id": "control",
        "kind": "bullets",
        "dur": 7.5,
        "kicker": "CONTROL & SAFETY",
        "title": "Autonomy with a leash.",
        "bullets": [
            {"h": "read_only \u2192 plan \u2192 ask \u2192 danger", "d": "The effective level is min(run, agent). You choose per run and per agent."},
            {"h": "Approve with a diff", "d": "Every write, command and MCP call can block for your sign-off."},
            {"h": "Budgets & loop detection", "d": "Turns, tokens, cost, wall-clock \u2014 runaway runs auto-pause for review."},
            {"h": "Real sandboxing", "d": "No shell, scrubbed env, rlimits, no network, allowlist (or Docker)."},
        ],
    },
    {
        "id": "model",
        "kind": "bullets",
        "dur": 7.0,
        "kicker": "THE MODEL LAYER",
        "title": "One model, done properly.",
        "bullets": [
            {"h": "Azure OpenAI gpt-6-luna", "d": "Straight over the v1 Responses API \u2014 no api-version quirks."},
            {"h": "Exact usage, exact cost", "d": "Uncached \u00b7 cached \u00b7 cache writes \u00b7 output incl. reasoning, priced live."},
            {"h": "Reasoning effort per agent", "d": "From none to max \u2014 tune how hard each role thinks."},
            {"h": "Demo Mode", "d": "A scripted offline company. No keys, no network, free to try."},
        ],
    },
    {
        "id": "stack",
        "kind": "cards4",
        "dur": 7.5,
        "kicker": "ENGINEERING",
        "title": "Built like real software.",
        "cards": [
            {"t": "Backend", "d": "FastAPI \u00b7 SQLAlchemy + Alembic \u00b7 SQLite \u00b7 WebSockets \u00b7 structlog \u00b7 MCP."},
            {"t": "Frontend", "d": "React 18 + TypeScript \u00b7 Vite \u00b7 Tailwind \u00b7 React Flow \u00b7 Zustand \u00b7 Monaco."},
            {"t": "Typed by contract", "d": "TS client generated from OpenAPI; agents answer a validated JSON schema."},
            {"t": "Tested & shipped", "d": "pytest \u00b7 vitest \u00b7 Playwright E2E \u00b7 CI on every push \u00b7 CD to GHCR \u00b7 Docker."},
        ],
    },
    {
        "id": "proof",
        "kind": "bullets",
        "dur": 7.0,
        "kicker": "PROOF",
        "title": "Proof, not promises.",
        "bullets": [
            {"h": "216 files \u00b7 23,000+ lines", "d": "A complete product: backend, frontend, migrations, tests, docs, CI/CD."},
            {"h": "14 team templates", "d": "Software startup, game studio, security audit, research lab \u2026"},
            {"h": "1-minute demo, real footage", "d": "Recorded from the actual app in Demo Mode \u2014 no mock-ups."},
            {"h": "One command to run", "d": "make setup && make start \u2192 localhost:8000. Fully offline."},
        ],
    },
    {
        "id": "ask",
        "kind": "cards3",
        "dur": 7.5,
        "kicker": "THE ASK",
        "title": "Vivek, here is the ask.",
        "cards": [
            {"n": "01", "t": "Be our first power user", "d": "Run one real goal end to end this week \u2014 and tear it apart."},
            {"n": "02", "t": "Open doors", "d": "Intros to 3 teams who would run an AI company daily."},
            {"n": "03", "t": "Advise us", "d": "Pricing, open-source GTM and the path to a hosted version."},
        ],
        "sub": "In return: the 90-day roadmap and a build partner who ships weekly.",
    },
    {
        "id": "closing",
        "kind": "closing",
        "dur": 7.0,
        "title": "Assemble an AI company.\nGive it a goal. Ship.",
        "sub": "github.com/bala2006/octopus",
        "footer": "Thank you, Vivek.",
    },
]


# ---------------------------------------------------------------------------
# Timeline helpers
# ---------------------------------------------------------------------------
def scene_starts() -> list[float]:
    """Start time of each scene (consecutive scenes overlap by TRANSITION)."""
    starts: list[float] = []
    t = 0.0
    for i, sc in enumerate(VIDEO_SCENES):
        starts.append(round(t, 6))
        if i < len(VIDEO_SCENES) - 1:
            t += sc["dur"] - TRANSITION
    return starts


def total_duration() -> float:
    starts = scene_starts()
    return starts[-1] + VIDEO_SCENES[-1]["dur"]


def total_frames() -> int:
    return int(round(total_duration() * FPS))


def segment_bounds(n_segments: int) -> list[tuple[int, int]]:
    """Frame ranges [i0, i1) for n_segments render workers."""
    total = total_frames()
    bounds = []
    for k in range(n_segments):
        i0 = round(total * k / n_segments)
        i1 = round(total * (k + 1) / n_segments)
        bounds.append((i0, i1))
    return bounds
