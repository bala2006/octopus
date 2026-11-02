from pathlib import Path

import pytest

from app.orchestrator import workspaces as W
from app.services.skill_contracts import ContractError


def project(tmp_path):
    root = tmp_path / "project"
    root.mkdir()
    (root / "app.py").write_text("answer = 1\n", encoding="utf-8")
    (root / "delete.py").write_text("old = True\n", encoding="utf-8")
    (root / "other.py").write_text("unrelated = True\n", encoding="utf-8")
    for relative in (".octopus/memory.json", ".git/config", "node_modules/pkg.js", ".env"):
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("do not copy", encoding="utf-8")
    (root / "asset.png").write_bytes(b"\x89PNG\x00binary")
    return root


def test_stage_isolated_text_edits_integrate_additions_deletions_and_preserve_private_files(tmp_path):
    root = project(tmp_path)
    stage, base = W.create_stage(root, "run-1", "attempt-1")
    assert {file.path for file in base.files} == {"app.py", "delete.py", "other.py"}
    assert not (stage / ".octopus").exists()
    assert not (stage / "node_modules").exists()
    assert not (stage / "asset.png").exists()
    (stage / "app.py").write_text("answer = 2\n", encoding="utf-8")
    (stage / "delete.py").unlink()
    (stage / "new").mkdir()
    (stage / "new" / "created.py").write_text("new = True\n", encoding="utf-8")
    assert (root / "app.py").read_text() == "answer = 1\n"
    changed = W.integrate(stage, root, base)
    assert changed == ("app.py", "delete.py", "new/created.py")
    assert (root / "app.py").read_text() == "answer = 2\n"
    assert not (root / "delete.py").exists()
    assert (root / "new" / "created.py").read_text() == "new = True\n"
    assert (root / ".octopus" / "memory.json").read_text() == "do not copy"
    assert (root / "node_modules" / "pkg.js").read_text() == "do not copy"
    assert (root / "asset.png").read_bytes() == b"\x89PNG\x00binary"


def test_conflicting_canonical_edit_rejects_entire_batch_before_first_write(tmp_path):
    root = project(tmp_path)
    stage, base = W.create_stage(root, "run", "attempt")
    (stage / "app.py").write_text("worker change", encoding="utf-8")
    (stage / "delete.py").unlink()
    (root / "delete.py").write_text("external edit", encoding="utf-8")
    with pytest.raises(W.WorkspaceConflict, match="delete.py"):
        W.integrate(stage, root, base)
    assert (root / "app.py").read_text() == "answer = 1\n"
    assert (root / "delete.py").read_text() == "external edit"


def test_task_scope_rejects_entire_stage_before_any_canonical_write(tmp_path):
    root = project(tmp_path)
    stage, base = W.create_stage(root, "run", "attempt")
    (stage / "app.py").write_text("allowed change", encoding="utf-8")
    (stage / "other.py").write_text("out of scope", encoding="utf-8")
    with pytest.raises(W.WorkspaceConflict, match="outside its task write scope: other.py"):
        W.integrate(stage, root, base, write_paths=("app.py",))
    assert (root / "app.py").read_text() == "answer = 1\n"
    assert (root / "other.py").read_text() == "unrelated = True\n"
    assert W.integration_status(root, "run", "attempt") is None


def test_addition_cannot_overwrite_a_file_created_after_the_base(tmp_path):
    root = project(tmp_path)
    stage, base = W.create_stage(root, "run", "attempt")
    (stage / "new.py").write_text("worker", encoding="utf-8")
    (root / "new.py").write_text("external", encoding="utf-8")
    with pytest.raises(W.WorkspaceConflict, match="new.py"):
        W.integrate(stage, root, base)
    assert (root / "new.py").read_text() == "external"


def test_unrelated_canonical_edit_survives_and_parallel_stages_have_separate_owners(tmp_path):
    root = project(tmp_path)
    first, base = W.create_stage(root, "run", "first")
    second, second_base = W.create_stage(root, "run", "second")
    (first / "app.py").write_text("first worker", encoding="utf-8")
    (second / "app.py").write_text("second worker", encoding="utf-8")
    (root / "other.py").write_text("user edit", encoding="utf-8")
    W.integrate(first, root, base)
    assert (root / "other.py").read_text() == "user edit"
    with pytest.raises(W.WorkspaceConflict, match="app.py"):
        W.integrate(second, root, second_base)


