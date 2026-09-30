import * as React from "react";
import { Link, useParams } from "react-router-dom";
import {
  ArrowLeft, ArrowRight, BookOpen, Building2, Cloud, Crown, FileCode2, FolderOpen, History, Keyboard, LayoutTemplate, MessagesSquare, Network,
  Play, Plug, Settings2, ShieldCheck, Sparkles, type LucideIcon,
} from "lucide-react";
import { EDGE_TYPES, PERMISSIONS } from "@/lib/meta";
import { cn } from "@/lib/utils";
import { useApp } from "@/stores/app";
import type { EdgeType, PermissionLevel } from "@/types";

interface Section { id: string; title: string; icon: LucideIcon; body: React.ReactNode }

/** Plain-language tour of every feature, with screenshots and small diagrams. Works inside and outside a project. */
export default function GuidePage() {
  const { wid } = useParams();
  const base = wid ? `/w/${wid}` : null;
  const [active, setActive] = React.useState(SECTIONS[0].id);
  const scroller = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const root = scroller.current;
    if (!root) return;
    const obs = new IntersectionObserver((entries) => {
      const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (visible) setActive(visible.target.id);
    }, { root, rootMargin: "0px 0px -65% 0px" });
    root.querySelectorAll("section[id]").forEach((el) => obs.observe(el));
    return () => obs.disconnect();
  }, []);
  const go = (id: string) => scroller.current?.querySelector(`#${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });

  return (
    <div className="flex h-full flex-col">
      {!base && (
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-surface px-3">
          <Link to="/" className="flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"><ArrowLeft className="h-4 w-4" />Projects</Link>
        </header>
      )}
      <div className="flex min-h-0 flex-1">
        <nav className="hidden w-60 shrink-0 overflow-y-auto border-r border-border bg-surface p-3 md:block" aria-label="Guide sections">
          <div className="mb-2 flex items-center gap-2 px-2 pt-1 text-sm font-semibold"><BookOpen className="h-4 w-4 text-primary" />Guide</div>
          {SECTIONS.map((s, i) => (
            <button key={s.id} onClick={() => go(s.id)}
              className={cn("flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] text-muted-foreground transition hover:bg-accent hover:text-foreground",
                active === s.id && "bg-accent font-medium text-foreground")}>
              <span className="w-4 text-right font-mono text-[10px] opacity-60">{i + 1}</span><s.icon className="h-3.5 w-3.5 shrink-0" />{s.title}
            </button>
          ))}
        </nav>
        <div ref={scroller} className="min-w-0 flex-1 overflow-y-auto">
          <article className="mx-auto max-w-3xl space-y-14 px-6 py-10">
            <div className="space-y-3">
              <p className="text-xs font-semibold uppercase tracking-widest text-terracotta">Octopus guide</p>
              <h1 className="text-3xl font-semibold tracking-tight">Everything in five minutes</h1>
              <p className="text-[15px] leading-relaxed text-muted-foreground">
                Octopus lets you run a small company made of AI agents. You pick a folder, choose a team, and give it a goal. The agents split the work,
                talk to each other, and write real files in your folder, while you watch and approve the risky parts.
              </p>
              {base && (
                <Link to={`${base}/canvas`} className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline">Back to the canvas<ArrowRight className="h-3.5 w-3.5" /></Link>
              )}
            </div>
            {SECTIONS.map((s, i) => (
              <section key={s.id} id={s.id} className="scroll-mt-6 space-y-4">
                <div className="flex items-center gap-3">
                  <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10 text-primary"><s.icon className="h-4 w-4" /></span>
                  <div>
                    <div className="font-mono text-[10px] text-muted-foreground">STEP {String(i + 1).padStart(2, "0")}</div>
                    <h2 className="text-xl font-semibold tracking-tight">{s.title}</h2>
                  </div>
                </div>
                <div className="space-y-4 text-[14.5px] leading-relaxed text-muted-foreground [&_b]:font-semibold [&_b]:text-foreground">{s.body}</div>
              </section>
            ))}
            <p className="border-t border-border pt-6 text-center text-xs text-muted-foreground">That's everything. Hover any button in the app for a short hint.</p>
          </article>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ visuals
function Shot({ name, alt, caption }: { name: string; alt: string; caption?: string }) {
  const theme = useApp((s) => s.theme);
  const [failed, setFailed] = React.useState(false);
  if (failed) return null;
  return (
    <figure className="space-y-2">
      <img src={`/guide/${name}-${theme}.jpg`} alt={alt} loading="lazy" onError={() => setFailed(true)}
        className="w-full rounded-xl border border-border shadow-sm" />
      {caption && <figcaption className="text-center text-xs text-muted-foreground">{caption}</figcaption>}
    </figure>
  );
}

function Panel({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("rounded-2xl border border-border bg-teal/25 p-5", className)}>{children}</div>;
}

function Tips({ items }: { items: React.ReactNode[] }) {
  return (
    <ul className="space-y-1.5">
      {items.map((t, i) => (
        <li key={i} className="flex gap-2"><span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-terracotta" /><span>{t}</span></li>
      ))}
    </ul>
  );
}

function FlowDiagram() {
  const steps = [
    { icon: FolderOpen, t: "Folder", d: "where work happens" },
    { icon: Network, t: "Team", d: "agents + channels" },
    { icon: Play, t: "Goal", d: "what to build" },
    { icon: FileCode2, t: "Results", d: "files + report" },
  ];
  return (
    <Panel>
      <div className="flex flex-wrap items-center justify-center gap-2">
        {steps.map((s, i) => (
          <React.Fragment key={s.t}>
            <div className="flex w-28 flex-col items-center gap-1.5 rounded-xl border border-border bg-card p-3 text-center shadow-sm">
              <s.icon className="h-5 w-5 text-terracotta" />
              <div className="text-sm font-semibold text-foreground">{s.t}</div>
              <div className="text-[11px] leading-tight text-muted-foreground">{s.d}</div>
            </div>
            {i < steps.length - 1 && <ArrowRight className="h-4 w-4 text-muted-foreground" />}
          </React.Fragment>
        ))}
      </div>
    </Panel>
  );
}

function MiniCard({ name, role, color, x, y, manager }: { name: string; role: string; color: string; x: number; y: number; manager?: boolean }) {
  return (
    <g transform={`translate(${x},${y})`}>
      <rect width="120" height="44" rx="9" fill="hsl(var(--card))" stroke="hsl(var(--border))" />
      <rect width="120" height="3" rx="1.5" fill={color} />
      <circle cx="18" cy="24" r="9" fill={color} opacity="0.85" />
      <text x="33" y="22" fontSize="11" fontWeight="600" fill="hsl(var(--foreground))">{name}{manager ? " ♛" : ""}</text>
      <text x="33" y="35" fontSize="9" fill="hsl(var(--muted-foreground))">{role}</text>
    </g>
  );
}

/** Mirrors the canvas routing rules: higher agent's bottom › lower agent's top; peers side to side. */
function OrgDiagram() {
  const d = EDGE_TYPES.delegate.color, r = EDGE_TYPES.report.color, c = EDGE_TYPES.consult.color;
  return (
    <Panel className="p-3">
      <svg viewBox="0 0 520 230" className="w-full" role="img" aria-label="Org chart: the CEO delegates to two managers, who delegate to their teams and consult each other">
        <defs>
          {[["d", d], ["r", r], ["c", c]].map(([k, col]) => (
            <marker key={k} id={`g-${k}`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill={col} /></marker>
          ))}
        </defs>
        <path d="M252 56 C252 80, 125 70, 125 96" fill="none" stroke={d} strokeWidth="1.8" markerEnd="url(#g-d)" />
        <path d="M268 56 C268 80, 395 70, 395 96" fill="none" stroke={d} strokeWidth="1.8" markerEnd="url(#g-d)" />
        <path d="M140 96 C140 76, 260 84, 260 58" fill="none" stroke={r} strokeWidth="1.5" strokeDasharray="8 4" markerEnd="url(#g-r)" />
        <path d="M185 118 L335 118" fill="none" stroke={c} strokeWidth="1.8" strokeDasharray="1 4" strokeLinecap="round" markerEnd="url(#g-c)" markerStart="url(#g-c)" />
        <path d="M110 140 C110 160, 60 150, 60 176" fill="none" stroke={d} strokeWidth="1.8" markerEnd="url(#g-d)" />
        <path d="M130 140 C130 160, 190 150, 190 176" fill="none" stroke={d} strokeWidth="1.8" markerEnd="url(#g-d)" />
        <path d="M395 140 L395 176" fill="none" stroke={d} strokeWidth="1.8" markerEnd="url(#g-d)" />
        <MiniCard name="Ava" role="CEO · entry" color="#D97756" x={200} y={12} manager />
        <MiniCard name="Omar" role="Eng. manager" color="#66839A" x={65} y={96} manager />
        <MiniCard name="Lucia" role="Marketing lead" color="#6B8440" x={335} y={96} manager />
        <MiniCard name="Ana" role="Frontend" color="#66839A" x={0} y={178} />
        <MiniCard name="Leo" role="Backend" color="#66839A" x={130} y={178} />
        <MiniCard name="Zoe" role="Writer" color="#6B8440" x={335} y={178} />
      </svg>
      <div className="flex flex-wrap justify-center gap-4 pb-1 text-[11px]">
        <span className="flex items-center gap-1.5"><span className="h-0.5 w-5" style={{ background: d }} />delegate: down, bottom › top</span>
        <span className="flex items-center gap-1.5"><span className="h-0.5 w-5 border-t-2 border-dashed" style={{ borderColor: r }} />report: back up</span>
        <span className="flex items-center gap-1.5"><span className="h-0.5 w-5 border-t-2 border-dotted" style={{ borderColor: c }} />consult: peers, side to side</span>
      </div>
    </Panel>
  );
}

function ChannelTable() {
  const examples: Record<EdgeType, string> = {
    delegate: "The CEO gives the engineering manager a task.",
    review: "The reviewer approves the engineer's code or asks for changes.",
    debate: "The architect and the security lead argue until they agree.",
    report: "An engineer tells their manager what is done.",
    consult: "Two managers ask each other quick questions.",
  };
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {(Object.keys(EDGE_TYPES) as EdgeType[]).map((k) => {
        const m = EDGE_TYPES[k];
        return (
          <div key={k} className="rounded-xl border border-border bg-card p-3">
            <div className="mb-1 flex items-center gap-2">
              <svg width="36" height="8" aria-hidden><line x1="1" y1="4" x2="35" y2="4" stroke={m.color} strokeWidth="2.5" strokeDasharray={m.dash} strokeLinecap="round" /></svg>
              <span className="text-sm font-semibold text-foreground">{m.label}</span>
            </div>
            <p className="text-xs">{examples[k]}</p>
          </div>
        );
      })}
    </div>
  );
}

function PermissionLadder() {
  const order: PermissionLevel[] = ["read_only", "plan", "ask", "danger"];
  return (
    <div className="grid gap-2 sm:grid-cols-4">
      {order.map((k, i) => {
        const p = PERMISSIONS[k];
        return (
          <div key={k} className="relative rounded-xl border border-border bg-card p-3">
            <div className="mb-1 h-1 rounded-full bg-gradient-to-r from-olive to-terracotta" style={{ width: `${25 * (i + 1)}%` }} />
            <div className="flex items-center gap-1.5 text-sm font-semibold text-foreground"><p.icon className={cn("h-3.5 w-3.5", p.tone)} />{p.short}</div>
            <p className="mt-1 text-[11.5px] leading-snug">{p.description}</p>
          </div>
        );
      })}
    </div>
  );
}

function EndpointExamples() {
  const rows = [
    ["https://<res>.services.ai.azure.com/openai/v1/responses", "Responses API"],
    ["https://<res>.openai.azure.com/openai/v1/chat/completions", "Chat Completions"],
    ["https://<res>.openai.azure.com", "Responses API (default)"],
  ];
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      {rows.map(([u, k]) => (
        <div key={u} className="flex items-center justify-between gap-3 border-b border-border px-3 py-2 last:border-0">
          <code className="truncate font-mono text-[11.5px] text-foreground">{u}</code>
          <span className="shrink-0 rounded-full bg-olive/15 px-2 py-0.5 text-[10.5px] font-medium text-olive">{k}</span>
        </div>
      ))}
    </div>
  );
}

function Shortcuts() {
  const rows = [
    ["Alt 1 to 6", "Canvas, Chat, Runs, Artifacts, Settings, Guide"],
    ["Ctrl Z / Ctrl Y", "Undo / redo on the canvas"],
    ["Ctrl C / Ctrl V / Ctrl D", "Copy, paste, duplicate agents"],
    ["Delete", "Remove the selected agents or channel"],
    ["Double-click an agent", "Open the full inspector"],
    ["Right-click the canvas", "Add an agent at that spot, auto-layout, fit view"],
  ];
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      {rows.map(([k, v]) => (
        <div key={k} className="grid grid-cols-[180px_1fr] gap-3 border-b border-border px-3 py-2 text-[13px] last:border-0">
          <span className="font-mono text-xs text-foreground">{k}</span><span>{v}</span>
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ content
const SECTIONS: Section[] = [
  {
    id: "overview", title: "The big picture", icon: Sparkles,
    body: <>
      <p>Everything in Octopus follows the same four steps. Once you know them, you know the app.</p>
      <FlowDiagram />
      <p>The top bar mirrors this: <b>Canvas</b> (your team), <b>Chat</b> (talk to one agent), <b>Runs</b> (the team at work) and <b>Artifacts</b> (what they made).
        <b> Guide</b> and <b>Settings</b> sit on the right.</p>
    </>,
  },
  {
    id: "projects", title: "Projects are folders", icon: FolderOpen,
    body: <>
      <p>A project is simply a folder on your computer. Agents can read and write <b>only inside it</b>. Octopus keeps its own data in a hidden
        <code className="mx-1 rounded bg-muted px-1 text-foreground">.octopus/</code>folder there, so deleting a project from the list never deletes your files.</p>
      <Shot name="welcome" alt="Welcome screen with the list of projects" caption="Open a folder from the welcome screen. Switch projects any time from the top-left." />
    </>,
  },
  {
    id: "companies", title: "Create a team (company)", icon: Building2,
    body: <>
      <p>A <b>company</b> is a team of agents. Start with a <b>template</b> such as <i>Software Startup</i>, or describe your goal and let AI design the team.
        You can keep several companies in one project and switch between them in the top bar.</p>
      <Shot name="new-company" alt="New company dialog with templates" caption="Templates are just starting points. Everything can be edited afterwards." />
    </>,
  },
  {
    id: "canvas", title: "The canvas", icon: Network,
    body: <>
      <p>The canvas shows your team as an org chart. Each card is an agent. Coloured zones are <b>departments</b>, each led by a manager (♛).
        Arrows are <b>channels</b>: who is allowed to talk to whom.</p>
      <OrgDiagram />
      <Tips items={[
        <>Arrows leave the <b>bottom</b> of the higher agent and enter the <b>top</b> of the lower one. Agents on the same level connect <b>side to side</b>.</>,
        <>Drag from the small dot on a card's edge to another card to create a channel. Click the channel's icon to change its type.</>,
        <>Use <b>Department</b> in the toolbar to add a manager and a small team in one go. The tidy-up button arranges everything neatly.</>,
        <>The flag marks the <b>entry agent</b>: the one that receives your goal first.</>,
      ]} />
      <Shot name="canvas" alt="Canvas with departments, agents and channels" />
    </>,
  },
  {
    id: "channels", title: "Channel types", icon: ArrowRight,
    body: <>
      <p>Channels decide <i>how</i> two agents work together. There are five kinds:</p>
      <ChannelTable />
    </>,
  },
  {
    id: "agents", title: "Configure an agent", icon: Settings2,
    body: <>
      <p>Click an agent to open its quick settings next to it: name, role, model, and the <b>tools</b> it may use (read files, write files, terminal, web search…).
        Double-click for the full inspector with its instructions and personality sliders.</p>
      <Shot name="quick-config" alt="Quick configuration popover next to an agent" />
      <Tips items={[
        <>Each agent can use a different model. Put a strong model on the manager and a fast one on the workers.</>,
        <>Agents with <b>Manage team</b> can hire new teammates during a run. New hires show an <i>AI hire</i> badge.</>,
      ]} />
    </>,
  },
  {
    id: "chat", title: "Chat with one agent", icon: MessagesSquare,
    body: <>
      <p><b>Chat</b> is a direct conversation with a single agent. It's the quickest way to test a prompt, ask about your code, or try a model before a full run.
        You can attach files, and the agent can use its tools.</p>
      <Shot name="chat" alt="Direct chat with an agent" />
    </>,
  },
  {
    id: "runs", title: "Run the team", icon: Play,
    body: <>
      <p>Press <b>Run</b>, type a goal (for example <i>"Build a todo app with login"</i>) and choose how much freedom the team gets:</p>
      <PermissionLadder />
      <p>While it runs you see who is thinking, messages flying along channels, and files being written. If an agent needs your approval, the run pauses and
        a <b>Needs you</b> badge appears in the top bar. You can pause, send a message to the team, or stop at any time.</p>
      <Shot name="run" alt="Live run view with the team graph and message feed" />
    </>,
  },
  {
    id: "artifacts", title: "Review the results", icon: FileCode2,
    body: <>
      <p><b>Artifacts</b> lists every file the team created or changed, with a diff for each version and the final report. In <b>Plan</b> mode nothing touches your
        project until you apply the plan here. You can also download everything as a zip.</p>
      <Shot name="artifacts" alt="Artifacts page with files and diffs" />
    </>,
  },
  {
    id: "history", title: "Past runs", icon: History,
    body: <p><b>Runs</b> keeps every run with its full timeline. Open one to replay it step by step, see the cost and tokens, or read the final report again.</p>,
  },
  {
    id: "models", title: "Connect Azure OpenAI (gpt-6-luna)", icon: Cloud,
    body: <>
      <p>Out of the box Octopus runs in <b>Demo Mode</b>: a scripted offline model, so you can try everything for free. To use real models open
        <b> Settings › Model</b> and fill in three things:</p>
      <ol className="space-y-1.5 pl-5 [list-style:decimal]">
        <li><b>Endpoint</b>: paste it exactly as the Azure or Foundry portal shows it. Octopus detects the format and shows which URL it will call.</li>
        <li><b>API key</b>: from the resource's <i>Keys and Endpoint</i> page. Or switch to Microsoft Entra ID under Advanced.</li>
        <li><b>Deployment name</b>: <code className="rounded bg-muted px-1 text-foreground">gpt-6-luna</code> (already filled in).</li>
      </ol>
      <EndpointExamples />
      <p>Click <b>Save</b>, then <b>Test connection</b>. The deployment now appears in every agent's model picker. Reasoning models that reject settings such as
        temperature are handled automatically. Every agent runs on this deployment; the only other choice is the offline Demo model.</p>
      <Shot name="settings" alt="Azure OpenAI settings card" />
    </>,
  },
  {
    id: "safety", title: "Staying in control", icon: ShieldCheck,
    body: <Tips items={[
      <>Agents are sandboxed to the project folder, including terminal commands.</>,
      <>Every run has limits: turns, tokens, cost and time. You'll find them under <i>Limits</i> in the Run dialog.</>,
      <>The permission badge in the top bar shows the project's default level. Change it in <b>Settings › Project</b>.</>,
      <>API keys are encrypted on your machine and never sent back to the browser.</>,
    ]} />,
  },
  {
    id: "extras", title: "Templates & MCP tools", icon: LayoutTemplate,
    body: <>
      <p><b>Save as template</b> (bookmark icon on the canvas toolbar) turns your current team into a reusable template, available in every project. Import or export
        templates as JSON in <b>Settings › Templates</b>.</p>
      <p className="flex gap-2"><Plug className="mt-1 h-4 w-4 shrink-0 text-terracotta" /><span><b>MCP servers</b> give agents extra tools (GitHub, databases, browsers…).
        Add one in <b>Settings › MCP servers</b>, then switch it on for specific agents in their settings.</span></p>
      <p className="flex gap-2"><Crown className="mt-1 h-4 w-4 shrink-0 text-terracotta" /><span>The left panel on the canvas has two tabs: <b>Org</b> lists departments and lets you pause agents, and <b>Roles</b> lists agent types you can drag in.</span></p>
    </>,
  },
  {
    id: "shortcuts", title: "Shortcuts", icon: Keyboard,
    body: <Shortcuts />,
  },
];
