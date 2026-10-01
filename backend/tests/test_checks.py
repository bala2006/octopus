"""Instant feedback in the edit loop: syntax checks after every write, and whitespace-tolerant edits."""
from __future__ import annotations

import shutil
from pathlib import Path

import pytest

from app.llm.router import set_provider_override
from app.orchestrator import actions as A
from app.orchestrator.engine import apply_edits
from app.services.checks import check_file
from conftest import NativeScriptedProvider, agent, make_company, start_run, wait_status

needs_node = pytest.mark.skipif(not shutil.which("node"), reason="node not installed")


async def test_python_and_json_errors_are_reported_with_the_line() -> None:
    assert await check_file("a.py", "x = 1\n") is None
    msg = await check_file("a.py", "def f(:\n    pass\n")
    assert msg and "line 1" in msg
    assert "Invalid JSON" in (await check_file("p.json", '{"a": 1,}') or "")
    assert await check_file("notes.md", "def f(:") is None  # not checked


@needs_node
async def test_js_and_inline_html_scripts_are_parsed() -> None:
    assert await check_file("a.js", "const f = (a) => a && a > 1;\n") is None
    assert "line 2" in (await check_file("a.js", "const a = 1;\nconst b = (;\n") or "")
    assert await check_file("m.mjs", "import x from './x.js';\nexport const y = x;\n") is None
    html = ("<!doctype html>\n<title>g</title>\n<script type=importmap>{\"imports\": {}}</script>\n"
            "<script type=module>\nimport * as THREE from 'three';\nconst s = new THREE.Scene();\n</script>\n"
            "<script>\nlet a = 1;\nfunction loop( {\n}\n</script>\n")
    msg = await check_file("index.html", html)
    assert msg and "inline <script>" in msg and "at line 1" in msg and "importmap" not in msg, msg  # line 11-12 of the HTML
    assert await check_file("ok.html", "<script>let a = 1 < 2 && 3 > 2;</script><script src=x.js></script>") is None
    assert "Unbalanced" in (await check_file("b.html", "<script>let a = 1;") or "")


def test_edit_tolerates_indentation_shift_and_trailing_spaces() -> None:
    text = "def f():\n    if x:\n        a = 1   \n        b = 2\n    return a\n"
    out, line = apply_edits(text, [A.Edit(old_string="if x:\n    a = 1\n    b = 2", new_string="if x:\n    a = 10\n    b = 2\n    c = 3")])
    assert out == "def f():\n    if x:\n        a = 10\n        b = 2\n        c = 3\n    return a\n" and line == 2
    with pytest.raises(ValueError):  # ambiguous after normalising: still refused
        apply_edits("  a\n  b\n    a\n    b\n", [A.Edit(old_string="a\nb", new_string="z")])


@needs_node
async def test_broken_write_is_flagged_to_the_agent_and_on_the_blackboard(client, workspace) -> None:
    provider = NativeScriptedProvider({"Ann": [
        [("write_file", {"path": "index.html", "content": "<script>\nfunction go( {\n</script>"})],
        [("write_file", {"path": "index.html", "content": "<script>\nfunction go() {}\n</script>"})],
        [("finish", {"summary": "fixed"})]]})
    set_provider_override(provider)
    cid = await make_company(client, workspace, [agent("a", "Ann", entry=True)], [])
    run = await start_run(client, workspace, cid, permission_level="danger")
    done = await wait_status(client, workspace, run["id"])
    assert done["status"] == "completed"
    first = [i["output"] for i in provider.requests[1].continuation if i.get("type") == "function_call_output"][-1]
    assert "AUTOMATIC CHECK FAILED for index.html" in first and "SyntaxError" in first
    second = [i["output"] for i in provider.requests[2].continuation if i.get("type") == "function_call_output"][-1]
    assert "AUTOMATIC CHECK FAILED" not in second
    assert (Path(workspace["path"]) / "index.html").read_text().startswith("<script>")
