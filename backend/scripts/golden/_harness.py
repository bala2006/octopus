"""Loads tests/conftest.py as a module, the same way pytest does before any test runs."""
from __future__ import annotations

import sys
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parents[2] / "tests"
if str(TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(TESTS_DIR))

import conftest as harness  # sets OCTOPUS_HOME and the offline env, migrates the registry DB

__all__ = ["TESTS_DIR", "harness"]
