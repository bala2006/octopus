"""Skills: built-in playbooks, edits and your own (Settings → Skills), project skills, and use_skill in a run."""
from __future__ import annotations

from pathlib import Path

from app.llm.router import set_provider_override
from app.prompts.roles import all_roles
from app.services import skills as S
from conftest import NativeScriptedProvider, agent, make_company, start_run, wait_status


def test_builtin_library_parses_and_targets_real_roles() -> None:
    lib = S.builtin_skills()
    assert {"intake-and-plan", "write-spec", "implement-feature", "browser-qa", "code-review", "web-game"} <= set(lib)
    roles = set(all_roles())
    for s in lib.values():
        assert s.description and len(s.body) > 200, s.name
        assert set(s.roles) <= roles, f"{s.name} names unknown roles: {set(s.roles) - roles}"


def test_front_matter_parsing_and_round_trip() -> None:
    s = S.parse("---\nname: My-Skill\ndescription: Do it well\nroles: qa, ceo\n---\n# Steps\n1. a\n")
    assert s and s.name == "my-skill" and s.roles == ("qa", "ceo") and s.body.startswith("# Steps")
    assert S.parse(S.render(s)) == s
    assert S.parse("no front matter", fallback_name="x") is None  # "x" is too short to be a name
    assert S.parse("# just steps", fallback_name="from-folder").name == "from-folder"


def test_prompt_lists_role_skills_first_and_names_the_rest() -> None:
    text = S.prompt_section(S.builtin_skills(), "qa", ["web-game"])
    yours, _, rest = text.partition("Also available:")
    assert "- web-game:" in yours and "- write-tests-from-spec:" in yours and "- browser-qa:" in yours
    assert "intake-and-plan" in rest and "Steps" not in text, "only names and descriptions until use_skill loads one"


def test_project_skills_from_claude_and_agents_folders(tmp_path: Path) -> None:
    d = tmp_path / ".claude" / "skills" / "deploy-fly"
    d.mkdir(parents=True)
    (d / "SKILL.md").write_text("---\nname: deploy-fly\ndescription: Deploy to Fly.io\n---\nRun fly deploy.")
    assert S.project_skills(tmp_path)["deploy-fly"].source == "project"


async def test_settings_api_edit_restore_create(client) -> None:  # type: ignore[no-untyped-def]
    lib = {s["name"]: s for s in (await client.get("/api/v1/skills")).json()}
    base = lib["code-review"]
    r = await client.put("/api/v1/skills/code-review", json={**base, "body": "Only check naming."})
    assert r.status_code == 200 and r.json()["source"] == "modified"
    r = await client.post("/api/v1/skills", json={"name": "a11y-audit", "description": "WCAG audit", "body": "1. Contrast", "roles": ["qa"]})
    assert r.status_code == 201 and r.json()["source"] == "custom"
    assert (await client.post("/api/v1/skills", json={"name": "code-review", "description": "x", "body": "y"})).status_code == 409
    assert (await client.post("/api/v1/skills/restore-defaults")).status_code == 204
    lib = {s["name"]: s for s in (await client.get("/api/v1/skills")).json()}
    assert lib["code-review"]["source"] == "builtin" and lib["code-review"]["body"] == base["body"] and lib["a11y-audit"]["source"] == "custom"
    assert (await client.delete("/api/v1/skills/a11y-audit")).status_code == 204
    assert "a11y-audit" not in {s["name"] for s in (await client.get("/api/v1/skills")).json()}


async def test_agent_loads_a_skill_in_a_run(client, workspace) -> None:  # type: ignore[no-untyped-def]
    provider = NativeScriptedProvider({"Quinn": [[("use_skill", {"name": "browser-qa"})], [("finish", {"summary": "ok"})]]})
    set_provider_override(provider)
    a = agent("q", "Quinn", entry=True, behavior={"template_key": "qa", "prompt_linked": True})
    cid = await make_company(client, workspace, [a], [])
    run = await start_run(client, workspace, cid)
    await wait_status(client, workspace, run["id"])
    system = provider.requests[0].messages[0]["content"]
    assert "## Skills" in system and "- browser-qa:" in system
    assert "use_skill" in {t["name"] for t in provider.requests[0].tools}
    loaded = [i["output"] for i in provider.requests[1].continuation if i.get("type") == "function_call_output"][-1]
    assert loaded.startswith("[use_skill OK] # Skill: browser-qa") and "browser_console_messages" in loaded
