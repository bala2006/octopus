"""Project sandbox, path traversal, command sandbox and permission levels (read_only / plan / ask / danger)."""
from __future__ import annotations

import asyncio
import os
from pathlib import Path

import pytest

from app.core.security import hash_password, verify_password
from app.llm.router import set_provider_override
from app.tools.sandbox import SandboxError, parse_command, run_command
from app.tools.workspace import ProjectFS, WorkspaceError, normalize_path
from conftest import ScriptedProvider, agent, edge, env, events, make_company, start_run, wait_status


def test_long_passwords_hash_and_verify_with_bcrypt5() -> None:
    """bcrypt>=5 raises on >72-byte passwords; the API accepts up to 200 chars, so hashing must truncate like bcrypt<5 did."""
    import bcrypt

    long_pw = "correct horse battery staple " * 6  # ~174 bytes
    h = hash_password(long_pw)
    assert verify_password(long_pw, h)
    assert not verify_password("x" + long_pw[1:], h)
    # a hash created by bcrypt<5 (which silently used the first 72 bytes) still verifies
    legacy = bcrypt.hashpw(long_pw.encode()[:72], bcrypt.gensalt()).decode()
    assert verify_password(long_pw, legacy)
    assert not verify_password("short-but-wrong", h)


async def test_register_and_login_with_long_password(client) -> None:
    pw = "p" * 150
    r = await client.post("/api/v1/auth/register", json={"email": "long-pw@example.com", "password": pw})
    assert r.status_code in (200, 201), r.text
    r = await client.post("/api/v1/auth/login", json={"email": "long-pw@example.com", "password": pw})
    assert r.status_code == 200, r.text


@pytest.mark.parametrize("bad", ["../x", "a/../../x", "/etc/passwd", "~/x", "C:/win", ".octopus/octopus.db", ".git/config", "a\x00b"])
def test_normalize_rejects(bad: str) -> None:
    with pytest.raises(WorkspaceError):
        normalize_path(bad)


def test_symlink_escape_blocked(tmp_path: Path) -> None:
    root = tmp_path / "proj"
    root.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.txt").write_text("s3cr3t")
    os.symlink(outside, root / "link")
    fs = ProjectFS(root)
    with pytest.raises(WorkspaceError):
        fs.read("link/secret.txt")
    with pytest.raises(WorkspaceError):
        fs.write("link/new.txt", "x")
    assert not (outside / "new.txt").exists()


def test_secrets_blocked_unless_danger(tmp_path: Path) -> None:
    (tmp_path / ".env").write_text("KEY=1")
    (tmp_path / ".env.example").write_text("KEY=")
    with pytest.raises(WorkspaceError):
        ProjectFS(tmp_path).read(".env")
    assert ProjectFS(tmp_path).read(".env.example") == "KEY="
    assert ProjectFS(tmp_path, allow_secrets=True).read(".env") == "KEY=1"
    assert ".env" not in ProjectFS(tmp_path).list()


def test_plan_shadow(tmp_path: Path) -> None:
    (tmp_path / "a.txt").write_text("orig")
    fs = ProjectFS(tmp_path, shadow=tmp_path / ".octopus" / "plans" / "r1")
    fs.write("a.txt", "planned")
    assert (tmp_path / "a.txt").read_text() == "orig"
    assert fs.read("a.txt") == "planned"


@pytest.mark.parametrize("cmd", ["rm -rf .", "python -c 'print(1)'", "ls; cat /etc/passwd", "cat ../x", "python ../evil.py",
                                 "curl http://x", "bash -c ls", "python .octopus/x.py"])
def test_command_sandbox_rejects(cmd: str) -> None:
    with pytest.raises(SandboxError):
        parse_command(cmd)


def test_danger_allows_more_but_not_shell_ops() -> None:
    assert parse_command("bash -c ls".replace("-c ls", "--version"), danger=True)[0] == "bash"
    with pytest.raises(SandboxError):
        parse_command("ls && rm x", danger=True)


async def test_sandbox_timeout_and_cwd(tmp_path: Path) -> None:
    (tmp_path / "loop.py").write_text("import os\nprint(os.getcwd())\nwhile True: pass\n")
    res = await run_command("python loop.py", tmp_path, timeout=2)
    assert res.timed_out and not res.ok


async def test_sandbox_runs_in_project(tmp_path: Path) -> None:
    (tmp_path / "hi.py").write_text("import os\nprint('cwd=' + os.getcwd())\n")
    res = await run_command("python hi.py", tmp_path)
    assert res.ok and f"cwd={tmp_path.resolve()}" in res.output


def _writer_company() -> tuple[list, list]:
    return [agent("w", "Wes", entry=True)], []


