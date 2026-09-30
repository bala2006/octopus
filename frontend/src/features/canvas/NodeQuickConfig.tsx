import * as React from "react";
import { useStore } from "@xyflow/react";
import { Link, useNavigate } from "react-router-dom";
import { Braces, Crown, Flag, Maximize2, MessageSquare, Plug, Plus, Power, Trash2, X } from "lucide-react";
import { useMcpServers, useWorkspaceId } from "@/hooks/queries";
import { PERMISSIONS, TOOLS } from "@/lib/meta";
import { cn } from "@/lib/utils";
import { useCanvas, type AgentData } from "@/stores/canvas";
import type { AgentPermission, AgentTools } from "@/types";
import { AgentAvatar } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Field, Input, Switch, Textarea } from "@/components/ui/primitives";
import { Select, Tip } from "@/components/ui/overlays";
import { ModelPicker } from "./ModelPicker";
import { EffortPicker, type Effort } from "./EffortPicker";

const VARS = ["{{company_name}}", "{{goal}}", "{{team}}", "{{agent_name}}", "{{role}}", "{{department}}", "{{manager}}", "{{reports}}"];

/** Mini configuration window rendered to the right of a clicked agent node. */
export function NodeQuickConfig({ id, data, onClose }: { id: string; data: AgentData; onClose: () => void }) {
  // The panel hangs next to its node, so it can start low on screen: fit it into the space left below its top edge.
  const panelRef = React.useRef<HTMLDivElement>(null);
  const transform = useStore((st) => st.transform);
  React.useLayoutEffect(() => {
    const fit = () => {
      const el = panelRef.current;
      if (!el) return;
      // the toolbar is aligned to the node's top edge, so measure from the node (independent of our own shift)
      const node = document.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(id)}"]`);
      const top = node ? node.getBoundingClientRect().top : el.getBoundingClientRect().top + (Number(el.dataset.shift) || 0);
      const body = el.querySelector<HTMLElement>("[data-qc-body]");
      const natural = el.offsetHeight - (body?.clientHeight ?? 0) + (body?.scrollHeight ?? 0);
      const flow = el.closest(".react-flow")?.getBoundingClientRect();
      const vh = Math.min(window.innerHeight, flow?.bottom ?? window.innerHeight), margin = 12;
      const minTop = (flow?.top ?? 48) + 52; // stay below the canvas toolbar
      const below = vh - top - margin;
      // shift up (not past the header) when the panel would run off the bottom, then cap the height and scroll inside
      const shift = natural > below ? Math.min(natural - below, Math.max(0, top - minTop)) : 0;
      // applied directly (not via state) so the measured position and the applied shift always agree
      el.dataset.shift = String(shift);
      el.style.marginTop = shift ? `-${shift}px` : ""; // margin, not transform: the enter animation owns `transform`
      el.style.maxHeight = `${Math.max(200, below + shift)}px`;
    };
    fit();
    const raf = requestAnimationFrame(fit);
    window.addEventListener("resize", fit);
    // React Flow positions the toolbar after mount and on pan/zoom: re-fit whenever its position changes
    const toolbar = panelRef.current?.closest(".react-flow__node-toolbar");
    const mo = toolbar ? new MutationObserver(fit) : null;
    if (toolbar && mo) mo.observe(toolbar, { attributes: true, attributeFilter: ["style"] });
    return () => { cancelAnimationFrame(raf); window.removeEventListener("resize", fit); mo?.disconnect(); };
  }, [transform]);
  const update = useCanvas((s) => s.updateAgent);
  const setInspector = useCanvas((s) => s.setInspector);
  const deleteNodes = useCanvas((s) => s.deleteNodes);
  const { data: mcp } = useMcpServers();
  const w = useWorkspaceId();
  const nav = useNavigate();
  const promptRef = React.useRef<HTMLTextAreaElement>(null);
  const tools = (data.tools ?? {}) as AgentTools;
  const setTool = (key: string, v: boolean | string[]) => update(id, { tools: { ...tools, [key]: v } as AgentTools });
  const mcpIds = tools.mcp_servers ?? [];
  const nodes = useCanvas((s) => s.nodes);
  const deptList = React.useMemo(() => [...new Set(nodes.map((n) => n.data.department).filter(Boolean) as string[])].sort(), [nodes]);
  const managers = nodes.filter((n) => n.id !== id && (n.data.is_manager || n.data.is_entry));
  const deptId = React.useId();

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const insertVar = (v: string) => {
    const el = promptRef.current;
    const text = data.system_prompt ?? "";
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    update(id, { system_prompt: text.slice(0, start) + v + text.slice(end) });
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(start + v.length, start + v.length); });
  };

  return (
    <div ref={panelRef} className="flex max-h-[calc(100dvh-5rem)] w-[340px] flex-col overflow-hidden rounded-xl border border-border bg-popover shadow-2xl animate-in fade-in-0 slide-in-from-left-2 zoom-in-95 duration-150"
      role="dialog" aria-label={`Configure ${data.name}`} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <AgentAvatar name={data.name} color={data.color} avatar={data.avatar} size={24} />
        <span className="flex-1 truncate text-sm font-semibold">{data.name || "Agent"}</span>
        <Tip content="Open full inspector"><Button variant="ghost" size="icon-sm" onClick={() => setInspector(id)} aria-label="Open full inspector"><Maximize2 /></Button></Tip>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close"><X /></Button>
      </div>

      <div data-qc-body className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain p-3">
        <div className="grid grid-cols-2 gap-2">
          <Field label="Agent name"><Input value={data.name} onChange={(e) => update(id, { name: e.target.value })} className="h-8" autoFocus /></Field>
          <Field label="Agent role"><Input value={data.role ?? ""} onChange={(e) => update(id, { role: e.target.value })} className="h-8" placeholder="e.g. QA Engineer" /></Field>
        </div>

        <div className="grid grid-cols-[1fr_auto] items-end gap-2">
          <Field label="Department">
            <Input list={deptId} value={(data.department as string) ?? ""} onChange={(e) => update(id, { department: e.target.value })} className="h-8" placeholder="e.g. Engineering" />
          </Field>
          <datalist id={deptId}>{deptList.map((d) => <option key={d} value={d} />)}</datalist>
          <Tip content="Managers lead a department: they delegate, review, and (with Manage team) hire">
            <button role="switch" aria-checked={!!data.is_manager} aria-label="Department manager"
              onClick={() => update(id, { is_manager: !data.is_manager, tools: { ...tools, manage_team: !data.is_manager ? true : tools.manage_team } as AgentTools }, { history: true })}
              className={cn("flex h-8 items-center gap-1 rounded-md border px-2 text-xs transition active:scale-95", data.is_manager ? "border-terracotta/50 bg-terracotta/10 text-terracotta" : "border-border text-muted-foreground hover:bg-accent/50")}>
              <Crown className="h-3.5 w-3.5" />Manager
            </button>
          </Tip>
        </div>
        <div className="grid grid-cols-[1fr_auto] items-end gap-2">
          <Field label="Reports to">
            <Select value={(data.reports_to as string) ?? "none"} onValueChange={(v) => update(id, { reports_to: v === "none" ? null : v }, { history: true })}
              options={[{ value: "none", label: "Nobody (top level)" }, ...managers.map((m) => ({ value: m.id, label: m.data.name, hint: m.data.department || m.data.role }))]} className="h-8 text-xs" />
          </Field>
          <Tip content={data.active === false ? "Inactive: never takes turns or receives messages" : "Active"}>
            <button role="switch" aria-checked={data.active !== false} aria-label="Active"
              onClick={() => update(id, { active: data.active === false }, { history: true })}
              className={cn("flex h-8 items-center gap-1 rounded-md border px-2 text-xs transition active:scale-95", data.active !== false ? "border-success/40 bg-success/10 text-success" : "border-border text-muted-foreground")}>
              <Power className="h-3.5 w-3.5" />{data.active !== false ? "Active" : "Inactive"}
            </button>
          </Tip>
        </div>

        <Field label="System prompt">
          <Textarea ref={promptRef} value={data.system_prompt ?? ""} onChange={(e) => update(id, { system_prompt: e.target.value })}
            className="min-h-[110px] resize-y font-mono text-[11px] leading-relaxed" placeholder="You are … Your responsibilities are …" />
          <div className="flex flex-wrap items-center gap-1 pt-1">
            <Braces className="h-3 w-3 text-muted-foreground" />
            {VARS.map((v) => (
              <button key={v} onClick={() => insertVar(v)} className="rounded border border-border px-1.5 py-px font-mono text-[10px] text-muted-foreground transition hover:border-primary/50 hover:text-primary">{v}</button>
            ))}
          </div>
        </Field>

        <div className="space-y-1.5">
          <div className="text-xs font-medium text-muted-foreground">Tools</div>
          <div className="grid grid-cols-2 gap-1">
            {TOOLS.map((t) => {
              const on = !!(tools as Record<string, unknown>)[t.key];
              return (
                <Tip key={t.key} content={t.hint}>
                  <button role="switch" aria-checked={on} onClick={() => setTool(t.key, !on)}
                    className={cn("flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-left text-xs transition-all active:scale-[0.97]",
                      on ? "border-primary/50 bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:bg-accent/50")}>
                    <t.icon className={cn("h-3.5 w-3.5", on && (t.danger ? "text-warning" : "text-primary"))} />
                    <span className="flex-1 truncate">{t.label}</span>
                    <span className={cn("h-1.5 w-1.5 rounded-full transition-colors", on ? "bg-primary" : "bg-muted-foreground/30")} />
                  </button>
                </Tip>
              );
            })}
          </div>
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs font-medium text-muted-foreground">
            <span className="flex items-center gap-1"><Plug className="h-3 w-3" />MCP servers</span>
            <Link to={`/w/${w}/settings#mcp`} className="flex items-center gap-0.5 text-[11px] text-primary hover:underline"><Plus className="h-3 w-3" />Manage</Link>
          </div>
          {!mcp?.length ? (
            <p className="rounded-md border border-dashed border-border p-2 text-[11px] text-muted-foreground">No MCP servers registered yet. Add one in Settings to grant this agent external tools.</p>
          ) : (
            <div className="space-y-1">
              {mcp.map((s) => {
                const on = mcpIds.includes(s.id);
                return (
                  <label key={s.id} className={cn("flex cursor-pointer items-center gap-2 rounded-md border px-2 py-1.5 text-xs transition", on ? "border-olive/40 bg-olive/5" : "border-border hover:bg-accent/40", !s.enabled && "opacity-50")}>
                    <Switch checked={on} disabled={!s.enabled} onCheckedChange={(v) => setTool("mcp_servers", v ? [...mcpIds, s.id] : mcpIds.filter((x) => x !== s.id))} aria-label={`Grant ${s.name}`} />
                    <span className="flex-1 truncate font-medium">{s.name}</span>
                    <span className={cn("text-[10px]", s.last_error ? "text-destructive" : "text-muted-foreground")}>{s.last_error ? "error" : `${(s.tools ?? []).length} tools`}</span>
                  </label>
                );
              })}
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 gap-2">
          <Field label="Permission">
            <Select value={(data.permission_level as string) ?? "inherit"} onValueChange={(v) => update(id, { permission_level: v as AgentPermission }, { history: true })}
              options={[{ value: "inherit", label: "Inherit from run" }, ...Object.entries(PERMISSIONS).map(([k, p]) => ({ value: k, label: p.label }))]} className="h-8 text-xs" />
          </Field>
          <Field label="Entry agent">
            <label className="flex h-8 items-center gap-2 rounded-md border border-border px-2 text-xs">
              <Switch checked={!!data.is_entry} onCheckedChange={(v) => update(id, { is_entry: v }, { history: true })} aria-label="Entry agent" />
              <Flag className="h-3 w-3 text-primary" />Receives goal
            </label>
          </Field>
        </div>
        <Field label="Model"><ModelPicker provider={data.provider ?? "mock"} model={data.model ?? ""} onChange={(p, m) => update(id, { provider: p, model: m })} compact /></Field>
        <Field label="Reasoning effort" hint="Higher = deeper thinking, more tokens and time">
          <EffortPicker compact value={((data.behavior as { reasoning_effort?: Effort } | undefined)?.reasoning_effort ?? "default") as Effort}
            onChange={(v) => update(id, { behavior: { ...(data.behavior ?? {}), reasoning_effort: v } as AgentData["behavior"] })} />
        </Field>
      </div>

      <div className="flex items-center gap-1 border-t border-border bg-surface px-2 py-1.5">
        <Button variant="ghost" size="xs" onClick={() => nav(`/w/${w}/chat?agent=${id}`)}><MessageSquare />Chat</Button>
        <Button variant="ghost" size="xs" onClick={() => setInspector(id)}><Maximize2 />All settings</Button>
        <Button variant="ghost" size="xs" className="ml-auto text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => deleteNodes([id])}><Trash2 />Delete</Button>
      </div>
    </div>
  );
}
