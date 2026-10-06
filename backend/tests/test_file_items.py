from pathlib import Path

import pytest


@pytest.mark.asyncio
async def test_binary_upload_download_move_trash_restore(client, workspace):
    base = f"/api/v1/w/{workspace['id']}/editor"
    data = bytes(range(256)) * 32
    uploaded = await client.post(f"{base}/asset", params={"path": "assets/image.png"}, files={"file": ("image.png", data, "image/png")})
    assert uploaded.status_code == 201, uploaded.text
    item = uploaded.json()
    assert item["size"] == len(data) and item["kind"] == "file"
    downloaded = await client.get(f"{base}/download", params={"path": item["path"]})
    assert downloaded.content == data
    assert "attachment" in downloaded.headers["content-disposition"]
    assert (await client.post(f"{base}/asset", params={"path": item["path"]}, files={"file": ("image.png", b"replacement")})).status_code == 409
    moved = await client.post(f"{base}/item/move", json={"path": item["path"], "revision": item["revision"], "destination": "assets/icon.png"})
    assert moved.status_code == 200, moved.text
    deleted = await client.post(f"{base}/item/trash", json={"path": moved.json()["path"], "revision": moved.json()["revision"]})
    assert deleted.status_code == 200
    restored = await client.post(f"{base}/item/restore/{deleted.json()['token']}")
    assert restored.status_code == 200, restored.text
    assert (Path(workspace["path"]) / "assets/icon.png").read_bytes() == data


@pytest.mark.asyncio
async def test_folder_move_conflict_delete_restore(client, workspace):
    base = f"/api/v1/w/{workspace['id']}/editor"
    root = Path(workspace["path"])
    (root / "src/empty").mkdir(parents=True)
    (root / "src/app.py").write_text("print('hello')")
    item = (await client.get(f"{base}/item", params={"path": "src"})).json()
    (root / "src/new.txt").write_text("external change")
    assert (await client.post(f"{base}/item/move", json={**item, "destination": "lib"})).status_code == 409
    item = (await client.get(f"{base}/item", params={"path": "src"})).json()
    moved = await client.post(f"{base}/item/move", json={**item, "destination": "lib"})
    assert moved.status_code == 200, moved.text
    assert (root / "lib/empty").is_dir() and not (root / "src").exists()
    deleted = await client.post(f"{base}/item/trash", json=moved.json())
    assert deleted.status_code == 200
    assert not (root / "lib").exists()
    (root / "lib").mkdir()
    assert (await client.post(f"{base}/item/restore/{deleted.json()['token']}")).status_code == 409
    (root / "lib").rmdir()
    assert (await client.post(f"{base}/item/restore/{deleted.json()['token']}")).status_code == 200
    assert (root / "lib/app.py").read_text() == "print('hello')"


@pytest.mark.asyncio
@pytest.mark.parametrize("private", [".env", ".git/config", "node_modules/module.js", ".octopus/registry.db"])
async def test_folder_operations_refuse_private_descendants(client, workspace, private):
    root = Path(workspace["path"])
    target = root / "src" / private
    target.parent.mkdir(parents=True)
    target.write_text("private")
    base = f"/api/v1/w/{workspace['id']}/editor"
    assert (await client.get(f"{base}/item", params={"path": "src"})).status_code == 400
    assert target.read_text() == "private"


@pytest.mark.asyncio
async def test_upload_size_boundary_leaves_no_partial_file(client, workspace, monkeypatch):
    from app.services import file_items
    monkeypatch.setattr(file_items, "MAX_UPLOAD_BYTES", 8)
    base = f"/api/v1/w/{workspace['id']}/editor"
    result = await client.post(f"{base}/asset", params={"path": "large.dat"}, files={"file": ("large.dat", b"012345678")})
    assert result.status_code == 413
    root = Path(workspace["path"])
    assert not (root / "large.dat").exists()
    assert not list(root.glob("*.octopus-tmp"))


@pytest.mark.asyncio
async def test_trash_list_survives_requests_and_skips_invalid_metadata(client, workspace):
    base = f"/api/v1/w/{workspace['id']}/editor"
    doc = (await client.put(f"{base}/document", json={"path": "keep.txt", "content": "recover me"})).json()
    token = (await client.post(f"{base}/item/trash", json={"path": doc["path"], "revision": doc["revision"]})).json()["token"]
    broken = Path(workspace["path"]) / ".octopus/trash" / ("b" * 32)
    broken.mkdir()
    (broken / "metadata.json").write_text('{"path":"../outside"}')
    (broken / "content").write_text("unsafe")
    listed = (await client.get(f"{base}/items/trash")).json()
    assert len(listed) == 1
    assert listed[0]["token"] == token and listed[0]["path"] == "keep.txt"
    assert (await client.post(f"{base}/item/restore/{token}")).status_code == 200
    assert (await client.get(f"{base}/items/trash")).json() == []
