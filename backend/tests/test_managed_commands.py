import asyncio
import json
import subprocess
from pathlib import Path

import pytest


async def wait_command(client, base, predicate):
    async with asyncio.timeout(8):
        while True:
            result = (await client.get(f"{base}/current")).json()
            if predicate(result):
                return result
            await asyncio.sleep(0.05)


@pytest.mark.asyncio
async def test_live_command_prompt_input_persistence_and_clear(client, workspace):
    root = Path(workspace["path"])
    (root / "prompt.py").write_text("from pathlib import Path\nprint('Live output', flush=True)\nanswer = input('Your name: ')\nPath('answer.txt').write_text(answer, encoding='utf-8')\nprint('Received ' + answer, flush=True)\n")
    base = f"/api/v1/w/{workspace['id']}/editor/commands"
    started = await client.post(f"{base}/current", json={"command": "python prompt.py"})
    assert started.status_code == 200, started.text
    await wait_command(client, base, lambda result: "Your name:" in result["output"])
    assert (await client.post(f"{base}/current", json={"command": "python prompt.py"})).status_code == 400
    assert (await client.delete(f"/api/v1/workspaces/{workspace['id']}")).status_code == 409
    assert (await client.post(f"{base}/input", json={"text": "Hello 世界"})).status_code == 200
    exited = await wait_command(client, base, lambda result: result["status"] == "exited")
    assert exited["exit_code"] == 0 and "Received Hello 世界" in exited["output"]
    assert (root / "answer.txt").read_text(encoding="utf-8") == "Hello 世界"
    assert not exited["timed_out"]
    assert (await client.delete(f"{base}/output")).json()["status"] == "idle"
    assert (await client.post(f"{base}/input", json={"text": "too late"})).status_code == 400


@pytest.mark.asyncio
async def test_managed_command_timeout_stop_permissions_and_shutdown(client, workspace):
    from app.services.processes import commands
    root = Path(workspace["path"])
    (root / "wait.py").write_text("import time\nprint('Waiting', flush=True)\ntime.sleep(30)\n")
    base = f"/api/v1/w/{workspace['id']}/editor/commands"
    assert (await client.post(f"{base}/current", json={"command": "python wait.py", "timeout_seconds": 1})).status_code == 200
    timed = await wait_command(client, base, lambda result: result["status"] == "exited")
    assert timed["timed_out"] and timed["exit_code"] != 0
    assert (await client.post(f"{base}/current", json={"command": "python wait.py"})).status_code == 200
    await client.patch(f"/api/v1/workspaces/{workspace['id']}", json={"default_permission": "read_only"})
    assert (await client.post(f"{base}/input", json={"text": "forbidden"})).status_code == 403
    stopped = (await client.delete(f"{base}/current")).json()
    assert stopped["status"] == "exited" and not stopped["timed_out"]
    assert (await client.post(f"{base}/current", json={"command": "python wait.py"})).status_code == 403
    await client.patch(f"/api/v1/workspaces/{workspace['id']}", json={"default_permission": "ask"})
    assert (await client.post(f"{base}/current", json={"command": "python wait.py"})).status_code == 200
    await commands.shutdown()
    assert commands.status(str(root))["status"] == "idle"


@pytest.mark.asyncio
async def test_install_empty_node_project_and_commit_staged_files(client, workspace):
    root = Path(workspace["path"])
    (root / "package.json").write_text(json.dumps({"name": "managed-command-test", "version": "1.0.0", "private": True}))
    (root / "package-lock.json").write_text(json.dumps({"name": "managed-command-test", "version": "1.0.0", "lockfileVersion": 3, "packages": {"": {"name": "managed-command-test", "version": "1.0.0"}}}))
    base = f"/api/v1/w/{workspace['id']}/editor/commands"
    started = await client.post(f"{base}/current", json={"command": "npm ci --offline --ignore-scripts --no-audit --no-fund"})
    assert started.status_code == 200, started.text
    installed = await wait_command(client, base, lambda result: result["status"] == "exited")
    assert installed["exit_code"] == 0, installed["output"]
    for arguments in [["init"], ["config", "user.name", "Octopus Test"], ["config", "user.email", "test@example.invalid"], ["add", "package.json", "package-lock.json"]]:
        subprocess.run(["git", *arguments], cwd=root, check=True, capture_output=True)
    committed = await client.post(f"{base}/current", json={"command": 'git commit -m "Initial project"'})
    assert committed.status_code == 200, committed.text
    completed = await wait_command(client, base, lambda result: result["status"] == "exited")
    assert completed["exit_code"] == 0, completed["output"]
    result = subprocess.run(["git", "log", "-1", "--format=%s"], cwd=root, check=True, capture_output=True, text=True)
    assert result.stdout.strip() == "Initial project"
