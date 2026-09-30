"""Runtime team management (hire / view / edit agents), department templates, AI org generation, user templates."""
from __future__ import annotations

import asyncio

from app.llm.router import set_provider_override
from conftest import ScriptedProvider, agent, edge, env, events, make_company, msg, run_messages, start_run, wait_status


def boss(**tools: bool) -> dict:
    return agent("boss", "Bea", entry=True, role="Engineering Manager", is_manager=True, department="Engineering",
                 tools={"terminal": False, "file_write": True, "manage_team": True, **tools})


async def canvas(client, ws, cid):  # type: ignore[no-untyped-def]
    return (await client.get(f"/api/v1/w/{ws['id']}/companies/{cid}")).json()


# ------------------------------------------------------------------ templates
async def test_builtin_templates_are_departmental(client) -> None:
    tpls = {t["key"]: t for t in (await client.get("/api/v1/templates")).json()}
    fc = tpls["full_company"]
    assert len(fc["departments"]) == 6
    for d in fc["departments"]:
        assert d["manager"], d
        assert 2 <= 1 + len(d["members"]) <= 3, d
    assert tpls["self_organizing"]["agent_count"] == 1
    for t in tpls.values():
        assert all(d["manager"] for d in t["departments"])


async def test_full_company_org_chart(client, workspace) -> None:
    r = await client.post(f"/api/v1/w/{workspace['id']}/companies/from-template", json={"template_key": "full_company"})
    body = r.json()
    agents = {a["id"]: a for a in body["agents"]}
    assert len(agents) == 15 and set(body["departments"]) == {"Executive", "Product", "Engineering", "Quality", "Operations", "Growth"}
    ceo = next(a for a in agents.values() if a["is_entry"])
    for a in agents.values():
        if a["id"] == ceo["id"]:
            continue
        mgr = agents[a["reports_to"]]
        assert mgr["is_manager"]
        if not a["is_manager"]:
            assert mgr["department"] == a["department"]
        else:
            assert mgr["id"] == ceo["id"]
    pairs = {(agents[e["source_agent_id"]]["name"], agents[e["target_agent_id"]]["name"], e["type"]) for e in body["edges"]}
    assert ("Omar", "Leo", "delegate") in pairs and ("Leo", "Omar", "report") in pairs and ("Ava", "Omar", "delegate") in pairs


# ------------------------------------------------------------------ hiring
async def test_agent_hires_teammate_without_privilege_escalation(client, workspace) -> None:
    cid = await make_company(client, workspace, [boss(), agent("x", "Xan", role="Designer")], [edge("e", "boss", "x", "consult", True)])
    set_provider_override(ScriptedProvider({
        "Bea": [env({"action": "create_agent", "name": "Leo", "role": "Backend Engineer", "tools": ["file_write", "terminal"],
                     "connect": [{"to": "Xan", "type": "consult"}, {"to": "Nobody", "type": "review"}],
                     "brief": "Build the API and report back."}),
                env({"action": "finish", "summary": "team built"})],
        "Leo": [env({"action": "write_file", "path": "api.py", "content": "print('api')\n"}, msg("Bea", "status_update", "API done: api.py"))],
    }))
    run = await start_run(client, workspace, cid, permission_level="danger")
    done = await wait_status(client, workspace, run["id"])
    assert done["status"] == "completed"
    created = [e["payload"] for e in await events(client, workspace, run["id"], "agent_created")]
    assert len(created) == 1
    leo = created[0]["agent"]
    assert leo["name"] == "Leo" and leo["created_by"] == "boss" and leo["reports_to"] == "boss" and leo["department"] == "Engineering"
    assert leo["tools"]["file_write"] is True and leo["tools"]["terminal"] is False, "cannot grant tools the hirer doesn't have"
    types = {(e["source_agent_id"] == "boss", e["type"]) for e in created[0]["edges"]}
    assert (True, "delegate") in types and (False, "report") in types
    assert any(e["type"] == "consult" and e["target_agent_id"] == "x" for e in created[0]["edges"])
    msgs = await run_messages(client, workspace, run["id"])
    assert any(m["to_agent_id"] == leo["id"] and m["type"] == "task" and "Build the API" in m["content"] for m in msgs)
    assert any(m["from_agent_id"] == leo["id"] and m["type"] == "status_update" for m in msgs), "the hire took turns"
    c = await canvas(client, workspace, cid)
    assert any(a["name"] == "Leo" and a["created_by"] == "boss" for a in c["agents"]), "hire persisted to the company"
    assert c["revision"] >= 2


