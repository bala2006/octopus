import asyncio
import json
import os
import subprocess
from pathlib import Path

import pytest

from app.services.git_review import commit, stage, status
from app.services.project_tasks import discover
from app.services.project_guidance import load
from app.tools.workspace import WorkspaceError


def git(root: Path, *args: str) -> str:
    env = {**os.environ, "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"}
    return subprocess.check_output(["git", *args], cwd=root, env=env, stderr=subprocess.PIPE).decode().strip()


def repository(root: Path) -> None:
    git(root, "init", "-b", "main")
    git(root, "config", "user.name", "Workbench Test")
    git(root, "config", "user.email", "workbench@example.invalid")


@pytest.mark.asyncio
async def test_git_review_supports_mounted_repository_ownership_without_global_config(tmp_path, monkeypatch):
    from app.services import git_review

    repository(tmp_path)
    (tmp_path / "mounted.txt").write_text("Review this mounted file")
    environment = git_review.command_environment
    monkeypatch.setattr(git_review, "command_environment", lambda root, developer=False: {
        **environment(root, developer=developer), "GIT_TEST_ASSUME_DIFFERENT_OWNER": "1"})
    reviewed = await status(tmp_path)
    assert reviewed["files"] == [{"path": "mounted.txt", "status": "??", "original_path": None}]
    staged = await stage(tmp_path, "mounted.txt", True)
    assert staged["files"][0]["status"] == "A "


@pytest.mark.asyncio
async def test_git_review_never_reviews_an_ancestor_repository(tmp_path):
    repository(tmp_path)
    (tmp_path / "parent.txt").write_text("Outside the selected project")
    project = tmp_path / "child"
    project.mkdir()
    with pytest.raises(WorkspaceError, match="repository root"):
        await status(project)


def test_discovers_monorepo_tasks_without_executing_or_reading_dependencies(tmp_path):
    frontend = tmp_path / "web app"
    frontend.mkdir()
    (frontend / "package.json").write_text(json.dumps({"packageManager": "pnpm@10.0.0", "scripts": {
        "build": "echo build", "dev": "vite", "test; touch hacked": "echo bad", "empty": ""}}))
    (tmp_path / "Cargo.toml").write_text('[package]\nname="example"\n')
    ignored = tmp_path / "node_modules"
    ignored.mkdir()
    (ignored / "package.json").write_text('{"scripts":{"hidden":"echo hidden"}}')
    result = discover(tmp_path)
    tasks = {t["id"]: t for t in result["tasks"]}
    assert tasks["web app:package.json:build"]["command"] == 'pnpm run "build"'
    assert tasks["web app:package.json:build"]["directory"] == "web app"
    assert tasks["web app:package.json:dev"]["kind"] == "server"
    assert any(t["command"] == "cargo test" for t in tasks.values())
    assert not any("hacked" in t["name"] or "hidden" in t["name"] for t in tasks.values())
    assert not (tmp_path / "hacked").exists()


def test_tasks_handle_invalid_and_oversized_manifests_and_external_symlinks(tmp_path):
    (tmp_path / "package.json").write_text("invalid JSON")
    assert discover(tmp_path)["warnings"] == ["Could not read package.json"]
    (tmp_path / "package.json").write_text("x" * 100001)
    assert discover(tmp_path)["tasks"] == []
    outside = tmp_path.parent / f"outside-{tmp_path.name}"
    outside.mkdir()
    (outside / "package.json").write_text('{"scripts":{"secret":"echo secret"}}')
    (tmp_path / "linked").symlink_to(outside, target_is_directory=True)
    assert discover(tmp_path)["tasks"] == []


@pytest.mark.asyncio
async def test_task_discovery_is_allowed_in_read_only_projects(client, workspace):
    root = Path(workspace["path"])
    (root / "package.json").write_text('{"scripts":{"test":"echo test"}}')
    await client.patch(f"/api/v1/workspaces/{workspace['id']}", json={"default_permission": "read_only"})
    response = await client.get(f"/api/v1/w/{workspace['id']}/editor/tasks")
    assert response.status_code == 200
    assert response.json()["tasks"][0]["command"] == 'npm run "test"'


@pytest.mark.asyncio
async def test_commit_contains_only_staged_snapshot_and_preserves_working_edits(tmp_path):
    repository(tmp_path)
    (tmp_path / "app.txt").write_text("staged version")
    await stage(tmp_path, "app.txt", True)
    reviewed = await status(tmp_path)
    (tmp_path / "app.txt").write_text("unsaved-to-index version")
    result = await commit(tmp_path, "Add app", reviewed["index_revision"])
    assert git(tmp_path, "show", "HEAD:app.txt") == "staged version"
    assert (tmp_path / "app.txt").read_text() == "unsaved-to-index version"
    assert result["status"]["files"][0]["status"] == " M"
    assert result["commit_sha"] == git(tmp_path, "rev-parse", "HEAD")


