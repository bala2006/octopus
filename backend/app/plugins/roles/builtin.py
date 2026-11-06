"""Built-in role plugins: the roles from prompts/roles.py and prompts/roles_org.py, grouped into the image's agent groups.

There is one RolePlugin per agent group. Each one carries the manifest that core/builtin.py catalogs for that group, the
role keys it owns, and a function that returns each role's system prompt. The prompt text is read from the prompt
modules, never copied. Roles a user stores in the user_roles table are loaded by app/agents/user_roles.py.
"""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

from app.kernel.catalog import VERSION
from app.sdk.manifest import Manifest
from app.plugins.roles.prompts import all_roles


@dataclass(frozen=True)
class RolePlugin:
    """The roles of one agent group. ``role_keys`` lists the keys the plugin owns, and ``prompt_of`` returns the
    system prompt text for one of them."""

    manifest: Manifest
    role_keys: tuple[str, ...]
    prompt_of: Callable[[str], str]

    def owns(self, key: str) -> bool:
        return key in self.role_keys

    def system_prompt(self, key: str) -> str:
        if not self.owns(key):
            raise KeyError(f"{self.manifest.id} does not own role {key!r}")
        return self.prompt_of(key)


def builtin_prompt(key: str) -> str:
    """The system prompt that prompts/roles.py or prompts/roles_org.py defines for a built-in role."""
    return all_roles()[key].system_prompt


def _manifest(manifest_id: str, capability: str, requires: tuple[str, ...] = ()) -> Manifest:
    return Manifest(id=manifest_id, layer="agent", kind="roles", version=VERSION,
                    provides=(capability,), requires=requires, status="built")


@dataclass(frozen=True)
class _Group:
    manifest_id: str
    capability: str
    keys: tuple[str, ...]


# The four groups the plan names. Their role keys are listed explicitly.
_NAMED_GROUPS: tuple[_Group, ...] = (
    _Group("agent.product_architect", "agents.product", ("pm", "architect", "techlead")),
    _Group("agent.engineers", "agents.engineering", ("developer", "backend", "frontend")),
    _Group("agent.designer_devops", "agents.design_ops", ("designer", "devops")),
    _Group("agent.qa_critic", "agents.qa", ("qa", "critic")),
)

# The custom group takes every built-in role the named groups don't list: founder, department_head, the other
# roles_org.py roles, and ceo, moderator and proposer. The user's own roles are added by user_roles.py.
CUSTOM_GROUP_MANIFEST = _manifest("agent.custom_roles", "agents.custom", ("storage.repositories",))


def _build() -> tuple[RolePlugin, ...]:
    roles = all_roles()
    named = [key for group in _NAMED_GROUPS for key in group.keys]
    if len(named) != len(set(named)):
        raise RuntimeError("a built-in role is listed in more than one agent group")
    unknown = sorted(set(named) - roles.keys())
    if unknown:
        raise RuntimeError(f"agent groups name roles that no prompt module defines: {unknown}")
    plugins = [RolePlugin(_manifest(g.manifest_id, g.capability), g.keys, builtin_prompt) for g in _NAMED_GROUPS]
    named_set = set(named)
    rest = tuple(key for key in roles if key not in named_set)
    plugins.append(RolePlugin(CUSTOM_GROUP_MANIFEST, rest, builtin_prompt))
    return tuple(plugins)


BUILTIN_ROLE_PLUGINS: tuple[RolePlugin, ...] = _build()
_PLUGIN_BY_KEY: dict[str, RolePlugin] = {key: plugin for plugin in BUILTIN_ROLE_PLUGINS for key in plugin.role_keys}


def plugin_for(key: str) -> RolePlugin:
    """The built-in agent group plugin that owns a built-in role key."""
    try:
        return _PLUGIN_BY_KEY[key]
    except KeyError:
        raise KeyError(f"no built-in agent group owns role {key!r}") from None
