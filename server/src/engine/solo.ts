/**
 * A solo conversation: one main agent works alone in one transcript, as a single coding agent does. The transcript lasts
 * for the whole conversation and is kept on disk. Its instructions and tools are fixed when it starts. Project facts
 * arrive as runtime-context messages, only when they change. A turn runs until the model replies without a tool call,
 * and that reply is what the user sees. A question to the user, a step or token limit, or a stop ends a turn early.
 *
 * The review floor runs when a turn would end with a reply. The project checks run first, and a failure goes back to the main
 * agent, at most three times a request. A diff at normal or high tier then gets a reviewer unless a review already covers it.
 * Blocker and major findings go back to the main agent in the same turn, for at most two floor rounds.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { AgentOut, AgentStatus, Effort, MessageOut, Question, Requirement, RunEventMap, RunStatus, RunTopic, SpecialistName, Usage } from "@octopus/shared";
import { skillCatalog, effectiveSkills } from "../catalog/skills";
import { config } from "../config";
import type { Registry } from "../db/registry";
import { SessionLog, trimToFinishedStep } from "../db/sessionLog";
import type { Item } from "../llm/azure";
import { renderOpenItems } from "../lib/findings";
import { clip, firstLine, newId, sha1 } from "../lib/util";
import { soloToolbox } from "../tools";
import type { Shown, Tool, ToolContext } from "../tools/types";
import type { Project } from "../workspace/projects";
import { CHECK_LIMIT, projectOverview } from "../workspace/overview";
import { rulesUpdate, type RulesSent } from "../workspace/instructions";
import { agentLoop, type LoopEvents } from "./agent";
import { checkBlockMessage, describeChecks, planChecks, runCheckList, type ChecksOutcome } from "./checks";
import { DOC_OR_ASSET } from "./checkScope";
import { fill, MAIN_PROMPT, runtimeContext } from "./prompts";
import { reviewersFor, tierOf } from "./risk";
import { Specialists, specialistSettings, type Seat } from "./specialists";

const WORDS = ["zero", "one", "two", "three", "four", "five"];
/** A count in words with its noun in the plural: "two review rounds". Settings allows one to five. */
const times = (n: number, noun: string) => `${WORDS[n]} ${noun}${n === 1 ? "" : "s"}`;
const sentence = (s: string) => `${s[0]!.toUpperCase()}${s.slice(1)}`;

/** What the solo path needs from its conversation. The conversation owns the run row, the events and the messages. */
export interface SoloHost {
  readonly p: Project;
  readonly reg: Registry;
  readonly runId: string;
  readonly state: { questions: { question: Question; task_id: string | null }[]; usage: Usage };
  lead(): AgentOut;
  emit<T extends RunTopic>(type: T, data: RunEventMap[T]): void;
  post(message: { type: string; content: string; meta?: Record<string, unknown> }): MessageOut;
  /** Adds a turn's reply to the run's report, under the request that started the turn. */
  recap(title: string, text: string): void;
  setRunStatus(status: RunStatus, extra?: { reason?: string; summary?: string }): void;
  /** Aborts when the user stops the conversation. */
  signal(): AbortSignal;
  /** The run's requirements list, which shows the verifier's asks. */
  requirements(): Requirement[];
  setRequirements(list: Requirement[]): void;
  setStatus(agent: AgentOut, status: AgentStatus, activity?: string): void;
  loopEvents(agent: AgentOut): LoopEvents;
  toolContext(agent: AgentOut, memory: { seen: Map<string, string>; shown: Shown }): ToolContext;
  /** A specialist's seat in this company. The first use of each one adds its agent to the canvas. */
  seat(name: SpecialistName): Seat;
  notes(): { key: string; value: string }[];
  model(agent: AgentOut): string;
  effort(agent: AgentOut): Effort | undefined;
  finish(reason: string, status: RunStatus): void;
}

/** One transcript: what the model sees, and what the engine keeps about it. */
interface Transcript {
  items: Item[];
  /** Leading items that compaction keeps word for word: the first runtime context and the first request. */
  head: number;
  /** The last runtime context written, without the project overview; null before the first one. */
  context: string | null;
  /** Whether the skill catalog is in the transcript. It goes in once, at the start of the session. */
  catalog: boolean;
  /** The project rules files sent so far, by name. A file that changes gets a new message; the sent ones stay as they are. */
  rules: RulesSent;
  tools: Tool[];
  instructions: string;
  /** File contents the transcript already holds, so an unchanged read is not sent twice. */
  seen: Map<string, string>;
  shown: Shown;
}

