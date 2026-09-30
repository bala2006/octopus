"""FastAPI dependencies: registry DB, current user, and the project context of a workspace."""
from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass
from pathlib import Path

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.security import decode_access_token, hash_password
from app.db.base import new_id, utcnow
from app.db.session import SessionFactory, get_registry_db, project_factory
from app.models import Company, User, Workspace


async def get_or_create_single_user(db: AsyncSession) -> User:
    s = get_settings()
    user = (await db.execute(select(User).where(User.email == s.single_user_email))).scalar_one_or_none()
    if user is None:
        user = User(email=s.single_user_email, password_hash=hash_password(new_id()))
        db.add(user)
        await db.commit()
        await db.refresh(user)
    return user


def token_from_request(request: Request) -> str | None:
    auth = request.headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    return request.query_params.get("token")


async def resolve_user(db: AsyncSession, token: str | None) -> User | None:
    if token:
        uid = decode_access_token(token)
        if uid:
            user = await db.get(User, uid)
            if user:
                return user
    if get_settings().single_user_mode:
        return await get_or_create_single_user(db)
    return None


async def current_user(request: Request, db: AsyncSession = Depends(get_registry_db)) -> User:
    user = await resolve_user(db, token_from_request(request))
    if user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not authenticated", headers={"WWW-Authenticate": "Bearer"})
    return user


@dataclass
class ProjectCtx:
    workspace: Workspace
    root: Path
    sf: SessionFactory
    user: User

    @property
    def key(self) -> str:
        return str(self.root)


async def load_project(workspace_id: str, user: User, rdb: AsyncSession, *, touch: bool = False) -> ProjectCtx:
    ws = await rdb.get(Workspace, workspace_id)
    if ws is None or ws.user_id != user.id:
        raise HTTPException(404, "Workspace not found")
    root = Path(ws.path)
    if not root.is_dir():
        raise HTTPException(410, f"Project directory is missing: {ws.path}")
    if touch:
        from app.services.projects import ensure_layout

        ensure_layout(root)  # self-managed .octopus: recreate anything the user deleted
        ws.last_opened_at = utcnow()
        await rdb.commit()
    sf = await project_factory(str(root), root)
    return ProjectCtx(workspace=ws, root=root, sf=sf, user=user)


async def project_ctx(workspace_id: str, user: User = Depends(current_user), rdb: AsyncSession = Depends(get_registry_db)) -> ProjectCtx:
    return await load_project(workspace_id, user, rdb)


async def get_pdb(ctx: ProjectCtx = Depends(project_ctx)) -> AsyncIterator[AsyncSession]:
    async with ctx.sf() as s:
        yield s


async def owned_company(company_id: str, db: AsyncSession, user: User) -> Company:
    company = await db.get(Company, company_id)
    if company is None or company.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Company not found")
    return company
