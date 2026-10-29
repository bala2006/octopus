from app.llm import router
from app.llm.router import set_provider_override
from conftest import ScriptedProvider, agent, make_company, start_run, wait_status


async def test_conversation_selection_reaches_model_requests_and_survives_followup(client, workspace, monkeypatch):
    async def credentials(db, user_id, provider):
        return "test-key", "https://example.invalid", {"deployments": ["chosen-deployment"]}

    monkeypatch.setattr(router, "resolve_credentials", credentials)
    provider = ScriptedProvider(default={"actions": [{"action": "finish", "summary": "Hello"}]})
    seen = []
    stream = provider.stream

    async def record(request):
        seen.append((request.provider, request.model, request.extra.get("reasoning_effort")))
        async for chunk in stream(request):
            yield chunk

    provider.stream = record
    set_provider_override(provider)
    company = await make_company(client, workspace, [agent("a", "Ann", entry=True)], [])
    run = await start_run(client, workspace, company, budget={
        "model": {"provider": "azure", "model": "chosen-deployment"}, "reasoning_effort": "high"})
    await wait_status(client, workspace, run["id"])
    assert seen and all(item == ("azure", "chosen-deployment", "high") for item in seen)
    first_count = len(seen)
    response = await client.post(f"/api/v1/w/{workspace['id']}/runs/{run['id']}/continue", json={"content": "Continue please"})
    assert response.status_code == 202
    saved = await wait_status(client, workspace, run["id"])
    assert len(seen) > first_count
    assert seen[-1] == ("azure", "chosen-deployment", "high")
    assert saved["budget"]["model"] == {"provider": "azure", "model": "chosen-deployment"}


async def test_explicit_unconfigured_model_fails_without_starting_a_demo(client, workspace):
    company = await make_company(client, workspace, [agent("a", "Ann", entry=True)], [])
    response = await client.post(f"/api/v1/w/{workspace['id']}/runs", json={
        "company_id": company, "goal": "Keep my message", "budget": {"model": {"provider": "azure", "model": "not-connected"}}})
    assert response.status_code == 422
    assert "Connect Azure" in response.text
    assert (await client.get(f"/api/v1/w/{workspace['id']}/runs")).json() == []


async def test_explicit_demo_overrides_agent_model(client, workspace):
    provider = ScriptedProvider(default={"actions": [{"action": "finish", "summary": "Done"}]})
    seen = []
    stream = provider.stream

    async def record(request):
        seen.append((request.provider, request.model))
        async for chunk in stream(request):
            yield chunk

    provider.stream = record
    set_provider_override(provider)
    company = await make_company(client, workspace, [agent("a", "Ann", entry=True, provider="azure", model="other")], [])
    run = await start_run(client, workspace, company, budget={"model": {"provider": "mock", "model": "mock/demo"}})
    await wait_status(client, workspace, run["id"])
    assert seen and all(item == ("mock", "mock/demo") for item in seen)
