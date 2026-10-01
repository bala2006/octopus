import * as React from "react";

/** Live run overlay consumed by canvas nodes/edges (empty in edit mode). */
export interface LiveOverlay {
  status: Record<string, string>;
  activity: Record<string, string>;
  lastMessage: Record<string, { text: string; type: string; to?: string }>;
  streaming: Record<string, string>;
  thinking?: Record<string, string>;
  activeEdges: Record<string, { at: number; from: string; type: string }>;
  tokens: Record<string, number>;
  pendingApprovalAgent?: string | null;
  departments?: Record<string, { color: string }>;
  names?: Record<string, string>;
  fresh?: Record<string, boolean>; // agents hired moments ago (entrance animation)
}

export const LiveContext = React.createContext<LiveOverlay | null>(null);
export const EditableContext = React.createContext<boolean>(true);
export const useLive = () => React.useContext(LiveContext);
export const useEditable = () => React.useContext(EditableContext);