async def _run_writer(client, workspace, level: str, extra_actions=()):  # type: ignore[no-untyped-def]
    agents, edges = _writer_company()
    cid = await make_company(client, workspace, agents, edges)
    set_provider_override(ScriptedProvider({"Wes": [
        env({"action": "write_file", "path": "out.txt", "content": "hello"}, *extra_actions),
        env({"action": "finish", "summary": "done"})]}))
    return await start_run(client, workspace, cid, permission_level=level)


async def test_read_only_blocks_writes(client, workspace) -> None:
    run = await _run_writer(client, workspace, "read_only")
    await wait_status(client, workspace, run["id"])
    assert not (Path(workspace["path"]) / "out.txt").exists()
    errs = [e["payload"]["message"] for e in await events(client, workspace, run["id"], "error")]
    assert any("read-only" in m for m in errs)


async def test_plan_mode_writes_to_shadow_and_apply(client, workspace) -> None:
    run = await _run_writer(client, workspace, "plan", [{"action": "run_code", "command": "python -V"}])
    await wait_status(client, workspace, run["id"])
    root = Path(workspace["path"])
    assert not (root / "out.txt").exists()
    assert (root / ".octopus" / "plans" / run["id"] / "out.txt").read_text() == "hello"
    arts = (await client.get(f"/api/v1/w/{workspace['id']}/runs/{run['id']}/artifacts")).json()
    assert arts[0]["planned"] is True
    errs = [e["payload"]["message"] for e in await events(client, workspace, run["id"], "error")]
    assert any("Plan mode" in m for m in errs), "terminal is not allowed in plan mode"
    r = await client.post(f"/api/v1/w/{workspace['id']}/runs/{run['id']}/plans/apply")
    assert r.json()["applied"] == ["out.txt"] and (root / "out.txt").read_text() == "hello"


async def test_ask_mode_requires_approval_and_always_allow(client, workspace) -> None:
    agents = [agent("w", "Wes", entry=True)]
    cid = await make_company(client, workspace, agents, [])
    set_provider_override(ScriptedProvider({"Wes": [
        env({"action": "write_file", "path": "a.txt", "content": "1"}),
        env({"action": "write_file", "path": "b.txt", "content": "2"},
            {"action": "write_file", "path": "c.txt", "content": "3"}, {"action": "finish", "summary": "ok"})]}))
    run = await start_run(client, workspace, cid, permission_level="ask")
    base = f"/api/v1/w/{workspace['id']}/runs/{run['id']}"
    root = Path(workspace["path"])

    async def pending() -> dict:
        await wait_status(client, workspace, run["id"], {"awaiting_user"})
        for _ in range(100):
            p = (await client.get(base)).json()["state"].get("pending_approval")
            if p:
                return p
            await asyncio.sleep(0.02)
        raise AssertionError("no pending approval")

    p = await pending()
    assert p["kind"] == "write_file" and p["details"]["path"] == "a.txt"
    assert not (root / "a.txt").exists(), "nothing is written before approval"
    await client.post(f"{base}/approve", json={"approval_id": p["id"], "approved": False, "reason": "not yet"})
    p = await pending()
    assert p["details"]["path"] == "b.txt"
    await client.post(f"{base}/approve", json={"approval_id": p["id"], "approved": True, "scope": "always"})
    done = await wait_status(client, workspace, run["id"])
    assert done["status"] == "completed"
    assert not (root / "a.txt").exists() and (root / "b.txt").exists() and (root / "c.txt").exists()
    auto = [e for e in await events(client, workspace, run["id"], "approval_resolved") if e["payload"].get("auto")]
    assert auto, "third write was auto-approved by 'always allow'"


async def test_agent_level_cannot_exceed_run_level(client, workspace) -> None:
    agents = [agent("w", "Wes", entry=True, permission_level="danger")]
    cid = await make_company(client, workspace, agents, [])
    set_provider_override(ScriptedProvider({"Wes": [env({"action": "write_file", "path": "z.txt", "content": "z"}),
                                                    env({"action": "finish", "summary": "x"})]}))
    run = await start_run(client, workspace, cid, permission_level="read_only")
    await wait_status(client, workspace, run["id"])
    assert not (Path(workspace["path"]) / "z.txt").exists()


async def test_agent_cannot_touch_octopus_dir(client, workspace) -> None:
    agents = [agent("w", "Wes", entry=True)]
    cid = await make_company(client, workspace, agents, [])
    set_provider_override(ScriptedProvider({"Wes": [env({"action": "write_file", "path": ".octopus/octopus.db", "content": "pwned"},
                                                        {"action": "read_file", "path": "../../etc/passwd"}),
                                                    env({"action": "finish", "summary": "x"})]}))
    run = await start_run(client, workspace, cid, permission_level="danger")
    await wait_status(client, workspace, run["id"])
    db = Path(workspace["path"]) / ".octopus" / "octopus.db"
    assert db.read_bytes()[:6] == b"SQLite"
    results = [e["payload"] for e in await events(client, workspace, run["id"], "tool_result")]
    assert all(not r["ok"] for r in results if r["tool"] in ("write_file", "read_file"))


