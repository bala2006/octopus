import * as React from "react";
import { useStore } from "@xyflow/react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { BookOpenCheck, Crown, Flag, Maximize2, MessageSquare, PenLine, Plug, Power, Trash2, X } from "lucide-react";
import { useMcpServers, useRoleTemplates, useSettings, useSkills, useWorkspaceId } from "@/hooks/queries";
import { PERMISSIONS, TOOLS } from "@/lib/meta";
import { cn } from "@/lib/utils";
import { useCanvas, type AgentData } from "@/stores/canvas";
import type { AgentPermission, AgentTools } from "@/types";
import { AgentAvatar } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Field, Input, Switch } from "@/components/ui/primitives";
import { Select, Tip } from "@/components/ui/overlays";
import { Combobox } from "@/components/ui/combobox";
import { EFFORTS } from "./EffortPicker";
import { applyRole, EFFORT_OPTIONS, isLinked, presetOf, roleOptions, TOOL_PRESETS } from "./roleHelpers";

/**
 * Mini configuration window next to a clicked agent node. Everything except the name is picked from a list (role,
 * department, model, thinking, permission, tool preset); the role brings the prompt, which is edited in Settings → Roles
 * (or, for one agent, under All settings → Prompt).
 */
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
  const undo = useCanvas((s) => s.undo);
  const setInspector = useCanvas((s) => s.setInspector);
  const deleteNodes = useCanvas((s) => s.deleteNodes);
  const { data: mcp } = useMcpServers();
  const { data: roles = [] } = useRoleTemplates();
  const { data: settings } = useSettings();
  const w = useWorkspaceId();
  const nav = useNavigate();
  const [customTools, setCustomTools] = React.useState(false);
  const tools = (data.tools ?? {}) as AgentTools;
  const setTool = (key: string, v: boolean | string[]) => update(id, { tools: { ...tools, [key]: v } as AgentTools });
  const mcpIds = tools.mcp_servers ?? [];
  const nodes = useCanvas((s) => s.nodes);
  const deptList = React.useMemo(() => [...new Set(nodes.map((n) => n.data.department).filter(Boolean) as string[])].sort(), [nodes]);
  const managers = nodes.filter((n) => n.id !== id && (n.data.is_manager || n.data.is_entry));
  const behavior = (data.behavior ?? {}) as NonNullable<AgentData["behavior"]>;
  const roleKey = behavior.template_key ?? "";
  const role = roles.find((r) => r.key === roleKey);
  const linkedPrompt = isLinked(data, roles);
  const preset = presetOf(tools, role);
  const modelOptions = React.useMemo(() => (settings?.providers ?? []).flatMap((p) => p.models.map((m) => ({
    value: `${p.provider}::${m}`, label: m, group: p.label, hint: p.configured || p.provider === "mock" ? undefined : "not connected yet" }))), [settings]);
  const effProvider = data.provider === "mock" ? "mock" : "azure";
  const effModels = settings?.providers.find((p) => p.provider === effProvider)?.models ?? [];
  const modelValue = `${effProvider}::${effModels.includes(data.model ?? "") ? data.model : effModels[0] ?? data.model}`;

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const pickRole = (key: string) => {
    const r = roles.find((x) => x.key === key);
    if (!r || key === roleKey) return;
    update(id, applyRole(data, r), { history: true });
    toast.success(`${data.name || "Agent"} is now ${r.role}`, { description: "Its prompt, look and tools come from the role.", action: { label: "Undo", onClick: undo } });
  };
  const pickPreset = (v: string) => {
    if (v === "custom") { setCustomTools(true); return; }
    const base = v === "role" && role ? role.tools : TOOL_PRESETS.find((p) => p.value === v)?.tools;
    if (base) update(id, { tools: { ...tools, ...base, mcp_servers: mcpIds, manage_team: !!tools.manage_team } as AgentTools }, { history: true });
  };

  return (
    // `nopan`/`nodrag`/`nowheel`: React Flow's pan/zoom filter ignores gestures that start inside the panel (a pan starts on
    // pointerdown, so stopping `click` alone was too late). select-text: the canvas sets user-select: none, but labels must
    // stay selectable. (No React-level pointerdown stopPropagation: in React 18 that also stops the native event at the root,
    // which breaks Radix's outside-click handling for the selects in this panel.)
    <div ref={panelRef} className="nodrag nopan nowheel flex max-h-[calc(100dvh-5rem)] w-[320px] cursor-auto select-text flex-col overflow-hidden rounded-xl border border-border bg-popover shadow-2xl animate-in fade-in-0 slide-in-from-left-2 zoom-in-95 duration-150"
      role="dialog" aria-label={`Configure ${data.name}`} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <AgentAvatar name={data.name} color={data.color} avatar={data.avatar} size={24} />
        <span className="flex-1 truncate text-sm font-semibold">{data.name || "Agent"}</span>
        <Tip content="All settings"><Button variant="ghost" size="icon-sm" onClick={() => setInspector(id)} aria-label="Open full inspector"><Maximize2 /></Button></Tip>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close"><X /></Button>
      </div>

      <div data-qc-body className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain p-3">
        <Field label="Name"><Input value={data.name} onChange={(e) => update(id, { name: e.target.value })} className="h-8" autoFocus aria-label="Agent name" /></Field>

        <div className="space-y-1">
          <Field label="Role">
            <Combobox value={roleKey} options={roleOptions(roles)} onChange={pickRole} ariaLabel="Role" testId="role-picker"
              placeholder={data.role ? `${data.role} (pick a role)` : "Pick a role"} />
          </Field>
          <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
            {linkedPrompt ? (
              <><BookOpenCheck className="h-3 w-3 text-success" />Prompt from the role ·
                <Link to={`/w/${w}/settings#roles`} className="text-primary hover:underline">edit in Settings → Roles</Link></>
            ) : (
              <><PenLine className="h-3 w-3 text-warning" />Own prompt (All settings → Prompt)
                {role && <button className="ml-auto text-primary hover:underline" onClick={() => update(id, applyRole(data, role), { history: true })}>Use role prompt</button>}</>
            )}
          </div>
        </div>

        <div className="grid grid-cols-[1fr_auto] items-end gap-2">
          <Field label="Department">
            <Combobox value={(data.department as string) ?? ""} ariaLabel="Department" placeholder="No department"
              options={[{ value: "", label: "No department" }, ...deptList.map((d) => ({ value: d, label: d }))]}
              onChange={(v) => update(id, { department: v }, { history: true })} onCreate={(v) => update(id, { department: v }, { history: true })} createLabel="New department" />
          </Field>
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

        <div className="grid grid-cols-[1fr_108px] gap-2">
          <Field label="Model">
            <Combobox value={modelValue} options={modelOptions} ariaLabel="Model" className="font-mono text-xs"
              onChange={(v) => { const [p, m] = v.split("::"); update(id, { provider: p, model: m }, { history: true }); }} />
          </Field>
          <Field label="Thinking">
            <Select ariaLabel="Reasoning effort" value={(behavior.reasoning_effort ?? "default") as string} className="h-8 text-xs"
              onValueChange={(v) => update(id, { behavior: { ...behavior, reasoning_effort: v } as AgentData["behavior"] }, { history: true })}
              options={EFFORT_OPTIONS.map((e) => ({ value: e.value, label: e.label, hint: EFFORTS.find((x) => x.value === e.value)?.hint }))} />
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <Field label="Permission">
            <Select value={(data.permission_level as string) ?? "inherit"} onValueChange={(v) => update(id, { permission_level: v as AgentPermission }, { history: true })}
              options={[{ value: "inherit", label: "Inherit from run" }, ...Object.entries(PERMISSIONS).map(([k, p]) => ({ value: k, label: p.label }))]} className="h-8 text-xs" />
          </Field>
          <Field label="Receives the goal">
            <label className="flex h-8 items-center gap-2 rounded-md border border-border px-2 text-xs">
              <Switch checked={!!data.is_entry} onCheckedChange={(v) => update(id, { is_entry: v }, { history: true })} aria-label="Entry agent" />
              <Flag className="h-3 w-3 shrink-0 text-primary" /><span className="truncate">Entry</span>
            </label>
          </Field>
        </div>

        <AgentSkills id={id} behavior={behavior} roleKey={roleKey} />

        <div className="space-y-1.5">
          <Field label="Tools">
            <Select ariaLabel="Tool preset" value={customTools ? "custom" : preset} onValueChange={pickPreset} className="h-8 text-xs"
              options={[...(role ? [{ value: "role", label: `Role default (${role.role})` }] : []),
                ...TOOL_PRESETS.map((p) => ({ value: p.value, label: p.label, hint: p.hint })), { value: "custom", label: "Custom…" }]} />
          </Field>
          <div className="flex flex-wrap items-center gap-1">
            {TOOLS.filter((t) => (tools as Record<string, unknown>)[t.key]).map((t) => (
              <span key={t.key} className="flex items-center gap-1 rounded border border-border bg-muted/40 px-1.5 py-px text-[10.5px] text-muted-foreground"><t.icon className="h-3 w-3" />{t.label}</span>
            ))}
            <button className="ml-auto text-[11px] text-primary hover:underline" onClick={() => setCustomTools(!customTools)} aria-expanded={customTools}>{customTools ? "Done" : "Customize"}</button>
          </div>
          {customTools && (
            <div className="grid grid-cols-2 gap-1 animate-fade-up">
              {TOOLS.map((t) => {
                const on = !!(tools as Record<string, unknown>)[t.key];
                return (
                  <Tip key={t.key} content={t.hint}>
                    <button role="switch" aria-checked={on} onClick={() => setTool(t.key, !on)}
                      className={cn("flex items-center gap-1.5 rounded-md border px-2 py-1 text-left text-xs transition-all active:scale-[0.97]",
                        on ? "border-primary/50 bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:bg-accent/50")}>
                      <t.icon className={cn("h-3.5 w-3.5", on && (t.danger ? "text-warning" : "text-primary"))} />
                      <span className="flex-1 truncate">{t.label}</span>
                    </button>
                  </Tip>
                );
              })}
            </div>
          )}
          {!!mcp?.length && (
            <div className="flex flex-wrap items-center gap-1 pt-0.5">
              <Plug className="h-3 w-3 text-muted-foreground" />
              {mcp.map((srv) => {
                const on = mcpIds.includes(srv.id);
                return (
                  <button key={srv.id} role="switch" aria-checked={on} aria-label={`Grant ${srv.name}`} disabled={!srv.enabled}
                    onClick={() => setTool("mcp_servers", on ? mcpIds.filter((x) => x !== srv.id) : [...mcpIds, srv.id])}
                    className={cn("rounded-full border px-2 py-px text-[10.5px] transition", on ? "border-olive/50 bg-olive/10 text-olive" : "border-border text-muted-foreground hover:bg-accent/50", !srv.enabled && "opacity-50")}>
                    {srv.name}
                  </button>
                );
              })}
              <Link to={`/w/${w}/settings#mcp`} className="ml-auto text-[11px] text-primary hover:underline">Manage</Link>
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center gap-1 border-t border-border bg-surface px-2 py-1.5">
        <Button variant="ghost" size="xs" onClick={() => nav(`/w/${w}/chat?agent=${id}`)}><MessageSquare />Chat</Button>
        <Button variant="ghost" size="xs" onClick={() => setInspector(id)}><Maximize2 />All settings</Button>
        <Button variant="ghost" size="xs" className="ml-auto text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => deleteNodes([id])}><Trash2 />Delete</Button>
      </div>
    </div>
  );
}

/** The agent's skills: its role's (from the skill library) plus any picked for it; add from a list, remove picked ones. */
function AgentSkills({ id, behavior, roleKey }: { id: string; behavior: NonNullable<AgentData["behavior"]>; roleKey: string }) {
  const { data: skills = [] } = useSkills();
  const update = useCanvas((s) => s.updateAgent);
  const picked = (behavior.skills ?? []) as string[];
  const fromRole = skills.filter((s) => roleKey && (s.roles ?? []).includes(roleKey) && !picked.includes(s.name)).map((s) => s.name);
  const setPicked = (next: string[]) => update(id, { behavior: { ...behavior, skills: next } as AgentData["behavior"] }, { history: true });
  return (
    <Field label="Skills">
      <div className="flex flex-wrap items-center gap-1" data-testid="agent-skills">
        {fromRole.map((n) => <Tip key={n} content="From the role"><span className="rounded-full border border-border bg-muted/40 px-2 py-px font-mono text-[10.5px] text-muted-foreground">{n}</span></Tip>)}
        {picked.map((n) => (
          <button key={n} onClick={() => setPicked(picked.filter((x) => x !== n))} title="Remove"
            className="rounded-full border border-primary/40 bg-primary/10 px-2 py-px font-mono text-[10.5px] text-primary hover:border-destructive/50">{n} ×</button>
        ))}
        <div className="min-w-[120px] flex-1">
          <Combobox value="" placeholder="Add a skill" ariaLabel="Add a skill" className="h-6 border-dashed text-[11px]"
            options={skills.filter((s) => !picked.includes(s.name) && !fromRole.includes(s.name)).map((s) => ({ value: s.name, label: s.name, hint: s.description }))}
            onChange={(v) => setPicked([...picked, v])} />
        </div>
      </div>
    </Field>
  );
}
