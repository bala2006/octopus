/** The `skill` tool: loads one skill's instructions, so the main agent reads a playbook only when its task needs it. */
import { z } from "zod";
import { effectiveSkills } from "../catalog/skills";
import { defineTool } from "./types";

export const skillTool = defineTool({
  name: "skill",
  description: "Load the full instructions of one skill by its exact name, as written in the skill list. Load them before you act on a task that names or clearly matches a skill, then follow them.",
  args: z.object({ name: z.string().describe("The exact skill name from the skill list") }),
  readOnly: true,
  async run(ctx, { name }) {
    const skill = effectiveSkills(ctx.reg).find((s) => s.name === name);
    if (!skill) return { text: `No skill named ${name}. Use a name exactly as the skill list gives it.`, ok: false };
    return { text: skill.body };
  },
});