/** How a turn ended, once no more of it can run. */
type Outcome =
  | { kind: "reply"; text: string }
  | { kind: "ask"; question: string; options: Question["options"] }
  | { kind: "pause"; reason: "steps" | "tokens" };

/** Raised from the step hook when the turn has spent its token budget. */
class TokenBudgetSpent extends Error {}

/** The text of the last model message in a transcript, or "" when there is none. */
function lastReply(items: Item[]): string {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    if (item.type === "message" && item.role === "assistant") return (item.content ?? []).map((c: Item) => c.text ?? "").join("").trim();
  }
  return "";
}

export class SoloRun {
  /** True while a turn is running. */
  running = false;
  private transcript: Transcript | null = null;
  private log: SessionLog;
  /** User messages sent during a turn. They reach the model before its next step. */
  private steer: { item: Item; text: string }[] = [];
  /** The request that started the turn in flight: the heading of its part of the report. */
  private turnTitle = "";
  /** The user's messages for the turn in flight, verbatim. A message sent while the turn runs joins them. */
  private turnMessages: string[] = [];
  /** The first line of every request in this conversation, in order. */
  private requests: string[] = [];
  /** The first line of each request before the turn in flight. */
  private earlier: string[] = [];
  /** Each file the turn changed, with its content before the turn first changed it. */
  private turnBefore = new Map<string, string | null>();
  private turnChanges = 0;
  private floorRounds = 0;
  /** Failing-check messages sent in the turn in flight. */
  private checkBlocks = 0;
  /** Keys of the file contents that passed the project checks in this conversation. */
  private checksPassed = new Set<string>();
  /** Why the turn ends incomplete, when the floor ran out of rounds with findings still open. */
  private incomplete: string | null = null;
  private stopping: { reason: string; status: RunStatus } | null = null;
  private turnSteps = 0;
  private turnTools = 0;
  private turnTokens = 0;
  /** Files this conversation has changed, for the usage counter. */
  private changed = new Set<string>();
  private specialists: Specialists;

  constructor(private readonly host: SoloHost) {
    this.log = new SessionLog(path.join(host.p.root, ".octopus", "sessions", `${host.runId}.jsonl`));
    this.specialists = new Specialists(host, () => ({
      messages: this.turnMessages, earlier: this.earlier, before: this.turnBefore, changes: this.turnChanges,
    }), () => this.checkChanges());
  }

  /** A user message, verbatim, with its images. It starts a turn, or joins the running one before its next step. */
  submit(content: string, images: Item[]) {
    const item: Item = { role: "user", content: images.length ? [{ type: "input_text", text: content }, ...images] : content };
    // A message sent while a question waits is the answer to it.
    this.host.state.questions.splice(0);
    if (this.running) {
      this.steer.push({ item, text: content });
      this.turnMessages.push(content);
    } else void this.run([item], [content]);
  }

  /** Ends the turn in flight, if any. The transcript is trimmed to its last finished step and kept. */
  stop(reason: string, status: RunStatus) {
    this.steer = [];
    this.stopping = { reason, status };
    if (!this.running) this.finishStop();
  }

  private finishStop() {
    const stop = this.stopping;
    this.stopping = null;
    if (stop) this.host.finish(stop.reason, stop.status);
  }

  private async run(first: Item[], messages: string[]) {
    this.running = true;
    this.turnTitle = messages[0]!;
    this.turnMessages = [...messages];
    this.earlier = [...this.requests];
    this.requests.push(firstLine(messages[0]!, 200));
    this.turnBefore = new Map();
    this.turnChanges = 0;
    this.floorRounds = 0;
    this.checkBlocks = 0;
    this.incomplete = null;
    this.specialists.startTurn();
    this.turnSteps = 0;
    this.turnTools = 0;
    this.turnTokens = 0;
    this.host.state.usage.agent_runs++;
    this.host.emit("turn_started", { agent_id: this.host.lead().id });
    let next = first;
    try {
      const t = this.transcript ?? (this.transcript = await this.open());
      this.host.setRunStatus("running", { reason: "" });
      for (;;) {
        this.begin(t, next);
        next = [];
        const outcome = await this.segment(t);
        if (this.stopping) break;
        if (outcome.kind === "reply" && !this.steer.length) {
          const sent = await this.floor(outcome.text);
          if (this.stopping) break;
          if (sent) {
            next = [sent];
            continue;
          }
        }
        if (this.steer.length) {
          next = this.steer.splice(0).map((s) => s.item);
          continue;
        }
        this.conclude(t, outcome);
        break;
      }
    } catch (e) {
      if (!this.stopping) {
        this.host.emit("error", { message: (e as Error).message, kind: "error" });
        this.host.setRunStatus("failed", { reason: (e as Error).message });
      }
    } finally {
      this.running = false;
      if (this.transcript) this.settle(this.transcript);
      this.host.setStatus(this.host.lead(), "idle");
      if (this.stopping) {
        const queued = this.steer.splice(0);
        this.finishStop();
        if (queued.length) void this.run(queued.map((s) => s.item), queued.map((s) => s.text));
      }
    }
  }

