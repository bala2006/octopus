import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { ArrowUpRight, Check, Folder, LockKeyhole, Pencil, Wrench } from "lucide-react";
import { api, unwrap } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/primitives";
import { calendarDays, localDate, weeklyTotals, type UsageDay } from "./calendar";
import "./activity.css";

type View = "Daily" | "Weekly" | "Cumulative";
const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const full = new Intl.NumberFormat();
const dateLabel = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const level = (value: number, max: number) => value === 0 ? 0 : Math.max(1, Math.ceil(value / Math.max(max, 1) * 4));

function duration(seconds: number): string {
  if (!seconds) return "0m";
  const minutes = Math.max(1, Math.round(seconds / 60));
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
}

export default function ActivityPage() {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const query = useQuery({ queryKey: ["personal-activity", tz], queryFn: () => unwrap(api.GET("/api/v1/activity", { params: { query: { tz } } })), refetchInterval: 30_000 });
  const [view, setView] = React.useState<View>("Daily");
  const [editing, setEditing] = React.useState(false);
  const [savedName, setSavedName] = React.useState("");
  const [draft, setDraft] = React.useState("");
  const data = query.data;
  React.useEffect(() => {
    if (!data) return;
    setSavedName(localStorage.getItem(`octopus-profile-name:${data.email}`) ?? "");
  }, [data?.email]);
  if (query.isPending) return <div className="personal-activity" aria-busy="true"><div className="activity-loading">Loading your activity…</div></div>;
  if (query.isError) return <div className="personal-activity activity-loading" role="alert"><p>Your activity could not be loaded.</p><Button onClick={() => void query.refetch()}>Try again</Button></div>;
  if (!data) return null;
  const name = savedName || "Your activity";
  const initials = savedName ? savedName.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase() : "YO";
  const days = calendarDays(data.days, localDate(new Date()));
  const stats = [
    [compact.format(data.lifetime_tokens), "Lifetime tokens", "Recorded tokens across your registered projects"],
    [compact.format(data.peak_tokens), "Peak daily tokens", "Your highest recorded daily token usage"],
    [duration(data.longest_task_seconds), "Longest task", "Longest recorded active task time, excluding pauses"],
    [`${data.longest_streak} days`, "Longest streak", "Consecutive days with recorded token usage"],
    [`${data.current_streak} days`, "Current streak", "Consecutive active days ending today or yesterday"],
  ];
  const saveName = (event: React.FormEvent) => {
    event.preventDefault();
    const value = draft.trim();
    localStorage.setItem(`octopus-profile-name:${data.email}`, value);
    setSavedName(value);
    setEditing(false);
  };
  return (
    <div className="personal-activity">
      <div className="activity-page-inner">
        <div className="activity-profile-actions"><span><LockKeyhole size={14} />Private on this device</span><Button variant="ghost" size="sm" onClick={() => { setDraft(savedName); setEditing(!editing); }}><Pencil />Edit profile</Button></div>
        <header className="activity-profile">
          <div className="activity-avatar" aria-hidden="true">{initials}</div>
          {editing ? <form className="activity-name-form" onSubmit={saveName}><label htmlFor="activity-name">Display name</label><div><Input id="activity-name" value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={60} autoFocus placeholder="Your name" /><Button type="submit" size="sm"><Check />Save</Button><Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)}>Cancel</Button></div></form> : <h1>{name}</h1>}
          <p>Your work with Octopus, over time.</p>
        </header>
        <dl className="activity-stats">{stats.map(([value, label, hint]) => <div key={label} title={hint}><dd>{value}</dd><dt>{label}</dt></div>)}</dl>
        {data.unavailable_projects > 0 && <p className="activity-notice" role="status">Totals exclude {data.unavailable_projects} unavailable project{data.unavailable_projects === 1 ? "" : "s"}. Reconnect those folders to include their history.</p>}
        <section className="activity-section" aria-labelledby="activity-projects"><div className="activity-section-heading"><h2 id="activity-projects">Your projects</h2><Link to="/">Open a project <ArrowUpRight size={14} /></Link></div>
          {data.projects.length ? <div className="activity-projects">{data.projects.slice(0, 3).map((project) => <Link key={project.id} to={`/w/${project.id}/agent`}><Folder size={22} /><strong>{project.name}</strong><span>{compact.format(project.tokens)} tokens</span><ArrowUpRight className="activity-project-arrow" size={16} /></Link>)}</div> : <div className="activity-project-empty"><Folder size={30} /><h3>A place for your work</h3><p>Your projects and their usage will appear here.</p><Button asChild variant="outline"><Link to="/">Open a project</Link></Button></div>}
        </section>
        <section className="activity-section" aria-labelledby="token-activity"><div className="activity-section-heading"><h2 id="token-activity">Token activity</h2><div className="activity-tabs" role="group" aria-label="Token activity view">{(["Daily", "Weekly", "Cumulative"] satisfies View[]).map((tab) => <button key={tab} aria-pressed={view === tab} onClick={() => setView(tab)}>{tab}</button>)}</div></div>
          <TokenChart days={days} view={view} />
          <div className="activity-chart-footer"><span>{data.active_days} active days · Past year shown</span><div aria-label="Token intensity: less to more"><span>Less</span>{[0, 1, 2, 3, 4].map((n) => <i key={n} data-level={n} />)}<span>More</span></div></div>
          {!data.lifetime_tokens && <p className="activity-chart-empty">Your first activity starts with a conversation in a project.</p>}
        </section>
        <section className="activity-section" aria-labelledby="top-tools"><h2 id="top-tools">Most used tools</h2>{data.tools.length ? <div className="activity-tools">{data.tools.map((tool) => <div key={tool.name} title={`${tool.name}: ${full.format(tool.count)} calls`}><div className="activity-tool-icon"><Wrench size={23} /></div><strong>{tool.name.replaceAll("_", " ")}</strong><span>{full.format(tool.count)} calls</span></div>)}</div> : <p className="activity-muted">Tools you use with Octopus will appear here.</p>}</section>
        <section className="activity-section" aria-labelledby="activity-insights"><h2 id="activity-insights">Insights</h2><dl className="activity-insights"><div><dt>Most used reasoning</dt><dd>{data.most_used_reasoning ? `${data.most_used_reasoning} · ${data.reasoning_percent}%` : "No recorded preference"}</dd></div><div><dt>Skills explored</dt><dd>{data.skills_explored}</dd></div><div><dt>Total skills used</dt><dd>{data.total_skills_used}</dd></div><div><dt>Projects connected</dt><dd>{data.projects.length}</dd></div></dl></section>
        <p className="activity-footnote">Based on usage history saved in your projects. Deleted history is excluded. Dates use {tz}. Updates every 30 seconds.</p>
      </div>
    </div>
  );
}

