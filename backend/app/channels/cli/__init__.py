"""CLI channel: the developer command line (decision D4: the dev scripts stay the CLI for now).

The scripts are not moved, because the start scripts and the Makefile reference them. The start entry points are
``start.sh``, ``start.bat``, and ``octopus.ps1`` at the repo root, plus the Makefile targets. The dev tools are in the
repo-root ``scripts/`` folder: ``bench.py``, ``evaluate_runtime.py``, ``folder_bridge.py``, ``runtime_doctor.py``, and
``visual/``. This module holds the manifest only and has no HTTP routes.
"""
from __future__ import annotations

from app.channels import catalog_manifest
from app.core.manifest import Manifest


class CliChannel:
    manifest: Manifest = catalog_manifest("channel.cli")
