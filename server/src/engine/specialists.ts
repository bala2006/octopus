/**
 * The read-only specialists: reviewer (correctness), security, designer (how the UI looks), explorer (answers one
 * question) and verifier (checks each ask of the user's messages by running the product). Each has one prompt and one
 * skill under catalog/specialists, a toolbox and an effort. Its instructions are the prompt followed by the skill, and they
 * never change, so every round reuses the cached prefix. Each specialist keeps
 * one session per conversation, so a later round continues the earlier one. A call that finds the session busy, such as a
 * second explore in the same step, gets a fresh session for itself.
 *
 * A review round briefs its reviewers from the request's facts. The first round of a request sends the user's messages,
 * the main agent's account, the project checks and the diff since the request started. A later round sends the findings
 * it answers, the main agent's answer and the diff since the last round.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SPECIALIST_NAMES, type AgentOut, type AgentStatus, type Effort, type EdgeOut, type Requirement, type RoleTemplateOut, type RunEventMap, type RunTopic, type SpecialistName, type SpecialistsSettings } from "@octopus/shared";
import { config } from "../config";
import type { Registry } from "../db/registry";
import type { Item } from "../llm/azure";
import { briefDiff, changedLines, type FileDiff } from "../lib/diff";
import { numberFindings, renderFindings, renderOpenItems, reviewReport, type CriticReport, type Finding, type FindingInput } from "../lib/findings";
import { enterRound, leaveRound, type Restored } from "../workspace/snapshot";
import type { Project } from "../workspace/projects";
import { specialistToolbox, type SpecialistTool } from "../tools";
import { CHECK_REFUSAL } from "../tools/commands";
import type { ReviewerName, Shown, ToolContext } from "../tools/types";
import { agentLoop, type LoopEvents } from "./agent";
import type { ChecksOutcome } from "./checks";
import { foldVerdicts, toRequirement, verdictMessage, type Ask, type Verdict } from "./acceptance";

export interface SpecialistDef {
  name: SpecialistName;
  title: string;
  effort: Effort;
  tools: readonly SpecialistTool[];
  /** How a round ends: a submit_review call with a verdict, a plain text answer, or a submit_acceptance call with an entry per ask. */
  ends: "review" | "answer" | "verdict";
  instructions: string;
}

const CATALOG = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "catalog", "specialists");
const read = (name: SpecialistName, file: "prompt.md" | "SKILL.md") => readFileSync(path.join(CATALOG, name, file), "utf8").trim();
const instructionsOf = (name: SpecialistName) => `${read(name, "prompt.md")}\n\n${read(name, "SKILL.md")}`;

const CHECKS: readonly SpecialistTool[] = ["read_file", "glob", "grep", "shell"];

export const SPECIALIST_DEFS: Record<SpecialistName, SpecialistDef> = {
  reviewer: { name: "reviewer", title: "Reviewer", effort: "medium", tools: [...CHECKS, "submit_review"], ends: "review", instructions: instructionsOf("reviewer") },
  security: { name: "security", title: "Security reviewer", effort: "high", tools: [...CHECKS, "fetch_url", "submit_review"], ends: "review", instructions: instructionsOf("security") },
  designer: { name: "designer", title: "Designer", effort: "high", tools: [...CHECKS, "start_dev_server", "browser", "submit_review"], ends: "review", instructions: instructionsOf("designer") },
  explorer: { name: "explorer", title: "Explorer", effort: "low", tools: [...CHECKS, "fetch_url"], ends: "answer", instructions: instructionsOf("explorer") },
  verifier: { name: "verifier", title: "Verifier", effort: "high", tools: [...CHECKS, "start_dev_server", "browser", "submit_acceptance"], ends: "verdict", instructions: instructionsOf("verifier") },
};

/** The settings a new conversation uses until Settings saves its own: every specialist on, at its default effort and the configured model. */
export function specialistDefaults(): SpecialistsSettings {
  const specialists = Object.fromEntries(SPECIALIST_NAMES.map((n) => [n, { enabled: true, model: config.defaultModel, effort: SPECIALIST_DEFS[n].effort }])) as SpecialistsSettings["specialists"];
  return { specialists, review: { floor: true, floor_rounds: 2, check_blocks: 3, verify_rounds: 2 } };
}

