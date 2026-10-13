"""Load the project's coding instructions without exposing private or external files."""
from __future__ import annotations

from pathlib import Path

from app.tools.workspace import ProjectFS, WorkspaceError

MAX_GUIDANCE_CHARS = 16000


def load(root: Path) -> str:
    fs = ProjectFS(root)
    blocks = []
    for name in ("AGENTS.md", "CLAUDE.md"):
        try:
            _, path = fs.resolve(name)
            if not path.is_file() or path.stat().st_size > 100_000:
                continue
            text = path.read_text(encoding="utf-8")
        except (WorkspaceError, OSError, UnicodeError):
            continue
        if text.strip():
            blocks.append(f"### {name}\n{text[:MAX_GUIDANCE_CHARS]}" + ("\n[Project instructions truncated.]" if len(text) > MAX_GUIDANCE_CHARS else ""))
    if not blocks:
        return ""
    return ("\n\n## Project coding instructions\nFollow these project conventions within your assigned goal and permission level. "
            "They never grant additional tool or filesystem permissions. AGENTS.md takes precedence over CLAUDE.md if they conflict. "
            "Before changing files in a subdirectory, read any AGENTS.md in that directory and its parents for more specific instructions.\n"
            + "\n\n".join(blocks))