  private async open(): Promise<Transcript> {
    const lead = this.host.lead();
    this.specialists.configure(specialistSettings(this.host.reg));
    const { tools, warnings } = await soloToolbox(this.host.reg, this.host.p.root, lead);
    for (const message of warnings) this.host.emit("error", { message, kind: "warning", agent_id: lead.id });
    const model = this.host.model(lead);
    const stored = this.log.load(model);
    const items = stored?.items ?? [];
    const keep = trimToFinishedStep(items);
    items.length = keep;
    return {
      items, head: Math.min(stored?.meta.head ?? 0, keep), context: stored?.meta.context ?? null, tools,
      catalog: stored?.meta.catalog ?? false,
      rules: stored?.meta.rules ?? {},
      instructions: fill(MAIN_PROMPT, { model }), seen: new Map(), shown: new Map(),
    };
  }

  /** Adds the runtime context when it changed, then the messages that start this step. */
  private begin(t: Transcript, items: Item[]) {
    for (const [rel, hash] of t.seen) {
      if (this.hashOf(rel) !== hash) {
        t.seen.delete(rel);
        t.shown.delete(rel);
      }
    }
    if (!t.catalog) {
      t.catalog = true;
      const catalog = skillCatalog(effectiveSkills(this.host.reg));
      if (catalog) t.items.push({ role: "user", content: catalog });
    }
    const rules = rulesUpdate(this.host.p.root, t.rules);
    if (rules) {
      t.items.push({ role: "user", content: rules.message });
      t.rules = rules.sent;
    }
    const context = this.context();
    const stable = runtimeContext({ ...context, overview: null });
    if (stable !== t.context) {
      // The overview goes in the first runtime context only, so later ones do not repeat it.
      const overview = t.context === null ? projectOverview(this.host.p.fs) : null;
      t.items.push({ role: "user", content: runtimeContext({ ...context, overview }) });
      t.context = stable;
    }
    t.items.push(...items);
    if (!t.head) t.head = t.items.length;
    this.save(t);
  }

  private context() {
    const windows = process.platform === "win32";
    return {
      root: this.host.p.root,
      platform: windows ? "Windows" : process.platform === "darwin" ? "macOS" : "Linux",
      shell: windows ? "PowerShell" : "bash",
      approvalMode: this.host.reg.setting<string>("approval_mode", "ask"),
      date: new Date().toISOString().slice(0, 10),
      notes: this.host.notes(),
    };
  }

  /** Runs model steps until the turn ends, asks the user, or reaches a limit. */
  private async segment(t: Transcript): Promise<Outcome> {
    const lead = this.host.lead();
    const base = this.host.loopEvents(lead);
    const events: LoopEvents = {
      ...base,
      toolResult: (callId, tool, ok, output, metrics) => {
        this.turnTools++;
        base.toolResult(callId, tool, ok, output, metrics);
      },
      usage: (r) => {
        // Cached input is reused, not new work, so only the uncached part of the input counts toward the budget.
        this.turnTokens += r.usage.input - r.usage.cached + r.usage.output;
        base.usage(r);
      },
      beforeCall: async () => {
        if (this.turnTokens >= config.soloTurnTokens) throw new TokenBudgetSpent("tokens");
        this.turnSteps++;
        await base.beforeCall();
      },
    };
    try {
      const res = await agentLoop({
        reg: this.host.reg, model: this.host.model(lead), effort: this.host.effort(lead), instructions: t.instructions, input: t.items, tools: t.tools,
        ctx: this.toolContext(t), events, maxRounds: Math.max(0, config.soloStepLimit - this.turnSteps), requireStop: false, stopTools: [],
        keepHead: t.head, steer: () => this.steer.splice(0).map((s) => s.item), persist: () => this.save(t),
        cacheKey: `${this.host.runId}:${lead.id}:solo`,
      });
      if (res.stop?.kind === "ask") return { kind: "ask", question: res.stop.question, options: res.stop.options };
      if (res.exhausted) return { kind: "pause", reason: "steps" };
      return { kind: "reply", text: res.text.trim() };
    } catch (e) {
      if (e instanceof TokenBudgetSpent) return { kind: "pause", reason: "tokens" };
      throw e;
    }
  }

