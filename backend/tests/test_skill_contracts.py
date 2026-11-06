from pathlib import Path

import pytest

from app.plugins.skills.library import Skill
from app.plugins.skills.contracts import ContractError, SkillBundle, pin_project_guidance, pin_skill_bundle, workflow_spec


def make_bundle(root: Path, *, capabilities: str = "read") -> Skill:
    root.mkdir()
    (root / "references").mkdir()
    (root / "scripts").mkdir()
    body = "Inspect [the contract](references/contract.md). Use `scripts/check.py` only with approval."
    (root / "SKILL.md").write_text(f"---\nname: check-project\nversion: 2\nrequired_capabilities: [{capabilities}]\n---\n{body}", encoding="utf-8")
    (root / "references" / "contract.md").write_text("Acceptance criteria", encoding="utf-8")
    (root / "scripts" / "check.py").write_text("raise RuntimeError('must never execute while pinning')", encoding="utf-8")
    return Skill(name="check-project", description="Check an artifact", body=body, source="project")


def test_pins_full_bundle_and_script_without_executing(tmp_path):
    directory = tmp_path / "bundle"
    skill = make_bundle(directory)
    pinned = pin_skill_bundle(skill, directory, allowed_capabilities={"read"})
    assert pinned.version == "2"
    assert pinned.origin == "project"
    assert [(doc.path, doc.kind) for doc in pinned.documents] == [
        ("SKILL.md", "skill"), ("references/contract.md", "reference"), ("scripts/check.py", "script")]
    assert pinned.required_capabilities == ("read",)
    assert not pinned.reviewed
    assert SkillBundle.model_validate_json(pinned.model_dump_json()) == pinned
    previous_script = pinned.documents[-1].content
    (directory / "scripts" / "check.py").write_text("changed", encoding="utf-8")
    assert pin_skill_bundle(skill, directory, allowed_capabilities={"read"}).content_hash != pinned.content_hash
    assert pinned.documents[-1].content == previous_script


def test_capabilities_are_requirements_not_permission_grants(tmp_path):
    directory = tmp_path / "bundle"
    skill = make_bundle(directory, capabilities="shell")
    with pytest.raises(ContractError, match="outside the assignment"):
        pin_skill_bundle(skill, directory, allowed_capabilities={"read"})
    allowed = pin_skill_bundle(skill, directory, allowed_capabilities={"read", "shell"}, reviewed=True)
    assert allowed.required_capabilities == ("shell",)
    assert allowed.reviewed
    assert "grants" not in allowed.model_dump()


@pytest.mark.parametrize("reference", ["../outside.md", "C:/private.txt", "file:///private.txt", "%2e%2e/outside.md", "references/missing.md"])
def test_bundle_rejects_escaping_or_missing_references(tmp_path, reference):
    directory = tmp_path / "bundle"
    skill = make_bundle(directory)
    skill = Skill(name=skill.name, description=skill.description, body=f"Read [reference]({reference})")
    with pytest.raises(ContractError):
        pin_skill_bundle(skill, directory, allowed_capabilities={"read"})


def test_remote_reference_is_recorded_without_download(tmp_path):
    directory = tmp_path / "bundle"
    skill = make_bundle(directory)
    skill = Skill(name=skill.name, description=skill.description, body="[docs](https://example.invalid/doc)")
    assert pin_skill_bundle(skill, directory, allowed_capabilities={"read"}).remote_references == ("https://example.invalid/doc",)


def test_unreferenced_files_are_part_of_the_hash_and_secrets_are_rejected(tmp_path):
    directory = tmp_path / "bundle"
    skill = make_bundle(directory)
    first = pin_skill_bundle(skill, directory, allowed_capabilities={"read"})
    (directory / "notes.md").write_text("New instructions", encoding="utf-8")
    assert pin_skill_bundle(skill, directory, allowed_capabilities={"read"}).content_hash != first.content_hash
    (directory / "credentials.txt").write_text("private", encoding="utf-8")
    with pytest.raises(ContractError, match="secret"):
        pin_skill_bundle(skill, directory, allowed_capabilities={"read"})


def test_registry_skill_cannot_hide_unpinned_local_references():
    skill = Skill(name="registry-skill", description="Inspect", body="Read [local](references/info.md)", source="custom")
    with pytest.raises(ContractError, match="self-contained"):
        pin_skill_bundle(skill)
    no_reference = Skill(name="registry-skill", description="Inspect", body="Inspect the supplied context.", source="custom")
    assert pin_skill_bundle(no_reference).body == "Inspect the supplied context."


def test_guidance_is_pinned_with_precedence_and_does_not_grant_access(tmp_path):
    (tmp_path / "AGENTS.md").write_text("Use pytest.", encoding="utf-8")
    (tmp_path / "CLAUDE.md").write_text("Prefer readable changes.", encoding="utf-8")
    pinned = pin_project_guidance(tmp_path)
    assert "AGENTS.md takes precedence" in pinned.content
    assert "never grant additional tool" in pinned.content
    (tmp_path / "AGENTS.md").write_text("Use unittest.", encoding="utf-8")
    assert pin_project_guidance(tmp_path).content_hash != pinned.content_hash
    assert pinned.documents[0].content == "Use pytest."


def test_workflow_requires_reproduction_and_independent_review():
    fix = workflow_spec("fix")
    assert [step.key for step in fix.steps] == ["reproduce", "implement", "verify"]
    assert "reproduction" in fix.steps[0].required_outputs
    assert workflow_spec("review").steps[-1].independent_owner


def test_auto_needs_classification_and_strategies_are_bounded():
    assert workflow_spec("auto").requires_selection
    assert workflow_spec("build", strategy="swarm").max_workers == 3
    assert workflow_spec("build", strategy="arena").content_hash != workflow_spec("build").content_hash
    with pytest.raises(ContractError, match="Unknown workflow"):
        workflow_spec("unknown")
