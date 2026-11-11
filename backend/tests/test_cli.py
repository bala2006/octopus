"""The launcher decides where things run and when to rebuild; those decisions are testable without starting a server."""
from __future__ import annotations

import os
import socket
import subprocess
import sys
from argparse import Namespace

import pytest

from app import cli


def parsed(port: int | None = None, skip_build: bool = False) -> Namespace:
    return Namespace(port=port, skip_build=skip_build, python=None)


def bound() -> socket.socket:
    server = socket.socket()
    server.bind(("127.0.0.1", 0))
    server.listen()
    return server


def test_dotenv_value_reads_the_env_files(tmp_path, monkeypatch) -> None:
    (tmp_path / ".env").write_text("OCTOPUS_PORT=9000  # moved\nOTHER=x\n", encoding="utf-8")
    monkeypatch.setattr(cli, "ROOT", tmp_path)
    monkeypatch.setattr(cli, "BACKEND", tmp_path / "backend")
    assert cli.dotenv_value("OCTOPUS_PORT") == "9000"
    assert cli.dotenv_value("MISSING") == ""


def test_public_port_prefers_the_flag_then_the_environment(monkeypatch) -> None:
    monkeypatch.setattr(cli, "dotenv_value", lambda key: "")
    monkeypatch.delenv("OCTOPUS_PORT", raising=False)
    assert cli.public_port(parsed()) == 8000
    monkeypatch.setenv("OCTOPUS_PORT", "9000")
    assert cli.public_port(parsed()) == 9000
    assert cli.public_port(parsed(port=9100)) == 9100
    monkeypatch.setenv("OCTOPUS_PORT", "not-a-port")
    with pytest.raises(cli.LauncherError, match="must be a number"):
        cli.public_port(parsed())
    with pytest.raises(cli.LauncherError, match="between 1024 and 65535"):
        cli.public_port(parsed(port=80))


def test_in_use_sees_a_bound_port() -> None:
    server = bound()
    port = server.getsockname()[1]
    try:
        assert cli.in_use(port)
    finally:
        server.close()
    assert not cli.in_use(port)


def test_pick_free_moves_past_a_busy_port() -> None:
    server = bound()
    port = server.getsockname()[1]
    try:
        chosen = cli.pick_free(port - 1)
    finally:
        server.close()
    assert chosen != port


def test_node_supported_matches_the_documented_range() -> None:
    assert cli.node_supported((22, 22, 2))
    assert not cli.node_supported((22, 22, 1))
    assert cli.node_supported((24, 15, 0))
    assert not cli.node_supported((24, 14, 9))
    assert cli.node_supported((26, 0, 0))


def test_ui_is_stale_only_when_a_source_is_newer_than_the_build(tmp_path, monkeypatch) -> None:
    frontend = tmp_path / "frontend"
    (frontend / "dist").mkdir(parents=True)
    index = frontend / "dist" / "index.html"
    index.write_text("built", encoding="utf-8")
    (frontend / "src").mkdir()
    source = frontend / "src" / "main.tsx"
    source.write_text("app", encoding="utf-8")
    monkeypatch.setattr(cli, "FRONTEND", frontend)
    monkeypatch.setattr(cli, "DIST", frontend / "dist")
    os.utime(index, (3_000_000, 3_000_000))
    os.utime(source, (2_000_000, 2_000_000))
    assert not cli.ui_is_stale()
    os.utime(source, (4_000_000, 4_000_000))
    assert cli.ui_is_stale()


def test_skip_build_still_needs_a_build_to_serve(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(cli, "DIST", tmp_path)
    with pytest.raises(cli.LauncherError):
        cli.build_ui(skip=True)


def test_stop_tree_leaves_no_child_behind() -> None:
    process = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"],
                               start_new_session=os.name != "nt")
    cli.stop_tree(process)
    assert process.poll() is not None
