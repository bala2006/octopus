import * as React from "react";
import { useNavigate } from "react-router-dom";
import { create } from "zustand";
import { useApp } from "@/stores/app";
import { threadKey, useWorkbenchStore } from "./workbenchStore";

/** Bumped whenever a conversation is opened on purpose, so the chat window opens up to show it. */
export const useChatFocus = create<{ token: number; bump: () => void }>()((set, get) => ({ token: 0, bump: () => set({ token: get().token + 1 }) }));

/**
 * Every conversation opens in one place: the Conversation space, with its team selected. Recents, History, the
 * team status pill and old `/runs/:id` links all go through this.
 */
export function useOpenConversation() {
  const navigate = useNavigate();
  const selectThread = useWorkbenchStore((s) => s.selectThread);
  const setCompany = useApp((s) => s.setCompany);
  return React.useCallback((w: string, run: { id: string; company_id?: string | null } | null, companyId?: string, replace = false) => {
    const company = run?.company_id || companyId || "";
    if (company) setCompany(w, company);
    selectThread(threadKey(w, company), run ? run.id : null);
    useChatFocus.getState().bump();
    navigate(`/w/${w}/agent`, { replace });
  }, [navigate, selectThread, setCompany]);
}
