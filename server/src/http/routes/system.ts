/** Health, projects and folders, attachment parsing and the activity dashboard. */
import type { FastifyInstance } from "fastify";
import type { ActivityOut, ParsedFileOut } from "@octopus/shared";
import { WorkspaceInSchema, WorkspacePatchSchema } from "@octopus/shared";
import type { Registry } from "../../db/registry";
import { Conversation } from "../../engine/conversation";
import { config } from "../../config";
import { notFound, UserError } from "../../lib/util";
import { availability, pickDirectory } from "../../services/dialog";
import { addWorkspace, browse, closeProject, project, workspaceOut } from "../../workspace/projects";
import type { RouteFn } from "../router";

const TEXT_LIMIT = 400_000;

async function parseUpload(filename: string, mime: string, data: Buffer): Promise<ParsedFileOut> {
  if (mime.startsWith("image/")) {
    if (data.length > 10_000_000) throw new UserError("Images up to 10 MB");
    return { filename, kind: "image", mime, text: "", chars: 0, truncated: false, data: `data:${mime};base64,${data.toString("base64")}` };
  }
  let text: string;
  if (mime === "application/pdf" || filename.toLowerCase().endsWith(".pdf")) {
    const { extractText } = await import("unpdf");
    const out = await extractText(new Uint8Array(data), { mergePages: true });
    text = Array.isArray(out.text) ? out.text.join("\n\n") : out.text;
  } else {
    if (data.subarray(0, 8000).includes(0)) throw new UserError(`${filename} looks like a binary file; attach text, code, PDF or images`);
    text = data.toString("utf8");
  }
  return { filename, kind: "text", mime, text: text.slice(0, TEXT_LIMIT), chars: text.length, truncated: text.length > TEXT_LIMIT };
}

function activity(reg: Registry, tz: string | undefined): ActivityOut {
  const day = (iso: string) => new Date(iso).toLocaleDateString("en-CA", { timeZone: tz || undefined });
  const days = new Map<string, number>();
  const projects: ActivityOut["projects"] = [];
  const tools = new Map<string, number>();
  const effort = new Map<string, number>();
  let unavailable = 0;
  let longest = 0;
  for (const w of reg.workspaces.find()) {
    let p;
    try { p = project(reg, w.id); } catch { unavailable++; continue; }
    let tokens = 0;
    for (const r of p.db.runs.find()) {
      tokens += r.tokens_used;
      days.set(day(r.created_at), (days.get(day(r.created_at)) ?? 0) + r.tokens_used);
      if (r.started_at && r.ended_at) longest = Math.max(longest, (Date.parse(r.ended_at) - Date.parse(r.started_at)) / 1000);
      const e = r.budget.reasoning_effort ?? "default";
      effort.set(e, (effort.get(e) ?? 0) + 1);
    }
    for (const t of p.db.db.all<{ tool: string; n: number }>("SELECT json_extract(data, '$.tool') AS tool, COUNT(*) AS n FROM run_events WHERE type = 'tool_call' GROUP BY tool"))
      tools.set(t.tool, (tools.get(t.tool) ?? 0) + Number(t.n));
    projects.push({ id: w.id, name: w.name, tokens });
  }
  const sorted = [...days.entries()].sort(([a], [b]) => a.localeCompare(b));
  const active = new Set(sorted.filter(([, n]) => n > 0).map(([d]) => d));
  const streak = (from: Date) => { let n = 0; const d = new Date(from); while (active.has(d.toLocaleDateString("en-CA", { timeZone: tz || undefined }))) { n++; d.setDate(d.getDate() - 1); } return n; };
  let longestStreak = 0, run = 0, prev = "";
  for (const d of [...active].sort()) {
    run = prev && (Date.parse(d) - Date.parse(prev)) / 86_400_000 === 1 ? run + 1 : 1;
    longestStreak = Math.max(longestStreak, run);
    prev = d;
  }
  const totalRuns = [...effort.values()].reduce((a, b) => a + b, 0);
  const [topEffort, topCount] = [...effort.entries()].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
  return {
    days: sorted.map(([date, tokens]) => ({ date, tokens })), lifetime_tokens: sorted.reduce((n, [, t]) => n + t, 0),
    peak_tokens: Math.max(0, ...sorted.map(([, t]) => t)), active_days: active.size, current_streak: streak(new Date()), longest_streak: longestStreak,
    longest_task_seconds: Math.round(longest), most_used_reasoning: topEffort, reasoning_percent: totalRuns ? Math.round((topCount / totalRuns) * 100) : 0,
    projects: projects.sort((a, b) => b.tokens - a.tokens), tools: [...tools.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, 12),
    unavailable_projects: unavailable,
  };
}

export function systemRoutes(route: RouteFn, app: FastifyInstance, reg: Registry) {
  route("GET", "/api/health", () => ({ ok: true, app: config.appName, live_runs: Conversation.liveCount() }));
  route("GET", "/api/v1/activity", ({ query }) => activity(reg, query.tz));

  route("GET", "/api/v1/fs/browse", ({ query }) => browse(query.path, !!query.show_hidden));
  route("GET", "/api/v1/fs/native", () => availability());
  route("POST", "/api/v1/fs/native/pick", async ({ req }) => {
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.ip)) throw new UserError("The folder dialog opens only for a browser on this computer", 403);
    const picked = await pickDirectory();
    return picked ? { cancelled: false, path: picked } : { cancelled: true, path: null };
  });

  route("GET", "/api/v1/workspaces", () => reg.workspaces.find("1=1", [], "last_opened_at DESC").map(workspaceOut));
  route("POST", "/api/v1/workspaces", WorkspaceInSchema, ({ body }) => addWorkspace(reg, body.path, body.name));
  route("GET", "/api/v1/workspaces/{workspace_id}", ({ params }) => {
    const w = reg.workspaces.get(params.workspace_id);
    if (!w) throw notFound("Project");
    return workspaceOut(w);
  });
  route("PATCH", "/api/v1/workspaces/{workspace_id}", WorkspacePatchSchema, ({ params, body }) => {
    const w = reg.workspaces.get(params.workspace_id);
    if (!w) throw notFound("Project");
    return workspaceOut(reg.workspaces.update(w.id, { name: body.name?.trim() || w.name })!);
  });
  route("DELETE", "/api/v1/workspaces/{workspace_id}", ({ params }) => {
    closeProject(params.workspace_id);
    reg.workspaces.remove(params.workspace_id);
    return { ok: true };
  });

  app.post("/api/v1/files/parse", async (req) => {
    const file = await req.file({ limits: { fileSize: 20_000_000 } });
    if (!file) throw new UserError("Attach a file");
    return parseUpload(file.filename, file.mimetype, await file.toBuffer());
  });
}
