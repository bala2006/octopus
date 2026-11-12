import { create } from "zustand";
import { persist } from "zustand/middleware";

type Theme = "dark" | "light";

interface AppState {
  theme: Theme;
  /** last selected company per workspace */
  companyByWorkspace: Record<string, string>;
  chatFilter: "all" | "user" | "internal";
  /** getting-started checklist dismissed */
  onboarded: boolean;
  /** display currency for costs (ISO code); costs are stored in USD and converted with live rates */
  currency: string;
  setCurrency: (c: string) => void;
  setOnboarded: (v: boolean) => void;
  setTheme: (t: Theme) => void;
  toggleTheme: () => void;
  setCompany: (workspaceId: string, companyId: string) => void;
  setChatFilter: (f: AppState["chatFilter"]) => void;
}

function applyTheme(t: Theme): void {
  document.documentElement.classList.toggle("dark", t === "dark");
  try { localStorage.setItem("octopus-theme", t); } catch { /* ignore */ }
}

export const useApp = create<AppState>()(
  persist(
    (set, get) => ({
      theme: "dark",
      companyByWorkspace: {},
      chatFilter: "all",
      onboarded: false,
      currency: "USD",
      setCurrency: (c) => set({ currency: c.toUpperCase() }),
      setOnboarded: (v) => set({ onboarded: v }),
      setTheme: (t) => { applyTheme(t); set({ theme: t }); },
      toggleTheme: () => get().setTheme(get().theme === "dark" ? "light" : "dark"),
      setCompany: (w, c) => set({ companyByWorkspace: { ...get().companyByWorkspace, [w]: c } }),
      setChatFilter: (f) => set({ chatFilter: f }),
    }),
    { name: "octopus-app", onRehydrateStorage: () => (s) => s && applyTheme(s.theme) },
  ),
);
