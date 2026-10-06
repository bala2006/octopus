import asyncio
import os
import subprocess
from pathlib import Path

import httpx
import pytest

from app.services.processes import ManagedProcesses
from app.services.git_review import diff, stage, status
from app.tools.sandbox import SandboxError


def git(root: Path, *args: str) -> str:
    env = {**os.environ, "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"}
    return subprocess.check_output(["git", *args], cwd=root, env=env, stderr=subprocess.PIPE).decode().strip()


@pytest.mark.asyncio
async def test_git_reviews_working_staged_deleted_and_renamed_files(tmp_path):
    git(tmp_path, "init", "-b", "main")
    (tmp_path / "app.txt").write_text("original\n")
    (tmp_path / "renamed.txt").write_text("rename me\n")
    (tmp_path / "delete.txt").write_text("delete me\n")
    git(tmp_path, "add", "app.txt", "renamed.txt", "delete.txt")
    git(tmp_path, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "Initial")
    (tmp_path / "app.txt").write_text("staged\n")
    git(tmp_path, "add", "app.txt")
    (tmp_path / "app.txt").write_text("working\n")
    git(tmp_path, "mv", "renamed.txt", "new name.txt")
    (tmp_path / "delete.txt").unlink()
    (tmp_path / "untracked.txt").write_text("untracked\n")
    (tmp_path / ".env").write_text("hidden secret\n")
    result = await status(tmp_path)
    assert result["branch"] == "main"
    files = {f["path"]: f for f in result["files"]}
    assert files["app.txt"]["status"] == "MM"
    assert files["new name.txt"]["original_path"] == "renamed.txt"
    assert files["delete.txt"]["status"] == " D"
    assert files["untracked.txt"]["status"] == "??"
    assert ".env" not in files
    assert "+working" in await diff(tmp_path, "app.txt", False)
    assert "+staged" in await diff(tmp_path, "app.txt", True)
    assert "-delete me" in await diff(tmp_path, "delete.txt", False)


@pytest.mark.asyncio
async def test_git_supports_unborn_and_detached_head(tmp_path):
    git(tmp_path, "init", "-b", "main")
    assert (await status(tmp_path))["branch"] == "main"
    (tmp_path / "file.txt").write_text("hello")
    git(tmp_path, "add", "file.txt")
    git(tmp_path, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "Initial")
    git(tmp_path, "checkout", "--detach")
    assert (await status(tmp_path))["branch"] == "Detached HEAD"


@pytest.mark.asyncio
async def test_stage_unstage_does_not_change_file_contents(tmp_path):
    git(tmp_path, "init", "-b", "main")
    (tmp_path / "new.txt").write_text("new file")
    staged = await stage(tmp_path, "new.txt", True)
    assert staged["files"][0]["status"] == "A "
    unstaged = await stage(tmp_path, "new.txt", False)
    assert unstaged["files"][0]["status"] == "??"
    assert (tmp_path / "new.txt").read_text() == "new file"
    await stage(tmp_path, "new.txt", True)
    git(tmp_path, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "Initial")
    git(tmp_path, "mv", "new.txt", "renamed.txt")
    (tmp_path / "renamed.txt").write_text("edited after rename")
    await stage(tmp_path, "renamed.txt", True)
    assert "+edited after rename" in await diff(tmp_path, "renamed.txt", True)
    await stage(tmp_path, "renamed.txt", False)
    assert not git(tmp_path, "diff", "--cached", "--", "renamed.txt")
    # A heavily edited rename can appear as an addition and a separate deletion.
    # Unstaging the new file must not change the other index entry.
    if any(f["path"] == "new.txt" and f["status"][0] == "D" for f in (await status(tmp_path))["files"]):
        await stage(tmp_path, "new.txt", False)
    assert not git(tmp_path, "diff", "--cached")
    assert (tmp_path / "renamed.txt").read_text() == "edited after rename"


@pytest.mark.asyncio
async def test_development_server_start_preview_stop_and_restart(client, workspace):
    root = Path(workspace["path"])
    (root / "index.html").write_text("<h1>Real development preview</h1>")
    (root / "serve.py").write_text(
        "from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler\n"
        "server = ThreadingHTTPServer(('127.0.0.1', 0), SimpleHTTPRequestHandler)\n"
        "print('PORT=' + str(server.server_port), flush=True)\nserver.serve_forever()\n"
    )
    base = f"/api/v1/w/{workspace['id']}/editor/server"
    try:
        started = await client.post(base, json={"command": "python serve.py"})
        assert started.status_code == 200, started.text
        assert started.json()["status"] == "running"
        assert (await client.delete(f"/api/v1/workspaces/{workspace['id']}")).status_code == 409
        assert (await client.post(base, json={"command": "python serve.py"})).status_code == 400
        for _ in range(100):
            snapshot = (await client.get(base)).json()
            if "PORT=" in snapshot["output"]:
                break
            await asyncio.sleep(0.02)
        port = int(snapshot["output"].split("PORT=")[1].splitlines()[0])
        async with httpx.AsyncClient() as browser:
            response = await browser.get(f"http://127.0.0.1:{port}/index.html")
            assert response.status_code == 200
            assert "Real development preview" in response.text
        stopped = await client.delete(base)
        assert stopped.json()["status"] == "exited"
        async with httpx.AsyncClient() as browser:
            with pytest.raises(httpx.ConnectError):
                await browser.get(f"http://127.0.0.1:{port}/index.html")
        assert (await client.post(base, json={"command": "python serve.py"})).status_code == 200
    finally:
        await client.delete(base)
    await client.patch(f"/api/v1/workspaces/{workspace['id']}", json={"default_permission": "read_only"})
    assert (await client.post(base, json={"command": "python serve.py"})).status_code == 403


@pytest.mark.asyncio
async def test_server_shutdown_closes_real_process_and_bounds_output(tmp_path):
    (tmp_path / "worker.py").write_text("import time\nprint('x' * 40000, flush=True)\ntime.sleep(30)\n")
    manager = ManagedProcesses()
    try:
        await manager.start("test", tmp_path, "python worker.py", danger=False)
        with pytest.raises(SandboxError, match="already running"):
            await manager.start("test", tmp_path, "python worker.py", danger=False)
        for _ in range(100):
            if manager.status("test")["truncated"]:
                break
            await asyncio.sleep(0.02)
        assert manager.status("test")["truncated"]
        assert len(manager.status("test")["output"]) <= 24_000
        record = manager.records["test"]
    finally:
        await manager.shutdown()
    assert record.process.returncode is not None
    assert manager.status("test")["status"] == "idle"


@pytest.mark.asyncio
async def test_concurrent_server_start_and_stop_leave_no_process(tmp_path):
    (tmp_path / "worker.py").write_text("import time\ntime.sleep(30)\n")
    manager = ManagedProcesses()
    try:
        starting = asyncio.create_task(manager.start("test", tmp_path, "python worker.py", danger=False))
        await asyncio.sleep(0)
        stopping = asyncio.create_task(manager.stop("test"))
        await starting
        await stopping
        assert manager.records["test"].process.returncode is not None
        assert manager.status("test")["status"] == "exited"
    finally:
        await manager.shutdown()
