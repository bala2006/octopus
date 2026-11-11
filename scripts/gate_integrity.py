"""Fail a change that weakens a quality gate.

Reads the diff between a base and a head commit and reports:

- test definitions removed without a matching addition (Python ``test_*`` functions and JS/TS ``it``/``test`` blocks),
- newly added skip, xfail, only or focused markers,
- edits to gate files, which need the ``gate-change`` label.

``check_diff`` is pure, so the rules are tested with fixture diffs. The CLI runs git and reads the
``GATE_CHANGE_LABEL`` environment variable, which CI sets to ``true`` when the pull request has the label.

Usage: python scripts/gate_integrity.py --base <sha> --head <sha>
Exit status: 0 when clean, 1 with one line per violation.
"""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys

GATE_PATHS = (
    ".github/",
    "backend/pytest.ini",
    "backend/.importlinter",
    "backend/tests/golden/",
    "scripts/visual/",
    "frontend/vite.config.ts",
    "frontend/tsconfig.json",
    "scripts/gate_integrity.py",
)

TEST_DEFINITION = re.compile(r"""^\s*(?:async\s+)?def\s+(test_\w+)|^\s*(?:it|test)\(\s*['"`]([^'"`]+)""")
SKIP_MARKER = re.compile(
    r"pytest\.mark\.(skip|xfail)\b|\b(it|test|describe)\.(skip|only)\b|\b(xit|xtest|xdescribe)\("
)


def _test_names(lines: list[str]) -> list[str]:
    names: list[str] = []
    for line in lines:
        match = TEST_DEFINITION.match(line)
        if match:
            names.append(match.group(1) or match.group(2))
    return names


def check_diff(diff: str, changed_files: list[str], gate_label: bool) -> list[str]:
    """Return the violations for a unified diff (``git diff --unified=0``) and the changed file list."""
    added: list[str] = []
    removed: list[str] = []
    for line in diff.splitlines():
        if line.startswith("+++") or line.startswith("---"):
            continue
        if line.startswith("+"):
            added.append(line[1:])
        elif line.startswith("-"):
            removed.append(line[1:])

    violations: list[str] = []

    lost = len(_test_names(removed)) - len(_test_names(added))
    if lost > 0:
        violations.append(f"{lost} test definition(s) removed without a replacement")

    for line in added:
        if SKIP_MARKER.search(line):
            violations.append(f"skip, xfail or focus marker added: {line.strip()}")

    gate_files = [path for path in changed_files if path.startswith(GATE_PATHS)]
    if gate_files and not gate_label:
        listed = ", ".join(gate_files)
        violations.append(f"gate files changed without the 'gate-change' label: {listed}")

    return violations


def _git(*args: str) -> str:
    result = subprocess.run(["git", *args], check=True, capture_output=True, text=True)
    return result.stdout


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--base", required=True)
    parser.add_argument("--head", required=True)
    args = parser.parse_args(argv)

    diff = _git("diff", "--unified=0", f"{args.base}...{args.head}")
    changed = [line for line in _git("diff", "--name-only", f"{args.base}...{args.head}").splitlines() if line]
    label = os.environ.get("GATE_CHANGE_LABEL", "").lower() == "true"

    violations = check_diff(diff, changed, label)
    for violation in violations:
        print(f"gate-integrity: {violation}", file=sys.stderr)
    if violations:
        return 1
    print(f"gate-integrity: clean ({len(changed)} file(s) checked)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