/** The specialist settings Settings holds now. A conversation reads them once, when it starts. */
export function specialistSettings(reg: Registry): SpecialistsSettings {
  return reg.setting<SpecialistsSettings | null>("specialists", null) ?? specialistDefaults();
}

/** The company role of a specialist. It is not in the role library, so it never appears in the hire list. */
export function specialistRole(name: SpecialistName): RoleTemplateOut {
  const def = SPECIALIST_DEFS[name];
  return {
    key: `specialist-${name}`, role: def.title, default_name: def.title, category: "Quality & Ops", color: "#8A8780", avatar: "search",
    description: `${def.title}: checks the main agent's work or answers a question, read-only.`, system_prompt: def.instructions,
    tools: { file_read: true, file_write: false, terminal: true, browser: def.tools.includes("browser"), web_search: def.tools.includes("fetch_url"), ask_user: false, send_message: false, mcp_servers: [] },
    source: "builtin",
  };
}

/** The most one round returns to the main agent, in characters. A message is kept under 6,000 characters with room to spare. */
export const RETURN_LIMIT = 5_900;
/** Steps one specialist round may take before it is stopped. */
const ROUND_STEPS = 60;
/** Written to the transcript when a specialist round cannot be undone. */
const UNDOABLE_WARNING = "This project is over the 64 MB limit for the undo record, so the checks in this round cannot be undone. Files they change stay changed.";

/** A specialist's place in the company: its agent, and the two channels between it and Octopus. */
export interface Seat { agent: AgentOut; delegate: EdgeOut; report: EdgeOut }

/** What a specialist round needs from its conversation. The solo path implements it. */
export interface SpecialistHost {
  readonly p: Project;
  readonly reg: Registry;
  readonly runId: string;
  lead(): AgentOut;
  seat(name: SpecialistName): Seat;
  emit<T extends RunTopic>(type: T, data: RunEventMap[T]): void;
  setStatus(agent: AgentOut, status: AgentStatus, activity?: string): void;
  loopEvents(agent: AgentOut): LoopEvents;
  toolContext(agent: AgentOut, memory: { seen: Map<string, string>; shown: Shown }): ToolContext;
  requirements(): Requirement[];
  setRequirements(list: Requirement[]): void;
}

/** The request a review is about. The solo path keeps these up to date as the turn runs. */
export interface RequestFacts {
  /** The user's messages for this request, verbatim, in the order they came. */
  messages: string[];
  /** The first line of each earlier request in this conversation. */
  earlier: string[];
  /** Each file this request changed, with its content before the request first changed it. */
  before: Map<string, string | null>;
  /** How many file changes this request has made. */
  changes: number;
}

/** What one review round returns: the message for the main agent, and how many of its findings block the reply. */
export interface ReviewRound { text: string; blocking: number; /** The reviewers that ended a round without a verdict. */ silent: ReviewerName[] }
/** What one verifier round returns: the message for the main agent, and how many asks are not met. */
export interface VerifyRound { text: string; unmet: number }

interface Session { items: Item[]; busy: boolean; seen: Map<string, string>; shown: Shown }
interface Outcome { verdict: CriticReport["verdict"]; findings: FindingInput[]; text: string; asks?: Verdict[] }
/** The commands that ran in the rounds that share one project snapshot, with the specialist that ran each. */
interface Group { ran: { name: SpecialistName; command: string }[] }

const fresh = (): Session => ({ items: [], busy: false, seen: new Map(), shown: new Map() });

