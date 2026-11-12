/**
 * The spaces of a project. Each job has exactly one home, and the rail, the View menu, the Alt+number shortcuts,
 * quick open and the page title all read this list, so a space has the same name, icon and shortcut everywhere.
 */
import { Code2, GitCompare, History, MessageSquare, MessagesSquare, Network, type LucideIcon } from "lucide-react";

export interface Space { to: string; label: string; hint: string; icon: LucideIcon; key: string }

export const SPACES: readonly Space[] = [
  { to: "agent", label: "Conversation", hint: "Talk to the team lead and watch the team work", icon: MessageSquare, key: "1" },
  { to: "canvas", label: "Team", hint: "Hire agents, set their tools and connect them", icon: Network, key: "2" },
  { to: "chat", label: "Direct chats", hint: "Talk one-on-one with a single agent", icon: MessagesSquare, key: "3" },
  { to: "artifacts", label: "Changes", hint: "Review the files each conversation changed", icon: GitCompare, key: "4" },
  { to: "workspace", label: "Code", hint: "Edit files, run commands and preview the app", icon: Code2, key: "5" },
  { to: "runs", label: "History", hint: "Every conversation, with cost and outcome", icon: History, key: "6" },
];

/** The space a path belongs to: `/w/:wid/<space>/...`. */
export const spaceOf = (pathname: string) => SPACES.find((s) => pathname.split("/")[3] === s.to);
