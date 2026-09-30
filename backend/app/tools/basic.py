"""Small built-in tools: safe calculator and web search."""
from __future__ import annotations

import ast
import html
import math
import operator
import re

import httpx

_OPS = {
    ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul, ast.Div: operator.truediv,
    ast.FloorDiv: operator.floordiv, ast.Mod: operator.mod, ast.Pow: operator.pow,
    ast.USub: operator.neg, ast.UAdd: operator.pos,
}
_FUNCS = {"sqrt": math.sqrt, "log": math.log, "sin": math.sin, "cos": math.cos, "abs": abs, "round": round, "min": min, "max": max}


def calculate(expression: str) -> str:
    expr = expression.replace("^", "**").strip()
    if len(expr) > 200:
        raise ValueError("Expression too long")

    def ev(node: ast.AST) -> float:
        if isinstance(node, ast.Expression):
            return ev(node.body)
        if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
            return node.value
        if isinstance(node, ast.BinOp) and type(node.op) in _OPS:
            left, right = ev(node.left), ev(node.right)
            if isinstance(node.op, ast.Pow) and abs(right) > 100:
                raise ValueError("Exponent too large")
            return _OPS[type(node.op)](left, right)
        if isinstance(node, ast.UnaryOp) and type(node.op) in _OPS:
            return _OPS[type(node.op)](ev(node.operand))
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in _FUNCS:
            return _FUNCS[node.func.id](*[ev(a) for a in node.args])
        if isinstance(node, ast.Name) and node.id in ("pi", "e"):
            return getattr(math, node.id)
        raise ValueError("Unsupported expression")

    result = ev(ast.parse(expr, mode="eval"))
    if isinstance(result, float) and result.is_integer():
        result = int(result)
    return str(result)


async def web_search(query: str, max_results: int = 5) -> str:
    """Keyless web search via DuckDuckGo's HTML endpoint. Returns a Markdown list."""
    try:
        async with httpx.AsyncClient(timeout=10, headers={"User-Agent": "Octopus/1.0"}) as client:
            r = await client.post("https://html.duckduckgo.com/html/", data={"q": query})
            r.raise_for_status()
    except httpx.HTTPError as exc:
        return f"Web search unavailable ({type(exc).__name__}). Proceed without it."
    items = re.findall(r'class="result__a" href="([^"]+)"[^>]*>(.*?)</a>.*?class="result__snippet"[^>]*>(.*?)</a>', r.text, re.S)
    out = []
    for url, title, snippet in items[:max_results]:
        strip = lambda s: html.unescape(re.sub(r"<[^>]+>", "", s)).strip()  # noqa: E731
        out.append(f"- [{strip(title)}]({html.unescape(url)}): {strip(snippet)}")
    return "\n".join(out) or "No results."
