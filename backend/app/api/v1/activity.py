"""Personal usage across the authenticated user's registered projects."""
from collections import Counter
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import current_user
from app.db.session import get_registry_db, project_db_path, project_factory
from app.models import Company, Run, RunEvent, User, Workspace

router = APIRouter(prefix="/activity", tags=["activity"])


class ActivityDay(BaseModel):
    date: str
    tokens: int


class ToolUsage(BaseModel):
    name: str
    count: int


class ActivityProject(BaseModel):
    id: str
    name: str
    tokens: int


class ActivityOut(BaseModel):
    email: str
    lifetime_tokens: int = 0
    peak_tokens: int = 0
    longest_task_seconds: float = 0
    longest_streak: int = 0
    current_streak: int = 0
    active_days: int = 0
    days: list[ActivityDay] = []
    tools: list[ToolUsage] = []
    skills_explored: int = 0
    total_skills_used: int = 0
    most_used_reasoning: str | None = None
    reasoning_percent: int = 0
    projects: list[ActivityProject] = []
    unavailable_projects: int = 0


def summarize(rows: list[tuple[Run, list[RunEvent]]], tz: ZoneInfo, now: datetime) -> dict:
    daily: Counter[str] = Counter()
    tools: Counter[str] = Counter()
    skills: Counter[str] = Counter()
    reasoning: Counter[str] = Counter()
    longest = 0.0
    lifetime = 0
    for run, events in rows:
        previous = 0
        active_seconds = 0.0
        calls = {}
        effort = (run.budget_json or {}).get("reasoning_effort")
        if effort and effort != "default":
            reasoning[effort] += 1
        for event in events:
            payload = event.payload_json or {}
            if event.type == "usage_update":
                tokens = max(0, int(payload.get("tokens", 0)))
                delta = max(0, tokens - previous)
                previous = max(previous, tokens)
                day = event.created_at.replace(tzinfo=timezone.utc).astimezone(tz).date().isoformat()
                daily[day] += delta
                active_seconds = max(active_seconds, float(payload.get("active_seconds", 0)))
            elif event.type == "tool_call":
                calls[payload.get("call_id")] = payload
                name = payload.get("tool")
                if name:
                    tools[name] += 1
            elif event.type == "tool_result" and payload.get("ok"):
                call = calls.get(payload.get("call_id"), {})
                if call.get("tool") == "use_skill":
                    name = (call.get("args") or {}).get("name")
                    if name:
                        skills[name] += 1
        total = max(previous, run.tokens_used)
        # Older histories can have a final counter without usage events.
        if total > previous:
            day = (run.ended_at or run.created_at).replace(tzinfo=timezone.utc).astimezone(tz).date().isoformat()
            daily[day] += total - previous
        lifetime += total
        longest = max(longest, active_seconds)
    active = sorted(datetime.fromisoformat(day).date() for day, tokens in daily.items() if tokens > 0)
    streak = best = 0
    last = None
    for day in active:
        streak = streak + 1 if last and day == last + timedelta(days=1) else 1
        best = max(best, streak)
        last = day
    today = now.astimezone(tz).date()
    current = streak if last in (today, today - timedelta(days=1)) else 0
    effort, count = reasoning.most_common(1)[0] if reasoning else (None, 0)
    return dict(lifetime_tokens=lifetime, peak_tokens=max(daily.values(), default=0),
                longest_task_seconds=longest, longest_streak=best, current_streak=current,
                active_days=len(active), days=[ActivityDay(date=d, tokens=n) for d, n in sorted(daily.items())],
                tools=[ToolUsage(name=n, count=c) for n, c in tools.most_common(6)],
                skills_explored=len(skills), total_skills_used=sum(skills.values()),
                most_used_reasoning=effort, reasoning_percent=round(count * 100 / sum(reasoning.values())) if reasoning else 0)


@router.get("", response_model=ActivityOut)
async def activity(tz: str = Query(default="UTC", max_length=80), user: User = Depends(current_user),
                   db: AsyncSession = Depends(get_registry_db)) -> ActivityOut:
    try:
        zone = ZoneInfo(tz)
    except (ZoneInfoNotFoundError, ValueError):
        raise HTTPException(422, "Unknown time zone")
    workspaces = (await db.execute(select(Workspace).where(Workspace.user_id == user.id))).scalars().all()
    rows = []
    projects = []
    unavailable = 0
    seen = set()
    for ws in workspaces:
        root = Path(ws.path)
        if not project_db_path(root).is_file():
            unavailable += 1
            continue
        key = str(root.resolve()).casefold() if os.name == "nt" else str(root.resolve())
        if key in seen:
            continue
        seen.add(key)
        try:
            sf = await project_factory(str(root), root)
            async with sf() as pdb:
                runs = (await pdb.execute(select(Run).join(Company).where(Company.user_id == user.id))).scalars().all()
                events = (await pdb.execute(select(RunEvent).join(Run).join(Company).where(
                    Company.user_id == user.id, RunEvent.type.in_(["usage_update", "tool_call", "tool_result"])
                ).order_by(RunEvent.id))).scalars().all()
                grouped = {}
                for event in events:
                    grouped.setdefault(event.run_id, []).append(event)
                project_rows = [(run, grouped.get(run.id, [])) for run in runs]
                rows.extend(project_rows)
                total = summarize(project_rows, zone, datetime.now(timezone.utc))["lifetime_tokens"]
                projects.append(ActivityProject(id=ws.id, name=ws.name, tokens=total))
        except (OSError, SQLAlchemyError):
            unavailable += 1
    return ActivityOut(email=user.email, projects=sorted(projects, key=lambda p: p.tokens, reverse=True),
                       unavailable_projects=unavailable, **summarize(rows, zone, datetime.now(timezone.utc)))
