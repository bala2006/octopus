import {
  Bot, Brain, Bug, ClipboardList, Code, Container, Crown, DraftingCompass, Eye, Gavel, GitPullRequest, Layout, Lightbulb,
  Palette, PenLine, Server, ShieldAlert, Sparkles, Terminal, Wrench, MessageSquareText, Hourglass, ShieldQuestion, CircleCheck,
  CircleAlert, Moon, FileSearch, FilePen, Calculator, Globe, UserRoundSearch, Send, Plug, UsersRound, Search, Crown as CrownIcon,
  type LucideIcon,
} from "lucide-react";
import type { AgentStatus, ApprovalMode, EdgeType } from "@/types";

export const AVATARS: Record<string, LucideIcon> = {
  crown: Crown, "clipboard-list": ClipboardList, "drafting-compass": DraftingCompass, layout: Layout, server: Server, bug: Bug,
  palette: Palette, container: Container, "git-pull-request": GitPullRequest, gavel: Gavel, lightbulb: Lightbulb,
  "shield-alert": ShieldAlert, code: Code, bot: Bot, brain: Brain, sparkles: Sparkles, wrench: Wrench,
  "pen-line": PenLine, search: Search, calculator: Calculator, users: UsersRound,
};
export const AVATAR_KEYS = Object.keys(AVATARS);
export const AGENT_COLORS = ["#D97756", "#66839A", "#6B8440", "#C9A04A", "#8E7AA8", "#5E9C94", "#C0655A", "#8A7F6E", "#B58D5E", "#7B8FB8", "#A36F8C", "#7E9B6A"];

export interface StatusMeta { label: string; color: string; icon: LucideIcon; live: boolean }
export const STATUS: Record<AgentStatus, StatusMeta> = {
  idle: { label: "Idle", color: "#8A8780", icon: Moon, live: false },
  thinking: { label: "Thinking", color: "#8E7AA8", icon: Brain, live: true },
  speaking: { label: "Writing message", color: "#6B98B2", icon: MessageSquareText, live: true },
  writing: { label: "Writing file", color: "#7E9B6A", icon: PenLine, live: true },
  reading: { label: "Reading", color: "#7B8FB8", icon: Eye, live: true },
  running: { label: "Running command", color: "#C9A04A", icon: Terminal, live: true },
  tool: { label: "Using tool", color: "#A36F8C", icon: Plug, live: true },
  waiting: { label: "Waiting", color: "#9D9A91", icon: Hourglass, live: false },
  awaiting_approval: { label: "Needs approval", color: "#D97756", icon: ShieldQuestion, live: true },
  error: { label: "Error", color: "#C0655A", icon: CircleAlert, live: false },
  done: { label: "Done", color: "#7E9B6A", icon: CircleCheck, live: false },
};
export const statusMeta = (s?: string): StatusMeta => STATUS[(s as AgentStatus) ?? "idle"] ?? STATUS.idle;

export interface EdgeMeta { label: string; color: string; dash?: string; description: string }
export const EDGE_TYPES: Record<EdgeType, EdgeMeta> = {
  delegate: { label: "Delegate", color: "#D97756", description: "Who hands work to whom. Lights up when a task is assigned along it." },
  review: { label: "Review", color: "#7E9B6A", dash: "6 4", description: "The source reviews the target's changes. Without one, the target's department lead or a tech lead reviews." },
  debate: { label: "Debate", color: "#B8645A", dash: "2 5", description: "From an older version of Octopus; works like Consult." },
  report: { label: "Report", color: "#6B98B2", dash: "10 4", description: "Status flows back up. Lights up when the target receives a finished task." },
  consult: { label: "Consult", color: "#C9A04A", dash: "1 4", description: "Teammates who ask each other questions. Lights up when they do; anyone can ask anyone." },
};
/** Channel types you can create (debate is kept only so older teams still display). */
export const CHANNEL_CHOICES: EdgeType[] = ["delegate", "review", "report", "consult"];

export interface ApprovalModeMeta { label: string; description: string; caption: string }
export const APPROVAL_MODES: Record<ApprovalMode, ApprovalModeMeta> = {
  ask: {
    label: "Ask for permission",
    description: "Octopus asks before the team edits or deletes files you already had, installs packages, changes Git history, runs unfamiliar programs or uses an MCP server. New files, builds and tests run without asking.",
    caption: "Octopus asks before edits to your files, installs and other risky actions.",
  },
  auto: {
    label: "Approve for me",
    description: "Octopus approves edits, installs, Git commits and tools for you. It still asks before high-risk actions such as pushing, publishing, deploying or reading secret files. Destructive commands are always refused.",
    caption: "Octopus approves edits, commands and tools. It still asks before high-risk ones.",
  },
};
/** The server stores one of two modes. Any other value (legacy data) is treated as "ask". */
export const approvalModeOf = (value?: string | null): ApprovalMode => (value === "auto" ? "auto" : "ask");

export interface ToolMeta { key: "file_read" | "file_write" | "list_files" | "terminal" | "web_search" | "calculator" | "ask_user" | "send_message" | "manage_team" | "browser"; label: string; icon: LucideIcon; hint: string; danger?: boolean }
export const TOOLS: ToolMeta[] = [
  { key: "file_read", label: "Read files", icon: FileSearch, hint: "List, read and search the project's files" },
  { key: "file_write", label: "Write files", icon: FilePen, hint: "Create, edit, move and delete files (versioned; deletes go to the trash)", danger: true },
  { key: "terminal", label: "Commands", icon: Terminal, hint: "Run builds, tests and tools in the project; destructive commands are always refused", danger: true },
  { key: "web_search", label: "Web", icon: Search, hint: "Search the web and read pages" },
  { key: "browser", label: "Browser", icon: Globe, hint: "A real browser tab: open the project preview, click through it, read console errors" },
  { key: "ask_user", label: "Ask you", icon: UserRoundSearch, hint: "Ask you a question with suggested answers when a decision is yours" },
  { key: "send_message", label: "Ask teammates", icon: Send, hint: "Ask a teammate a question and wait for the answer" },
];
export const MANAGER_ICON = CrownIcon;
export const SEARCH_ICON = Search;

export const RUN_STATUS: Record<string, { label: string; variant: "default" | "secondary" | "success" | "warning" | "destructive" | "outline" }> = {
  queued: { label: "Queued", variant: "secondary" },
  running: { label: "Running", variant: "default" },
  paused: { label: "Paused", variant: "warning" },
  awaiting_user: { label: "Needs you", variant: "warning" },
  completed: { label: "Completed", variant: "success" },
  incomplete: { label: "Incomplete", variant: "warning" },
  failed: { label: "Halted", variant: "destructive" },
  cancelled: { label: "Stopped", variant: "outline" },
};

export const MESSAGE_TYPE_LABEL: Record<string, string> = {
  task: "Task", question: "Question", answer: "Answer", proposal: "Proposal", critique: "Critique", agreement: "Agreement",
  objection: "Objection", decision: "Decision", review_request: "Review request", review_result: "Review", status_update: "Status",
  artifact_created: "File", user_interjection: "You", final_report: "Final report", chat: "Chat", org: "Org change",
};
