"""Agent role plugins: every built-in role sits in one agent group, each group's prompts are the prompt modules' text,
its manifest is the catalog entry in core/builtin.py, the registry accepts the groups with the rest of the catalog, and
user roles load from the user_roles table."""
from __future__ import annotations

from collections import Counter
from collections.abc import AsyncIterator, Iterator
from dataclasses import asdict
from pathlib import Path

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.plugins.roles.builtin import BUILTIN_ROLE_PLUGINS, CUSTOM_GROUP_MANIFEST, plugin_for
from app.plugins.roles.user_roles import custom_role_plugin, load_user_roles
from app.kernel.catalog import BUILTIN_MANIFESTS
from app.sdk.manifest import Manifest
from app.kernel.registry import PluginRegistry
from app.storage.migrate import upgrade_registry
from app.storage.session import make_engine
from app.storage.models import User, UserRole
from app.plugins.roles.prompts import ROLE_TEMPLATES
from app.plugins.roles.prompts_org import ORG_ROLES
from app.plugins.roles.library import effective_roles

BUILTIN_KEYS = set(ROLE_TEMPLATES) | set(ORG_ROLES)

EXPECTED_NAMED_GROUPS = {
    "agent.product_architect": ("pm", "architect", "techlead"),
    "agent.engineers": ("developer", "backend", "frontend"),
    "agent.designer_devops": ("designer", "devops"),
    "agent.qa_critic": ("qa", "critic"),
}
EXPECTED_CAPABILITY = {
    "agent.product_architect": "agents.product",
    "agent.engineers": "agents.engineering",
    "agent.designer_devops": "agents.design_ops",
    "agent.qa_critic": "agents.qa",
    "agent.custom_roles": "agents.custom",
}


def _source_prompt(key: str) -> str:
    """The prompt text as the prompt modules define it, read without going through the plugin code."""
    return (ROLE_TEMPLATES[key] if key in ROLE_TEMPLATES else ORG_ROLES[key]).system_prompt


def test_every_builtin_role_is_in_exactly_one_group() -> None:
    counts = Counter(key for plugin in BUILTIN_ROLE_PLUGINS for key in plugin.role_keys)
    assert set(counts) == BUILTIN_KEYS, f"missing: {sorted(BUILTIN_KEYS - set(counts))}, unknown: {sorted(set(counts) - BUILTIN_KEYS)}"
    duplicated = sorted(key for key, n in counts.items() if n > 1)
    assert not duplicated, f"a role key is in more than one group: {duplicated}"


def test_named_groups_hold_the_roles_the_plan_names() -> None:
    by_id = {plugin.manifest.id: plugin for plugin in BUILTIN_ROLE_PLUGINS}
    assert set(by_id) == set(EXPECTED_NAMED_GROUPS) | {"agent.custom_roles"}
    for manifest_id, keys in EXPECTED_NAMED_GROUPS.items():
        assert by_id[manifest_id].role_keys == keys


def test_custom_group_holds_founder_department_head_and_every_other_builtin() -> None:
    custom = set(plugin_for("founder").role_keys)
    assert plugin_for("founder").manifest.id == "agent.custom_roles"
    assert {"founder", "department_head"} <= custom
    named = {key for keys in EXPECTED_NAMED_GROUPS.values() for key in keys}
    assert custom == BUILTIN_KEYS - named


def test_group_prompts_are_the_prompt_modules_text() -> None:
    for plugin in BUILTIN_ROLE_PLUGINS:
        for key in plugin.role_keys:
            assert plugin.system_prompt(key) == _source_prompt(key), f"{plugin.manifest.id} changed the prompt of {key}"


def test_plugin_refuses_roles_it_does_not_own() -> None:
    engineers = next(p for p in BUILTIN_ROLE_PLUGINS if p.manifest.id == "agent.engineers")
    with pytest.raises(KeyError):
        engineers.system_prompt("pm")
    with pytest.raises(KeyError):
        plugin_for("no_such_role")


def test_manifests_are_agent_roles_built_and_match_the_catalog() -> None:
    catalog = {m.id: m for m in BUILTIN_MANIFESTS}
    for plugin in BUILTIN_ROLE_PLUGINS:
        manifest = plugin.manifest
        assert manifest.id in catalog, f"{manifest.id} is not in core/builtin.py"
        assert manifest == catalog[manifest.id]
        assert (manifest.layer, manifest.kind, manifest.status) == ("agent", "roles", "built")
        assert manifest.provides == (EXPECTED_CAPABILITY[manifest.id],)
        assert Manifest(**asdict(manifest)) == manifest  # re-validates every field


def test_registry_accepts_agent_groups_with_the_builtin_catalog() -> None:
    registry = PluginRegistry(BUILTIN_MANIFESTS)
    for plugin in BUILTIN_ROLE_PLUGINS:
        assert registry.get(plugin.manifest.id) == plugin.manifest
    order = [m.id for m in registry.ordered_for_start()]
    assert set(EXPECTED_CAPABILITY) <= set(order)
    assert order.index("capability.storage") < order.index(CUSTOM_GROUP_MANIFEST.id), "custom roles start after storage"


@pytest.fixture
def registry_url(tmp_path: Path) -> Iterator[str]:
    """A fresh, migrated registry database for each test, so the seeded user never collides across tests."""
    url = f"sqlite+aiosqlite:///{tmp_path / 'registry.db'}"
    upgrade_registry(url)
    yield url


@pytest_asyncio.fixture
async def rdb(registry_url: str) -> AsyncIterator[AsyncSession]:
    engine = make_engine(registry_url)
    try:
        async with async_sessionmaker(engine, expire_on_commit=False)() as session:
            session.add(User(id="user-1", email="ada@example.test", password_hash="unused"))
            session.add(UserRole(user_id="user-1", key="custom:accessibility_auditor", role="Accessibility Auditor",
                                 system_prompt="Check WCAG 2.2 AA."))
            session.add(UserRole(user_id="user-1", key="pm", role="PM", system_prompt="Edited PM prompt."))
            await session.commit()
            yield session
    finally:
        await engine.dispose()


async def test_user_roles_load_as_the_effective_roles_for_their_keys(rdb: AsyncSession) -> None:
    roles = await load_user_roles(rdb, "user-1")
    assert set(roles) == {"custom:accessibility_auditor", "pm"}, "only the stored rows, not every built-in role"
    assert roles["custom:accessibility_auditor"].system_prompt == "Check WCAG 2.2 AA."
    assert roles["pm"].system_prompt == "Edited PM prompt."
    effective = await effective_roles(rdb, "user-1")
    assert roles == {key: effective[key] for key in roles}


async def test_user_role_plugin_owns_custom_roles_and_leaves_overrides_to_their_group(rdb: AsyncSession) -> None:
    plugin = custom_role_plugin(await load_user_roles(rdb, "user-1"))
    assert plugin.manifest == CUSTOM_GROUP_MANIFEST
    assert plugin.role_keys == ("custom:accessibility_auditor",)
    assert plugin.system_prompt("custom:accessibility_auditor") == "Check WCAG 2.2 AA."
    with pytest.raises(KeyError):
        plugin.system_prompt("pm")
    assert plugin_for("pm").system_prompt("pm") == _source_prompt("pm"), "a user's edit never changes the built-in text"


async def test_user_without_rows_gets_an_empty_custom_plugin(rdb: AsyncSession) -> None:
    roles = await load_user_roles(rdb, "nobody")
    assert roles == {}
    assert custom_role_plugin(roles).role_keys == ()