/** Each conversation holds one of these. It runs specialist rounds and answers the main agent's review and explore calls. */
export class Specialists {
  private sessions = new Map<SpecialistName, Session>();
  private open = 0;
  private group: Group = { ran: [] };
  /** Review rounds this request has run, numbered from one. */
  private rounds = 0;
  /** Findings this request has numbered, so ids run on across its review rounds. */
  private found = 0;
  /** File contents at the start of the last review round. The diff since the last round is measured from them. */
  private reviewed = new Map<string, string | null>();
  /** The file change count when the last review round started. A review covers the diff until a later change. */
  private covered: number | null = null;
  /** Blocker and major findings of the last review round. */
  private blocking: Finding[] = [];
  /** Minor findings of the last review round. They are listed to the user and never sent back. */
  private minors: Finding[] = [];
  /** The reviewers of the last review round that ended without a verdict. */
  private silent: ReviewerName[] = [];
  /** The verifier's asks for this request, with the verdict on each. */
  private asks: Ask[] = [];
  /** Verifier rounds this request has run. */
  private verifyCount = 0;
  /** The file change count when the last verifier round started. A later change makes the verifier due again. */
  private verifiedAt: number | null = null;
  /** File contents when the last verifier round started. The next verifier brief shows the change since then. */
  private verifiedFrom = new Map<string, string | null>();
  /** The settings this conversation runs its specialists with, read when it starts. */
  private policy: SpecialistsSettings = specialistDefaults();

  /** `runChecks` runs the project checks for a review brief, when the caller has not run them already. */
  constructor(private readonly host: SpecialistHost, private readonly facts: () => RequestFacts, private readonly runChecks: () => Promise<ChecksOutcome>) {}

  /** Takes the settings a conversation starts with. Rounds that begin later use them. */
  configure(policy: SpecialistsSettings) {
    this.policy = policy;
  }

  /** Whether Settings turns this specialist on. */
  enabled(name: SpecialistName): boolean {
    return this.policy.specialists[name].enabled;
  }

  /** The review floor and its round caps, as this conversation runs them. */
  get caps(): SpecialistsSettings["review"] {
    return this.policy.review;
  }

  /** A new request starts. Its review rounds are numbered from one, and no earlier review covers its changes. */
  startTurn() {
    this.rounds = 0;
    this.found = 0;
    this.reviewed = new Map();
    this.covered = null;
    this.blocking = [];
    this.minors = [];
    this.silent = [];
    this.asks = [];
    this.verifiedAt = null;
    this.verifiedFrom = new Map();
  }

  /** The files this request changed, each with the lines that differ from its content before the request. */
  requestDiff(): FileDiff[] {
    return this.diffSince((file) => this.facts().before.get(file) ?? null);
  }

  /** Whether a review should run: a change came after the last review, or the last review's blockers await an answer. */
  reviewDue(): boolean {
    return this.covered !== this.facts().changes || this.blocking.length > 0;
  }

  blockingFindings(): Finding[] {
    return this.blocking;
  }

  /** The reviewers that ended the last review round without a verdict. */
  silentReviewers(): ReviewerName[] {
    return this.silent;
  }

  minorFindings(): Finding[] {
    return this.minors;
  }

  /**
   * The main agent's review call. The reviewers run at once. The verifier runs after them, and only once the project checks
   * pass. Their findings and verdicts come back as one message.
   */
  async review(names: ReviewerName[], focus: string): Promise<string> {
    const on = names.filter((n) => this.enabled(n));
    if (!on.length) return `${names.join(", ")} ${names.length === 1 ? "is" : "are"} turned off in Settings, so nothing ran.`;
    const parts: string[] = [];
    const reviewers = on.filter((n) => n !== "verifier");
    if (reviewers.length) parts.push(this.covers() ? this.reviewedMessage() : (await this.check(reviewers, focus)).text);
    if (on.includes("verifier")) parts.push(await this.verifyNow(focus));
    return parts.join("\n\n");
  }

  /** Whether a review round has run on the request's change, and no file changed since it started. */
  private covers(): boolean {
    return this.rounds > 0 && this.covered === this.facts().changes;
  }

  /** The answer to a manual review of code that a review already covers: its open blockers, and what to do before another review. */
  private reviewedMessage(): string {
    if (!this.blocking.length) return "A review already ran for this code and reported no blocker or major finding. Change the code before you ask for another review.";
    return `A review already ran for this code and reported these blockers or major findings:\n${renderOpenItems(this.blocking)}\n\nFix them, or change the code, before you ask for another review.`;
  }

