/** Which tools an agent gets, from its kind (writer, critic or lead), its tool switches and what it is doing right now. */
import type { AgentOut } from "@octopus/shared";
import type { Registry } from "../db/registry";
import { canWrite, kindOf } from "../catalog/kinds";
import { BUILDER_BROWSER_TOOLS, browserTools, serverTools } from "../services/mcp";
import { browserBudget } from "./budget";
import { checkShellTool, commandTools } from "./commands";
import { fileTools } from "./files";
import { skillTool } from "./skill";
import { acceptanceTool, askUser, collabTools, memoryTools, plannerTools, reviewTool, workerTools } from "./team";
import { todoTools } from "./todo";
import { setPlanTool } from "./plan";
import { askVerdictTool, exploreTool, reviewCallTool } from "./review";
import type { Tool } from "./types";
import { webTools } from "./web";

/**
 * `quick_review`: a reviewer for a small change, shown as a diff, with only the verdict tools.
 * `acceptance`: checks the finished product against the user's requirements; it can run and look, not write.
 */
export type Mode = "orchestrator" | "worker" | "reviewer" | "quick_review" | "acceptance" | "chat" | "consult" | "report";
const READ = ["glob", "grep", "read_file"];
/** The tools that end a turn on its task. A turn that must wrap up names only the ones in its own toolbox. */
export const ENDING_TOOLS = new Set(["ask_user", "block_task", "complete_task", "reply_to_user", "start_work", "submit_acceptance", "submit_review"]);
/** The names of the toolbox tools that end a turn. */
export const endingNames = (tools: { name: string }[]) => tools.map((t) => t.name).filter((n) => ENDING_TOOLS.has(n));
const blockTask = workerTools.find((w) => w.name === "block_task")!;

/** What an agent may change or run in a mode. The only place that decides it. */
export type Policy = { files: boolean; commands: "all" | "start" | "none"; browser: boolean; mcp: boolean };

export function policyFor(agent: AgentOut, mode: Mode): Policy {
  const t = agent.tools;
  const kind = kindOf(agent);
  const checks = mode === "worker" || mode === "reviewer" || mode === "acceptance";
  const build = canWrite(agent) && mode === "worker";
  let commands: Policy["commands"] = "none";
  if (checks && t.terminal) commands = build ? "all" : mode === "acceptance" ? "start" : "none";
  return {
    files: build,
    commands,
    browser: !!t.browser && checks,
    mcp: !(kind === "critic" && checks),
  };
}

export async function toolbox(reg: Registry, root: string, agent: AgentOut, mode: Mode): Promise<{ tools: Tool[]; warnings: string[] }> {
  const t = agent.tools;
  const warnings: string[] = [];
  if (mode === "report") return { tools: [], warnings };
  if (mode === "quick_review") return { tools: [reviewTool, blockTask], warnings };
  const policy = policyFor(agent, mode);
  const checks = mode === "worker" || mode === "reviewer" || mode === "acceptance";
  const tools: Tool[] = fileTools.filter((f) => (READ.includes(f.name) && (t.file_read !== false || mode === "orchestrator")) || (policy.files && !READ.includes(f.name)));
  if (t.web_search || mode === "orchestrator") tools.push(...webTools);
  if (policy.commands === "all") tools.push(...commandTools);
  if (policy.commands === "start") tools.push(...commandTools.filter((c) => c.name === "start_dev_server"));
  if (policy.browser) {
    try { tools.push(...browserBudget(await browserTools(root, mode === "worker" ? BUILDER_BROWSER_TOOLS : undefined), mode === "acceptance" ? 20 : 15)); } catch (e) { warnings.push(`Browser unavailable: ${(e as Error).message}`); }
  }
  if (t.mcp_servers?.length && mode !== "consult" && policy.mcp) tools.push(...await serverTools(reg, t.mcp_servers));
  if (mode !== "consult") tools.push(...memoryTools);
  if (checks && t.send_message !== false) tools.push(...collabTools);
  if ((mode === "worker" || mode === "reviewer") && t.ask_user !== false) tools.push(askUser);
  if (mode === "worker") tools.push(...workerTools, ...todoTools);
  if (mode === "reviewer") tools.push(reviewTool, blockTask);
  if (mode === "acceptance") tools.push(acceptanceTool, blockTask);
  if (mode === "orchestrator") tools.push(...plannerTools, askUser);
  return { tools, warnings };
}

/**
 * The main agent of a solo conversation: the builder's tools, plus skill, ask_user and todo_write. It has no team,
 * planning, hiring or review tools, so the only way its turn ends without a reply is a question to the user.
 */
export async function soloToolbox(reg: Registry, root: string, agent: AgentOut): Promise<{ tools: Tool[]; warnings: string[] }> {
  const t = agent.tools;
  const warnings: string[] = [];
  const tools: Tool[] = fileTools.filter((f) => (t.file_read !== false || !READ.includes(f.name)) && (t.file_write !== false || READ.includes(f.name)));
  if (t.terminal) tools.push(...commandTools);
  if (t.web_search) tools.push(...webTools);
  if (t.browser) {
    try { tools.push(...await browserTools(root, BUILDER_BROWSER_TOOLS)); } catch (e) { warnings.push(`Browser unavailable: ${(e as Error).message}`); }
  }
  if (t.mcp_servers?.length) tools.push(...await serverTools(reg, t.mcp_servers));
  tools.push(skillTool, ...memoryTools, askUser, ...todoTools, setPlanTool, reviewCallTool, exploreTool);
  return { tools, warnings };
}

/** The tools a read-only specialist may hold. None of them writes, edits, deletes, remembers or asks the user. */
export type SpecialistTool = "read_file" | "glob" | "grep" | "shell" | "fetch_url" | "start_dev_server" | "browser" | "submit_review" | "submit_acceptance";

const SPECIALIST_TOOLS: Record<Exclude<SpecialistTool, "browser">, Tool> = {
  read_file: fileTools.find((f) => f.name === "read_file")!,
  glob: fileTools.find((f) => f.name === "glob")!,
  grep: fileTools.find((f) => f.name === "grep")!,
  shell: checkShellTool,
  fetch_url: webTools.find((w) => w.name === "fetch_url")!,
  start_dev_server: commandTools.find((c) => c.name === "start_dev_server")!,
  submit_review: reviewTool,
  submit_acceptance: askVerdictTool,
};

/** A specialist's toolbox: exactly the names it lists. The browser is the full Playwright list, as a designer needs it. */
export async function specialistToolbox(names: readonly SpecialistTool[], root: string): Promise<{ tools: Tool[]; warnings: string[] }> {
  const warnings: string[] = [];
  const tools: Tool[] = [];
  for (const name of names) {
    if (name !== "browser") {
      tools.push(SPECIALIST_TOOLS[name]);
      continue;
    }
    try { tools.push(...await browserTools(root)); } catch (e) { warnings.push(`Browser unavailable: ${(e as Error).message}`); }
  }
  return { tools, warnings };
}