def test_create_and_integration_are_recoverable_and_idempotent(tmp_path, monkeypatch):
    root = project(tmp_path)
    stage, base = W.create_stage(root, "run", "attempt")
    (stage / "app.py").write_text("updated", encoding="utf-8")
    assert W.create_stage(root, "run", "attempt") == (stage, base)
    assert (stage / "app.py").read_text() == "updated"
    write_json = W._write_json
    def interrupted(path, value):
        if path.name == "integration.json" and '"status":"applied"' in value:
            raise OSError("crash after file apply")
        return write_json(path, value)
    monkeypatch.setattr(W, "_write_json", interrupted)
    with pytest.raises(OSError, match="crash"):
        W.integrate(stage, root, base)
    assert W.integration_status(root, "run", "attempt").status == "applying"
    assert (root / "app.py").read_text() == "updated"
    monkeypatch.setattr(W, "_write_json", write_json)
    assert W.load_stage(root, "run", "attempt") == (stage, base)
    assert W.integrate(stage, root, base) == ("app.py",)
    assert W.integration_status(root, "run", "attempt").status == "applied"
    assert W.integrate(stage, root, base) == ("app.py",)
    (root / "app.py").write_text("new user change", encoding="utf-8")
    with pytest.raises(W.WorkspaceConflict):
        W.integrate(stage, root, base)


@pytest.mark.parametrize("run_id,attempt_id", [("../escape", "attempt"), ("run", "C:/escape"), ("run", "CON"), ("run", "attempt/child")])
def test_attempt_identity_cannot_escape_storage(tmp_path, run_id, attempt_id):
    root = project(tmp_path)
    with pytest.raises(ContractError):
        W.create_stage(root, run_id, attempt_id)


@pytest.mark.parametrize("relative,raw", [(".env", b"SECRET=yes"), ("asset.png", b"\x00new binary")])
def test_worker_cannot_integrate_secrets_or_binary_artifacts(tmp_path, relative, raw):
    root = project(tmp_path)
    stage, base = W.create_stage(root, "run", "attempt")
    (stage / relative).write_bytes(raw)
    with pytest.raises(ContractError):
        W.integrate(stage, root, base)
    assert (root / ".env").read_text() == "do not copy"
    assert (root / "asset.png").read_bytes() == b"\x89PNG\x00binary"


def test_symlink_in_stage_is_rejected(tmp_path):
    root = project(tmp_path)
    stage, base = W.create_stage(root, "run", "attempt")
    outside = tmp_path / "external.py"
    outside.write_text("private", encoding="utf-8")
    try:
        (stage / "link.py").symlink_to(outside)
    except OSError:
        pytest.skip("Creating symlinks is not permitted on this host")
    with pytest.raises(ContractError, match="symlink|escapes"):
        W.integrate(stage, root, base)


def test_metadata_edit_cannot_retarget_another_project(tmp_path):
    root = project(tmp_path)
    stage, base = W.create_stage(root, "run", "attempt")
    other = tmp_path / "other"
    other.mkdir()
    with pytest.raises(ContractError):
        W.integrate(stage, other, base)


def test_working_documents_integrate_without_exposing_runtime_metadata(tmp_path):
    root = tmp_path / "project"
    (root / ".octopus/work").mkdir(parents=True)
    (root / ".octopus/work/spec.md").write_text("original", encoding="utf-8")
    (root / ".octopus/private.db").write_text("private", encoding="utf-8")
    stage, base = W.create_stage(root, "run", "attempt")
    assert (stage / ".octopus/work/spec.md").read_text() == "original"
    assert not (stage / ".octopus/private.db").exists()
    (stage / ".octopus/work/spec.md").write_text("revised", encoding="utf-8")
    assert W.integrate(stage, root, base) == (".octopus/work/spec.md",)
    assert (root / ".octopus/work/spec.md").read_text() == "revised"
