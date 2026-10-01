"""Settings → Roles: edit built-in roles, restore defaults, create roles of your own; linked agents follow the library."""
from __future__ import annotations

from app.llm.base import LLMRequest
from app.llm.router import set_provider_override
from app.prompts.roles import all_roles
from app.services.roles import category_of, linked, resolve_prompt
from conftest import NativeScriptedProvider, agent, make_company, start_run, wait_status


async def test_role_library_lists_builtins_with_categories(client) -> None:  # type: ignore[no-untyped-def]
    roles = (await client.get("/api/v1/roles")).json()
    by = {r["key"]: r for r in roles}
    assert len(roles) >= len(all_roles()) and by["qa"]["category"] == "Quality" and by["ceo"]["category"] == "Leadership"
    assert (await client.get("/api/v1/templates/roles")).json() == roles  # the canvas pickers see the same library


async def test_edit_restore_and_custom_roles(client) -> None:  # type: ignore[no-untyped-def]
    body = {"role": "QA Engineer", "system_prompt": "You are {{agent_name}}. Test EVERYTHING twice.", "category": "Quality"}
    r = await client.put("/api/v1/roles/qa", json=body)
    assert r.status_code == 200 and r.json()["source"] == "modified" and "twice" in r.json()["system_prompt"]
    r = await client.post("/api/v1/roles", json={"role": "Accessibility Auditor", "system_prompt": "Check WCAG 2.2 AA.", "category": "Quality"})
    assert r.status_code == 201 and r.json()["key"] == "custom:accessibility_auditor" and r.json()["source"] == "custom"
    r2 = await client.post("/api/v1/roles", json={"role": "Accessibility Auditor", "system_prompt": "x"})
    assert r2.json()["key"] == "custom:accessibility_auditor_2"
    assert (await client.delete("/api/v1/roles/qa")).status_code == 204  # restore the default
    qa = next(x for x in (await client.get("/api/v1/roles")).json() if x["key"] == "qa")
    assert qa["source"] == "builtin" and qa["system_prompt"] == all_roles()["qa"].system_prompt
    await client.put("/api/v1/roles/pm", json={"role": "PM", "system_prompt": "edited"})
    assert (await client.post("/api/v1/roles/restore-defaults")).status_code == 204
    keys = {x["key"]: x["source"] for x in (await client.get("/api/v1/roles")).json()}
    assert keys["pm"] == "builtin" and keys["custom:accessibility_auditor"] == "custom", "restore-all keeps your own roles"
    for k in ("custom:accessibility_auditor", "custom:accessibility_auditor_2"):
        assert (await client.delete(f"/api/v1/roles/{k}")).status_code == 204
    assert (await client.delete("/api/v1/roles/custom:nope")).status_code == 404


def test_linking_rules() -> None:
    qa = all_roles()["qa"]
    roles = {**all_roles()}
    assert linked({"template_key": "qa", "prompt_linked": True}, "anything") == "qa"
    assert linked({"template_key": "qa", "prompt_linked": False}, qa.system_prompt) is None
    assert linked({"template_key": "qa"}, qa.system_prompt) == "qa", "agents from before linking: untouched prompt = linked"
    assert linked({"template_key": "qa"}, "my own prompt") is None
    assert resolve_prompt({"template_key": "qa", "prompt_linked": True, "extra_instructions": "Use pytest."}, "", roles).endswith("Use pytest.")
    assert category_of("gameplay_programmer") == "Engineering" and category_of("playtester") == "Quality"


async def test_a_linked_agent_runs_with_the_edited_role_prompt(client, workspace) -> None:  # type: ignore[no-untyped-def]
    await client.put("/api/v1/roles/qa", json={"role": "QA Engineer", "system_prompt": "EDITED-QA-PROMPT for {{agent_name}}"})
    try:
        provider = NativeScriptedProvider({"Quinn": [[("finish", {"summary": "ok"})]]})
        set_provider_override(provider)
        a = agent("q", "Quinn", entry=True, behavior={"template_key": "qa", "prompt_linked": True, "extra_instructions": "Be brief."})
        cid = await make_company(client, workspace, [a], [])
        run = await start_run(client, workspace, cid)
        await wait_status(client, workspace, run["id"])
        req: LLMRequest = provider.requests[0]
        system = req.messages[0]["content"]
        assert "EDITED-QA-PROMPT for Quinn" in system and "Be brief." in system
    finally:
        await client.delete("/api/v1/roles/qa")
