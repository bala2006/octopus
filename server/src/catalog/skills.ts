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

/** The most of a skill's description that the catalog shows. The full instructions load with the `skill` tool. */
export const CATALOG_SUMMARY_CHARS = 500;

/**
 * The skill catalog of a solo session, in the format of DeepSeek Harness: one line per skill, then how to load one. The
 * session sends it once, as a user message. It is empty when there are no skills.
 */
export function skillCatalog(skills: SkillOut[]): string {
  if (!skills.length) return "";
  const lines = skills.map((s) => {
    const summary = Array.from(s.description.replace(/\s+/g, " ").trim()).slice(0, CATALOG_SUMMARY_CHARS).join("");
    return `- \`${s.name}\`: ${summary}`;
  });
  return [
    "<skills>",
    "A skill is a set of instructions for one kind of task. These skills are available in this session:",
    ...lines,
    "If the user names a skill, or the task clearly matches one, call skill with its exact name before you start, then follow it. This list holds summaries only. Do not follow a skill until you have loaded it.",
    "</skills>",
  ].join("\n");
}

/**
 * The skills that apply to an agent's turn, most specific first: the ones its task asks for, the ones switched on for
 * the agent, then the ones its role lists. At most three, to keep prompts focused.
 */
export function skillsFor(reg: Registry, agent: AgentOut, wanted: string[] = []): SkillOut[] {
  const role = agent.behavior.template_key ?? "";
  const chosen = new Set(agent.behavior.skills ?? []);
  const all = effectiveSkills(reg);
  const rank = (s: SkillOut) => (wanted.includes(s.name) ? 0 : chosen.has(s.name) ? 1 : role && s.roles.includes(role) ? 2 : 3);
  return all.filter((s) => rank(s) < 3).sort((a, b) => rank(a) - rank(b)).slice(0, 3);
}