async def test_hiring_requires_manage_team_and_respects_cap(client, workspace) -> None:
    cid = await make_company(client, workspace, [agent("a", "Ann", entry=True, tools={"manage_team": False})], [])
    set_provider_override(ScriptedProvider({"Ann": [env({"action": "create_agent", "name": "Z", "role": "Dev"}), env({"action": "finish", "summary": "x"})]}))
    run = await start_run(client, workspace, cid, permission_level="danger")
    await wait_status(client, workspace, run["id"])
    assert not await events(client, workspace, run["id"], "agent_created")

    cid2 = await make_company(client, workspace, [boss()], [])
    set_provider_override(ScriptedProvider({"Bea": [env(*[{"action": "create_agent", "name": f"Dev{i}", "role": "Dev"} for i in range(4)]),
                                                    env({"action": "finish", "summary": "x"})]}))
    run = await start_run(client, workspace, cid2, permission_level="danger", budget={"max_agents": 3})
    await wait_status(client, workspace, run["id"])
    assert len(await events(client, workspace, run["id"], "agent_created")) == 2
    assert any("cap" in e["payload"]["output"] for e in await events(client, workspace, run["id"], "tool_result") if e["payload"]["tool"] == "create_agent")


async def test_permission_levels_for_hiring(client, workspace) -> None:
    script = lambda: ScriptedProvider({"Bea": [env({"action": "create_agent", "name": "Leo", "role": "Dev"}), env({"action": "finish", "summary": "x"})]})  # noqa: E731
    cid = await make_company(client, workspace, [boss()], [])
    set_provider_override(script())
    run = await start_run(client, workspace, cid, permission_level="read_only")
    await wait_status(client, workspace, run["id"])
    assert not await events(client, workspace, run["id"], "agent_created")

    set_provider_override(script())
    run = await start_run(client, workspace, cid, permission_level="plan")
    await wait_status(client, workspace, run["id"])
    ev = await events(client, workspace, run["id"], "agent_created")
    assert ev and ev[0]["payload"]["persisted"] is False
    assert not any(a["name"] == "Leo" for a in (await canvas(client, workspace, cid))["agents"]), "plan-mode hires are run-only"

    set_provider_override(script())
    run = await start_run(client, workspace, cid, permission_level="ask")
    base = f"/api/v1/w/{workspace['id']}/runs/{run['id']}"
    await wait_status(client, workspace, run["id"], {"awaiting_user"})
    for _ in range(100):
        p = (await client.get(base)).json()["state"].get("pending_approval")
        if p:
            break
        await asyncio.sleep(0.02)
    assert p["kind"] == "create_agent" and p["details"]["name"] == "Leo"
    await client.post(f"{base}/approve", json={"approval_id": p["id"], "approved": True})
    await wait_status(client, workspace, run["id"])
    assert any(a["name"] == "Leo" for a in (await canvas(client, workspace, cid))["agents"])