function TokenChart({ days, view }: { days: UsageDay[]; view: View }) {
  const [focused, setFocused] = React.useState(days.length - 1);
  const max = Math.max(0, ...days.map((day) => day.tokens));
  const weeks = weeklyTotals(days);
  const months = weeks.map((week, index) => {
    const date = new Date(`${week.date}T12:00:00Z`);
    const previous = weeks[index - 1];
    return !previous || previous.date.slice(5, 7) !== week.date.slice(5, 7) ? date.toLocaleDateString(undefined, { month: "short", timeZone: "UTC" }) : "";
  });
  let total = 0;
  const cumulative = days.map((day) => { total += day.tokens; return total; });
  const path = cumulative.map((value, index) => `${index === 0 ? "M" : "L"}${index / Math.max(1, days.length - 1) * 900},${125 - value / Math.max(1, total) * 115}`).join(" ");
  return <div className="activity-chart-scroll"><div className="activity-chart">
    {view === "Daily" ? <div className="activity-heatmap" aria-label="Daily token activity">{days.map((day, index) => <button key={day.date} data-tooltip-managed data-level={level(day.tokens, max)} aria-label={`${dateLabel(day.date)}: ${full.format(day.tokens)} tokens`} data-tooltip={`${dateLabel(day.date)} · ${full.format(day.tokens)} tokens`} tabIndex={focused === index ? 0 : -1} onFocus={() => setFocused(index)} onKeyDown={(event) => { const offset = { ArrowUp: -1, ArrowDown: 1, ArrowLeft: -7, ArrowRight: 7 }[event.key]; if (offset !== undefined) { event.preventDefault(); const next = Math.max(0, Math.min(days.length - 1, index + offset)); setFocused(next); event.currentTarget.parentElement?.querySelectorAll("button")[next]?.focus(); } }} />)}</div> : view === "Weekly" ? <div className="activity-weekly" aria-label="Weekly token activity">{weeks.map((week) => <button key={week.date} data-tooltip-managed style={{ height: `${Math.max(3, week.tokens / Math.max(1, ...weeks.map((w) => w.tokens)) * 100)}%` }} data-tooltip={`Week of ${dateLabel(week.date)} · ${full.format(week.tokens)} tokens`} aria-label={`Week of ${dateLabel(week.date)}: ${full.format(week.tokens)} tokens`} />)}</div> : <div className="activity-cumulative"><span>{compact.format(total)} tokens in the past year</span><svg viewBox="0 0 900 140" role="img" aria-label={`Cumulative token usage over the past year: ${full.format(total)} tokens`} preserveAspectRatio="none"><path d={`${path} L900,140 L0,140 Z`} className="activity-chart-fill" /><path d={path} className="activity-chart-line" /></svg></div>}
    <div className="activity-months">{months.map((month, index) => <span key={weeks[index]?.date}>{month}</span>)}</div>
  </div></div>;
}