  /** Runs reviewers on the request's change, and keeps their findings for the next round to check. */
  async check(names: ReviewerName[], focus: string, checks?: string): Promise<ReviewRound> {
    const round = ++this.rounds;
    const first = this.found + 1;
    const brief = await this.brief(round, focus, checks ?? (await this.runChecks()).text);
    const changes = this.facts().changes;
    this.reviewed = new Map([...this.facts().before.keys()].map((file) => [file, this.current(file)]));
    const outcomes = await this.inRound(() => Promise.all(names.map((name) => this.round(name, brief))));
    const reports: CriticReport[] = names.map((critic, i) => ({ critic, verdict: outcomes[i]!.verdict, findings: outcomes[i]!.findings }));
    const numbered = numberFindings(reports, first);
    this.found += numbered.length;
    const complete = outcomes.every((o) => o.verdict !== null);
    // A round missing a verdict keeps the findings still open, and leaves the change uncovered until a complete round runs.
    this.blocking = complete ? numbered.filter((f) => f.severity !== "minor") : [...this.blocking, ...numbered.filter((f) => f.severity !== "minor")];
    this.minors = complete ? numbered.filter((f) => f.severity === "minor") : [...this.minors, ...numbered.filter((f) => f.severity === "minor")];
    this.silent = names.filter((_, i) => outcomes[i]!.verdict === null);
    if (complete) this.covered = changes;
    this.host.emit("review_round", {
      round,
      specialists: names.map((name, i) => ({
        agent_id: this.host.seat(name).agent.id, name, verdict: outcomes[i]!.verdict,
        findings: numbered.filter((f) => f.critic === name).map(({ id, critic, severity, file, lines, problem, evidence, fix }) => ({ id, critic, severity, file, lines, problem, evidence, fix })),
      })),
    });
    const gaps = this.silent.map((name) => `\n${name} gave no verdict, so this change is not reviewed yet.`).join("");
    return { text: reviewReport(round, reports, RETURN_LIMIT, first) + gaps, blocking: this.blocking.length, silent: this.silent };
  }

  /** Asks the verifier to check the request: a round lists its asks, checks each one in the running product, and submits them. */
  async verify(focus: string, checks: string): Promise<VerifyRound> {
    const round = ++this.verifyCount;
    const brief = this.verifyBrief(round, focus, checks);
    const changesAtStart = this.facts().changes;
    this.verifiedFrom = new Map([...this.facts().before.keys()].map((file) => [file, this.current(file)]));
    const outcome = await this.inRound(() => this.round("verifier", brief));
    let next = this.host.requirements().length;
    this.asks = foldVerdicts(this.asks, outcome.asks ?? [], () => `R${++next}`);
    this.publishAsks();
    // A round that submitted no asks checked nothing, so the change stays due for another round.
    if (!this.asks.length) return { text: "The acceptance check submitted no asks.", unmet: 1 };
    this.verifiedAt = changesAtStart;
    return { text: verdictMessage(round, this.asks, RETURN_LIMIT), unmet: this.asks.filter((a) => !a.met).length };
  }

  /** The asks of this request that the verifier has not found met. */
  unmetAsks(): Ask[] {
    return this.asks.filter((a) => !a.met);
  }

  /** Whether the verifier should check the request again: a change came after its last round. */
  verifyDue(): boolean {
    return this.verifiedAt !== this.facts().changes;
  }

  /** The verifier rounds this request has run. */
  verifyRoundCount(): number {
    return this.verifyCount;
  }

  /** The verifier, when the main agent asks for it. It runs after the project checks, and only when the change is not yet verified. */
  private async verifyNow(focus: string): Promise<string> {
    const checks = await this.runChecks();
    if (checks.stopped) return "The turn was stopped.";
    if (checks.failing.length) return `The project's checks fail, so the acceptance check did not run.\n\n${checks.text}`;
    if (!this.verifyDue()) return verdictMessage(this.verifyCount, this.asks, RETURN_LIMIT);
    if (this.verifyCount === this.caps.verify_rounds) return `The acceptance check already ran ${this.caps.verify_rounds} times for this request.\n\n${verdictMessage(this.verifyCount, this.asks, RETURN_LIMIT)}`;
    return (await this.verify(focus, checks.text)).text;
  }

