"""The public surface of the skills plugin (capability ``skills.library``).

Other plugins and the kernel use skills through this object; they do not import the plugin's modules.
"""
from __future__ import annotations

from app.plugins.skills.contracts import pin_project_guidance, pin_skill_bundle
from app.plugins.skills.guidance import MAX_GUIDANCE_CHARS, load as load_guidance
from app.plugins.skills.library import (
    BUILTIN_DIR, builtin_skills, effective_skills, from_row, merge, parse, project_skills, prompt_section, render, skills_for,
    user_rows, with_source,
)

__all__ = ["BUILTIN_DIR", "MAX_GUIDANCE_CHARS", "builtin_skills", "effective_skills", "from_row", "load_guidance", "merge", "parse",
           "pin_project_guidance", "pin_skill_bundle", "project_skills", "prompt_section", "render", "skills_for", "user_rows",
           "with_source"]