  private toolContext(t: Transcript): ToolContext {
    const ctx = this.host.toolContext(this.host.lead(), { seen: t.seen, shown: t.shown });
    const recordFile = ctx.recordFile;
    return {
      ...ctx,
      specialists: this.specialists,
      recordFile: (rel, before, after, note) => {
        recordFile(rel, before, after, note);
        this.changed.add(rel);
        if (!this.turnBefore.has(rel)) this.turnBefore.set(rel, before);
        this.turnChanges++;
        this.host.state.usage.files_changed = this.changed.size;
      },
    };
  }

  /**
   * The review floor, run when a reply would end the turn. The project checks run first, because they cost no model call:
   * a failure goes back to the main agent as one message, for at most the check blocks Settings allows a request. Then the
   * enabled reviewers run for a normal or high diff that no review covers, and their blocker and major findings go back the
   * same way, for at most the review rounds Settings allows. Last, the verifier checks the request's asks for a normal or high
   * code change it has not checked yet, and an ask it finds unmet goes back the same way, for at most the verify rounds.
   * Null lets the reply go out.
   */
  private async floor(reply: string): Promise<Item | null> {
    const cap = this.specialists.caps;
    if (!cap.floor) return null;
    const checks = await this.checkChanges();
    if (checks.stopped) return null;
    if (checks.failing.length) {
      if (this.checkBlocks === cap.check_blocks) {
        this.incomplete = `Checks still fail after ${cap.check_blocks} check block${cap.check_blocks === 1 ? "" : "s"}: ${checks.failing.map((f) => f.name).join(", ")}.`;
        return null;
      }
      this.checkBlocks++;
      return { role: "user", content: checkBlockMessage(checks.failing) };
    }
    const diff = this.specialists.requestDiff();
    const tier = tierOf({
      files: diff.map((d) => d.file), lines: diff.reduce((sum, d) => sum + d.lines, 0), specialists: 0, requirements: 0, revised: this.floorRounds > 0,
    });
    const deep = tier === "normal" || tier === "high";
    const browser = this.host.lead().tools.browser === true;
    const reviewers = reviewersFor(diff.map((d) => d.file), browser).filter((n) => this.specialists.enabled(n));
    // A fix to a change a reviewer sent back is checked again at any tier, because its findings are answered only by a check.
    if (reviewers.length && (deep || this.specialists.blockingFindings().length > 0) && this.specialists.reviewDue()) {
      if (this.floorRounds === cap.floor_rounds) {
        const open = this.specialists.blockingFindings().length;
        this.incomplete = open
          ? `${sentence(times(cap.floor_rounds, "review round"))} ended with ${open} blocker or major finding${open === 1 ? "" : "s"} open.`
          : `The last change was not reviewed: ${times(cap.floor_rounds, "review round")} had already run.`;
        return null;
      }
      this.floorRounds++;
      const round = await this.specialists.check(reviewers, reply, checks.text);
      if (round.blocking) return { role: "user", content: round.text };
    }
    const codeChanged = [...this.turnBefore.keys()].some((f) => !DOC_OR_ASSET.test(f));
    if (!deep || !codeChanged || !this.specialists.enabled("verifier") || !this.specialists.verifyDue()) return null;
    if (this.specialists.verifyRoundCount() === cap.verify_rounds) {
      this.incomplete = this.notMetReason();
      return null;
    }
    const verdict = await this.specialists.verify(reply, checks.text);
    if (!verdict.unmet) return null;
    if (this.specialists.verifyRoundCount() === cap.verify_rounds) {
      this.incomplete = this.notMetReason();
      return null;
    }
    return { role: "user", content: verdict.text };
  }

  /** Why the verifier's last round leaves the request incomplete: the asks it did not meet, or that it submitted none. */
  private notMetReason(): string {
    const ids = this.specialists.unmetAsks().map((a) => a.id);
    const rounds = sentence(times(this.specialists.caps.verify_rounds, "acceptance check"));
    return ids.length ? `${rounds} left ${ids.join(", ")} not met.` : `${rounds} did not submit their asks.`;
  }
  /** Why a reply cannot count as completed, or null when it can: a floor that ran out, an open blocker, or an ask not met. */
  private unfinished(): string | null {
    if (this.incomplete) return this.incomplete;
    const open = this.specialists.blockingFindings().length;
    if (open) return `${open} blocker or major finding${open === 1 ? "" : "s"} open.`;
    const unmet = this.specialists.unmetAsks();
    return unmet.length ? `Not met: ${unmet.map((a) => a.id).join(", ")}.` : null;
  }

