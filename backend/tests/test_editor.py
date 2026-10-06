import io
import zipfile
from pathlib import Path

import pytest

from app.tools.workspace import MAX_FILE_BYTES, ProjectFS, WorkspaceError


@pytest.mark.asyncio
async def test_edit_conflict_move_trash_restore(client, workspace):
    base = f"/api/v1/w/{workspace['id']}/editor"
    created = await client.put(f"{base}/document", json={"path": "src/app.txt", "content": "first\r\n"})
    assert created.status_code == 200, created.text
    doc = created.json()
    assert doc["size"] == 7
    assert (Path(workspace["path"]) / "src/app.txt").read_bytes() == b"first\r\n"
    duplicate = await client.put(f"{base}/document", json={"path": doc["path"], "content": "overwrite"})
    assert duplicate.status_code == 409
    saved = await client.put(f"{base}/document", json={"path": doc["path"], "content": "second", "revision": doc["revision"]})
    assert saved.status_code == 200
    stale = await client.put(f"{base}/document", json={"path": doc["path"], "content": "lost update", "revision": doc["revision"]})
    assert stale.status_code == 409
    assert (Path(workspace["path"]) / doc["path"]).read_text() == "second"
    version = {"path": doc["path"], "revision": saved.json()["revision"]}
    moved = await client.post(f"{base}/item/move", json={**version, "destination": "lib/renamed.txt"})
    assert moved.status_code == 200, moved.text
    assert not (Path(workspace["path"]) / "src/app.txt").exists()
    deleted = await client.post(f"{base}/item/trash", json={"path": moved.json()["path"], "revision": moved.json()["revision"]})
    assert deleted.status_code == 200
    assert not (Path(workspace["path"]) / "lib/renamed.txt").exists()
    restored = await client.post(f"{base}/item/restore/{deleted.json()['token']}")
    assert restored.status_code == 200
    assert (Path(workspace["path"]) / "lib/renamed.txt").read_text() == "second"


@pytest.mark.asyncio
async def test_search_tree_and_empty_folders(client, workspace):
    base = f"/api/v1/w/{workspace['id']}/editor"
    assert (await client.post(f"{base}/folder", json={"path": "src/empty"})).status_code == 201
    await client.put(f"{base}/document", json={"path": "src/hello.txt", "content": "first\nHello world\nhello again"})
    root = Path(workspace["path"])
    (root / ".env").write_text("hello secret")
    (root / "image.png").write_bytes(b"\x89PNG\x00hello")
    tree = (await client.get(f"{base}/tree")).json()
    assert "src/empty" in tree["folders"]
    assert ".env" not in tree["files"]
    result = (await client.get(f"{base}/search", params={"q": "HELLO"})).json()
    assert [(m["path"], m["line"]) for m in result["matches"]] == [("src/hello.txt", 2), ("src/hello.txt", 3)]
    assert not result["truncated"]


@pytest.mark.asyncio
@pytest.mark.parametrize("path", ["../outside.txt", ".git/config", ".GIT/config", ".octopus/octopus.db", ".OCTOPUS/key", ".env", ".ENV", "file.txt:secret", "nul.txt", "src/trailing.", "src/.git/config", "src/.octopus/data"])
async def test_editor_rejects_unsafe_paths(client, workspace, path):
    response = await client.put(f"/api/v1/w/{workspace['id']}/editor/document", json={"path": path, "content": "unsafe"})
    assert response.status_code == 400, response.text


@pytest.mark.asyncio
async def test_editor_refuses_binary_and_oversized_files(client, workspace):
    root = Path(workspace["path"])
    for name, content in [("binary.dat", b"\x00text"), ("large.txt", b"a" * (MAX_FILE_BYTES + 1))]:
        (root / name).write_bytes(content)
        result = await client.get(f"/api/v1/w/{workspace['id']}/editor/document", params={"path": name})
        assert result.status_code == 400
        assert (root / name).read_bytes() == content


def test_zip_preserves_binary_assets(tmp_path):
    data = bytes(range(256)) * 4
    (tmp_path / "image.png").write_bytes(data)
    with zipfile.ZipFile(io.BytesIO(ProjectFS(tmp_path).zip_bytes())) as archive:
        assert archive.read("image.png") == data


def test_links_cannot_expose_internal_files(tmp_path):
    protected = tmp_path / ".octopus"
    protected.mkdir()
    (protected / "private.txt").write_text("private")
    try:
        (tmp_path / "public.txt").symlink_to(protected / "private.txt")
    except OSError:
        pytest.skip("Symlink creation requires developer mode or elevated privileges on Windows")
    with pytest.raises(WorkspaceError):
        ProjectFS(tmp_path).read("public.txt")


@pytest.mark.asyncio
async def test_restore_never_overwrites_new_file(client, workspace):
    base = f"/api/v1/w/{workspace['id']}/editor"
    doc = (await client.put(f"{base}/document", json={"path": "a.txt", "content": "original"})).json()
    token = (await client.post(f"{base}/item/trash", json={"path": doc["path"], "revision": doc["revision"]})).json()["token"]
    await client.put(f"{base}/document", json={"path": "a.txt", "content": "replacement"})
    assert (await client.post(f"{base}/item/restore/{token}")).status_code == 409
    assert (Path(workspace["path"]) / "a.txt").read_text() == "replacement"


@pytest.mark.asyncio
async def test_commands_use_project_and_permission(client, workspace):
    root = Path(workspace["path"])
    (root / "check.py").write_text("from pathlib import Path\nprint(Path('marker.txt').read_text())")
    (root / "marker.txt").write_text("project command succeeded")
    base = f"/api/v1/w/{workspace['id']}/editor"
    result = await client.post(f"{base}/command", json={"command": "python check.py"})
    assert result.status_code == 200
    assert result.json()["exit_code"] == 0
    assert "project command succeeded" in result.json()["output"]
    await client.patch(f"/api/v1/workspaces/{workspace['id']}", json={"default_permission": "read_only"})
    assert (await client.post(f"{base}/command", json={"command": "python check.py"})).status_code == 403
