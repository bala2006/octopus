import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import { api, unwrap } from "@/lib/api";
import { useApp } from "@/stores/app";

export function useWorkspaceId(): string {
  const { wid } = useParams();
  return wid ?? "";
}

export const qk = {
  workspaces: ["workspaces"] as const,
  workspace: (w: string) => ["workspace", w] as const,
  companies: (w: string) => ["companies", w] as const,
  canvas: (w: string, c: string) => ["canvas", w, c] as const,
  sessions: (w: string, c: string) => ["sessions", w, c] as const,
  messages: (w: string, s: string) => ["messages", w, s] as const,
  runs: (w: string, c?: string) => ["runs", w, c ?? "all"] as const,
  run: (w: string, r: string) => ["run", w, r] as const,
  artifacts: (w: string, r: string) => ["artifacts", w, r] as const,
  files: (w: string) => ["files", w] as const,
  settings: ["settings"] as const,
  mcp: ["mcp"] as const,
  memory: (w: string, a: string) => ["memory", w, a] as const,
};

export const useAuthConfig = () => useQuery({ queryKey: ["auth-config"], queryFn: () => unwrap(api.GET("/api/v1/auth/config")), staleTime: Infinity });
export const useWorkspaces = () => useQuery({ queryKey: qk.workspaces, queryFn: () => unwrap(api.GET("/api/v1/workspaces")) });
export const useWorkspace = (w: string) =>
  useQuery({ queryKey: qk.workspace(w), enabled: !!w, retry: false, queryFn: () => unwrap(api.GET("/api/v1/workspaces/{workspace_id}", { params: { path: { workspace_id: w } } })) });

export const useCompanies = (w: string) =>
  useQuery({ queryKey: qk.companies(w), enabled: !!w, queryFn: () => unwrap(api.GET("/api/v1/w/{workspace_id}/companies", { params: { path: { workspace_id: w } } })) });

/** Selected company for the workspace (falls back to the most recent one). */
export function useCompanyId(): { companyId: string; setCompanyId: (c: string) => void; loading: boolean } {
  const w = useWorkspaceId();
  const { data, isLoading } = useCompanies(w);
  const stored = useApp((s) => s.companyByWorkspace[w]);
  const setCompany = useApp((s) => s.setCompany);
  const exists = data?.some((c) => c.id === stored);
  const companyId = exists ? stored! : data?.[0]?.id ?? "";
  return { companyId, setCompanyId: (c) => setCompany(w, c), loading: isLoading };
}

export const useCanvas = (w: string, c: string) =>
  useQuery({
    queryKey: qk.canvas(w, c), enabled: !!w && !!c, staleTime: 0, refetchOnMount: "always",
    queryFn: () => unwrap(api.GET("/api/v1/w/{workspace_id}/companies/{company_id}", { params: { path: { workspace_id: w, company_id: c } } })),
  });

export const useTemplates = () => useQuery({ queryKey: ["templates"], staleTime: Infinity, queryFn: () => unwrap(api.GET("/api/v1/templates")) });
export const useRoleTemplates = () => useQuery({ queryKey: ["roles"], staleTime: Infinity, queryFn: () => unwrap(api.GET("/api/v1/templates/roles")) });

export const useSessions = (w: string, c: string) =>
  useQuery({ queryKey: qk.sessions(w, c), enabled: !!w && !!c, queryFn: () => unwrap(api.GET("/api/v1/w/{workspace_id}/sessions", { params: { path: { workspace_id: w }, query: { company_id: c } } })) });

export const useSessionMessages = (w: string, s: string) =>
  useQuery({ queryKey: qk.messages(w, s), enabled: !!w && !!s, queryFn: () => unwrap(api.GET("/api/v1/w/{workspace_id}/sessions/{session_id}/messages", { params: { path: { workspace_id: w, session_id: s } } })) });

export const useRuns = (w: string, c?: string, poll = false) =>
  useQuery({
    queryKey: qk.runs(w, c), enabled: !!w, refetchInterval: poll ? 3000 : false,
    queryFn: () => unwrap(api.GET("/api/v1/w/{workspace_id}/runs", { params: { path: { workspace_id: w }, query: c ? { company_id: c } : {} } })),
  });

export const useRun = (w: string, r: string) =>
  useQuery({ queryKey: qk.run(w, r), enabled: !!w && !!r, queryFn: () => unwrap(api.GET("/api/v1/w/{workspace_id}/runs/{run_id}", { params: { path: { workspace_id: w, run_id: r } } })) });

export const useArtifacts = (w: string, r: string) =>
  useQuery({
    queryKey: qk.artifacts(w, r), enabled: !!w && !!r,
    queryFn: () => unwrap(api.GET("/api/v1/w/{workspace_id}/runs/{run_id}/artifacts", { params: { path: { workspace_id: w, run_id: r }, query: { all_versions: true } } })),
  });

export const useProjectFiles = (w: string) =>
  useQuery({ queryKey: qk.files(w), enabled: !!w, queryFn: () => unwrap(api.GET("/api/v1/w/{workspace_id}/files", { params: { path: { workspace_id: w } } })) });

export const useSettings = () => useQuery({ queryKey: qk.settings, queryFn: () => unwrap(api.GET("/api/v1/settings")) });
export const useMcpServers = () => useQuery({ queryKey: qk.mcp, queryFn: () => unwrap(api.GET("/api/v1/mcp-servers")) });
