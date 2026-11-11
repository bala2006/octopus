"""Model-facing text limits. Every cut is marked so the model knows it saw only part (see docs/MODEL_QUALITY_AUDIT.md)."""
from __future__ import annotations

# gpt-6-luna reads up to 922k input tokens, so this is generous; it only guards against pathological inputs.
TOOL_RESULT_CHARS = 60_000  # one tool result / notice in the prompt (~15k tokens)


def clip(text: str, limit: int, hint: str = "") -> str:
    """Cut ``text`` to ``limit`` chars with an explicit marker (never a silent cut)."""
    if len(text) <= limit:
        return text
    return text[:limit] + f"\n…[truncated: showing {limit:,} of {len(text):,} characters{'; ' + hint if hint else ''}]"
