/**
 * The read-only specialists: reviewer (correctness), security, designer (how the UI looks) and explorer (answers one
 * question). Each has one prompt and one skill under catalog/specialists, a toolbox and an effort. Its instructions are
 * the prompt followed by the skill, and they never change, so every round reuses the cached prefix.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Effort } from "@octopus/shared";
import type { SpecialistTool } from "../tools";

export const SPECIALISTS = ["reviewer", "security", "designer", "explorer"] as const;
export type SpecialistName = (typeof SPECIALISTS)[number];

export interface SpecialistDef {
  name: SpecialistName;
  title: string;
  effort: Effort;
  tools: readonly SpecialistTool[];
  /** How a round ends: a submit_review call with a verdict, or a plain text answer. */
  ends: "review" | "answer";
  instructions: string;
}

const CATALOG = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "catalog", "specialists");
const read = (name: SpecialistName, file: "prompt.md" | "SKILL.md") => readFileSync(path.join(CATALOG, name, file), "utf8").trim();
const instructionsOf = (name: SpecialistName) => `${read(name, "prompt.md")}\n\n${read(name, "SKILL.md")}`;

const CHECKS: readonly SpecialistTool[] = ["read_file", "glob", "grep", "shell"];

export const SPECIALIST_DEFS: Record<SpecialistName, SpecialistDef> = {
  reviewer: { name: "reviewer", title: "Reviewer", effort: "medium", tools: [...CHECKS, "submit_review"], ends: "review", instructions: instructionsOf("reviewer") },
  security: { name: "security", title: "Security reviewer", effort: "high", tools: [...CHECKS, "fetch_url", "submit_review"], ends: "review", instructions: instructionsOf("security") },
  designer: { name: "designer", title: "Designer", effort: "high", tools: [...CHECKS, "start_dev_server", "browser", "submit_review"], ends: "review", instructions: instructionsOf("designer") },
  explorer: { name: "explorer", title: "Explorer", effort: "low", tools: [...CHECKS, "fetch_url"], ends: "answer", instructions: instructionsOf("explorer") },
};
