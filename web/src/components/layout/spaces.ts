/**
 * The spaces of a project. Each job has exactly one home, and the View menu, the Alt+number shortcuts, quick open,
 * the sidebar and the page title all read this list, so a space has the same name, icon and shortcut everywhere.
 * `rail` picks the spaces that also get an icon on the left rail.
 */
import { GitCompare, History, MessageSquare, type LucideIcon } from "lucide-react";

export interface Space { to: string; label: string; hint: string; icon: LucideIcon; key: string; rail: boolean }

export const SPACES: readonly Space[] = [
  { to: "agent", label: "Chats", hint: "Talk to the team lead, watch the team work and design the team on the canvas", icon: MessageSquare, key: "1", rail: true },
  { to: "artifacts", label: "Changes", hint: "Review the files each conversation changed", icon: GitCompare, key: "4", rail: false },
  { to: "runs", label: "History", hint: "Every conversation, with cost and outcome", icon: History, key: "6", rail: false },
];

/** The space a path belongs to: `/w/:wid/<space>/...`. */
export const spaceOf = (pathname: string) => SPACES.find((s) => pathname.split("/")[3] === s.to);