@pytest.mark.asyncio
async def test_commit_rejects_stale_index_empty_message_and_hidden_staged_files(tmp_path):
    repository(tmp_path)
    (tmp_path / "app.txt").write_text("one")
    await stage(tmp_path, "app.txt", True)
    reviewed = await status(tmp_path)
    (tmp_path / "app.txt").write_text("two")
    git(tmp_path, "add", "app.txt")
    with pytest.raises(WorkspaceError, match="changed since your review"):
        await commit(tmp_path, "Old review", reviewed["index_revision"])
    current = await status(tmp_path)
    with pytest.raises(WorkspaceError, match="nonempty"):
        await commit(tmp_path, " \n ", current["index_revision"])
    (tmp_path / ".env").write_text("SECRET=private")
    git(tmp_path, "add", ".env")
    current = await status(tmp_path)
    with pytest.raises(WorkspaceError, match="secrets"):
        await commit(tmp_path, "Must not include hidden secret", current["index_revision"])
    with pytest.raises(subprocess.CalledProcessError):
        git(tmp_path, "rev-parse", "--verify", "HEAD")
    assert git(tmp_path, "diff", "--cached", "--name-only").splitlines() == [".env", "app.txt"]


@pytest.mark.asyncio
async def test_ui_commit_does_not_execute_repository_hooks(tmp_path):
    repository(tmp_path)
    hook = tmp_path / ".git/hooks/pre-commit"
    hook.write_text("#!/bin/sh\necho ran > hook-ran.txt\nexit 1\n")
    hook.chmod(0o755)
    (tmp_path / "app.txt").write_text("hello")
    await stage(tmp_path, "app.txt", True)
    await commit(tmp_path, "Explicit UI commit", (await status(tmp_path))["index_revision"])
    assert not (tmp_path / "hook-ran.txt").exists()


@pytest.mark.asyncio
async def test_commit_endpoint_permission_and_index_validation(client, workspace):
    root = Path(workspace["path"])
    repository(root)
    (root / "app.txt").write_text("hello")
    await stage(root, "app.txt", True)
    base = f"/api/v1/w/{workspace['id']}/editor/git"
    current = (await client.get(base)).json()
    body = {"message": "From workbench", "expected_index": current["index_revision"]}
    await client.patch(f"/api/v1/workspaces/{workspace['id']}", json={"default_permission": "plan"})
    assert (await client.post(base + "/commit", json=body)).status_code == 403
    await client.patch(f"/api/v1/workspaces/{workspace['id']}", json={"default_permission": "ask"})
    assert (await client.post(base + "/commit", json={**body, "expected_index": "bad"})).status_code == 422
    result = await client.post(base + "/commit", json=body)
    assert result.status_code == 200, result.text
    assert result.json()["status"]["files"] == []
    assert (await client.post(base + "/commit", json=body)).status_code == 400


def test_project_guidance_is_refreshed_bounded_and_sandboxed(tmp_path):
    (tmp_path / "AGENTS.md").write_text("Use strict TypeScript and run tests.")
    assert "Use strict TypeScript" in load(tmp_path)
    (tmp_path / "AGENTS.md").write_text("Now use Python.")
    assert "Now use Python" in load(tmp_path)
    (tmp_path / "CLAUDE.md").write_text("x" * 17000)
    assert "[Project instructions truncated.]" in load(tmp_path)
    (tmp_path / "AGENTS.md").unlink()
    outside = tmp_path.parent / f"guidance-{tmp_path.name}.md"
    outside.write_text("External private instructions")
    (tmp_path / "AGENTS.md").symlink_to(outside)
    assert "External private instructions" not in load(tmp_path)


@pytest.mark.asyncio
async def test_detected_subproject_task_runs_in_its_folder_and_rejects_escape(client, workspace):
    root = Path(workspace["path"])
    nested = root / "python app"
    nested.mkdir()
    (nested / "check.py").write_text("from pathlib import Path\nprint(Path.cwd().name, flush=True)\n")
    base = f"/api/v1/w/{workspace['id']}/editor/commands/current"
    try:
        started = await client.post(base, json={"command": "python check.py", "directory": "python app"})
        assert started.status_code == 200, started.text
        assert started.json()["directory"] == "python app"
        for _ in range(100):
            current = (await client.get(base)).json()
            if current["status"] == "exited":
                break
            await asyncio.sleep(0.02)
        assert current["exit_code"] == 0
        assert "python app" in current["output"]
        for directory in ("../", str(root.parent), "missing", ".octopus"):
            response = await client.post(base, json={"command": "python check.py", "directory": directory})
            assert response.status_code == 400, response.text
    finally:
        await client.delete(base)
