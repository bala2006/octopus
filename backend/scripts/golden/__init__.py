"""Golden artifact exporters (docs/architecture/refactor-plan.md, section 5).

Importing this package first loads the pytest harness in tests/conftest.py. That module sets the isolated Octopus home,
the allowed project root and the offline environment, so every exporter runs with the same settings as the test suite.
"""
from __future__ import annotations

from scripts.golden import _harness  # noqa: F401  (must load before any app module reads its settings)
