/** Which tools an agent gets, from its tool switches and what it is doing right now. */
import type { AgentOut } from "@octopus/shared";
import type { Registry } from "../db/registry";
import { browserTools, serverTools } from "../services/mcp";
import { commandTools } from "./commands";
import { fileTools } from "./files";
import { askUser, consultTool, memoryTools, plannerTools, reviewTool, workerTools } from "./team";
import type { Tool } from "./types";
import { webTools } from "./web";

/** `quick_review`: a reviewer for a small change, shown as a diff, with only the verdict tools. */
export type Mode = "orchestrator" | "worker" | "reviewer" | "quick_review" | "chat" | "consult" | "report";
const READ = ["list_files", "read_file", "search_project"];

export async function toolbox(reg: Registry, root: string, agent: AgentOut, mode: Mode): Promise<{ tools: Tool[]; warnings: string[] }> {
  const t = agent.tools;
  const warnings: string[] = [];
  if (mode === "report") return { tools: [], warnings };
  if (mode === "quick_review") return { tools: [reviewTool, workerTools.find((w) => w.name === "block_task")!], warnings };
  const tools: Tool[] = fileTools.filter((f) => (READ.includes(f.name) && (t.file_read !== false || mode === "orchestrator")) || (mode === "worker" && t.file_write !== false && !READ.includes(f.name)));
  if (t.web_search || mode === "orchestrator") tools.push(...webTools);
  if (t.terminal && (mode === "worker" || mode === "reviewer")) tools.push(...commandTools);
  if (t.browser && (mode === "worker" || mode === "reviewer")) {
    try { tools.push(...await browserTools(root)); } catch (e) { warnings.push(`Browser unavailable: ${(e as Error).message}`); }
  }
  if (t.mcp_servers?.length && mode !== "consult") tools.push(...await serverTools(reg, t.mcp_servers));
  if (mode !== "consult") tools.push(...memoryTools);
  if ((mode === "worker" || mode === "reviewer") && t.send_message !== false) tools.push(consultTool);
  if ((mode === "worker" || mode === "reviewer") && t.ask_user !== false) tools.push(askUser);
  if (mode === "worker") tools.push(...workerTools);
  if (mode === "reviewer") tools.push(reviewTool, workerTools.find((w) => w.name === "block_task")!);
  if (mode === "orchestrator") tools.push(...plannerTools, askUser);
  return { tools, warnings };
}
