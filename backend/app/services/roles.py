"""The role library: built-in roles (``prompts/roles*.py``) merged with the user's edits and own roles (``user_roles``).

* A role carries the agent's system prompt, description, look and default tools.
* Agents link to their role by ``behavior.template_key``. A linked agent's prompt is resolved at run time from the
  *effective* role, so editing a role in Settings → Roles updates every agent that uses it; per-agent tweaks live in
  ``behavior.extra_instructions``. An agent whose prompt was edited by hand keeps it (``behavior.prompt_linked`` False).
* Agents created before roles were linked are treated as linked when their prompt is still the built-in text.
"""
from __future__ import annotations

import re
from dataclasses import replace
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.prompts.roles import RoleTemplate, _tools, all_roles

CATEGORIES = ["Leadership", "Product", "Design", "Engineering", "Quality", "Operations", "Security", "Research", "Data",
              "Content", "Growth", "Support", "Debate", "General"]
_CATEGORY_RULES: list[tuple[str, str]] = [
    ("Debate", r"^(moderator|proposer|critic)$"),
    ("Leadership", r"^(ceo|founder|chief_of_staff|department_head|eng_manager|techlead|game_director|creative_director)$"),
    ("Security", r"security"),
    ("Quality", r"qa|tester|playtester"),
    ("Product", r"pm$|product"),
    ("Design", r"design|ux"),
    ("Data", r"data|ml_"),
    ("Research", r"research"),
    ("Operations", r"devops|sre"),
    ("Content", r"writer|editor|seo"),
    ("Growth", r"marketing|growth|sales"),
    ("Support", r"support"),
    ("Engineering", r"dev|engineer|architect|frontend|backend|programmer|fullstack"),
]


def category_of(key: str) -> str:
    for cat, rx in _CATEGORY_RULES:
        if re.search(rx, key):
            return cat
    return "General"


def is_builtin(key: str) -> bool:
    return key in all_roles()


def custom_key(title: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "_", title.lower()).strip("_")[:60] or "role"
    return f"custom:{slug}"


def _apply(base: RoleTemplate | None, row: Any) -> RoleTemplate:
    """A user_roles row over its built-in role (or on its own for a custom role). Empty fields keep the base value."""
    b = base or RoleTemplate(key=row.key, role=row.role or "Custom role", default_name=row.default_name or "Agent",
                             color=row.color or "#6366f1", avatar=row.avatar or "bot", description=row.description or "",
                             system_prompt=row.system_prompt or "", tools=_tools())
    return replace(b, key=row.key, role=row.role or b.role, default_name=row.default_name or b.default_name, color=row.color or b.color,
                   avatar=row.avatar or b.avatar, description=row.description or b.description,
                   system_prompt=row.system_prompt or b.system_prompt, tools={**(b.tools or {}), **(row.tools_json or {})} or b.tools)


async def user_rows(rdb: AsyncSession, user_id: str) -> list[Any]:
    from app.models import UserRole

    return list((await rdb.execute(select(UserRole).where(UserRole.user_id == user_id))).scalars().all())


def merge(rows: list[Any]) -> dict[str, RoleTemplate]:
    roles = dict(all_roles())
    for r in rows:
        roles[r.key] = _apply(roles.get(r.key) if is_builtin(r.key) else None, r)
    return roles


async def effective_roles(rdb: AsyncSession, user_id: str) -> dict[str, RoleTemplate]:
    return merge(await user_rows(rdb, user_id))


def role_info(t: RoleTemplate, rows_by_key: dict[str, Any]) -> dict[str, Any]:
    row = rows_by_key.get(t.key)
    builtin = is_builtin(t.key)
    return {"key": t.key, "role": t.role, "default_name": t.default_name, "color": t.color, "avatar": t.avatar,
            "description": t.description, "system_prompt": t.system_prompt, "tools": t.tools or _tools(),
            "category": (row.category if row is not None and row.category else category_of(t.key)),
            "source": "custom" if not builtin else "modified" if row is not None else "builtin"}


# ---------------------------------------------------------------- linking agents to roles
def linked(agent_behavior: dict[str, Any], system_prompt: str) -> str | None:
    """The role key whose prompt this agent uses, or None when the agent has a prompt of its own."""
    key = str(agent_behavior.get("template_key") or "")
    if not key:
        return None
    flag = agent_behavior.get("prompt_linked")
    if flag is True:
        return key
    if flag is False:
        return None
    base = all_roles().get(key)  # created before linking existed: linked while the prompt is untouched
    return key if base is not None and (not system_prompt.strip() or system_prompt.strip() == base.system_prompt.strip()) else None


def resolve_prompt(agent_behavior: dict[str, Any], system_prompt: str, roles: dict[str, RoleTemplate]) -> str:
    """The system prompt an agent runs with: its role's current prompt (+ its additional instructions) when linked."""
    key = linked(agent_behavior, system_prompt)
    base = roles[key].system_prompt if key and key in roles else system_prompt
    extra = str(agent_behavior.get("extra_instructions") or "").strip()
    return base + (f"\n\n## Additional instructions for you\n{extra}" if extra else "")
