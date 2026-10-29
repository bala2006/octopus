import * as React from "react";
import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Building2,
  ChevronsUpDown,
  FolderOpen,
  Home,
  Pencil,
  Plus,
  Trash2,
  Check,
  Radio,
  Sparkles,
  CircleCheck,
} from "lucide-react";
import {
  useCompanies,
  useCompanyId,
  useRuns,
  useSettings,
  useWorkspace,
  useWorkspaceId,
  qk,
} from "@/hooks/queries";
import { api, unwrap } from "@/lib/api";
import { cn } from "@/lib/utils";
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
import { NewCompanyDialog } from "@/features/workspaces/NewCompanyDialog";
import { CommandPalette } from "./CommandPalette";
import { ProcessIndicator } from "./ProcessIndicator";
import { DesktopLayout } from "./DesktopLayout";

const VIEWS = [
  { to: "agent", label: "Conversation", shortcut: "0" },
  { to: "workspace", label: "Workspace", shortcut: "7" },
  { to: "canvas", label: "Team canvas", shortcut: "1" },
  { to: "chat", label: "Agent chats", shortcut: "2" },
  { to: "runs", label: "Activity", shortcut: "3" },
  { to: "artifacts", label: "Changes", shortcut: "4" },
  { to: "settings", label: "Settings", shortcut: "5" },
  { to: "guide", label: "Guide", shortcut: "6" },
];

export function AppShell() {
  const w = useWorkspaceId();
  const ws = useWorkspace(w);
  const nav = useNavigate();
  const loc = useLocation();
  const view = VIEWS.find((item) => loc.pathname.split("/")[3] === item.to);
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey) return;
      const item = VIEWS.find((n) => n.shortcut === e.key);
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
      header={
        <>
          <FolderOpen className="hidden h-4 w-4 shrink-0 text-muted-foreground sm:block" />
          <div className="min-w-0 flex-1 truncate text-[13px] font-medium">
            {ws.data?.name ?? "Opening project"}
            <span className="mx-2 text-muted-foreground/40">/</span>
            <span className="text-muted-foreground">
              {view?.label ?? "Project"}
            </span>
          </div>
          <div className="hidden sm:block">
            <CompanySwitcher />
          </div>
          <LiveRunsIndicator />
          <ProcessIndicator />
          <div className="hidden lg:block">
            <ModelStatus />
          </div>
          <CommandPalette />
        </>
      }
    >
      {ws.isError ? (
        <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
          <p className="text-sm font-medium">
            This project could not be opened
          </p>
          <p className="max-w-md text-sm text-muted-foreground">
            {ws.error.message}
          </p>
          <Button asChild variant="outline">
            <Link to="/">
              <Home />
              All projects
            </Link>
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
/** One glance: are agents using a real model, or the offline demo? Click → Settings → Model. */
function ModelStatus() {
  const { data } = useSettings();
  if (!data) return null;
  const ready = data.providers.filter(
    (p) => p.provider !== "mock" && p.configured,
  );
  return (
    <Tip
      content={
        ready.length
          ? `Connected: ${ready.map((p) => p.label).join(", ")}`
          : "No model connected. Agents use the offline demo. Click to connect Azure OpenAI or another provider."
      }
      side="bottom"
    >
      <Link
        to="settings#providers"
        className={cn(
          "hidden items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-[11px] font-medium transition hover:bg-accent sm:flex",
          ready.length
            ? "border-success/40 text-success"
            : "border-primary/40 bg-primary/10 text-primary",
        )}
      >
        {ready.length ? (
          <CircleCheck className="h-3 w-3" />
        ) : (
          <Sparkles className="h-3 w-3" />
        )}
        {ready.length ? (
          ready[0].label
        ) : (
          <>
            Demo mode
            <span className="hidden 2xl:inline">&nbsp;· connect a model</span>
          </>
        )}
      </Link>
    </Tip>
  );
}

function CompanySwitcher() {
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
      toast.success("Renamed");
    },
  });
  const del = useMutation({
    mutationFn: () =>
      unwrap(
        api.DELETE("/api/v1/w/{workspace_id}/companies/{company_id}", {
          params: { path: { workspace_id: w, company_id: companyId } },
        }),
      ),
    onSuccess: () => {
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
            aria-label="Switch company"
            data-testid="company-switcher"
          >
            <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="truncate font-medium">
              {current?.name ?? "No company"}
            </span>
            <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuLabel>Companies in this project</DropdownMenuLabel>
          {companies?.map((c) => (
            <DropdownMenuItem key={c.id} onSelect={() => setCompanyId(c.id)}>
              <Building2 />
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
            New company…
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
              Delete company
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <NewCompanyDialog open={creating} onOpenChange={setCreating} />
      <Dialog open={renaming} onOpenChange={setRenaming}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Rename company</DialogTitle>
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
        description="All agents, channels, chats and run history of this company will be removed from .octopus. Files in your project are not touched."
        onConfirm={() => del.mutate()}
      />
    </>
  );
}

function LiveRunsIndicator() {
  const w = useWorkspaceId();
  const { data } = useRuns(w, undefined, true);
  const live =
    data?.filter((r) =>
      ["running", "paused", "awaiting_user", "queued"].includes(r.status),
    ) ?? [];
  if (!live.length) return null;
  const needsYou = live.some((r) => r.status === "awaiting_user");
  const first = live.find((r) => r.status === "awaiting_user") ?? live[0];
  return (
    <Tip
      content={
        needsYou ? "A run is waiting for you" : `${live.length} live run(s)`
      }
      side="bottom"
    >
      <Link
        to={`/w/${w}/runs/${first.id}`}
        className={cn(
          "flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-[11px] font-medium transition hover:bg-accent",
          needsYou
            ? "border-warning/50 bg-warning/10 text-warning"
            : "border-primary/40 bg-primary/10 text-primary",
        )}
      >
        <Radio className={cn("h-3 w-3", !needsYou && "animate-pulse")} />
        {needsYou ? "Needs you" : `${live.length} live`}
      </Link>
    </Tip>
  );
}
