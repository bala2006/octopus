"""Images attached to a run's goal (pasted screenshots, png/jpg files) reach every agent's model call as images."""
from __future__ import annotations

import base64
import struct
import zlib
from typing import Any

from app.llm.base import LLMRequest, with_images
from app.llm.router import set_provider_override
from conftest import ScriptedProvider, agent, make_company, run_messages, start_run, wait_status


def tiny_png() -> bytes:
    def chunk(t: bytes, d: bytes) -> bytes:
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    raw = b"\x00\xff\x00\x00"  # one red pixel
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


async def test_upload_returns_an_image_attachment_for_png_and_pasted_files(client) -> None:  # type: ignore[no-untyped-def]
    png = tiny_png()
    for name in ("shot.png", "image"):  # a clipboard paste may come without an extension
        r = await client.post("/api/v1/files/parse", files={"file": (name, png, "image/png")})
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["kind"] == "image" and body["mime"] == "image/png" and base64.b64decode(body["data"]) == png
    r = await client.post("/api/v1/files/parse", files={"file": ("fake.png", b"not an image", "image/png")})
    assert r.status_code == 415
    r = await client.post("/api/v1/files/parse", files={"file": ("notes.md", b"# hi", "text/markdown")})
    assert r.json()["kind"] == "text" and r.json()["text"] == "# hi"


async def test_goal_images_are_stored_announced_and_sent_to_the_model(client, workspace) -> None:  # type: ignore[no-untyped-def]
    seen: list[LLMRequest] = []
    prov = ScriptedProvider({"Ann": [{"thought": "", "actions": [{"action": "finish", "summary": "done"}]}]})
    orig = prov.stream

    async def spy(req: LLMRequest):  # type: ignore[no-untyped-def]
        seen.append(req)
        async for ch in orig(req):
            yield ch

    prov.stream = spy  # type: ignore[method-assign]
    set_provider_override(prov)
    cid = await make_company(client, workspace, [agent("a", "Ann", entry=True)], [])
    png = tiny_png()
    run = await start_run(client, workspace, cid, goal="Build a page that looks like this", attachments=[
        {"filename": "mockup.png", "kind": "image", "mime": "image/png", "data": base64.b64encode(png).decode()},
        {"filename": "notes.txt", "text": "use blue"}])
    await wait_status(client, workspace, run["id"])
    goal_msg = next(m for m in await run_messages(client, workspace, run["id"]) if (m.get("meta") or {}).get("goal"))
    assert "use blue" in goal_msg["content"] and "mockup.png" in goal_msg["content"]
    img = goal_msg["meta"]["images"][0]
    r = await client.get(f"/api/v1/w/{workspace['id']}/runs/{run['id']}/attachments/{img['name']}")
    assert r.status_code == 200 and r.content == png and r.headers["content-type"] == "image/png"
    req = next(q for q in seen if q.metadata.get("mock_context"))
    assert req.images == [{"mime": "image/png", "data": base64.b64encode(png).decode()}]


async def test_invalid_image_attachment_is_rejected(client, workspace) -> None:  # type: ignore[no-untyped-def]
    cid = await make_company(client, workspace, [agent("a", "Ann", entry=True)], [])
    r = await client.post(f"/api/v1/w/{workspace['id']}/runs", json={"company_id": cid, "goal": "x", "attachments": [
        {"filename": "x.png", "kind": "image", "data": base64.b64encode(b"nope").decode()}]})
    assert r.status_code == 422 and "not a PNG" in r.text


def test_images_become_provider_content_parts() -> None:
    msgs: list[dict[str, Any]] = [{"role": "system", "content": "sys"}, {"role": "user", "content": "look"}]
    imgs = [{"mime": "image/png", "data": "AAAA"}]
    r = with_images(msgs, imgs, "responses")
    assert r[0] == msgs[0] and r[1]["content"] == [{"type": "input_text", "text": "look"},
                                                    {"type": "input_image", "image_url": "data:image/png;base64,AAAA"}]
    c = with_images(msgs, imgs, "chat")
    assert c[1]["content"][1] == {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}}
    assert msgs[1]["content"] == "look"  # the request's own messages stay strings
    assert with_images(msgs, [], "chat") is msgs
