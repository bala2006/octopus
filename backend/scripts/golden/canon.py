"""Canonical JSON output and placeholders for volatile values (ids, timestamps, temporary paths)."""
from __future__ import annotations

import json
import re
from collections import Counter
from typing import Any

UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
TIME_RE = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[+-]\d{2}:\d{2}|Z)?")


def dump_json(value: Any) -> str:
    """Every JSON golden file: sorted keys, two-space indent, UTF-8 text, one trailing newline."""
    return json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


class Placeholders:
    """Replaces volatile values with <kind-N> names, numbered in order of first appearance."""

    def __init__(self) -> None:
        self._names: dict[tuple[str, str], str] = {}
        self._count: Counter[str] = Counter()

    def name(self, kind: str, raw: str) -> str:
        key = (kind, raw)
        if key not in self._names:
            self._count[kind] += 1
            self._names[key] = f"<{kind}-{self._count[kind]}>"
        return self._names[key]

    def scrub_text(self, text: str, literal_roots: dict[str, str]) -> str:
        """``literal_roots`` maps a temporary absolute path prefix to its stable name (e.g. "<project>")."""
        for raw, stable in sorted(literal_roots.items(), key=lambda item: -len(item[0])):
            text = text.replace(raw, stable)
        text = UUID_RE.sub(lambda m: self.name("uuid", m.group(0)), text)
        return TIME_RE.sub(lambda m: self.name("time", m.group(0)), text)

    def scrub(self, value: Any, literal_roots: dict[str, str], volatile_keys: frozenset[str] = frozenset(),
              unordered_keys: frozenset[str] = frozenset()) -> Any:
        """Recursively scrub strings.

        ``volatile_keys``: values become the fixed token <duration> (wall-clock measurements).
        ``unordered_keys``: list values are sorted, because the code builds them from a set and their order follows the process
        hash seed.
        """
        if isinstance(value, str):
            return self.scrub_text(value, literal_roots)
        if isinstance(value, list):
            return [self.scrub(item, literal_roots, volatile_keys, unordered_keys) for item in value]
        if isinstance(value, dict):
            out: dict[str, Any] = {}
            for key, item in value.items():
                if key in volatile_keys and isinstance(item, (int, float)):
                    out[key] = "<duration>"
                    continue
                scrubbed = self.scrub(item, literal_roots, volatile_keys, unordered_keys)
                if key in unordered_keys and isinstance(scrubbed, list):
                    scrubbed = sorted(scrubbed, key=lambda x: json.dumps(x, sort_keys=True))
                out[key] = scrubbed
            return out
        return value
