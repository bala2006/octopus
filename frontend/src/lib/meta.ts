import {
  Bot, Brain, Bug, ClipboardList, Code, Container, Crown, DraftingCompass, Eye, Gavel, GitPullRequest, Layout, Lightbulb,
  Palette, PenLine, Server, ShieldAlert, Sparkles, Terminal, Wrench, MessageSquareText, Hourglass, ShieldQuestion, CircleCheck,
  CircleAlert, Moon, FileSearch, FolderTree, FilePen, Calculator, Globe, UserRoundSearch, Send, Plug, Lock, ListChecks, Hand, Flame, UsersRound, Search, Crown as CrownIcon,
  type LucideIcon,
} from "lucide-react";
import type { AgentStatus, EdgeType, PermissionLevel } from "@/types";

export const AVATARS: Record<string, LucideIcon> = {
  crown: Crown, "clipboard-list": ClipboardList, "drafting-compass": DraftingCompass, layout: Layout, server: Server, bug: Bug,
  palette: Palette, container: Container, "git-pull-request": GitPullRequest, gavel: Gavel, lightbulb: Lightbulb,
  "shield-alert": ShieldAlert, code: Code, bot: Bot, brain: Brain, sparkles: Sparkles, wrench: Wrench,
  "pen-line": PenLine, search: Search, calculator: Calculator, users: UsersRound,
};
export const AVATAR_KEYS = Object.keys(AVATARS);
export const AGENT_COLORS = ["#8b5cf6", "#6366f1", "#06b6d4", "#10b981", "#22c55e", "#eab308", "#f59e0b", "#f97316", "#ef4444", "#ec4899", "#0ea5e9", "#64748b"];

export interface StatusMeta { label: string; color: string; icon: LucideIcon; live: boolean }
export const STATUS: Record<AgentStatus, StatusMeta> = {
  idle: { label: "Idle", color: "#64748b", icon: Moon, live: false },
  thinking: { label: "Thinking", color: "#a78bfa", icon: Brain, live: true },
  speaking: { label: "Writing message", color: "#38bdf8", icon: MessageSquareText, live: true },
  writing: { label: "Writing file", color: "#34d399", icon: PenLine, live: true },
  reading: { label: "Reading", color: "#60a5fa", icon: Eye, live: true },
  running: { label: "Running command", color: "#fbbf24", icon: Terminal, live: true },
  tool: { label: "Using tool", color: "#f472b6", icon: Plug, live: true },
  waiting: { label: "Waiting", color: "#94a3b8", icon: Hourglass, live: false },
  awaiting_approval: { label: "Needs approval", color: "#f59e0b", icon: ShieldQuestion, live: true },
  error: { label: "Error", color: "#f87171", icon: CircleAlert, live: false },
  done: { label: "Done", color: "#22c55e", icon: CircleCheck, live: false },
};
export const statusMeta = (s?: string): StatusMeta => STATUS[(s as AgentStatus) ?? "idle"] ?? STATUS.idle;

export interface EdgeMeta { label: string; color: string; dash?: string; description: string }
export const EDGE_TYPES: Record<EdgeType, EdgeMeta> = {
  delegate: { label: "Delegate", color: "#8b5cf6", description: "Task handoff: the source assigns work to the target." },
  review: { label: "Review", color: "#10b981", dash: "6 4", description: "Feedback loop: review_request → approve / request_changes." },
  debate: { label: "Debate", color: "#f43f5e", dash: "2 5", description: "Adversarial discussion ending in explicit agreement or a decision." },
  report: { label: "Report", color: "#0ea5e9", dash: "10 4", description: "Status reported upward." },
  consult: { label: "Consult", color: "#eab308", dash: "1 4", description: "Ask-only: questions and answers." },
};

export interface PermMeta { label: string; short: string; description: string; icon: LucideIcon; tone: string }
export const PERMISSIONS: Record<PermissionLevel, PermMeta> = {
  read_only: { label: "Read only", short: "Read", description: "Agents can read and discuss. No writes, commands or MCP calls.", icon: Lock, tone: "text-sky-400" },
  plan: { label: "Plan", short: "Plan", description: "Agents write proposed changes to a plan (.octopus/plans). Your project stays untouched until you apply it.", icon: ListChecks, tone: "text-violet-400" },
  ask: { label: "Ask for dangerous actions", short: "Ask", description: "Reading is free. Writing files, running commands and MCP calls need your approval.", icon: Hand, tone: "text-amber-400" },
  danger: { label: "Danger mode", short: "Danger", description: "Everything auto-approved, network allowed for commands. Still sandboxed to the project directory.", icon: Flame, tone: "text-red-400" },
};

export interface ToolMeta { key: "file_read" | "file_write" | "list_files" | "terminal" | "web_search" | "calculator" | "ask_user" | "send_message" | "manage_team"; label: string; icon: LucideIcon; hint: string; danger?: boolean }
export const TOOLS: ToolMeta[] = [
  { key: "file_read", label: "Read files", icon: FileSearch, hint: "read_file inside the project" },
  { key: "list_files", label: "List files", icon: FolderTree, hint: "Browse the project tree" },
  { key: "file_write", label: "Write files", icon: FilePen, hint: "Create / modify files (subject to permission level)", danger: true },
  { key: "terminal", label: "Terminal", icon: Terminal, hint: "Run sandboxed commands (python, node, npm test, pytest…)", danger: true },
  { key: "web_search", label: "Web search", icon: Globe, hint: "Keyless web search" },
  { key: "calculator", label: "Calculator", icon: Calculator, hint: "Exact arithmetic" },
  { key: "ask_user", label: "Ask user", icon: UserRoundSearch, hint: "Pause the run to ask you a question" },
  { key: "send_message", label: "Messaging", icon: Send, hint: "Talk to connected teammates" },
  { key: "manage_team", label: "Manage team", icon: UsersRound, hint: "Hire agents at runtime and reconfigure / deactivate the agents it manages", danger: true },
];
export const MANAGER_ICON = CrownIcon;
export const SEARCH_ICON = Search;

export const RUN_STATUS: Record<string, { label: string; variant: "default" | "secondary" | "success" | "warning" | "destructive" | "outline" }> = {
  queued: { label: "Queued", variant: "secondary" },
  running: { label: "Running", variant: "default" },
  paused: { label: "Paused", variant: "warning" },
  awaiting_user: { label: "Needs you", variant: "warning" },
  completed: { label: "Completed", variant: "success" },
  failed: { label: "Halted", variant: "destructive" },
  cancelled: { label: "Stopped", variant: "outline" },
};

export const MESSAGE_TYPE_LABEL: Record<string, string> = {
  task: "Task", question: "Question", answer: "Answer", proposal: "Proposal", critique: "Critique", agreement: "Agreement",
  objection: "Objection", decision: "Decision", review_request: "Review request", review_result: "Review", status_update: "Status",
  artifact_created: "File", user_interjection: "You", final_report: "Final report", chat: "Chat", org: "Org change",
};