# ------------------------------------------------------------------ editing & viewing
async def test_agent_edits_own_config_but_cannot_self_escalate(client, workspace) -> None:
    cid = await make_company(client, workspace, [agent("a", "Ann", entry=True, tools={"terminal": False})], [])
    set_provider_override(ScriptedProvider({"Ann": [
        env({"action": "update_agent", "target": "self", "reason": "sharpen focus",
             "changes": {"role": "Staff Engineer", "append_to_prompt": "Always write tests first.", "tools": {"terminal": True, "calculator": False},
                         "behavior": {"max_autonomous_turns": 99, "strictness": 0.9}}}),
        env({"action": "finish", "summary": "ok"})]}))
    run = await start_run(client, workspace, cid, permission_level="danger")
    await wait_status(client, workspace, run["id"])
    upd = [e["payload"] for e in await events(client, workspace, run["id"], "agent_updated")]
    assert upd and upd[0]["self"] is True
    ann = next(a for a in (await canvas(client, workspace, cid))["agents"] if a["id"] == "a")
    assert ann["role"] == "Staff Engineer" and ann["system_prompt"].endswith("Always write tests first.")
    assert ann["tools"]["terminal"] is False and ann["tools"]["calculator"] is False, "can drop tools, never add"
    assert ann["behavior"]["max_autonomous_turns"] <= 30 and ann["behavior"]["strictness"] == 0.9
    result = next(e["payload"]["output"] for e in await events(client, workspace, run["id"], "tool_result") if e["payload"]["tool"] == "update_agent")
    assert "terminal" in result and "cannot grant yourself" in result


async def test_manager_reconfigures_and_deactivates_report(client, workspace) -> None:
    agents = [boss(), agent("r", "Rae", role="Dev", department="Engineering", reports_to="boss", tools={"terminal": False}),
              agent("p", "Pip", role="Dev", department="Engineering", reports_to="boss")]
    edges = [edge("d1", "boss", "r"), edge("d2", "boss", "p"), edge("c", "r", "p", "consult", True)]
    cid = await make_company(client, workspace, agents, edges)
    set_provider_override(ScriptedProvider({
        "Bea": [env({"action": "update_agent", "target": "Rae", "changes": {"role": "Senior Dev", "tools": {"terminal": True}}, "reason": "promotion"},
                    {"action": "update_agent", "target": "Pip", "changes": {"active": False}, "reason": "not needed"},
                    msg("Pip", "task", "should be rejected: inactive"), msg("Rae", "task", "please ask Pip something")),
                env({"action": "list_agents"}), env({"action": "finish", "summary": "done"})],
        "Rae": [env({"action": "update_agent", "target": "Pip", "changes": {"role": "Hacker"}}, msg("Pip", "question", "hello?")),
                env(msg("Bea", "status_update", "done"))],
    }))
    run = await start_run(client, workspace, cid, permission_level="danger")
    await wait_status(client, workspace, run["id"])
    c = {a["name"]: a for a in (await canvas(client, workspace, cid))["agents"]}
    assert c["Rae"]["role"] == "Senior Dev"
    assert c["Rae"]["tools"]["terminal"] is False, "the manager doesn't have terminal, so can't grant it"
    assert c["Pip"]["active"] is False and c["Pip"]["role"] == "Dev", "a peer cannot edit a peer"
    rejected = [e["payload"]["reason"] for e in await events(client, workspace, run["id"], "message_rejected")]
    assert sum("inactive" in r for r in rejected) >= 2
    msgs = await run_messages(client, workspace, run["id"])
    assert not any(m["from_agent_id"] == "p" for m in msgs), "inactive agents never take turns"
    listing = next(e["payload"]["output"] for e in await events(client, workspace, run["id"], "tool_result") if e["payload"]["tool"] == "list_agents")
    assert "Pip" in listing and "status: inactive" in listing and "1 inactive" in listing


# ------------------------------------------------------------------ demo runs
async def test_self_organizing_company_builds_itself(client, workspace) -> None:
    set_provider_override(None)
    c = (await client.post(f"/api/v1/w/{workspace['id']}/companies/from-template", json={"template_key": "self_organizing"})).json()
    run = await start_run(client, workspace, c["company"]["id"], goal="Build a URL shortener", permission_level="danger", budget={"force_mock": True})
    done = await wait_status(client, workspace, run["id"], timeout=90)
    assert done["status"] == "completed", done["halt_reason"]
    created = [e["payload"]["agent"] for e in await events(client, workspace, run["id"], "agent_created")]
    names = {a["name"] for a in created}
    assert {"Omar", "Tess"} <= names and len(created) >= 5
    assert any(a["created_by"] != c["agents"][0]["id"] for a in created), "managers hired their own specialists"
    upd = await events(client, workspace, run["id"], "agent_updated")
    assert any(e["payload"]["self"] for e in upd) and any(not e["payload"]["self"] for e in upd)
    final = await canvas(client, workspace, c["company"]["id"])
    assert len(final["agents"]) == 1 + len(created)
    assert {"Engineering", "Quality"} <= set(final["departments"])
    report = (await client.get(f"/api/v1/w/{workspace['id']}/runs/{run['id']}/report")).text
    assert "hired" in report


