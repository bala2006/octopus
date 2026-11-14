import * as React from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import {
  ArrowLeft, ArrowRight, BookOpen, Cloud, Code2, Compass, FileCode2, FolderOpen, History, Keyboard, LayoutTemplate, MessagesSquare, Network,
  Play, Plug, Settings2, ShieldCheck, Sparkles, type LucideIcon,
} from "lucide-react";
import { APPROVAL_MODES, CHANNEL_CHOICES, EDGE_TYPES } from "@/lib/meta";
import { cn } from "@/lib/utils";
import { useApp } from "@/stores/app";
import { SPACES } from "@/components/layout/spaces";
import type { ApprovalMode, EdgeType } from "@/types";

interface Section { id: string; title: string; icon: LucideIcon; body: React.ReactNode }

/** Plain-language tour of every feature, with screenshots and small diagrams. Works inside and outside a project. */
export default function GuidePage({ embedded = false }: { embedded?: boolean }) {
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
  const go = (id: string) => scroller.current?.querySelector(`#${CSS.escape(id)}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  const { hash } = useLocation();
  React.useEffect(() => { if (hash) setTimeout(() => go(hash.slice(1)), 50); }, [hash]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex h-full flex-col">
      {!base && !embedded && (
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-surface px-3">
          <Link to="/" className="flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"><ArrowLeft className="h-4 w-4" />Projects</Link>
        </header>
      )}
      <div className="flex min-h-0 flex-1">
        <nav className="guide-navigation section-navigation hidden md:block" aria-label="Guide sections">
          <div className="mb-2 flex items-center gap-2 px-2 pt-1 text-sm font-semibold"><BookOpen className="h-4 w-4 text-primary" />Guide</div>
          {SECTIONS.map((s, i) => (
            <button key={s.id} onClick={() => go(s.id)}
              className={cn("section-navigation-item", active === s.id && "is-active")}>
              <span className="w-4 text-right font-mono text-[10px] opacity-60">{i + 1}</span><s.icon className="h-3.5 w-3.5 shrink-0" />{s.title}
            </button>
          ))}
        </nav>
        <div ref={scroller} className="min-w-0 flex-1 overflow-y-auto">
          <article className="guide-content space-y-12">
            <div className="space-y-3">
              <p className="text-xs font-medium text-primary">Octopus guide</p>
              <h1 className="page-title">How to work with Octopus</h1>
              <p className="text-[15px] leading-relaxed text-muted-foreground">
                Octopus is a team of AI specialists that works in a folder on your computer. You say what you want, the way you would in a coding chat.
                Octopus, the team lead, decides who the job needs, hires them onto the team, and runs the work. Every change is reviewed and checked
                with your project's own tests before Octopus reports back. Then you reply, and the same team carries on.
              </p>
            </div>
            {SECTIONS.map((s, i) => (
              <section key={s.id} id={s.id} className="scroll-mt-6 space-y-4">
                <div className="flex items-center gap-3">
                  <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10 text-primary"><s.icon className="h-4 w-4" /></span>
                  <div>
                    <div className="font-mono text-[10px] text-muted-foreground">{String(i + 1).padStart(2, "0")}</div>
                    <h2 className="text-xl font-semibold tracking-tight">{s.title}</h2>
                  </div>
                </div>
                <div className="space-y-4 text-[14.5px] leading-relaxed text-muted-foreground [&_b]:font-semibold [&_b]:text-foreground">{s.body}</div>
              </section>
            ))}
            <p className="border-t border-border pt-6 text-center text-xs text-muted-foreground">That's everything. Hover any button for a short hint, or use Help › Report an issue if something does not work as described.</p>
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
    { icon: MessagesSquare, t: "You ask", d: "in the conversation" },
    { icon: Network, t: "Plan", d: "Octopus staffs and assigns" },
    { icon: FileCode2, t: "Build", d: "specialists work in parallel" },
    { icon: ShieldCheck, t: "Review", d: "a second pair of eyes, then your tests" },
    { icon: Sparkles, t: "Report", d: "what changed and how it was checked" },
  ];
  return (
    <Panel>
      <div className="flex flex-wrap items-center justify-center gap-2">
        {steps.map((s, i) => (
          <React.Fragment key={s.t}>
            <div className="flex w-32 flex-col items-center gap-1.5 rounded-xl border border-border bg-card p-3 text-center shadow-sm">
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
      <svg viewBox="0 0 520 230" className="w-full" role="img" aria-label="Org chart: Octopus leads two department leads, who lead their teams and consult each other">
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
        <MiniCard name="Octopus" role="Team lead" color="#D97756" x={200} y={12} manager />
        <MiniCard name="Kai" role="Tech lead" color="#66839A" x={65} y={96} manager />
        <MiniCard name="Priya" role="Product manager" color="#6B8440" x={335} y={96} manager />
        <MiniCard name="Lena" role="Frontend" color="#66839A" x={0} y={178} />
        <MiniCard name="Diego" role="Backend" color="#66839A" x={130} y={178} />
        <MiniCard name="Iris" role="Designer" color="#6B8440" x={335} y={178} />
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
  const examples: Partial<Record<EdgeType, string>> = {
    delegate: "Octopus assigns Lena a task: the line lights up.",
    review: "Kai → Lena means Kai reviews Lena's changes. Without one, the author's department lead or a tech lead reviews.",
    report: "Lena finishes and her status flows back to her lead.",
    consult: "Lena asks Diego about the API contract and waits for his answer.",
  };
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {CHANNEL_CHOICES.map((k) => {
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

function ApprovalModes() {
  const order: ApprovalMode[] = ["ask", "auto"];
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {order.map((k) => (
        <div key={k} className="rounded-xl border border-border bg-card p-3">
          <div className="text-sm font-semibold text-foreground">{APPROVAL_MODES[k].label}</div>
          <p className="mt-1 text-[11.5px] leading-snug">{APPROVAL_MODES[k].description}</p>
        </div>
      ))}
    </div>
  );
}

function EndpointExamples() {
  const rows = [
    ["https://<resource>.openai.azure.com", "Azure OpenAI"],
    ["https://<resource>.services.ai.azure.com/openai/v1/responses", "Azure AI Foundry"],
    ["https://<resource>.openai.azure.com/openai/deployments/<name>/…", "Older deployment URL"],
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

function SpaceTable() {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      {SPACES.map((sp) => (
        <div key={sp.to} className="grid grid-cols-[150px_1fr_52px] items-center gap-3 border-b border-border px-3 py-2 text-[13px] last:border-0">
          <span className="flex items-center gap-2 font-medium text-foreground"><sp.icon className="h-4 w-4 text-terracotta" />{sp.label}</span>
          <span>{sp.hint}</span>
          <span className="text-right font-mono text-[11px]">Alt {sp.key}</span>
        </div>
      ))}
    </div>
  );
}

function Shortcuts() {
  const rows = [
    ["Alt 1 … 6", SPACES.map((sp) => sp.label).join(", ")],
    ["Ctrl K or Ctrl P", "Quick open: a file or page (inside a project)"],
    ["Ctrl L", "Jump to the message box"],
    ["Enter / Shift Enter", "Send / new line in the message box"],
    ["1 … 9, then Enter", "Pick an answer when an agent asks you something"],
    ["A / Shift A / R", "Approve once / always allow / reject a pending approval"],
    ["Ctrl S / Ctrl Shift S", "Save / save all in Code"],
    ["Ctrl Shift F", "Search the project in Code"],
    ["Ctrl `", "Show or hide the terminal in Code"],
    ["Ctrl Z / Ctrl Y", "Undo / redo in Team"],
    ["Ctrl C / V / D / A", "Copy, paste, duplicate, select all agents in Team"],
    ["Delete", "Remove the selected agents or channel"],
    ["Double-click an agent", "Open the full inspector"],
  ];
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      {rows.map(([k, v]) => (
        <div key={k} className="grid grid-cols-[190px_1fr] gap-3 border-b border-border px-3 py-2 text-[13px] last:border-0">
          <span className="font-mono text-xs text-foreground">{k}</span><span>{v}</span>
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ content
const SECTIONS: Section[] = [
  {
    id: "overview", title: "How Octopus works", icon: Sparkles,
    body: <>
      <p>Every message you send goes through the same five steps. You see each one happen, and you can step in at any point.</p>
      <FlowDiagram />
      <Tips items={[
        <><b>Plan.</b> Octopus reads your request and the project. It answers directly when no work is needed, asks you when a decision is genuinely yours, or hires the specialists the job needs. For a feature it lists your asks in your words as requirements, and anything it leaves out is shown with the reason. Each task gets acceptance criteria, the requirements it delivers and the files it owns.</>,
        <><b>Build.</b> Specialists work in parallel on separate files, each with real tools: files, commands, a browser, the web and your MCP servers.</>,
        <><b>Review.</b> Every change is reviewed by someone other than its author. Requested changes go back to the author, who continues where they left off; the next review looks only at what changed.</>,
        <><b>Verify.</b> Your project's own tests, type checks and lint run after changes. Then a QA engineer runs the product and checks every requirement. Failures go back to whoever built that part.</>,
        <><b>Report.</b> Octopus tells you what changed, where and how it was verified, followed by each requirement's status and everything still open. Reply to continue with the same team.</>,
      ]} />
    </>,
  },
  {
    id: "layout", title: "Find your way around", icon: Compass,
    body: <>
      <p>Each job in a project has exactly one place. The rail on the left switches between them:</p>
      <SpaceTable />
      <Tips items={[
        <>The <b>sidebar</b> lists your projects and recent conversations. Show or hide it with the panel button at the top left.</>,
        <>The top bar shows where you are, which <b>team</b> works in this project, and a status pill while the team works. It turns amber when the team needs you.</>,
        <><b>Ctrl K</b> opens any file or page. Your avatar at the bottom of the rail holds your profile, Settings and the theme; <b>Help</b> holds this guide.</>,
      ]} />
    </>,
  },
  {
    id: "projects", title: "Projects are folders", icon: FolderOpen,
    body: <>
      <p>A project is a folder on your computer. Choose <b>Open project folder</b> (File menu, the <b>+</b> next to Projects in the sidebar, or Home), pick a folder, and give it a name. Agents can only read and write <b>inside that folder</b>.</p>
      <p>Octopus keeps the project's teams, conversations, file history, agent notes and trash in a hidden <code className="mx-1 rounded bg-muted px-1 text-foreground">.octopus/</code> folder, ignored by Git.
        Open the same folder later and everything is back. Right-click a project in the sidebar to rename it or remove it from Octopus; removing never deletes your files.</p>
      <p>If the folder is a Git repository, Home lets you pick a branch or start a <b>new worktree</b>, so the team works on a separate branch and leaves your checkout untouched.</p>
      <Shot name="welcome" alt="Home: choose a project and describe what to build" caption="Pick a project, describe the work, and press Enter." />
    </>,
  },
  {
    id: "models", title: "Connect Azure OpenAI", icon: Cloud,
    body: <>
      <p>Every agent runs on your Azure OpenAI deployment. Open <b>Settings › Model</b> and fill in:</p>
      <ol className="space-y-1.5 pl-5 [list-style:decimal]">
        <li><b>Endpoint</b>, pasted as the Azure or Foundry portal shows it. Octopus shows which address it will call.</li>
        <li><b>API key</b> from the resource's <i>Keys and Endpoint</i> page, or Microsoft Entra ID (after <code className="rounded bg-muted px-1 text-foreground">az login</code>) under Advanced.</li>
        <li><b>Deployments</b>: <code className="rounded bg-muted px-1 text-foreground">gpt-6-luna</code> is filled in; add others you want to pick from.</li>
      </ol>
      <EndpointExamples />
      <p>Press <b>Save</b>, then <b>Test connection</b>. The key is encrypted on this computer and never sent back to the browser. Usage and cost come from what Azure reports for every call; you can show costs in your currency under <b>Settings › Preferences</b>.</p>
      <Shot name="settings" alt="Azure OpenAI settings" />
    </>,
  },
  {
    id: "conversation", title: "Start a conversation", icon: MessagesSquare,
    body: <>
      <p>Type what you want in the message box, for example <i>"Add a pricing section to the landing page"</i> or <i>"Why does the login test fail?"</i>, and press <b>Enter</b>.</p>
      <Tips items={[
        <><b>+</b> attaches photos, screenshots (or paste them), text files, PDFs, or files from the project. In the code workspace you can also attach the current file or a selection.</>,
        <><b>Ask for permission / Approve for me</b> sets what needs your OK (see Safety).</>,
        <>The model button picks the Azure deployment and how long the team thinks: <b>Auto</b> uses each agent's own setting.</>,
        <>Start a message with <b>@Name</b> to give it straight to one teammate instead of Octopus.</>,
        <>The conversation window floats over your team. Minimise it, dock it left or right, or drag any edge to resize it.</>,
        <><b>New conversation</b> in the sidebar (or File menu) starts fresh with the same team. Past conversations are under <b>Recent conversations</b> in the sidebar, and all of them are in <b>History</b>.</>,
        <><b>New conversation with limits…</b> in the message box options lets you set the team size, parallel tasks, fix rounds and a step-by-step mode first.</>,
      ]} />
    </>,
  },
  {
    id: "runs", title: "While the team works", icon: Play,
    body: <>
      <p>Everything about a conversation is in one window. The chat shows what matters to you: the plan, questions, approvals and the final report. <b>Show the team's internal messages</b> in the message box options adds what agents say to each other.
        Next to it, the team's cards light up as each agent thinks, writes or uses a tool.</p>
      <Tips items={[
        <>The tabs above the chat show <b>Tasks</b> (each task's owner, status and result), <b>Tools</b> (every command and tool call), <b>Browser</b> (what an agent sees, live, once one uses the browser) and the <b>Recap</b> when the team is done, which you can download as Markdown.</>,
        <>The strip under the tabs shows the workflow phases, what the team is doing, and the calls, tokens and cost so far (click them for the exact breakdown). <b>Pause</b> or <b>Next step</b> is there too.</>,
        <>When an agent needs a decision, it asks with 2 to 5 answers and marks the one it recommends. Pick one or type your own; the rest of the team keeps working meanwhile.</>,
        <>Send a message at any time. While the team works, Octopus plans it in alongside the running tasks.</>,
        <>To stop the team, press the square send button while the message box is empty. The team works until its tasks are finished, checked and reported. A task that keeps testing is told to wrap up before its step limit.</>,
        <>When the team needs you, the status pill at the top right turns amber and says <b>Needs you</b>, on every page. Click it to jump to that conversation.</>,
      ]} />
      <Shot name="run" alt="The team at work next to the conversation" />
    </>,
  },
  {
    id: "canvas", title: "Design your team", icon: Network,
    body: <>
      <p><b>Team</b> shows your team as an org chart. Each card is an agent; coloured zones are <b>departments</b>, each with a lead (♛). The flag marks the <b>team lead</b>, usually Octopus, who plans every request and reports back to you.
        During a conversation the cards show who is thinking or writing, their last message and their token use.</p>
      <OrgDiagram />
      <p>The lines are <b>channels</b>. Octopus draws delegate and report lines when it hires someone; you can add your own by dragging from the dot on one card to another, and click a line to change it:</p>
      <ChannelTable />
      <Tips items={[
        <>New team: <b>Self-organizing</b> starts with only Octopus, which hires as each request needs. Templates (Software Startup, Web App Studio, Mobile App Team, SaaS Launch, Full Company and more) start with a typical shape. You can also describe a team and let AI design it, or import one.</>,
        <>People Octopus hires show an <b>AI hire</b> badge and stay in the team for later requests.</>,
        <>Use <b>Department</b> in the toolbar to add a lead and a small team at once, and <b>Tidy up</b> to arrange everything. Zoom and fit are in the corner controls. Changes save automatically.</>,
        <>Right-click an agent to configure it, chat with it, make it the team lead, duplicate or delete it.</>,
        <>Switch, create, rename or delete teams from the team name in the top bar. <b>Talk to the team</b> opens a fresh conversation with it.</>,
      ]} />
      <Shot name="canvas" alt="Team: departments, agents and channels" />
    </>,
  },
  {
    id: "agents", title: "Configure an agent", icon: Settings2,
    body: <>
      <p>Click an agent for quick settings next to it; double-click for the full inspector.</p>
      <Tips items={[
        <><b>Role</b> brings the agent's expertise, look and default tools from the role library. <b>Title</b> is how teammates see it.</>,
        <><b>Model</b> and <b>thinking</b>: give the lead a stronger setting and specialists a faster one if you like.</>,
        <><b>Tools</b>: read files, write files, commands, web, browser, ask you, ask teammates, plus any MCP servers you grant.</>,
        <><b>Skills</b> are playbooks (code review, security review, writing tests…) added to the agent's instructions. Agents get the skills that match their role automatically.</>,
        <><b>Prompt</b>: an agent uses its role's prompt unless you give it one of its own. Additional instructions are added for this agent only.</>,
        <><b>Notes</b> (the brain tab) are what the agent remembers between tasks. Agents add their own; you can add or delete them.</>,
        <>Turn an agent <b>inactive</b> to keep it on the canvas without giving it work.</>,
      ]} />
      <Shot name="quick-config" alt="Quick settings next to an agent" />
    </>,
  },
  {
    id: "safety", title: "Safety and approvals", icon: ShieldCheck,
    body: <>
      <ApprovalModes />
      <Tips items={[
        <>Agents only touch files inside the project. <code>.git</code> and Octopus's own data are off-limits, and so are symlinks that lead outside.</>,
        <>Every change is versioned: <b>Changes</b> reverts any file to any version. Deleted files go to a trash you can restore from in Code.</>,
        <>Commands run without a shell and without your keys. Destructive ones (<code>rm</code>, <code>git reset --hard</code>, <code>git clean</code>, force pushes, <code>sudo</code>) are always refused, also when they are wrapped in other commands.</>,
        <>Approvals show the exact diff or command. <b>Always allow</b> applies to that exact action for the rest of the conversation.</>,
        <>Programs the team runs (your tests, scripts it wrote) run with your user's permissions. Use Git or a worktree for work you cannot afford to lose.</>,
      ]} />
    </>,
  },
  {
    id: "artifacts", title: "Review the results", icon: FileCode2,
    body: <>
      <p><b>Changes</b> lists every file the team created or changed, with each version's author, reason and diff. Revert one file to any version, or to how it was before the conversation, and download the changes as a ZIP.
        <b> Project files</b> shows the whole folder; <b>Preview</b> runs HTML apps and renders Markdown, images and PDFs.</p>
      <p><b>History</b> lists every conversation with its outcome and cost. Open one to pick it up where you left off; from the row you can also ask again, review its changes, or delete it.</p>
      <Shot name="artifacts" alt="Changes: files, versions and diffs" />
    </>,
  },
  {
    id: "chat", title: "Chat with one agent", icon: MessagesSquare,
    body: <>
      <p><b>Direct chats</b> are one-on-one conversations with a single teammate: ask your designer about the colour palette or your backend developer how the API works. In a direct chat the agent can read the project and search the web but does not change files; ask in Conversation for changes.</p>
      <p>Pick an agent from the list, or right-click its card in Team and choose <b>Chat with agent</b>.</p>
      <Shot name="chat" alt="Direct chat with an agent" />
    </>,
  },
  {
    id: "workspace", title: "Edit code yourself", icon: Code2,
    body: <>
      <p><b>Code</b> (Alt 5) is an editor with a preview, a terminal and Git. The <b>Agent</b> button opens the same conversation beside your code, so you can attach the current file or a selection.</p>
      <Tips items={[
        <>Open files from the explorer or <b>Ctrl K</b>; <b>Ctrl S</b> saves. If the file changed on disk meanwhile, Octopus shows both versions before you choose.</>,
        <>New file, new folder, rename, move and delete (with undo and a trash) are in the explorer.</>,
        <><b>Git</b> shows your changes; stage files one by one after reviewing the diff, then commit.</>,
        <><b>Commands</b> runs your own commands in a terminal (with input), and <b>Dev server</b> starts your app's server and opens its preview. The indicator in the top bar takes you back to them.</>,
        <>Unsaved edits survive a reload of the page.</>,
      ]} />
    </>,
  },
  {
    id: "extras", title: "Roles, skills, templates and MCP", icon: LayoutTemplate,
    body: <>
      <p>In <b>Settings</b> you can edit the <b>role library</b> Octopus hires from, write <b>skills</b> (Markdown playbooks), and manage <b>templates</b>: save your team as one from the Team toolbar, and import or export them as JSON.</p>
      <p className="flex gap-2"><Plug className="mt-1 h-4 w-4 shrink-0 text-terracotta" /><span><b>Built-in browser</b>: agents with the Browser tool get their own tab in an isolated browser on this computer. They open the project preview, click through it and read console errors. Use <b>Test browser</b> in Settings › MCP servers to check it works.</span></p>
      <p className="flex gap-2"><Plug className="mt-1 h-4 w-4 shrink-0 text-terracotta" /><span><b>MCP servers</b> give agents more tools (GitHub, databases, …). Add one in Settings › MCP servers, then grant it to specific agents in their tools.</span></p>
    </>,
  },
  {
    id: "history", title: "Profile and activity", icon: History,
    body: <p>Click your avatar at the bottom of the rail and choose <b>Profile and activity</b> to see your tokens over time, your projects and the tools your teams use most. Add your name there; it appears on your avatar. Settings and the light or dark theme are in the same menu. Everything stays on this computer.</p>,
  },
  {
    id: "shortcuts", title: "Keyboard shortcuts", icon: Keyboard,
    body: <Shortcuts />,
  },
];
