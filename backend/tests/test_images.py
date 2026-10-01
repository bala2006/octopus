"""Images in messages: the user pastes or attaches a picture; the agents' model actually sees it, and it can be recalled."""
from __future__ import annotations

import asyncio
import base64

import pytest

from app.llm.azure_v1 import _body
from app.llm.base import LLMRequest
from app.llm.litellm_provider import _chat_message
from app.llm.router import set_provider_override
from app.services.images import ImageError, parse_images
from conftest import NativeScriptedProvider, agent, edge, make_company, start_run, wait_status

PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC"
PNG = f"data:image/png;base64,{PNG_B64}"


def test_images_are_validated() -> None:
    assert parse_images([{"name": "shot.png", "data_url": PNG}])[0] == {"name": "shot.png", "media_type": "image/png", "data_url": PNG}
    with pytest.raises(ImageError, match="only PNG, JPEG"):
        parse_images([{"name": "x.svg", "data_url": "data:image/svg+xml;base64,PHN2Zz4="}])
    with pytest.raises(ImageError, match="not a JPEG"):
        parse_images([{"name": "fake.jpg", "data_url": f"data:image/jpeg;base64,{PNG_B64}"}])
    with pytest.raises(ImageError, match="at most 4"):
        parse_images([{"data_url": PNG}] * 5)


def test_providers_send_images_as_image_parts() -> None:
    req = LLMRequest(provider="azure", model="gpt-6-luna", api_key="k", base_url="https://x.openai.azure.com",
                     messages=[{"role": "user", "content": "what is this?", "images": [PNG]}])
    assert _body(req, "responses", set())["input"][0]["content"] == [{"type": "input_text", "text": "what is this?"},
                                                                    {"type": "input_image", "image_url": PNG}]
    assert _body(req, "chat", set())["messages"][0]["content"][1] == {"type": "image_url", "image_url": {"url": PNG}}
    assert _chat_message(req.messages[0])["content"][1]["image_url"]["url"] == PNG
    assert "images" not in _chat_message(req.messages[0])


async def test_image_sent_to_a_run_reaches_the_agents_model_and_can_be_recalled(client, workspace) -> None:
    def ben(ctx, outputs):  # noqa: ANN001
        return [("recall", {"ref": "i1"})] if not outputs else [("wait", {})]

    provider = NativeScriptedProvider({"Ann": [[("wait", {})]], "Ben": [ben, ben]})
    set_provider_override(provider)
    cid = await make_company(client, workspace, [agent("a", "Ann", entry=True), agent("b", "Ben")], [edge("e", "a", "b")])
    run = await start_run(client, workspace, cid, mode="step")
    base = f"/api/v1/w/{workspace['id']}/runs/{run['id']}"
    await wait_status(client, workspace, run["id"], {"paused"})
    r = await client.post(f"{base}/interject", json={"content": "Make the header look like this", "to_agent_id": "b",
                                                     "images": [{"name": "header.png", "data_url": PNG}],
                                                     "attachments": [{"filename": "notes.md", "text": "Use the brand blue."}]})
    assert r.status_code == 202, r.text
    msg = next(m for m in (await client.get(f"{base}/messages")).json() if m["type"] == "user_interjection")
    assert msg["meta"]["images"] == [{"ref": "i1", "name": "header.png", "media_type": "image/png"}], "the message carries a reference"
    assert "--- Attached file: notes.md ---\nUse the brand blue." in msg["content"]
    img = await client.get(f"{base}/images/i1")
    assert img.status_code == 200 and img.headers["content-type"] == "image/png" and img.content == base64.b64decode(PNG_B64)
    assert (await client.get(f"{base}/images/o1")).status_code == 404

    def bens() -> list[LLMRequest]:
        return [r for r in provider.requests if r.metadata["mock_context"]["agent"]["name"] == "Ben"]

    for _ in range(60):  # step until Ben has taken his turn (Ann's goal turn may come first)
        if len(bens()) >= 2:
            break
        if not _ % 10:
            await client.post(f"{base}/control/step")
        await asyncio.sleep(0.05)
    first, second = bens()[:2]
    assert first.messages[-1]["images"] == [PNG], "Ben's model sees the picture with the new message"
    assert "[images: i1 header.png]" in first.messages[-1]["content"]
    recalled = [i for i in second.continuation if i.get("role") == "user"]
    assert recalled and recalled[0]["content"][1] == {"type": "input_image", "image_url": PNG}, "a recalled image is shown again"
    await client.post(f"{base}/control/stop")


async def test_bad_image_is_refused_with_a_reason(client, workspace) -> None:
    cid = await make_company(client, workspace, [agent("a", "Ann", entry=True)], [])
    set_provider_override(NativeScriptedProvider({"Ann": [[("wait", {})]]}))
    run = await start_run(client, workspace, cid, mode="step")
    base = f"/api/v1/w/{workspace['id']}/runs/{run['id']}"
    await wait_status(client, workspace, run["id"], {"paused"})
    r = await client.post(f"{base}/interject", json={"content": "x", "images": [{"name": "a.gif", "data_url": f"data:image/gif;base64,{PNG_B64}"}]})
    assert r.status_code == 422 and "not a GIF" in r.text
    assert (await client.post(f"{base}/interject", json={"content": " "})).status_code == 422
    await client.post(f"{base}/control/stop")
