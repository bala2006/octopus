"""Instant checks after an agent writes a file: syntax errors come back in the same tool result.

The agent-computer-interface finding (SWE-agent, Yang et al. 2024) is that a linter in the edit loop is one of the
largest single wins for coding agents: a broken edit is caught at the moment it is made, with the line, instead of
surfacing turns later (or never) as "the page is blank". Checks are fast, offline and never block a write.

* ``.py`` → ``compile()``                    * ``.json`` → ``json.loads``
* ``.js`` / ``.mjs`` / ``.cjs`` → ``node --check``
* ``.html`` / ``.htm`` → every inline classic ``<script>`` through ``node --check`` (line numbers mapped to the
  HTML file), module scripts as ES modules, plus unbalanced ``<script>`` tags.
"""
from __future__ import annotations

import asyncio
import json
import re
import shutil
import tempfile
from pathlib import Path

NODE_TIMEOUT_S = 15
MAX_CHECK_CHARS = 2_000_000
_SCRIPT_RE = re.compile(r"<script\b([^>]*)>(.*?)</script\s*>", re.I | re.S)
_SRC_RE = re.compile(r"\bsrc\s*=", re.I)
_TYPE_RE = re.compile(r"""\btype\s*=\s*["']?([\w/+.-]+)""", re.I)
_NODE_LINE_RE = re.compile(r"^(?:.*?):(\d+)\s*$", re.M)
JS_TYPES = {"", "text/javascript", "application/javascript", "module"}


def _py(text: str, rel: str) -> str | None:
    try:
        compile(text, rel, "exec")
    except SyntaxError as exc:
        where = f"line {exc.lineno}" + (f", column {exc.offset}" if exc.offset else "")
        src = (exc.text or "").rstrip()
        return f"Python syntax error at {where}: {exc.msg}" + (f"\n    {src}" if src else "")
    except (ValueError, OverflowError) as exc:  # e.g. null bytes
        return f"Python could not compile the file: {exc}"
    return None


def _json(text: str) -> str | None:
    try:
        json.loads(text)
    except ValueError as exc:
        return f"Invalid JSON: {exc}"
    return None


async def _node_check(code: str, *, module: bool) -> tuple[int, str] | None:
    """(line, message) of the first syntax error, or None when the code parses (or Node isn't available)."""
    node = shutil.which("node")
    if not node:
        return None
    with tempfile.TemporaryDirectory(prefix="octopus-check-") as d:
        p = Path(d) / ("snippet.mjs" if module else "snippet.cjs")
        p.write_text(code, encoding="utf-8")
        try:
            proc = await asyncio.create_subprocess_exec(node, "--check", str(p), stdout=asyncio.subprocess.PIPE,
                                                        stderr=asyncio.subprocess.STDOUT)
            out, _ = await asyncio.wait_for(proc.communicate(), NODE_TIMEOUT_S)
        except (OSError, asyncio.TimeoutError):
            return None
        if proc.returncode == 0:
            return None
        text = out.decode("utf-8", errors="replace").replace(str(p), "script")
        m = _NODE_LINE_RE.search(text)
        line = int(m.group(1)) if m else 1
        lines = [ln for ln in text.splitlines() if ln.strip() and not ln.strip().startswith(("at ", "Node.js"))]
        msg = next((ln.strip() for ln in lines if "Error" in ln), lines[-1].strip() if lines else "syntax error")
        snippet = "\n".join(lines[1:3]) if len(lines) > 2 else ""
        return line, msg + (f"\n{snippet}" if snippet else "")


async def _js(text: str, *, module: bool) -> str | None:
    err = await _node_check(text, module=module)
    return f"JavaScript syntax error at line {err[0]}: {err[1]}" if err else None


async def _html(text: str) -> str | None:
    problems: list[str] = []
    opened, closed = len(re.findall(r"<script\b", text, re.I)), len(re.findall(r"</script\s*>", text, re.I))
    if opened != closed:
        problems.append(f"Unbalanced <script> tags ({opened} opening, {closed} closing): the page will not run as intended.")
    for m in _SCRIPT_RE.finditer(text):
        attrs, code = m.group(1), m.group(2)
        if _SRC_RE.search(attrs) or not code.strip():
            continue
        t = (_TYPE_RE.search(attrs).group(1).lower() if _TYPE_RE.search(attrs) else "")
        if t not in JS_TYPES:  # importmap, JSON data, templates, shaders: not JavaScript
            continue
        err = await _node_check(code, module=t == "module")
        if err:
            first = text.count("\n", 0, m.start(2)) + 1  # the script's first line in the HTML file
            problems.append(f"JavaScript syntax error in the inline <script> at line {first + err[0] - 1} of the file: {err[1]}")
    return "\n".join(problems) or None


async def check_file(rel: str, text: str) -> str | None:
    """A short problem report for ``rel`` with content ``text``, or None when nothing is wrong (or it can't be checked)."""
    if len(text) > MAX_CHECK_CHARS:
        return None
    ext = rel.rsplit(".", 1)[-1].lower() if "." in rel else ""
    if ext == "py":
        return _py(text, rel)
    if ext == "json":
        return _json(text)
    if ext in ("js", "cjs"):
        return await _js(text, module=False) if "import " not in text and "export " not in text else await _js(text, module=True)
    if ext == "mjs":
        return await _js(text, module=True)
    if ext in ("html", "htm"):
        return await _html(text)
    return None
