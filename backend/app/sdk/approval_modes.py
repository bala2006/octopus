"""Approval modes and the edits that always need approval (the policy gate reads these).

Moved from app/orchestrator/permissions.py in Phase 5. Pure helpers; the decision itself is PolicyGate.decide.
"""
from __future__ import annotations


# One global setting per user. "ask" asks before every command, edit, external tool, web search and team change.
# "auto" (Approve for me) runs commands and edits without asking, except the cases below.
APPROVAL_MODES = ("ask", "auto")
# Edits under these prefixes ask even in "auto": CI workflows run code without the user watching.
DANGEROUS_EDIT_PREFIXES = (".github/workflows/",)


def normalize_mode(value: str | None) -> str:
    """Anything other than "auto" is "ask". Legacy values (read_only, plan, danger) therefore become "ask"."""
    return "auto" if value == "auto" else "ask"


def is_dangerous_edit(rel: str, *, move: bool = False) -> bool:
    """Dangerous edits ask in "auto" mode: every move or rename, and edits to CI workflow files."""
    if move:
        return True
    path = rel.replace("\\", "/").lstrip("/").lower()
    return any(path.startswith(prefix) for prefix in DANGEROUS_EDIT_PREFIXES)
