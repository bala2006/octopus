"""Deterministic task director and outcome gates (no live model required)."""
from app.orchestrator.director import profile_goal, quality_brief, specialist_bonus
from app.orchestrator.quality import assess_completion


def test_simple_goals_do_not_spawn_specialists():
    profile = profile_goal("Fix typo in README")
    assert profile.suggested_track == "quick"
    assert not profile.checks


def test_cross_cutting_work_gets_relevant_checks():
    profile = profile_goal("Redesign full onboarding app navigation, optimize FPS and fix auth")
    assert profile.suggested_track == "large"
    assert {"ux", "performance", "security", "integration"} <= set(profile.checks)
    brief = quality_brief("Fix authentication and slow screen")
    assert "authorization" in brief and "Measure" in brief


def test_specialist_tie_breakers_are_goal_specific():
    assert specialist_bonus("Security Engineer", "security_engineer", "review", "Fix auth permissions") > 0
    assert specialist_bonus("UX Designer", "ux_designer", "design", "Update onboarding UI") > 0
    assert specialist_bonus("UX Designer", "ux_designer", "design", "Fix SQL permissions") == 0


def test_failed_phase_and_open_tasks_cannot_complete():
    status, reason = assess_completion("completed", "", workflow={"ended": True, "phases": [{"key": "test", "status": "failed"}]},
                                       open_tasks=[{"key": "T1"}], broken_files={}, unverified={}, require_verification=False)
    assert status == "incomplete" and "failed workflow" in reason and "unfinished task" in reason


def test_unverified_code_downgrades_outcome_when_checks_enabled():
    kwargs = dict(workflow=None, open_tasks=[], broken_files={}, require_verification=True)
    assert assess_completion("completed", "", unverified={"src/app.py": 1}, **kwargs)[0] == "incomplete"
    assert assess_completion("completed", "", unverified={}, **kwargs)[0] == "completed"
    assert assess_completion("failed", "budget", unverified={}, **kwargs) == ("failed", "budget")

def test_unrelated_successful_command_is_not_code_verification():
    from app.orchestrator.quality import command_is_verification

    assert not command_is_verification("python --version", ["src/app.py"])
    assert not command_is_verification("ls", ["src/app.py"])
    assert command_is_verification("python src/app.py", ["src/app.py"])
    assert command_is_verification("pytest -q", ["src/app.py"])
    assert command_is_verification("npm run build", ["src/index.ts"])