  /** The verifier's brief. Round one lists the user's messages; a later round lists the asks so far and the change since the last round. */
  private verifyBrief(round: number, focus: string, checks: string): string {
    const facts = this.facts();
    const messages = `The user's messages for this request, verbatim:\n${facts.messages.join("\n\n")}`;
    if (round === 1) {
      return [
        "Verify round 1 of this request. Every ask in the user's messages below is yours to check.",
        messages,
        `What the main agent says it did and how it checked it:\n${focus}`,
        `Project checks:\n${checks}`,
        `Diff since the request started:\n${briefDiff(this.requestDiff())}`,
      ].join("\n\n");
    }
    const since = (file: string) => (this.verifiedFrom.has(file) ? this.verifiedFrom.get(file)! : facts.before.get(file) ?? null);
    const asks = this.asks.map((a) => `${a.id} [${a.met ? "met" : "not met"}] ${a.ask}\n  Evidence: ${a.evidence}`).join("\n");
    return [
      `Verify round ${round} of this request. Check each ask below again in the running product, and submit every one with its id. Add an ask only for a request in the user's messages that is not listed.`,
      `Asks so far:\n${asks}`,
      messages,
      `What the main agent says it did and how it checked it:\n${focus}`,
      `Project checks:\n${checks}`,
      `Diff since the last verify round:\n${briefDiff(this.diffSince(since))}`,
    ].join("\n\n");
  }

  /** Shows the request's asks in the run's requirements list, each as met or not met with its evidence. */
  private publishAsks() {
    const current = this.host.requirements();
    const known = new Set(current.map((r) => r.id));
    const updated = current.map((r) => {
      const a = this.asks.find((x) => x.id === r.id);
      return a ? toRequirement(a) : r;
    });
    const added = this.asks.filter((a) => !known.has(a.id)).map(toRequirement);
    this.host.setRequirements([...updated, ...added]);
  }

  /** Answers one question. Several calls in one step run at the same time. */
  async explore(question: string): Promise<string> {
    if (!this.enabled("explorer")) return "The explorer is turned off in Settings.";
    const outcome = await this.inRound(() => this.round("explorer", `Question: ${question}`));
    return outcome.text ? clampAnswer(outcome.text) : "The explorer gave no answer.";
  }

  /**
   * Runs rounds inside one project record. The first round takes the record, and the last round to end restores whatever
   * the specialists' checks changed. Rounds of another conversation wait until these end.
   */
  private async inRound<T>(run: () => Promise<T>): Promise<T> {
    const root = this.host.p.root;
    const { undoable } = await enterRound(root, this);
    if (this.open === 0) {
      this.group = { ran: [] };
      if (!undoable) this.host.emit("error", { message: UNDOABLE_WARNING, kind: "warning", agent_id: this.host.lead().id });
    }
    this.open++;
    try {
      return await run();
    } finally {
      this.open--;
      const undone = leaveRound(root, this);
      if (undone) this.reportRestore(undone);
    }
  }

  private async round(name: SpecialistName, brief: string): Promise<Outcome> {
    const def = SPECIALIST_DEFS[name];
    const seat = this.host.seat(name);
    const agent = seat.agent;
    const session = this.take(name);
    const commands: string[] = [];
    this.host.emit("edge_activity", { edge_id: seat.delegate.id, from_agent_id: this.host.lead().id, type: seat.delegate.type });
    try {
      const { tools, warnings } = await specialistToolbox(def.tools, this.host.p.root);
      for (const message of warnings) this.host.emit("error", { message, kind: "warning", agent_id: agent.id });
      session.items.push({ role: "user", content: brief });
      const base = this.host.loopEvents(agent);
      const asked = new Map<string, string>();
      const events: LoopEvents = {
        ...base,
        toolCall: (callId, tool, args) => {
          if (tool === "shell" && typeof args.command === "string") asked.set(callId, args.command);
          base.toolCall(callId, tool, args);
        },
        toolResult: (callId, tool, ok, output, metrics) => {
          const command = asked.get(callId);
          if (command !== undefined && !output.startsWith(CHECK_REFUSAL)) commands.push(command);
          base.toolResult(callId, tool, ok, output, metrics);
        },
      };
      const setting = this.policy.specialists[name];
      const res = await agentLoop({
        reg: this.host.reg, model: setting.model, effort: setting.effort, instructions: def.instructions, input: session.items, tools,
        ctx: this.host.toolContext(agent, session), events, maxRounds: ROUND_STEPS, requireStop: false, stopTools: [], keepHead: 1,
        cacheKey: `${this.host.runId}:${agent.id}:specialist`,
      });
      this.host.setStatus(agent, "done", "Reported");
      if (res.stop?.kind === "review") return { verdict: res.stop.verdict, findings: res.stop.findings, text: res.stop.comments };
      if (res.stop?.kind === "asks") return { verdict: null, findings: [], text: "", asks: res.stop.asks };
      return { verdict: null, findings: [], text: res.exhausted ? "The specialist ran out of steps before it finished." : res.text };
    } catch (e) {
      this.host.setStatus(agent, "error", (e as Error).message);
      throw e;
    } finally {
      session.busy = false;
      this.group.ran.push(...commands.map((command) => ({ name, command })));
      this.host.emit("edge_activity", { edge_id: seat.report.id, from_agent_id: agent.id, type: seat.report.type });
    }
  }

