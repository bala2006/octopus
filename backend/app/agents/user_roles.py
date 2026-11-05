"""Custom roles: the roles a user stored in the user_roles table, loaded as role plugins.

A row whose key is a built-in role key overrides that role for the user. Any other key (``custom:<slug>``) is a role
of the user's own. The read and merge rules stay in services/roles.py. This module wraps them and adds no SQL.
"""
from __future__ import annotations

from collections.abc import Mapping

from sqlalchemy.ext.asyncio import AsyncSession

from app.agents.roles import CUSTOM_GROUP_MANIFEST, RolePlugin
from app.prompts.roles import RoleTemplate
from app.services import roles as R


async def load_user_roles(rdb: AsyncSession, user_id: str) -> dict[str, RoleTemplate]:
    """The roles the user stored, each row applied over its built-in role (an override) or on its own (a custom role).

    The values match services.roles.effective_roles for the same keys. Built-in roles the user never edited are left out.
    """
    rows = await R.user_rows(rdb, user_id)
    effective = R.merge(rows)
    return {row.key: effective[row.key] for row in rows}


def custom_role_plugin(roles: Mapping[str, RoleTemplate]) -> RolePlugin:
    """A role plugin for the user's own roles in ``roles``. Overrides of built-in roles stay with their group plugin.

    The plugin reuses the ``agent.custom_roles`` manifest. It is built per user and is not part of the built-in catalog.
    """
    own = {key: template for key, template in roles.items() if not R.is_builtin(key)}
    return RolePlugin(manifest=CUSTOM_GROUP_MANIFEST, role_keys=tuple(own),
                      prompt_of=lambda key: own[key].system_prompt)
