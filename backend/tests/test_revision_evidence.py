from pathlib import Path

import pytest

from app.orchestrator import evidence as E
from app.services.skill_contracts import ContractError


ENV = {"python": "3.12", "lockfile": "known-lock"}


def check(command="python -m pytest tests/test_app.py", **kwargs):
    return E.VerificationCheck(kind="command", name="Relevant regression", command=command, exit_code=0,
                               observed=True, tool_call_id="tool-1", **kwargs)


def record(manifest, **kwargs):
    if "covered_paths" not in kwargs:
        kwargs["covered_paths"] = [file.path for file in manifest.files]
        kwargs["whole_project"] = manifest.selection is None
    return E.record_evidence(manifest, task_revision=1, environment=ENV, criterion_ids=["AC-1"],
                             check=check(), status="pass", producer="qa", **kwargs)


def test_actual_external_edit_invalidates_previously_passing_evidence(tmp_path):
    target = tmp_path / "app.py"
    target.write_text("answer = 1\n", encoding="utf-8")
    original = E.capture_manifest(tmp_path)
    proof = record(original)
    assert E.validate_evidence(proof, original, task_revision=1, environment=ENV, criterion="AC-1").valid
    target.write_text("answer = 2\n", encoding="utf-8")
    latest = E.capture_manifest(tmp_path)
    assert E.changed_paths(original, latest) == ("app.py",)
    result = E.validate_evidence(proof, latest, task_revision=1, environment=ENV, criterion="AC-1")
    assert not result.valid
    assert "Artifact changed: app.py" in result.reasons
    assert result.status == "unknown"


def test_scoped_success_does_not_clear_unrelated_files(tmp_path):
    (tmp_path / "app.py").write_text("answer = 1", encoding="utf-8")
    (tmp_path / "other.py").write_text("answer = 2", encoding="utf-8")
    manifest = E.capture_manifest(tmp_path)
    criterion = E.AcceptanceCriterion(id="AC-1", description="App returns one", required_paths=("app.py",))
    scoped = record(manifest, covered_paths=["app.py"])
    (tmp_path / "other.py").write_text("changed unrelated file", encoding="utf-8")
    latest = E.capture_manifest(tmp_path)
    assert E.validate_evidence(scoped, latest, task_revision=1, environment=ENV, criterion=criterion).valid
    other_criterion = E.AcceptanceCriterion(id="AC-1", description="Both files", required_paths=("app.py", "other.py"))
    assert not E.validate_evidence(scoped, latest, task_revision=1, environment=ENV, criterion=other_criterion).valid


def test_new_files_invalidate_whole_project_proof_and_deletions_are_visible(tmp_path):
    (tmp_path / "app.py").write_text("print('ok')", encoding="utf-8")
    original = E.capture_manifest(tmp_path)
    proof = record(original)
    (tmp_path / "new.py").write_text("print('new')", encoding="utf-8")
    assert not E.validate_evidence(proof, E.capture_manifest(tmp_path), task_revision=1, environment=ENV, criterion="AC-1").valid
    (tmp_path / "app.py").unlink()
    assert "app.py" in E.changed_paths(original, E.capture_manifest(tmp_path))
    deleted = E.capture_manifest(tmp_path, ["app.py"])
    assert deleted.files[0].exists is False
    assert deleted.files[0].sha256 is None


def test_manifest_excludes_metadata_dependencies_and_secret_files(tmp_path):
    for path in [".octopus/memory.json", "node_modules/pkg.js", ".git/config", ".env", "credentials.json"]:
        target = tmp_path / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("sensitive", encoding="utf-8")
    (tmp_path / "app.py").write_text("ok", encoding="utf-8")
    manifest = E.capture_manifest(tmp_path)
    assert [file.path for file in manifest.files] == ["app.py"]
    assert manifest.complete
    with pytest.raises(ValueError):
        E.capture_manifest(tmp_path, [".env"])
    with pytest.raises(ContractError):
        E.capture_manifest(tmp_path, ["node_modules/pkg.js"])


