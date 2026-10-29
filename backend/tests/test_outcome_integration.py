"""Integration guards for auto staffing and independently verified acceptance."""
from app.llm.router import set_provider_override
from conftest import NativeScriptedProvider, agent, events, make_company, start_run, wait_status


async def test_adaptive_company_creation_is_goal_driven(client, workspace):
    url = f"/api/v1/w/{workspace['id']}/companies/from-template"
    solo = await client.post(url, json={"template_key": "adaptive", "goal": "Fix README typo"})
    assert solo.status_code == 201, solo.text
    assert len(solo.json()["agents"]) == 1
    feature = await client.post(url, json={"template_key": "adaptive", "goal": "Implement onboarding feature and API"})
    assert feature.status_code == 201, feature.text
    team = feature.json()["agents"]
    assert len(team) == 3
    assert any("QA" in a["role"] or "Quality" in a["role"] for a in team)


async def test_qa_cannot_pass_by_only_writing_a_plausible_report(client, workspace):
    team = [
        agent("h", "Ava", entry=True, role="CEO", behavior={"template_key": "ceo"}),
        agent("b", "Sam", role="Software Engineer", behavior={"template_key": "fullstack_dev"}),
        agent("q", "Quinn", role="QA Engineer", behavior={"template_key": "qa"}),
    ]
    report = ("# Test report\n\nAC1. Run the script and inspect its output.\n"
              "Expected result: print ok. Report says PASS.\n"
              "Commands mentioned but not executed by QA: python app.py\n")
    provider = NativeScriptedProvider({
        "Ava": [[("set_track", {"track": "quick"})], [("finish", {"summary": "QA claimed success"})]],
        "Sam": [[("write_file", {"path": "app.py", "content": "print('ok')\n"})],
                [("run_code", {"command": "python app.py"})],
                [("finish", {"summary": "Script ran successfully"})]],
        "Quinn": [[("write_file", {"path": ".octopus/work/test-report.md", "content": report})],
                  [("finish", {"summary": "All requirements passed", "outcome": "pass"})],
                  [("finish", {"summary": "Still no execution", "outcome": "pass"})],
                  [("finish", {"summary": "Still no execution", "outcome": "pass"})]],
    })
    set_provider_override(provider)
    company = await make_company(client, workspace, team, [])
    run = await start_run(client, workspace, company, goal="Write an app.py that prints ok",
                          permission_level="danger", budget={"workflow": "on", "verify_before_finish": True})
    done = await wait_status(client, workspace, run["id"])
    assert done["status"] == "incomplete", done["halt_reason"]
    workflow = (await events(client, workspace, run["id"], "workflow_updated"))[-1]["payload"]["workflow"]
    assert next(p for p in workflow["phases"] if p["key"] == "test")["status"] == "failed"