  /**
   * Runs the project checks for the files this request changed. No model call is made. The run is announced in a status
   * message that names each check and the checks left out, and each check's events go to the feed.
   */
  private async checkChanges(): Promise<ChecksOutcome> {
    const changed = [...this.turnBefore.keys()];
    if (!changed.length) return { text: "No project file changed.", failing: [], stopped: false };
    const plan = planChecks(this.host.p.fs, changed, this.checksPassed);
    if (plan.kind === "none") return { text: "The project has no automated checks.", failing: [], stopped: false };
    if (plan.kind === "skipped") return { text: `Not run: ${plan.reason}.`, failing: [], stopped: false };
    if (plan.kind === "passed") return { text: "Passed earlier in this conversation, with the same files.", failing: [], stopped: false };
    const lead = this.host.lead();
    const left = plan.left.length ? `Left out, over the limit of ${CHECK_LIMIT}: ${plan.left.join(", ")}.` : "Left out: none.";
    this.host.post({ type: "status_update", content: `Running the project checks: ${plan.checks.map((c) => c.name).join(", ")}. ${left}` });
    let callId = "";
    const results = await runCheckList(this.host.p.fs, plan.checks, this.host.signal(), {
      stopped: () => this.stopping !== null,
      started: (c) => {
        callId = newId();
        this.host.setStatus(lead, "running", c.command);
        this.host.emit("tool_call", { call_id: callId, agent_id: lead.id, tool: "run_code", args: { command: c.command, cwd: c.directory } });
      },
      finished: (_c, ok, output) => this.host.emit("tool_result", { call_id: callId, agent_id: lead.id, tool: "run_code", ok, output: clip(output, 4000) }),
    });
    this.host.setStatus(lead, "idle");
    if (!results) return { text: "", failing: [], stopped: true };
    this.host.state.usage.verifications += results.length;
    const failing = results.filter((r) => !r.ok);
    if (!failing.length) this.checksPassed.add(plan.key);
    return { text: describeChecks(results), failing, stopped: false };
  }

  private conclude(t: Transcript, outcome: Outcome) {
    const lead = this.host.lead();
    if (outcome.kind === "ask") {
      this.host.state.questions.push({ question: { agent_id: lead.id, question: outcome.question, options: outcome.options, allow_other: true }, task_id: null });
      this.host.post({ type: "question", content: outcome.question, meta: { awaiting_input: true, options: outcome.options } });
      this.host.setRunStatus("awaiting_user", { reason: "Waiting for your answer" });
      return;
    }
    if (outcome.kind === "reply") {
      const body = outcome.text || "The model returned no reply.";
      const open = this.openItems();
      const text = open ? `${body}\n\n${open}` : body;
      this.host.post({ type: "final_report", content: text });
      this.host.recap(this.turnTitle, text);
      const reason = this.unfinished();
      this.host.setRunStatus(reason ? "incomplete" : "completed", { summary: firstLine(text, 300), reason: reason ?? "" });
      return;
    }
    const text = this.pauseText(t, outcome.reason);
    this.host.post({ type: "final_report", content: text });
    this.host.setRunStatus("awaiting_user", { reason: "Paused: reply to continue", summary: firstLine(text, 300) });
  }

  /** The open items a reply lists: the last review's minor notes, and its blockers when the run ends incomplete. */
  private openItems(): string {
    const blocking = this.unfinished() ? this.specialists.blockingFindings() : [];
    return renderOpenItems([...blocking, ...this.specialists.minorFindings()]);
  }

  private pauseText(t: Transcript, reason: "steps" | "tokens"): string {
    const where = reason === "steps" ? `at the ${config.soloStepLimit}-step limit` : "at the token budget for this turn";
    const said = lastReply(t.items);
    return [`Paused ${where}, after ${this.turnSteps} steps and ${this.turnTools} tool calls.`, said && clip(said, 1500), "Reply to continue the work from here."]
      .filter(Boolean).join("\n\n");
  }

  /** Keeps the transcript up to its last finished step, and writes it to disk. */
  private settle(t: Transcript) {
    const keep = trimToFinishedStep(t.items);
    t.items.length = keep;
    t.head = Math.min(t.head, keep);
    this.save(t);
  }

  private save(t: Transcript) {
    this.log.save({ model: this.host.model(this.host.lead()), head: t.head, context: t.context, catalog: t.catalog, rules: t.rules }, t.items);
  }

  private hashOf(rel: string): string | null {
    try {
      const abs = this.host.p.fs.abs(rel);
      return existsSync(abs) ? sha1(readFileSync(abs, "utf8")) : null;
    } catch {
      return null;
    }
  }
}
