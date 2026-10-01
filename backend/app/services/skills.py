"""Skills: step-by-step playbooks agents follow (Agent Skills format: a SKILL.md with front matter + Markdown body).

Sources, later ones win by name:
1. built-in  ``app/skills/<name>/SKILL.md``
2. the user's edits and own skills (registry ``user_skills``; Settings → Skills; delete an edit to restore the default)
3. the project's own skills: ``.octopus/skills``, ``.agents/skills`` and ``.claude/skills`` (``<name>/SKILL.md``), so
   skills written for Claude Code / Codex work here too

Progressive disclosure: an agent's prompt lists only names + descriptions (its role's skills first); the full steps are
loaded with the ``use_skill`` tool when needed.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field, replace
from functools import lru_cache
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

BUILTIN_DIR = Path(__file__).resolve().parent.parent / "skills"
PROJECT_DIRS = (".octopus/skills", ".agents/skills", ".claude/skills")
NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,62}$")
MAX_BODY = 40_000
ROLE_SKILLS_SHOWN = 8


@dataclass(frozen=True)
class Skill:
    name: str
    description: str
    body: str
    roles: tuple[str, ...] = field(default_factory=tuple)
    phases: tuple[str, ...] = field(default_factory=tuple)
    source: str = "builtin"  # builtin | modified | custom | project


def _csv(v: str) -> tuple[str, ...]:
    v = v.strip().strip("[]")
    return tuple(x.strip().strip("'\"") for x in v.split(",") if x.strip())


def parse(text: str, *, fallback_name: str = "", source: str = "builtin") -> Skill | None:
    """SKILL.md → Skill. Front matter: ``name``, ``description`` (required), ``roles``, ``phases`` (comma lists)."""
    m = re.match(r"^---\s*\n(.*?)\n---\s*\n?(.*)$", text, re.S)
    meta: dict[str, str] = {}
    body = text
    if m:
        for line in m.group(1).splitlines():
            if ":" in line and not line.startswith((" ", "\t", "#")):
                k, v = line.split(":", 1)
                meta[k.strip().lower()] = v.strip()
        body = m.group(2)
    name = (meta.get("name") or fallback_name).strip().strip("'\"").lower()
    if not NAME_RE.match(name):
        return None
    desc = meta.get("description", "").strip().strip("'\"")
    return Skill(name=name, description=desc[:400], body=body.strip()[:MAX_BODY], roles=_csv(meta.get("roles", "")),
                 phases=_csv(meta.get("phases", "")), source=source)


def render(s: Skill) -> str:
    """Back to SKILL.md text (front matter + body), e.g. for export."""
    head = [f"name: {s.name}", f"description: {s.description}"]
    if s.roles:
        head.append("roles: " + ", ".join(s.roles))
    if s.phases:
        head.append("phases: " + ", ".join(s.phases))
    return "---\n" + "\n".join(head) + "\n---\n" + s.body + "\n"


@lru_cache(maxsize=1)
def builtin_skills() -> dict[str, Skill]:
    out: dict[str, Skill] = {}
    for p in sorted(BUILTIN_DIR.glob("*/SKILL.md")):
        s = parse(p.read_text(encoding="utf-8"), fallback_name=p.parent.name)
        if s:
            out[s.name] = s
    return out


def project_skills(root: Path) -> dict[str, Skill]:
    out: dict[str, Skill] = {}
    for rel in PROJECT_DIRS:
        d = root / rel
        if not d.is_dir():
            continue
        for p in sorted(d.glob("*/SKILL.md"))[:100]:
            try:
                s = parse(p.read_text(encoding="utf-8", errors="replace"), fallback_name=p.parent.name.lower(), source="project")
            except OSError:
                continue
            if s and s.name not in out:
                out[s.name] = s
    return out


async def user_rows(rdb: AsyncSession, user_id: str) -> list[Any]:
    from app.models import UserSkill

    return list((await rdb.execute(select(UserSkill).where(UserSkill.user_id == user_id))).scalars().all())


def from_row(row: Any) -> Skill:
    builtin = row.name in builtin_skills()
    return Skill(name=row.name, description=row.description, body=row.body, roles=_csv(row.roles or ""), phases=_csv(row.phases or ""),
                 source="modified" if builtin else "custom")


def merge(rows: list[Any], root: Path | None = None) -> dict[str, Skill]:
    skills = dict(builtin_skills())
    for r in rows:
        skills[r.name] = from_row(r)
    if root is not None:
        for name, s in project_skills(root).items():
            skills[name] = s
    return skills


async def effective_skills(rdb: AsyncSession, user_id: str, root: Path | None = None) -> dict[str, Skill]:
    return merge(await user_rows(rdb, user_id), root)


def skills_for(skills: dict[str, Skill], role_key: str, chosen: list[str] | None = None) -> list[Skill]:
    """An agent's own skills: the ones picked for it, then the ones made for its role."""
    picked = [skills[n] for n in (chosen or []) if n in skills]
    by_role = [s for s in skills.values() if role_key and role_key in s.roles and s not in picked]
    return (picked + by_role)[:ROLE_SKILLS_SHOWN]


def prompt_section(skills: dict[str, Skill], role_key: str, chosen: list[str] | None = None) -> str:
    """The skills part of an agent's system prompt: names + descriptions only (load the steps with use_skill)."""
    if not skills:
        return ""
    mine = skills_for(skills, role_key, chosen)
    others = [s for s in skills.values() if s not in mine]
    lines = ["\n## Skills (step-by-step playbooks; call `use_skill` with the name to load one, then follow it)"]
    if mine:
        lines.append("Yours (load the one that fits before you start the work):")
        lines += [f"- {s.name}: {s.description}" for s in mine]
    if others:
        lines.append("Also available: " + ", ".join(s.name for s in sorted(others, key=lambda s: s.name)))
    return "\n".join(lines)


def with_source(s: Skill, source: str) -> Skill:
    return replace(s, source=source)
