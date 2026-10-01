"""Settings → Skills: step-by-step playbooks agents load with ``use_skill`` (built-in, edited, or the user's own)."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import current_user
from app.db.session import get_registry_db
from app.models import User, UserSkill
from app.schemas import SkillIn, SkillOut
from app.services import skills as S

router = APIRouter(prefix="/skills", tags=["skills"])


def out(s: S.Skill) -> SkillOut:
    return SkillOut(name=s.name, description=s.description, body=s.body, roles=list(s.roles), phases=list(s.phases), source=s.source)  # type: ignore[arg-type]


async def _row(db: AsyncSession, user: User, name: str) -> UserSkill | None:
    return (await db.execute(select(UserSkill).where(UserSkill.user_id == user.id, UserSkill.name == name))).scalar_one_or_none()


def _fill(row: UserSkill, body: SkillIn) -> None:
    row.description, row.body = body.description.strip(), body.body
    row.roles = ", ".join(r.strip() for r in body.roles if r.strip())
    row.phases = ", ".join(p.strip() for p in body.phases if p.strip())


@router.get("", response_model=list[SkillOut])
async def list_skills(db: AsyncSession = Depends(get_registry_db), user: User = Depends(current_user)) -> list[SkillOut]:
    return [out(s) for s in sorted(S.merge(await S.user_rows(db, user.id)).values(), key=lambda s: s.name)]


@router.post("", response_model=SkillOut, status_code=201)
async def create_skill(body: SkillIn, db: AsyncSession = Depends(get_registry_db), user: User = Depends(current_user)) -> SkillOut:
    if body.name in S.builtin_skills() or await _row(db, user, body.name):
        raise HTTPException(409, f"A skill named '{body.name}' already exists; edit it instead")
    row = UserSkill(user_id=user.id, name=body.name)
    _fill(row, body)
    db.add(row)
    await db.commit()
    return out(S.from_row(row))


@router.put("/{name}", response_model=SkillOut)
async def update_skill(name: str, body: SkillIn, db: AsyncSession = Depends(get_registry_db), user: User = Depends(current_user)) -> SkillOut:
    """Edit a skill; for a built-in one this saves your version (DELETE restores the default). The name can't change."""
    row = await _row(db, user, name)
    if row is None:
        if name not in S.builtin_skills():
            raise HTTPException(404, "Skill not found")
        row = UserSkill(user_id=user.id, name=name)
        db.add(row)
    _fill(row, body)
    await db.commit()
    return out(S.from_row(row))


@router.delete("/{name}", status_code=204, response_class=Response, response_model=None)
async def delete_skill(name: str, db: AsyncSession = Depends(get_registry_db), user: User = Depends(current_user)) -> None:
    """Built-in skill: restore its default. Your own skill: delete it."""
    row = await _row(db, user, name)
    if row is None:
        if name in S.builtin_skills():
            return None
        raise HTTPException(404, "Skill not found")
    await db.delete(row)
    await db.commit()


@router.post("/restore-defaults", status_code=204, response_class=Response, response_model=None)
async def restore_defaults(db: AsyncSession = Depends(get_registry_db), user: User = Depends(current_user)) -> None:
    for row in await S.user_rows(db, user.id):
        if row.name in S.builtin_skills():
            await db.delete(row)
    await db.commit()