  /** The session a round continues: the kept one, unless a round is still using it. */
  private take(name: SpecialistName): Session {
    const kept = this.sessions.get(name);
    if (kept?.busy) return { ...fresh(), busy: true };
    const session = kept ?? fresh();
    this.sessions.set(name, session);
    session.busy = true;
    return session;
  }

  /** The first round sends the request. A later round sends what changed since the last one and the answers to its findings. */
  private async brief(round: number, focus: string, checks: string): Promise<string> {
    const facts = this.facts();
    if (round === 1) {
      const earlier = facts.earlier.length ? facts.earlier.map((line) => `- ${line}`).join("\n") : "None.";
      return [
        "Review round 1 of this request.",
        `The user's messages for this request, verbatim:\n${facts.messages.join("\n\n")}`,
        `Earlier requests in this conversation, the first line of each:\n${earlier}`,
        `What the main agent did and how it checked it:\n${focus}`,
        `Project checks:\n${checks}`,
        `Diff since the request started:\n${briefDiff(this.requestDiff())}`,
      ].join("\n\n");
    }
    const since = (file: string) => (this.reviewed.has(file) ? this.reviewed.get(file)! : facts.before.get(file) ?? null);
    return [
      `Review round ${round} of this request. The main agent answered your findings from the last round.`,
      `Findings from the last round:\n${this.blocking.length ? renderFindings(this.blocking) : "None."}`,
      `The main agent's answer and what it checked:\n${focus}`,
      `Diff since the last round:\n${briefDiff(this.diffSince(since))}`,
    ].join("\n\n");
  }

  /** The diff of each file the request changed, measured from `since`. Files with no changed line are left out. */
  private diffSince(since: (file: string) => string | null): FileDiff[] {
    return [...this.facts().before.keys()]
      .map((file) => ({ file, ...changedLines(since(file), this.current(file)) }))
      .filter((d) => d.lines > 0);
  }

  private current(file: string): string | null {
    const abs = this.host.p.fs.abs(file);
    return existsSync(abs) ? readFileSync(abs, "utf8") : null;
  }

  /** Tells the main agent which checks changed files, and that Octopus put them back. */
  private reportRestore(undone: Restored) {
    if (!undone.restored.length && !undone.deleted.length) return;
    const ran = this.group.ran.map((r) => `${r.name} ran \`${r.command}\``).join("; ") || "A specialist ran a command";
    const files = [...undone.restored.map((f) => `restored ${f}`), ...undone.deleted.map((f) => `deleted ${f}`)].join(", ");
    const note = undone.partial ? " The project has more files than the record holds, so new files were kept." : "";
    this.host.emit("error", { message: `${ran}, and it changed project files. Octopus put them back: ${files}.${note}`, kind: "warning", agent_id: this.host.lead().id });
  }
}

/** An explorer answer, cut to the return limit when it is longer. */
function clampAnswer(text: string): string {
  if (text.length <= RETURN_LIMIT) return text;
  return `${text.slice(0, RETURN_LIMIT - 60)}\n(answer cut at ${RETURN_LIMIT} characters)`;
}
