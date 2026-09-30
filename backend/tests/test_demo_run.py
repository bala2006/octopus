"""End-to-end Demo Mode: the Software Startup template builds a real todo app offline."""
from __future__ import annotations

from pathlib import Path

from app.llm.router import set_provider_override
from conftest import events, run_messages, wait_status


async def _from_template(client, workspace, key: str) -> dict:  # type: ignore[no-untyped-def]
    r = await client.post(f"/api/v1/w/{workspace['id']}/companies/from-template", json={"template_key": key})
    assert r.status_code == 201, r.text
    return r.json()


async def test_software_startup_demo(client, workspace) -> None:
    set_provider_override(None)
    canvas = await _from_template(client, workspace, "software_startup")
    assert len(canvas["agents"]) == 8 and len(canvas["edges"]) == 14
    r = await client.post(f"/api/v1/w/{workspace['id']}/runs", json={
        "company_id": canvas["company"]["id"], "goal": "Build a todo app with auth", "permission_level": "danger",
        "budget": {"force_mock": True, "max_turns": 80}})
    run = r.json()
    done = await wait_status(client, workspace, run["id"], timeout=120)
    assert done["status"] == "completed", done["halt_reason"]

    root = Path(workspace["path"])
    for f in ("docs/PRD.md", "docs/ARCHITECTURE.md", "backend/todo_api.py", "frontend/index.html", "tests/test_todo_api.py",
              "tests/test_frontend_static.py", "design/style-guide.md", "Dockerfile", "README.md"):
        assert (root / f).is_file(), f"missing {f}"
    assert "pbkdf2_hmac" in (root / "backend/todo_api.py").read_text(), "review feedback was applied"

    ws = f"/api/v1/w/{workspace['id']}/runs/{run['id']}"
    proto = [e["payload"] for e in await events(client, workspace, run["id"], "protocol")]
    assert any(p["kind"] == "debate" and p["result"] == "consensus" for p in proto)
    reviews = [p["result"] for p in proto if p["kind"] == "review"]
    assert "changes_requested" in reviews and reviews.count("approved") >= 2

    tests = [e["payload"] for e in await events(client, workspace, run["id"], "tool_result") if e["payload"]["tool"] == "run_code"]
    assert tests and tests[-1]["ok"], tests[-1]["output"] if tests else "QA never ran tests"
    assert "OK" in tests[-1]["output"]

    tasks = (await client.get(f"{ws}/tasks")).json()
    assert tasks and all(t["status"] == "done" for t in tasks)
    versions = (await client.get(f"{ws}/artifacts?all_versions=true")).json()
    assert [v["version"] for v in versions if v["path"] == "backend/todo_api.py"] == [1, 2]
    report = (await client.get(f"{ws}/report")).text
    for section in ("## Key decisions", "## Debates", "## Reviews", "## Task board", "## Artifacts", "✅ passed"):
        assert section in report
    z = await client.get(f"{ws}/artifacts.zip")
    assert z.status_code == 200 and z.content[:2] == b"PK"
    msgs = await run_messages(client, workspace, run["id"])
    assert msgs[-1]["type"] == "final_report"
    statuses = {e["payload"]["status"] for e in await events(client, workspace, run["id"], "agent_status")}
    assert {"thinking", "speaking", "writing", "running"} <= statuses


async def test_debate_panel_demo(client, workspace) -> None:
    set_provider_override(None)
    canvas = await _from_template(client, workspace, "debate_panel")
    r = await client.post(f"/api/v1/w/{workspace['id']}/runs", json={
        "company_id": canvas["company"]["id"], "goal": "Should we adopt AI pair programming?", "budget": {"force_mock": True}})
    run = r.json()
    done = await wait_status(client, workspace, run["id"])
    assert done["status"] == "completed"
    proto = [e["payload"] for e in await events(client, workspace, run["id"], "protocol") if e["payload"]["kind"] == "debate"]
    assert proto[-1]["result"] == "decided"
    assert proto[-1]["state"]["rounds"] >= 2


async def test_small_team_demo_review_by_qa(client, workspace) -> None:
    set_provider_override(None)
    canvas = await _from_template(client, workspace, "small_dev_team")
    r = await client.post(f"/api/v1/w/{workspace['id']}/runs", json={
        "company_id": canvas["company"]["id"], "goal": "Build a todo service", "permission_level": "danger", "budget": {"force_mock": True}})
    run = r.json()
    done = await wait_status(client, workspace, run["id"], timeout=90)
    assert done["status"] == "completed", done["halt_reason"]
    proto = [e["payload"]["result"] for e in await events(client, workspace, run["id"], "protocol") if e["payload"]["kind"] == "review"]
    assert "changes_requested" in proto and proto[-1] == "approved"


async def test_export_import_roundtrip(client, workspace) -> None:
    canvas = await _from_template(client, workspace, "software_startup")
    base = f"/api/v1/w/{workspace['id']}/companies"
    exp = (await client.get(f"{base}/{canvas['company']['id']}/export")).json()
    imp = await client.post(f"{base}/import", json=exp)
    assert imp.status_code == 201
    body = imp.json()
    assert len(body["agents"]) == 8 and len(body["edges"]) == 14
    assert {a["id"] for a in body["agents"]}.isdisjoint({a["id"] for a in canvas["agents"]})
