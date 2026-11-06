from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest

from app.api.v1.activity import summarize
from app.db.session import project_factory
from app.models import Company, Run, RunEvent


def test_usage_deltas_local_days_and_streaks():
    run = Run(tokens_used=350, budget_json={"reasoning_effort": "high"}, created_at=datetime(2026, 10, 30))
    def event(kind, stamp, payload):
        return RunEvent(type=kind, created_at=datetime.fromisoformat(stamp), payload_json=payload)
    events = [
        event("usage_update", "2026-10-30T17:00:00", {"tokens": 100, "active_seconds": 60}),
        event("usage_update", "2026-10-30T20:00:00", {"tokens": 250, "active_seconds": 120}),
        event("usage_update", "2026-10-31T20:00:00", {"tokens": 350, "active_seconds": 180}),
        event("tool_call", "2026-10-31T20:00:00", {"call_id": "one", "tool": "use_skill", "args": {"name": "design"}}),
        event("tool_result", "2026-10-31T20:00:01", {"call_id": "one", "ok": True}),
    ]
    result = summarize([(run, events)], ZoneInfo("Asia/Kolkata"), datetime(2026, 11, 2, tzinfo=timezone.utc))
    assert [(day.date, day.tokens) for day in result["days"]] == [("2026-10-30", 100), ("2026-10-31", 150), ("2026-11-01", 100)]
    assert result["lifetime_tokens"] == 350
    assert result["peak_tokens"] == 150
    assert result["longest_streak"] == result["current_streak"] == 3
    assert result["longest_task_seconds"] == 180
    assert result["skills_explored"] == result["total_skills_used"] == 1
    assert result["most_used_reasoning"] == "high"
    assert result["reasoning_percent"] == 100
    assert summarize([(run, events)], ZoneInfo("UTC"), datetime(2026, 11, 5, tzinfo=timezone.utc))["current_streak"] == 0


@pytest.mark.asyncio
async def test_activity_filters_company_ownership(client, workspace):
    before = (await client.get("/api/v1/activity?tz=UTC")).json()["lifetime_tokens"]
    user = (await client.get("/api/v1/auth/me")).json()
    sf = await project_factory(workspace["path"], Path(workspace["path"]))
    async with sf() as db:
        mine = Company(user_id=user["id"], name="Mine")
        other = Company(user_id="someone-else", name="Other")
        db.add_all([mine, other])
        await db.flush()
        db.add_all([Run(company_id=mine.id, goal="Private", tokens_used=123), Run(company_id=other.id, goal="Other", tokens_used=9999)])
        await db.commit()
    response = await client.get("/api/v1/activity?tz=UTC")
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["lifetime_tokens"] == before + 123
    assert next(p["tokens"] for p in data["projects"] if p["id"] == workspace["id"]) == 123
    assert "Private" not in response.text
    assert (await client.get("/api/v1/activity?tz=Invalid/Zone")).status_code == 422
