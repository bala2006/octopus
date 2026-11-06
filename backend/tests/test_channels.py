"""Channels as plugins: the mounted HTTP surface matches the golden OpenAPI, the WebSocket endpoints are mounted, the web
shell serves the built UI, the chat-apps placeholder mounts nothing, and each channel's manifest is its catalog entry."""
from __future__ import annotations

import ast
import json
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

import app as app_package
from app.channels import catalog_manifest
from app.channels import web_shell
from app.channels.api import ApiChannel
from app.channels.chat_apps import ChatAppsChannel
from app.channels.cli import CliChannel
from app.channels.web_shell import WebShellChannel
from app.channels.ws import WsChannel
from app.core.builtin import BUILTIN_MANIFESTS
from app.main import app as main_app
from app.main import create_app

BACKEND = Path(__file__).resolve().parents[1]
CHANNELS_DIR = BACKEND / "app" / "channels"
GOLDEN_OPENAPI = BACKEND / "tests" / "golden" / "openapi.json"
HTTP_METHODS = {"get", "put", "post", "delete", "options", "head", "patch", "trace"}
WS_PATHS = ("/ws/w/w1/runs/r1", "/ws/w/w1/runs/r1/browser/a1", "/ws/w/w1/chat/s1")
# Imports allowed inside app/channels. app.capabilities, app.workflows, and app.main are never allowed.
APP_IMPORTS_ALLOWED = ("app.api", "app.core", "app.services", "app.orchestrator", "app.channels")
# app/channels/deps.py is the FastAPI wiring that opens registry and project DB sessions and loads the User model.
# The one exception to the layer rules: it moved from app/core/deps.py in Phase 2.
# No other channel module may import storage.
CHANNEL_STORAGE_ALLOWED = ("app.db", "app.models")
CHANNEL_STORAGE_MODULES = {"app/channels/deps.py"}


def _operations(schema: dict) -> set[tuple[str, str]]:
    return {(path, method.upper()) for path, item in schema["paths"].items() for method in item if method in HTTP_METHODS}


def schema_operations(application: FastAPI) -> set[tuple[str, str]]:
    """(path, METHOD) for every operation in the app's OpenAPI schema (routes with include_in_schema=False are absent)."""
    return _operations(application.openapi())


def golden_operations() -> set[tuple[str, str]]:
    return _operations(json.loads(GOLDEN_OPENAPI.read_text(encoding="utf-8")))