async def test_full_company_demo_completes(client, workspace) -> None:
    set_provider_override(None)
    c = (await client.post(f"/api/v1/w/{workspace['id']}/companies/from-template", json={"template_key": "full_company"})).json()
    run = await start_run(client, workspace, c["company"]["id"], goal="Launch a habit tracker", permission_level="danger",
                          budget={"force_mock": True, "max_turns": 120})
    done = await wait_status(client, workspace, run["id"], timeout=90)
    assert done["status"] == "completed", done["halt_reason"]
    senders = {m["from_agent_id"] for m in await run_messages(client, workspace, run["id"]) if m["type"] == "status_update"}
    assert len(senders) >= 10, "every department reported through its manager"


# ------------------------------------------------------------------ generation & user templates
async def test_generate_company_from_prompt(client, workspace) -> None:
    base = f"/api/v1/w/{workspace['id']}/companies"
    r = await client.post(f"{base}/generate", json={"prompt": "Build and launch a GDPR-compliant SaaS invoicing app with a marketing campaign", "max_agents": 14})
    assert r.status_code == 200, r.text
    g = r.json()
    assert g["source"] == "demo"
    depts = {d["name"]: d for d in g["departments"] if d["name"] != "Executive"}
    assert {"Engineering", "Growth", "Security"} <= set(depts)
    for d in depts.values():
        assert d["manager"] and 1 <= len(d["members"]) <= 2
    assert len(g["spec"]["agents"]) <= 14
    created = await client.post(f"{base}/import", json=g["spec"])
    assert created.status_code == 201 and len(created.json()["agents"]) == len(g["spec"]["agents"])
    assert all(a["reports_to"] for a in created.json()["agents"] if not a["is_entry"]), "org references survive the id remap"


async def test_user_templates_roundtrip(client, workspace) -> None:
    base = f"/api/v1/w/{workspace['id']}/companies"
    c = (await client.post(f"{base}/from-template", json={"template_key": "research_lab"})).json()
    t = await client.post(f"{base}/{c['company']['id']}/save-template", json={"name": "My Lab", "description": "mine"})
    assert t.status_code == 201
    tpl = t.json()
    assert tpl["source"] == "user" and tpl["key"].startswith("user:") and len(tpl["departments"]) == 2
    listed = [x["key"] for x in (await client.get("/api/v1/templates")).json()]
    assert tpl["key"] in listed
    inst = (await client.post(f"{base}/from-template", json={"template_key": tpl["key"], "name": "Lab 2"})).json()
    assert inst["company"]["name"] == "Lab 2" and len(inst["agents"]) == 5
    assert {a["id"] for a in inst["agents"]}.isdisjoint({a["id"] for a in c["agents"]})
    assert (await client.delete(f"/api/v1/templates/{tpl['key']}")).status_code == 204
    assert (await client.delete("/api/v1/templates/software_startup")).status_code == 404


async def test_canvas_revision_conflict(client, workspace) -> None:
    base = f"/api/v1/w/{workspace['id']}/companies"
    c = (await client.post(f"{base}/from-template", json={"template_key": "small_dev_team"})).json()
    body = {"agents": c["agents"], "edges": c["edges"], "revision": c["revision"]}
    ok = await client.put(f"{base}/{c['company']['id']}/canvas", json=body)
    assert ok.status_code == 200 and ok.json()["revision"] == c["revision"] + 1
    stale = await client.put(f"{base}/{c['company']['id']}/canvas", json=body)
    assert stale.status_code == 409 and stale.json()["detail"]["revision"] == c["revision"] + 1
