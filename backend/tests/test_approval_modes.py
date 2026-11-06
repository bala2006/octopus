"""Approval modes: one global setting, "ask" (Ask for permission) or "auto" (Approve for me), decides what waits for the user."""
from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from app.plugins.providers.router import set_provider_override
from app.sdk.approval_modes import is_dangerous_edit, normalize_mode
from app.plugins.sandbox.commands import SandboxError, analyze_command, parse_command
from conftest import ScriptedProvider, agent, env, make_company, set_approval, start_run, wait_status


def test_legacy_levels_and_unknown_values_mean_ask() -> None:
    assert normalize_mode("read_only") == "ask"
    assert normalize_mode("plan") == "ask"
    assert normalize_mode("danger") == "ask"
    assert normalize_mode(None) == "ask"
    assert normalize_mode("auto") == "auto"


def test_dangerous_edits_are_moves_and_ci_workflows() -> None:
    assert is_dangerous_edit("src/app.py") is False
    assert is_dangerous_edit(".github/workflows/ci.yml") is True
    assert is_dangerous_edit("src/app.py", move=True) is True


def test_commands_outside_the_project_are_reported_for_approval() -> None:
    assert analyze_command("python -V").outside == []
    assert analyze_command("python ../other.py").outside == ["../other.py"]
    with pytest.raises(SandboxError, match="outside the project"):
        parse_command("python ../other.py")
    assert parse_command("python ../other.py", allow_outside=True) == ["python", "../other.py"]


def test_protected_internals_stay_blocked_even_when_approved() -> None:
    with pytest.raises(SandboxError, match="protected"):
        parse_command("python .git/config", allow_outside=True)


def test_shell_operators_and_inline_code_are_never_allowed() -> None:
    with pytest.raises(SandboxError, match="Shell operators"):
        analyze_command("python a.py | head")
    with pytest.raises(SandboxError, match="Inline code"):
        analyze_command('python -c "print(1)"')


async def test_global_setting_defaults_to_ask_and_persists(client) -> None:
    # The registry database is shared by the whole test session, so the stored value depends on the tests that ran
    # before. The default is the rule in normalize_mode; the API checks only persistence and rejection.
    assert normalize_mode(None) == "ask" and normalize_mode("") == "ask"
    r = await client.put("/api/v1/settings/approval-mode", json={"approval_mode": "auto"})
    assert r.status_code == 200 and r.json() == {"approval_mode": "auto"}
    assert (await client.get("/api/v1/settings")).json()["approval_mode"] == "auto"
    await client.put("/api/v1/settings/approval-mode", json={"approval_mode": "ask"})
    assert (await client.get("/api/v1/settings")).json()["approval_mode"] == "ask"
    assert (await client.put("/api/v1/settings/approval-mode", json={"approval_mode": "danger"})).status_code == 422


async def test_new_runs_record_the_global_mode(client, workspace) -> None:
    cid = await make_company(client, workspace, [agent("a", "Ann", entry=True)], [])
    set_provider_override(ScriptedProvider({"Ann": [env({"action": "finish", "summary": "x"})]}))
    await set_approval(client, "auto")
    run = await start_run(client, workspace, cid)
    assert run["permission_level"] == "auto"
    await wait_status(client, workspace, run["id"])


async def _approval(client, workspace, run: dict) -> dict:
    base = f"/api/v1/w/{workspace['id']}/runs/{run['id']}"
    await wait_status(client, workspace, run["id"], {"awaiting_user"})
    for _ in range(200):
        pending = (await client.get(base)).json()["state"].get("pending_approval")
        if pending:
            return pending
        await asyncio.sleep(0.02)
    raise AssertionError("no approval was requested")


async def test_auto_runs_commands_inside_the_project_without_asking(client, workspace) -> None:
    cid = await make_company(client, workspace, [agent("w", "Wes", entry=True)], [])
    set_provider_override(ScriptedProvider({"Wes": [env({"action": "run_code", "command": "python -V"}), env({"action": "finish", "summary": "done"})]}))
    run = await start_run(client, workspace, cid, permission_level="auto")
    run = await wait_status(client, workspace, run["id"])
    assert run["status"] == "completed"


async def test_ask_waits_for_approval_before_a_command(client, workspace) -> None:
    cid = await make_company(client, workspace, [agent("w", "Wes", entry=True)], [])
    set_provider_override(ScriptedProvider({"Wes": [env({"action": "run_code", "command": "python -V"}), env({"action": "finish", "summary": "done"})]}))
    run = await start_run(client, workspace, cid, permission_level="ask")
    pending = await _approval(client, workspace, run)
    assert pending["kind"] == "run_code" and pending["details"]["command"] == "python -V"
    await client.post(f"/api/v1/w/{workspace['id']}/runs/{run['id']}/approve", json={"approval_id": pending["id"], "approved": True})
    assert (await wait_status(client, workspace, run["id"]))["status"] == "completed"


async def test_auto_asks_before_editing_a_ci_workflow(client, workspace) -> None:
    root = Path(workspace["path"])
    cid = await make_company(client, workspace, [agent("w", "Wes", entry=True)], [])
    set_provider_override(ScriptedProvider({"Wes": [
        env({"action": "write_file", "path": ".github/workflows/ci.yml", "content": "name: ci\n"}),
        env({"action": "finish", "summary": "done"})]}))
    run = await start_run(client, workspace, cid, permission_level="auto")
    pending = await _approval(client, workspace, run)
    assert pending["kind"] == "write_file" and pending["details"]["path"] == ".github/workflows/ci.yml"
    assert not (root / ".github/workflows/ci.yml").exists()
    await client.post(f"/api/v1/w/{workspace['id']}/runs/{run['id']}/approve", json={"approval_id": pending["id"], "approved": True})
    assert (await wait_status(client, workspace, run["id"]))["status"] == "completed"
    assert (root / ".github/workflows/ci.yml").read_text() == "name: ci\n"


async def test_auto_asks_before_a_command_outside_the_project(client, workspace) -> None:
    cid = await make_company(client, workspace, [agent("w", "Wes", entry=True)], [])
    set_provider_override(ScriptedProvider({"Wes": [env({"action": "run_code", "command": "python ../outside.py"}), env({"action": "finish", "summary": "done"})]}))
    run = await start_run(client, workspace, cid, permission_level="auto")
    pending = await _approval(client, workspace, run)
    assert pending["kind"] == "run_code" and pending["details"]["outside"] == ["../outside.py"]
    await client.post(f"/api/v1/w/{workspace['id']}/runs/{run['id']}/approve", json={"approval_id": pending["id"], "approved": False, "reason": "no"})
    assert (await wait_status(client, workspace, run["id"]))["status"] == "completed"
