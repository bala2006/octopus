import * as React from "react";
import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  UsersRound,
  ChevronsUpDown,
  Home,
  Pencil,
  Plus,
  Trash2,
  Check,
  Sparkles,
} from "lucide-react";
import {
  useCompanies,
  useCompanyId,
  useSettings,
  useWorkspace,
  useWorkspaceId,
  useRun,
  useRuns,
  qk,
} from "@/hooks/queries";
import { api, unwrap } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/primitives";
import {
  ConfirmDialog,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Tip,
} from "@/components/ui/overlays";
import { ErrorBoundary } from "@/components/common";
import { NewCompanyDialog } from "@/features/projects/NewCompanyDialog";
import { ProcessIndicator } from "./ProcessIndicator";
import { DesktopLayout } from "./DesktopLayout";
import { SPACES, spaceOf } from "./spaces";
import { threadKey, useWorkbenchStore } from "@/features/conversation/workbenchStore";

export function AppShell() {
  const w = useWorkspaceId();
  const ws = useWorkspace(w);
  const nav = useNavigate();
  const loc = useLocation();
  const segment = loc.pathname.split("/")[3];
  const space = spaceOf(loc.pathname);
  const title = space?.label ?? (segment === "guide" ? "Guide" : segment === "settings" ? "Settings" : "Project");
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      const item = SPACES.find((n) => n.key === e.key);
      if (item) {
        e.preventDefault();
        nav(`/w/${w}/${item.to}`);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [nav, w]);
  return (
    <DesktopLayout
      hideHeader={segment === "settings"}
      header={
        <>
          <div className="min-w-0 flex-1 truncate text-sm font-semibold">
            {space?.to === "agent" ? <ConversationTitle /> : title}
          </div>
          <div className="hidden sm:block">
            <TeamSwitcher />
          </div>
          <ProcessIndicator />
          <ModelStatus />
        </>
      }
    >
      {ws.isError ? (
        <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
          <p className="text-sm font-medium">This project could not be opened</p>
          <p className="max-w-md text-sm text-muted-foreground">{ws.error.message}</p>
          <Button asChild variant="outline">
            <Link to="/"><Home />Home</Link>
          </Button>
        </div>
      ) : (
        <ErrorBoundary label="This view crashed">
          <Outlet />
        </ErrorBoundary>
      )}
    </DesktopLayout>
  );
}

function ConversationTitle() {
  const w = useWorkspaceId();
  const { companyId } = useCompanyId();
  const { data: runs } = useRuns(w, companyId || undefined, true);
  const selected = useWorkbenchStore((store) => store.threads[threadKey(w, companyId)]);
  const id = companyId ? selected === undefined ? runs?.[0]?.id : selected : null;
  const { data: conversation } = useRun(w, id ?? "");
  const title = conversation?.goal.split("\n")[0]?.trim() || "New chat";
  return <span title={title}>{title}</span>;
}
/** Appears only when no model is connected, and links to the fix. A connected model needs no badge. */
function ModelStatus() {
  const { data } = useSettings();
  if (!data || data.providers.some((p) => p.configured)) return null;
  return (
    <Tip content="Agents can't work until you connect Azure OpenAI." side="bottom">
      <Link to="settings#providers" className="flex items-center gap-1.5 whitespace-nowrap rounded-full border border-primary/40 bg-primary/10 px-2.5 py-1 text-[11px] font-medium text-primary transition hover:bg-primary/20">
        <Sparkles className="h-3 w-3" />Connect a model
      </Link>
    </Tip>
  );
}

/** Which team works in this project. Create, rename and delete teams here. */
function TeamSwitcher() {
  const w = useWorkspaceId();
  const { data: companies, isLoading } = useCompanies(w);
  const { companyId, setCompanyId } = useCompanyId();
  const current = companies?.find((c) => c.id === companyId);
  const [creating, setCreating] = React.useState(false);
  const [renaming, setRenaming] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const [name, setName] = React.useState("");
  const qc = useQueryClient();
  const rename = useMutation({
    mutationFn: () =>
      unwrap(
        api.PATCH("/api/v1/w/{workspace_id}/companies/{company_id}", {
          params: { path: { workspace_id: w, company_id: companyId } },
          body: { name },
        }),
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.companies(w) });
      qc.invalidateQueries({ queryKey: qk.canvas(w, companyId) });
      setRenaming(false);
      toast.success("Team renamed");
    },
    onError: (e: Error) => toast.error("Could not rename the team", { description: e.message }),
  });
  const del = useMutation({
    mutationFn: () =>
      unwrap(
        api.DELETE("/api/v1/w/{workspace_id}/companies/{company_id}", {
          params: { path: { workspace_id: w, company_id: companyId } },
        }),
      ),
    onSuccess: () => {
      const next = companies?.find((c) => c.id !== companyId);
      if (next) setCompanyId(next.id);
      qc.invalidateQueries({ queryKey: qk.companies(w) });
      toast.success(`Deleted ${current?.name}`);
    },
    onError: (e: Error) => toast.error(e.message),
  });
  if (isLoading) return <span className="skeleton h-4 w-28" />;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className="flex max-w-[220px] items-center gap-1.5 rounded-md px-2 py-1 text-sm transition hover:bg-accent"
            aria-label="Switch team"
            data-testid="company-switcher"
          >
            <UsersRound className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="truncate font-medium">
              {current?.name ?? "No team"}
            </span>
            <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuLabel>Teams in this project</DropdownMenuLabel>
          {companies?.map((c) => (
            <DropdownMenuItem key={c.id} onSelect={() => setCompanyId(c.id)}>
              <UsersRound />
              <span className="flex-1 truncate">{c.name}</span>
              <span className="text-[10px] text-muted-foreground">
                {c.agent_count}
              </span>
              {c.id === companyId && <Check className="!text-primary" />}
            </DropdownMenuItem>
          ))}
          {!!companies?.length && <DropdownMenuSeparator />}
          <DropdownMenuItem onSelect={() => setCreating(true)}>
            <Plus />
            New team…
          </DropdownMenuItem>
          {current && (
            <DropdownMenuItem
              onSelect={() => {
                setName(current.name);
                setRenaming(true);
              }}
            >
              <Pencil />
              Rename
            </DropdownMenuItem>
          )}
          {current && (
            <DropdownMenuItem destructive onSelect={() => setDeleting(true)}>
              <Trash2 />
              Delete team
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <NewCompanyDialog open={creating} onOpenChange={setCreating} />
      <Dialog open={renaming} onOpenChange={setRenaming}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Rename team</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim()) rename.mutate();
            }}
            className="space-y-3"
          >
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <div className="flex justify-end">
              <Button type="submit" loading={rename.isPending}>
                Save
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete ${current?.name}?`}
        destructive
        confirmLabel="Delete"
        description="Removes this team\u2019s agents and conversations from .octopus. Files in your project are not touched."
        onConfirm={() => del.mutate()}
      />
    </>
  );
}