def test_binary_hashes_are_bounded_and_incomplete_inventory_cannot_pass(tmp_path, monkeypatch):
    (tmp_path / "image.png").write_bytes(b"\x89PNG\x00test")
    first = E.capture_manifest(tmp_path)
    assert [file.path for file in first.files] == ["image.png"]
    monkeypatch.setattr(E, "MAX_BINARY_BYTES", 4)
    capped = E.capture_manifest(tmp_path)
    assert not capped.complete
    assert record(capped).status == "unknown"


@pytest.mark.parametrize("command", ["echo pytest tests/test_app.py", "ls app.py", "python -c 'print(1)'", "pytest; echo success", "npm run test && echo done"])
def test_nonchecks_and_shell_compositions_cannot_certify_artifacts(tmp_path, command):
    manifest = E.capture_manifest(tmp_path)
    proof = E.record_evidence(manifest, task_revision=1, environment=ENV, criterion_ids=["AC-1"],
                              check=check(command), status="pass", producer="qa")
    assert proof.status == "unknown"
    assert not E.validate_evidence(proof, manifest, task_revision=1, environment=ENV, criterion="AC-1").valid


def test_revision_environment_and_check_kind_are_not_interchangeable(tmp_path):
    manifest = E.capture_manifest(tmp_path)
    proof = record(manifest)
    ui = E.AcceptanceCriterion(id="AC-1", description="Popup reanchors after restore", check_kinds=("ui",))
    assert not E.validate_evidence(proof, manifest, task_revision=1, environment=ENV, criterion=ui).valid
    assert not E.validate_evidence(proof, manifest, task_revision=2, environment=ENV, criterion="AC-1").valid
    assert not E.validate_evidence(proof, manifest, task_revision=1, environment={"python": "different"}, criterion="AC-1").valid
    observed = E.VerificationCheck(kind="ui", name="Popup lifecycle", scenario="Open popup, collapse chat, restore, inspect anchor", observed=True, tool_call_id="browser-1")
    ui_proof = E.record_evidence(manifest, task_revision=1, environment=ENV, criterion_ids=["AC-1"], check=observed, status="pass", producer="qa")
    assert E.validate_evidence(ui_proof, manifest, task_revision=1, environment=ENV, criterion=ui).valid


def test_failed_and_unknown_results_are_retained_without_success_promotion(tmp_path):
    manifest = E.capture_manifest(tmp_path)
    failure = E.record_evidence(manifest, task_revision=1, environment=ENV, criterion_ids=["AC-1"], check=check(), status="fail", producer="qa", output="Expected 1, got 2")
    assert failure.status == "fail"
    assert failure.output == "Expected 1, got 2"
    assert E.validate_evidence(failure, manifest, task_revision=1, environment=ENV, criterion="AC-1").status == "fail"
    claimed = E.VerificationCheck(kind="command", name="Agent says tests passed", command="pytest", exit_code=0)
    unknown = E.record_evidence(manifest, task_revision=1, environment=ENV, criterion_ids=["AC-1"], check=claimed, status="pass", producer="builder")
    assert unknown.status == "unknown"


def test_capture_redacts_secrets_before_serialization(tmp_path):
    manifest = E.capture_manifest(tmp_path)
    raw = 'API_KEY="abc-super-secret"\nAuthorization: Bearer private-token\npassword: hunter2\nhttps://user:dbpassword@localhost/db'
    proof = record(manifest, output=raw)
    serialized = proof.model_dump_json()
    for secret in ("abc-super-secret", "private-token", "hunter2", "dbpassword"):
        assert secret not in serialized
    assert "[REDACTED]" in serialized
    assert E.RevisionEvidence.model_validate_json(serialized) == proof


def test_omitting_coverage_cannot_certify_unrelated_artifacts(tmp_path):
    (tmp_path / "app.py").write_text("print('ok')", encoding="utf-8")
    manifest = E.capture_manifest(tmp_path)
    proof = E.record_evidence(manifest, task_revision=1, environment=ENV, criterion_ids=["AC-1"],
                              check=check(), status="pass", producer="qa")
    assert proof.coverage == ()
    assert proof.status == "unknown"
    with pytest.raises(ContractError, match="complete unselected"):
        E.record_evidence(manifest, task_revision=1, environment=ENV, criterion_ids=["AC-1"], check=check(),
                          status="pass", producer="qa", whole_project=True)
