"""Task-aware specialist advice without extra LLM calls or unnecessary agents."""
from __future__ import annotations

import re
from dataclasses import dataclass


@dataclass(frozen=True)
class GoalProfile:
    suggested_track: str
    checks: tuple[str, ...]
    reason: str


SIGNALS = {
    "ux": r"\b(ui|ux|onboarding|screen|layout|animation|visual|responsive|accessib\w*|design|frontend)\b",
    "security": r"\b(auth\w*|security|permission\w*|secret\w*|encrypt\w*|payment\w*|credential\w*)\b",
    "performance": r"\b(performance|latency|slow|memory|fps|profil\w*|bottleneck\w*|optimiz\w*)\b",
    "integration": r"\b(integrat\w*|migration|backend|api|database|subscription|end.to.end|navigation|routing)\b",
    "research": r"\b(research|compare|investigat\w*|survey|unknown|explore)\b",
}
GUIDANCE = {
    "ux": "Inspect the real rendered UI; check interactions, states, responsive layout and accessibility.",
    "security": "Check authorization boundaries, untrusted inputs, secrets and security regressions.",
    "performance": "Measure baseline and after-change behavior; give reproducible measurements.",
    "integration": "Verify affected callers, interfaces, data flow and failure handling end-to-end.",
    "research": "Distinguish sourced facts from assumptions and evaluate alternatives.",
}


def profile_goal(goal: str) -> GoalProfile:
    text = goal.lower()[:20000]
    checks = tuple(key for key, pattern in SIGNALS.items() if re.search(pattern, text))
    large = bool(re.search(r"\b(entire|whole|complete|full|from scratch|multi.service|multi.module|end.to.end system)\b", text)
                 and re.search(r"\b(build|create|implement|develop|rebuild|redesign|architect|migrat\w*)\b", text))
    standard = bool(re.search(r"\b(feature|refactor|implement|redesign|migrat\w*|onboarding|integrat\w*|application|app|system)\b", text))
    track = "large" if large else "standard" if standard else "quick"
    reason = ("Several coordinated deliverables" if large else "Feature or cross-cutting change" if standard
              else "One coherent task; avoid unnecessary handoffs")
    return GoalProfile(track, checks, reason)


def quality_brief(goal: str) -> str:
    checks = profile_goal(goal).checks
    if not checks:
        return "Run relevant executable checks and report exact results and limitations."
    return "\n".join("- " + GUIDANCE[check] for check in checks)


def specialist_bonus(role: str, key: str, phase: str, goal: str) -> int:
    """Rank eligible specialists by task relevance; never turn an ineligible role into an owner."""
    focus = set(profile_goal(goal).checks)
    description = (role + " " + key).lower()
    if phase not in ("design", "review", "test"):
        return 0
    if "security" in focus and re.search(r"security|appsec", description):
        return 5
    if "performance" in focus and re.search(r"performance|sre|profil", description):
        return 5
    if "ux" in focus and re.search(r"ux|ui|design|frontend|e2e|playtest", description):
        return 4
    if "integration" in focus and re.search(r"qa|integration|e2e|backend|architect", description):
        return 3
    return 0

def default_company_template(goal: str) -> str:
    """Small tasks stay solo; feature work gets an independent QA agent.

    Larger visual product builds may justify a UX specialist and browser tester.
    This is the initial team, not an instruction to activate every member on every run.
    """
    profile = profile_goal(goal)
    if profile.suggested_track == "quick":
        return "solo_engineer"
    if profile.suggested_track == "large" and "ux" in profile.checks:
        return "web_app_studio"
    return "small_dev_team"