def _imported_modules(path: Path) -> set[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    modules: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            modules.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            modules.add(node.module)
    return modules


def _under(module: str, package: str) -> bool:
    return module == package or module.startswith(package + ".")


@pytest.fixture
def build(tmp_path: Path) -> Path:
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<!doctype html><title>octopus</title>", encoding="utf-8")
    (dist / "assets" / "app.js").write_text("console.log('octopus')", encoding="utf-8")
    return dist.resolve()


# --- mounted HTTP surface -------------------------------------------------------------------------------------------

def test_api_channel_mounts_every_golden_operation_and_nothing_else() -> None:
    bare = FastAPI()
    ApiChannel().mount(bare)
    assert schema_operations(bare) == golden_operations()


def test_main_app_serves_every_golden_operation() -> None:
    assert ("/api/health", "GET") in golden_operations()
    assert schema_operations(main_app) == golden_operations()


# --- WebSocket endpoints --------------------------------------------------------------------------------------------

@pytest.mark.parametrize("path", WS_PATHS)
def test_ws_channel_mounts_each_websocket_endpoint(path: str) -> None:
    bare = FastAPI()
    WsChannel().mount(bare)
    with pytest.raises(WebSocketDisconnect) as closed:
        with TestClient(bare).websocket_connect(path) as ws:
            ws.receive_json()
    # The endpoint accepts, then closes with an app code: 4401 (no user) or 4404 (no such workspace or run).
    # A path with no route is closed by the router with 1000.
    assert closed.value.code in {4401, 4404}


# --- web shell ------------------------------------------------------------------------------------------------------

def test_web_shell_serves_index_html_at_the_root(build: Path) -> None:
    bare = FastAPI()
    WebShellChannel(dist=build).mount(bare)
    resp = TestClient(bare).get("/")
    assert resp.status_code == 200
    assert resp.text == (build / "index.html").read_text(encoding="utf-8")


def test_web_shell_serves_build_files_and_falls_back_to_index_for_client_routes(build: Path) -> None:
    bare = FastAPI()
    WebShellChannel(dist=build).mount(bare)
    client = TestClient(bare)
    assert client.get("/assets/app.js").text == "console.log('octopus')"
    assert client.get("/w/w1/agent").text == (build / "index.html").read_text(encoding="utf-8")


def test_web_shell_mounts_nothing_without_a_build(tmp_path: Path) -> None:
    bare = FastAPI()
    before = len(bare.routes)
    WebShellChannel(dist=tmp_path / "no-build").mount(bare)
    assert len(bare.routes) == before
    assert TestClient(bare).get("/").status_code == 404


def test_web_shell_default_build_is_the_repo_frontend_dist() -> None:
    assert web_shell.DEFAULT_DIST == Path(app_package.__file__).resolve().parents[2] / "frontend" / "dist"


def test_main_app_serves_the_built_ui_and_keeps_the_catch_all_last(build: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(web_shell, "DEFAULT_DIST", build)
    built = create_app()
    client = TestClient(built)
    assert client.get("/").text == (build / "index.html").read_text(encoding="utf-8")
    assert client.get("/api/health").json()["ok"] is True  # the catch-all must not shadow API routes
    assert built.routes[-1].path == "/{full_path:path}"


# --- chat apps placeholder -------------------------------------------------------------------------------------------

def test_chat_apps_placeholder_is_planned() -> None:
    assert ChatAppsChannel.manifest.id == "channel.chat_apps"
    assert ChatAppsChannel.manifest.status == "planned"


def test_chat_apps_placeholder_mounts_no_routes() -> None:
    bare = FastAPI()
    before = len(bare.routes)
    ChatAppsChannel().mount(bare)
    assert len(bare.routes) == before
    assert schema_operations(bare) == set()


def test_chat_apps_placeholder_imports_no_chat_platform() -> None:
    assert _imported_modules(CHANNELS_DIR / "chat_apps" / "__init__.py") <= {"__future__", "fastapi", "app.channels", "app.core.manifest"}


# --- manifests ------------------------------------------------------------------------------------------------------

@pytest.mark.parametrize(("channel", "plugin_id"), [
    (ApiChannel, "channel.api_ws"),
    (WsChannel, "channel.api_ws"),
    (WebShellChannel, "channel.web_shell"),
    (CliChannel, "channel.cli"),
    (ChatAppsChannel, "channel.chat_apps"),
])
def test_channel_manifest_is_its_builtin_catalog_entry(channel: type, plugin_id: str) -> None:
    manifest = channel.manifest
    assert manifest.id == plugin_id
    assert manifest.layer == "channel"
    assert manifest == catalog_manifest(plugin_id)
    assert manifest in BUILTIN_MANIFESTS


def test_cli_channel_is_partly_built_and_mounts_no_http_surface() -> None:
    assert CliChannel.manifest.status == "partly"
    assert not hasattr(CliChannel, "mount")


# --- import rules ---------------------------------------------------------------------------------------------------

def test_channel_modules_import_only_the_layers_they_may() -> None:
    modules = sorted(CHANNELS_DIR.rglob("*.py"))
    assert len(modules) >= 6
    for path in modules:
        for module in _imported_modules(path):
            if not _under(module, "app"):
                continue  # stdlib and third-party packages
            allowed = any(_under(module, prefix) for prefix in APP_IMPORTS_ALLOWED)
            if not allowed and path.relative_to(BACKEND).as_posix() in CHANNEL_STORAGE_MODULES:
                allowed = any(_under(module, prefix) for prefix in CHANNEL_STORAGE_ALLOWED)
            assert allowed, f"{path.relative_to(BACKEND)} imports {module}, which the channels layer may not import"
