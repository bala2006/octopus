/**
 * Skills: Markdown playbooks (catalog/skills/*.md) added to an agent's instructions when the skill lists the agent's
 * role, or when the agent has the skill switched on. Users can edit and add skills in Settings → Skills.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentOut, SkillOut } from "@octopus/shared";
import type { Registry } from "../db/registry";

type Skill = Omit<SkillOut, "source">;
const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "skills");

function parse(text: string): Skill {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text.replace(/\r\n/g, "\n"));
  const meta = Object.fromEntries((m?.[1] ?? "").split("\n").map((l) => [l.slice(0, l.indexOf(":")).trim(), l.slice(l.indexOf(":") + 1).trim()]));
  const csv = (s?: string) => (s ? s.split(",").map((x) => x.trim()).filter(Boolean) : []);
  return { name: meta.name ?? "", description: meta.description ?? "", roles: csv(meta.roles), phases: csv(meta.phases), body: (m?.[2] ?? text).trim() };
}

export const BUILTIN_SKILLS: Skill[] = readdirSync(DIR).filter((f) => f.endsWith(".md")).sort().map((f) => parse(readFileSync(path.join(DIR, f), "utf8")));

export function effectiveSkills(reg: Registry): SkillOut[] {
  const custom = new Map(reg.skills.find().map((s) => [s.name, s]));
  const out: SkillOut[] = [];
  for (const s of BUILTIN_SKILLS) {
    const c = custom.get(s.name);
    if (c?.deleted) continue;
    out.push(c ? { ...c.data, name: s.name, source: "modified" } : { ...s, source: "builtin" });
  }
  for (const c of custom.values()) if (!c.deleted && !BUILTIN_SKILLS.some((s) => s.name === c.name)) out.push({ ...c.data, name: c.name, source: "custom" });
  return out;
}

/** The skills that apply to an agent: by role, plus any switched on for it. At most three, to keep prompts focused. */
export function skillsFor(reg: Registry, agent: AgentOut): SkillOut[] {
  const role = agent.behavior.template_key ?? "";
  const chosen = new Set(agent.behavior.skills ?? []);
  return effectiveSkills(reg).filter((s) => chosen.has(s.name) || (role && s.roles.includes(role))).slice(0, 3);
}
