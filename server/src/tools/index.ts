/** Which tools an agent gets, from its kind (writer, critic or lead), its tool switches and what it is doing right now. */
import type { AgentOut } from "@octopus/shared";
import type { Registry } from "../db/registry";
import { canWrite, kindOf } from "../catalog/kinds";
import { browserTools, serverTools } from "../services/mcp";
import { commandTools } from "./commands";
import { fileTools } from "./files";
import { acceptanceTool, askUser, collabTools, memoryTools, plannerTools, reviewTool, workerTools } from "./team";
import type { Tool } from "./types";
import { webTools } from "./web";

/**
 * `quick_review`: a reviewer for a small change, shown as a diff, with only the verdict tools.
 * `acceptance`: checks the finished product against the user's requirements; it can run and look, not write.
 */
export type Mode = "orchestrator" | "worker" | "reviewer" | "quick_review" | "acceptance" | "chat" | "consult" | "report";
const READ = ["list_files", "read_file", "search_project"];
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
    try { tools.push(...await browserTools(root)); } catch (e) { warnings.push(`Browser unavailable: ${(e as Error).message}`); }
  }
  if (t.mcp_servers?.length && mode !== "consult" && policy.mcp) tools.push(...await serverTools(reg, t.mcp_servers));
  if (mode !== "consult") tools.push(...memoryTools);
  if (checks && t.send_message !== false) tools.push(...collabTools);
  if ((mode === "worker" || mode === "reviewer") && t.ask_user !== false) tools.push(askUser);
  if (mode === "worker") tools.push(...workerTools);
  if (mode === "reviewer") tools.push(reviewTool, blockTask);
  if (mode === "acceptance") tools.push(acceptanceTool, blockTask);
  if (mode === "orchestrator") tools.push(...plannerTools, askUser);
  return { tools, warnings };
}
