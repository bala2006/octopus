"""Settings → Roles: the role library (built-in roles, the user's edits of them, and roles of their own)."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import current_user
from app.db.session import get_registry_db
from app.models import User, UserRole
from app.schemas import AgentTools, RoleIn, RoleTemplateOut
from app.services import roles as R

router = APIRouter(prefix="/roles", tags=["roles"])


async def role_list(db: AsyncSession, user: User) -> list[RoleTemplateOut]:
    rows = await R.user_rows(db, user.id)
    by_key = {r.key: r for r in rows}
    out = []
    for t in R.merge(rows).values():
        info = R.role_info(t, by_key)
        out.append(RoleTemplateOut(**{**info, "tools": AgentTools(**info["tools"])}))
    return out


def _out(t, row) -> RoleTemplateOut:  # type: ignore[no-untyped-def]
    info = R.role_info(t, {row.key: row} if row is not None else {})
    return RoleTemplateOut(**{**info, "tools": AgentTools(**info["tools"])})


async def _row(db: AsyncSession, user: User, key: str) -> UserRole | None:
    return (await db.execute(select(UserRole).where(UserRole.user_id == user.id, UserRole.key == key))).scalar_one_or_none()


def _fill(row: UserRole, body: RoleIn) -> None:
    row.role, row.category, row.description = body.role.strip(), body.category.strip(), body.description.strip()
    row.system_prompt, row.default_name = body.system_prompt, body.default_name.strip()
    row.color, row.avatar = body.color.strip(), body.avatar.strip()
    row.tools_json = body.tools.model_dump() if body.tools is not None else {}


@router.get("", response_model=list[RoleTemplateOut])
async def list_roles(db: AsyncSession = Depends(get_registry_db), user: User = Depends(current_user)) -> list[RoleTemplateOut]:
    return await role_list(db, user)


@router.post("", response_model=RoleTemplateOut, status_code=201)
async def create_role(body: RoleIn, db: AsyncSession = Depends(get_registry_db), user: User = Depends(current_user)) -> RoleTemplateOut:
    """A role of the user's own (key ``custom:<slug>``)."""
    base = R.custom_key(body.role)
    existing = {r.key for r in await R.user_rows(db, user.id)}
    key, n = base, 2
    while key in existing:
        key, n = f"{base}_{n}", n + 1
    row = UserRole(user_id=user.id, key=key)
    _fill(row, body)
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return _out(R.merge([row])[key], row)


@router.put("/{key}", response_model=RoleTemplateOut)
async def update_role(key: str, body: RoleIn, db: AsyncSession = Depends(get_registry_db), user: User = Depends(current_user)) -> RoleTemplateOut:
    """Edit a role. For a built-in role this saves the user's version; DELETE brings the default back."""
    row = await _row(db, user, key)
    if row is None:
        if not R.is_builtin(key):
            raise HTTPException(404, "Role not found")
        row = UserRole(user_id=user.id, key=key)
        db.add(row)
    _fill(row, body)
    await db.commit()
    await db.refresh(row)
    return _out(R.merge([row])[key], row)


@router.delete("/{key}", status_code=204, response_class=Response, response_model=None)
async def delete_role(key: str, db: AsyncSession = Depends(get_registry_db), user: User = Depends(current_user)) -> None:
    """Built-in role: restore its default. Custom role: delete it (agents using it keep their current prompt)."""
    row = await _row(db, user, key)
    if row is None:
        if R.is_builtin(key):
            return None  # already the default
        raise HTTPException(404, "Role not found")
    await db.delete(row)
    await db.commit()


@router.post("/restore-defaults", status_code=204, response_class=Response, response_model=None)
async def restore_defaults(db: AsyncSession = Depends(get_registry_db), user: User = Depends(current_user)) -> None:
    """Undo every edit of a built-in role (roles of the user's own are kept)."""
    for row in await R.user_rows(db, user.id):
        if R.is_builtin(row.key):
            await db.delete(row)
    await db.commit()
