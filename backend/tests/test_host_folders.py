"""Opening laptop folders when Octopus runs in Docker: path mapping, API translation and the laptop-side picker."""
from __future__ import annotations

import importlib.util
import json
import threading
import urllib.error
import urllib.request
from pathlib import Path

import pytest

from app.core.config import get_settings
from app.services import hostpaths

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture
def windows_host(monkeypatch, tmp_root: Path) -> Path:
    """Pretend C:\\Users\\me on the laptop is shared into the container at <tmp_root>/host."""
    mount = tmp_root / "host"
    mount.mkdir(exist_ok=True)
    monkeypatch.setattr(get_settings(), "host_dir", "C:\\Users\\me")
    monkeypatch.setattr(get_settings(), "host_dir_mount", str(mount))
    return mount


def test_path_mapping_windows(windows_host: Path) -> None:
    m = str(windows_host)
    assert hostpaths.to_container("C:\\Users\\me\\code\\game") == f"{m}/code/game"
    assert hostpaths.to_container("c:/users/me/code/game/") == f"{m}/code/game", "drive letters and separators are normalised"
    assert hostpaths.to_container("C:\\Users\\me") == m
    assert hostpaths.to_host(f"{m}/code/game") == "C:\\Users\\me\\code\\game"
    assert hostpaths.to_host(m) == "C:\\Users\\me"
    assert hostpaths.to_container("D:\\other\\x") == "D:\\other\\x", "outside the shared folder: unchanged"
    assert hostpaths.to_host("/data/x") == "/data/x"
    assert "isn't shared" in (hostpaths.outside_shared_folder("D:\\other\\x") or "")


def test_path_mapping_posix(monkeypatch) -> None:
    monkeypatch.setattr(get_settings(), "host_dir", "/Users/me")
    monkeypatch.setattr(get_settings(), "host_dir_mount", "/host")
    assert hostpaths.to_container("/Users/me/code") == "/host/code"
    assert hostpaths.to_container("/Users/meow/code") == "/Users/meow/code", "prefix match is per path segment"
    assert hostpaths.to_host("/host/code/app") == "/Users/me/code/app"


def test_no_mapping_when_running_natively() -> None:
    assert get_settings().host_dir == ""
    assert hostpaths.to_container("C:\\Users\\me") == "C:\\Users\\me" and hostpaths.outside_shared_folder("C:\\x") is None


async def test_open_a_laptop_path_through_the_shared_folder(client, windows_host: Path) -> None:
    (windows_host / "code" / "game").mkdir(parents=True, exist_ok=True)
    r = await client.post("/api/v1/workspaces", json={"path": "C:\\Users\\me\\code\\game"})
    assert r.status_code == 201, r.text
    w = r.json()
    assert w["path"] == str(windows_host / "code" / "game") and w["display_path"] == "C:\\Users\\me\\code\\game"
    assert (windows_host / "code" / "game" / ".octopus" / "octopus.db").is_file()

    r = await client.post("/api/v1/workspaces", json={"path": "D:\\elsewhere\\proj"})
    assert r.status_code == 400 and "isn't shared with the Octopus container" in r.json()["detail"]


async def test_browse_shows_laptop_paths(client, windows_host: Path) -> None:
    (windows_host / "code").mkdir(exist_ok=True)
    body = (await client.get("/api/v1/fs/browse", params={"path": "C:\\Users\\me"})).json()
    assert body["path"] == str(windows_host) and body["display_path"] == "C:\\Users\\me"
    code = next(e for e in body["entries"] if e["name"] == "code")
    assert code["display_path"] == "C:\\Users\\me\\code"


async def test_native_status_points_the_ui_at_the_laptop_helper(client) -> None:
    body = (await client.get("/api/v1/fs/native")).json()
    assert body["bridge_url"] == "http://127.0.0.1:8765"


# ------------------------------------------------------------------ the laptop-side helper
def _bridge_module():  # type: ignore[no-untyped-def]
    spec = importlib.util.spec_from_file_location("folder_bridge", ROOT / "scripts" / "folder_bridge.py")
    mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


@pytest.fixture
def bridge():  # type: ignore[no-untyped-def]
    mod = _bridge_module()
    mod.Handler.picker = staticmethod(lambda start: Path("C:/Users/me/code/game"))
    srv = mod.serve(0)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    yield mod, f"http://127.0.0.1:{srv.server_address[1]}"
    srv.shutdown()


def _call(url: str, method: str = "GET", origin: str | None = "http://localhost:8080") -> tuple[int, dict, dict]:
    req = urllib.request.Request(url, method=method, data=b"" if method == "POST" else None, headers={"Origin": origin} if origin else {})
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, dict(r.headers), json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), json.loads(e.read() or b"{}")


def test_bridge_returns_the_picked_folder_to_the_octopus_ui(bridge) -> None:  # type: ignore[no-untyped-def]
    _, url = bridge
    status, headers, body = _call(f"{url}/pick", "POST")
    assert status == 200 and body == {"cancelled": False, "path": str(Path("C:/Users/me/code/game"))}
    assert headers["Access-Control-Allow-Origin"] == "http://localhost:8080"
    status, headers, _ = _call(f"{url}/pick", "OPTIONS")
    assert status == 204 and headers["Access-Control-Allow-Private-Network"] == "true"


def test_bridge_ignores_other_websites(bridge) -> None:  # type: ignore[no-untyped-def]
    _, url = bridge
    assert _call(f"{url}/pick", "POST", origin="https://evil.example")[0] == 403
    assert _call(f"{url}/pick", "POST", origin=None)[0] == 403


def test_bridge_reports_cancel(bridge) -> None:  # type: ignore[no-untyped-def]
    mod, url = bridge
    mod.Handler.picker = staticmethod(lambda start: None)
    assert _call(f"{url}/pick", "POST")[2] == {"cancelled": True, "path": ""}


def test_native_dialog_module_has_no_backend_dependencies() -> None:
    """The helper imports native_dialog on the laptop, where pydantic & co. aren't installed."""
    src = (ROOT / "backend" / "app" / "services" / "native_dialog.py").read_text()
    top = [ln for ln in src.splitlines() if ln.startswith(("import ", "from "))]
    assert all(ln.split()[1].split(".")[0] in {"__future__", "asyncio", "os", "shutil", "subprocess", "sys", "dataclasses", "pathlib"} for ln in top), top
