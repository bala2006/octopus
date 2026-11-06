"""Plugins API: list plugins with state and dependents, switch them on and off, refuse what would break the run loop."""
from __future__ import annotations

import pytest
import pytest_asyncio

from app.kernel.current import current


@pytest_asyncio.fixture
async def restore_plugins(client):
    """The API changes the process kernel and the registry database. Put every plugin back afterwards."""
    yield
    kernel = current()
    for row in kernel.host.describe():
        if not row["enabled"]:
            await client.patch(f"/api/v1/plugins/{row['id']}", json={"enabled": True, "cascade": True})


async def test_lists_every_plugin_with_its_state_and_the_event_log_counters(client) -> None:
    body = (await client.get("/api/v1/plugins")).json()
    plugins = {p["id"]: p for p in body["plugins"]}
    assert body["sdk_version"] == "1.0.0" and len(plugins) >= 39
    assert {"published", "persisted", "batches", "dropped_live", "lagged"} <= set(body["event_log"])
    web = plugins["tool.web"]
    assert (web["slot"], web["state"], web["enabled"], web["required"], web["applies"]) == ("tool", "registered", True, False, "now")
    assert web["provides"] == ["tools.web"] and web["permissions"] == ["network"]
    assert plugins["provider.router"]["required"] is True and plugins["channel.web_shell"]["applies"] == "restart"
    assert plugins["workflow.org"]["dependents"] == ["tool.team"]


async def test_health_can_be_refreshed_on_request(client) -> None:
    body = (await client.get("/api/v1/plugins", params={"health": "true"})).json()
    assert all(p["health"]["state"] in ("ok", "degraded", "failed") for p in body["plugins"])


async def test_switching_a_plugin_off_and_on_changes_what_agents_can_do(client, restore_plugins) -> None:
    kernel = current()
    off = await client.patch("/api/v1/plugins/tool.web", json={"enabled": False})
    assert off.status_code == 200 and off.json()["changed"] == ["tool.web"]
    assert not kernel.tools.has("calculate")
    shown = {p["id"]: p for p in off.json()["state"]["plugins"]}["tool.web"]
    assert (shown["enabled"], shown["state"]) == (False, "disabled")
    on = await client.patch("/api/v1/plugins/tool.web", json={"enabled": True})
    assert on.json()["changed"] == ["tool.web"] and kernel.tools.has("calculate")


async def test_a_plugin_that_others_need_asks_for_cascade(client, restore_plugins) -> None:
    refused = await client.patch("/api/v1/plugins/workflow.org", json={"enabled": False})
    assert refused.status_code == 409 and "tool.team" in refused.json()["detail"]
    allowed = await client.patch("/api/v1/plugins/workflow.org", json={"enabled": False, "cascade": True})
    assert allowed.status_code == 200 and allowed.json()["changed"] == ["tool.team", "workflow.org"]


@pytest.mark.parametrize("plugin_id", ["kernel.runs", "provider.router", "tool.messaging", "workspace.local"])
async def test_the_parts_the_run_loop_depends_on_cannot_be_switched_off(client, plugin_id: str) -> None:
    response = await client.patch(f"/api/v1/plugins/{plugin_id}", json={"enabled": False})
    assert response.status_code == 409 and "cannot be disabled" in response.json()["detail"]


async def test_unknown_plugins_are_not_found(client) -> None:
    assert (await client.patch("/api/v1/plugins/tool.nope", json={"enabled": False})).status_code == 404