@pytest.mark.parametrize("path", [".octopus/octopus.db", ".octopus/plans/r1/x.py", ".octopus/exports/a.json", ".octopus/browser/s.png",
                                  ".octopus/project.json", ".octopus/workspace/x", ".octopus"])
def test_only_the_work_subtree_of_octopus_is_open(path: str) -> None:
    with pytest.raises(WorkspaceError):
        normalize_path(path)
    assert normalize_path(".octopus/work/qa/test_plan.md") == ".octopus/work/qa/test_plan.md"
    assert normalize_path("./.octopus/work") == ".octopus/work"


def test_work_docs_are_listed_separately(tmp_path: Path) -> None:
    fs = ProjectFS(tmp_path)
    fs.write("index.html", "<html></html>")
    fs.write(".octopus/work/qa/test_plan.md", "# plan")
    assert fs.list() == ["index.html"], "the project tree holds deliverables only"
    assert fs.list_work() == [".octopus/work/qa/test_plan.md"]
    with pytest.raises(WorkspaceError):
        fs.move(".octopus/work", "work")


async def test_working_docs_go_to_octopus_work_and_user_files_are_flagged(client, workspace) -> None:
    root = Path(workspace["path"])
    (root / "notes.txt").write_text("my own notes")
    cid = await make_company(client, workspace, [agent("w", "Wes", entry=True)], [])
    set_provider_override(ScriptedProvider({"Wes": [env({"action": "write_file", "path": ".octopus/work/qa/test_plan.md", "content": "# QA plan"},
                                                        {"action": "write_file", "path": "index.html", "content": "<html></html>"},
                                                        {"action": "write_file", "path": "notes.txt", "content": "overwritten"}),
                                                    env({"action": "finish", "summary": "x"})]}))
    run = await start_run(client, workspace, cid, permission_level="danger")
    await wait_status(client, workspace, run["id"])
    assert (root / ".octopus/work/qa/test_plan.md").read_text() == "# QA plan"
    files = {f["path"]: f for f in (await client.get(f"/api/v1/w/{workspace['id']}/files")).json()}
    assert files[".octopus/work/qa/test_plan.md"]["area"] == "work" and files[".octopus/work/qa/test_plan.md"]["generated"]
    assert files["index.html"]["area"] == "project" and files["index.html"]["generated"]
    assert not any(p.startswith(".octopus/") and f["area"] == "project" for p, f in files.items())
    content = await client.get(f"/api/v1/w/{workspace['id']}/files/content", params={"path": ".octopus/work/qa/test_plan.md"})
    assert content.status_code == 200 and content.json()["content"] == "# QA plan"
    assert (await client.get(f"/api/v1/w/{workspace['id']}/files/content", params={"path": ".octopus/octopus.db"})).status_code == 400
    warns = [e["payload"] for e in await events(client, workspace, run["id"], "error") if e["payload"].get("kind") == "warning"]
    assert [w["path"] for w in warns] == ["notes.txt"], "only the user's own pre-existing file is flagged"


async def test_workspace_creation_and_browse(client, tmp_root) -> None:
    d = tmp_root / "brand-new"
    d.mkdir()
    r = await client.post("/api/v1/workspaces", json={"path": str(d)})
    assert r.status_code == 201
    assert (d / ".octopus" / "project.json").is_file() and (d / ".octopus" / "octopus.db").is_file()
    r = await client.get("/api/v1/fs/browse", params={"path": str(tmp_root)})
    names = {e["name"]: e for e in r.json()["entries"]}
    assert names["brand-new"]["is_project"] is True
    assert (await client.post("/api/v1/workspaces", json={"path": "/etc"})).status_code == 400
    assert (await client.get("/api/v1/fs/browse", params={"path": "/"})).status_code == 400


async def test_concurrent_first_requests_share_the_single_user(tmp_path) -> None:
    """Regression: two first requests both inserted the single local user (UNIQUE constraint failed: users.email)."""
    import asyncio

    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.core.deps import get_or_create_single_user
    from app.db.migrate import upgrade_registry

    url = f"sqlite+aiosqlite:///{tmp_path / 'registry.db'}"
    upgrade_registry(url)
    sf = async_sessionmaker(create_async_engine(url), expire_on_commit=False)

    async def one():  # type: ignore[no-untyped-def]
        async with sf() as db:
            return (await get_or_create_single_user(db)).id

    ids = await asyncio.gather(*(one() for _ in range(8)))
    assert len(set(ids)) == 1
