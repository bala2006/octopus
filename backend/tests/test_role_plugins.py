"""Role plugins: the built-in roles, the user's role library (edits and own roles), and the chief's lead routing."""
from __future__ import annotations

from collections.abc import AsyncIterator, Iterator
from pathlib import Path

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.kernel.current import current
from app.plugins.roles.library import effective_roles, resolve_prompt
from app.plugins.roles.prompts import ROLE_TEMPLATES, all_roles
from app.plugins.roles.prompts_org import ORG_ROLES
from app.storage.migrate import upgrade_registry
from app.storage.models import User, UserRole
from app.storage.session import make_engine


def test_all_roles_is_the_union_of_the_prompt_modules() -> None:
    assert set(all_roles()) == set(ROLE_TEMPLATES) | set(ORG_ROLES)


def test_roles_are_reached_through_services() -> None:
    services = current().services
    assert services.require("roles.builtin").all_roles() is not None
    assert services.require("roles.library").resolve_prompt is resolve_prompt
    assert services.require("roles.lead").choose_lead([{"id": "b"}, {"id": "a", "is_entry": True}]) == "a"


def test_the_lead_defaults_to_the_entry_agent_and_keeps_the_previous_lead() -> None:
    lead = current().services.require("roles.lead")
    agents = [{"id": "z"}, {"id": "m", "is_entry": True}, {"id": "a", "active": False}]
    assert lead.choose_lead(agents) == "m"
    assert lead.choose_lead(agents, previous="z") == "z"
    assert lead.choose_lead(agents, previous="a") == "m"  # an inactive agent cannot be the lead
    with pytest.raises(ValueError):
        lead.choose_lead([{"id": "a", "active": False}])


def test_a_message_goes_to_the_lead_unless_it_names_a_teammate() -> None:
    lead = current().services.require("roles.lead")
    agents = [{"id": "a", "name": "Ava"}, {"id": "b", "name": "Sam"}]
    assert lead.route_target("build it", agents, "a") == "a"
    assert lead.route_target("@Sam please review", agents, "a") == "b"
    with pytest.raises(ValueError):
        lead.route_target("@Nobody hi", agents, "a")


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


async def test_user_rows_override_built_in_roles_and_add_their_own(rdb: AsyncSession) -> None:
    roles = await effective_roles(rdb, "user-1")
    assert roles["pm"].system_prompt == "Edited PM prompt."
    assert roles["custom:accessibility_auditor"].system_prompt == "Check WCAG 2.2 AA."
    assert set(all_roles()) < set(roles), "the library adds the user's own role to every built-in one"
    assert all_roles()["pm"].system_prompt != "Edited PM prompt.", "a user's edit never changes the built-in text"


async def test_a_user_without_rows_gets_the_built_in_roles(rdb: AsyncSession) -> None:
    assert set(await effective_roles(rdb, "nobody")) == set(all_roles())


def test_a_linked_agent_runs_on_its_roles_current_prompt() -> None:
    roles = all_roles()
    behavior = {"template_key": "qa", "prompt_linked": True, "extra_instructions": "Be brief."}
    prompt = resolve_prompt(behavior, "stale prompt", roles)
    assert prompt.startswith(roles["qa"].system_prompt) and prompt.endswith("Be brief.")
    assert resolve_prompt({"template_key": "qa", "prompt_linked": False}, "my own", roles) == "my own"
