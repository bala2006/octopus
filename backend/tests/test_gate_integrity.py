"""Gate integrity: a change may not silently weaken a quality gate (scripts/gate_integrity.py)."""

from __future__ import annotations

import importlib.util
from pathlib import Path

_SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "gate_integrity.py"
_spec = importlib.util.spec_from_file_location("gate_integrity", _SCRIPT)
assert _spec is not None and _spec.loader is not None
gate = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(gate)


def _diff(*lines: str) -> str:
    return "\n".join(lines) + "\n"


def test_removed_test_without_replacement_is_a_violation() -> None:
    diff = _diff("--- a/backend/tests/test_x.py", "-def test_keeps_budget() -> None:", "-    assert True")
    violations = gate.check_diff(diff, ["backend/tests/test_x.py"], gate_label=False)
    assert violations == ["1 test definition(s) removed without a replacement"]


def test_renamed_test_is_not_a_removal() -> None:
    diff = _diff("-def test_old_name() -> None:", "+def test_new_name() -> None:")
    assert gate.check_diff(diff, ["backend/tests/test_x.py"], gate_label=False) == []


def test_javascript_test_block_removal_is_a_violation() -> None:
    diff = _diff("-it('rejects an empty name', () => {", "-})", "+it('accepts an empty name', () => {")
    assert gate.check_diff(diff, ["frontend/src/a.test.ts"], gate_label=False) == []
    removed_only = _diff("-it('rejects an empty name', () => {", "-})")
    assert gate.check_diff(removed_only, ["frontend/src/a.test.ts"], gate_label=False) == [
        "1 test definition(s) removed without a replacement"
    ]


def test_added_pytest_skip_is_a_violation() -> None:
    diff = _diff('+@pytest.mark.skip(reason="flaky")', "+def test_x() -> None:")
    violations = gate.check_diff(diff, ["backend/tests/test_x.py"], gate_label=False)
    assert any("skip, xfail or focus marker added" in v for v in violations)


def test_conditional_skip_is_allowed() -> None:
    diff = _diff('+@pytest.mark.skipif(not shutil.which("node"), reason="node")')
    assert gate.check_diff(diff, ["backend/tests/test_checks.py"], gate_label=False) == []


def test_added_focus_or_skip_in_javascript_is_a_violation() -> None:
    for line in ("+it.only('x', () => {", "+describe.skip('x', () => {", "+xit('x', () => {"):
        violations = gate.check_diff(_diff(line), ["frontend/src/a.test.ts"], gate_label=False)
        assert violations, line


def test_gate_file_change_needs_the_label() -> None:
    changed = [".github/workflows/ci.yml", "backend/app/kernel/policy.py"]
    without = gate.check_diff("", changed, gate_label=False)
    assert without == ["gate files changed without the 'gate-change' label: .github/workflows/ci.yml"]
    assert gate.check_diff("", changed, gate_label=True) == []


def test_non_gate_change_is_clean() -> None:
    assert gate.check_diff(_diff("+x = 1"), ["backend/app/kernel/policy.py"], gate_label=False) == []


def test_removed_lines_of_unrelated_code_are_not_flagged() -> None:
    diff = _diff("-    value = compute()", "+    value = compute(strict=True)")
    assert gate.check_diff(diff, ["backend/app/a.py"], gate_label=False) == []
