/**
 * The read-only specialists: reviewer (correctness), security, designer (how the UI looks) and explorer (answers one
 * question). Each has one prompt and one skill under catalog/specialists, a toolbox and an effort. Its instructions are
 * the prompt followed by the skill, and they never change, so every round reuses the cached prefix. Each specialist keeps
 * one session per conversation, so a later round continues the earlier one. A call that finds the session busy, such as a
 * second explore in the same step, gets a fresh session for itself.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentOut, AgentStatus, Effort, EdgeOut, RoleTemplateOut, RunEventMap, RunTopic } from "@octopus/shared";
import type { Registry } from "../db/registry";
import type { Item } from "../llm/azure";
import { clip } from "../lib/util";
import { reviewReport, type CriticReport, type FindingInput } from "../lib/findings";
import { enterRound, leaveRound, type Restored } from "../workspace/snapshot";
import type { Project } from "../workspace/projects";
import { specialistToolbox, type SpecialistTool } from "../tools";
import { CHECK_REFUSAL } from "../tools/commands";
import type { ReviewerName, Shown, ToolContext } from "../tools/types";
import { agentLoop, type LoopEvents } from "./agent";

export const SPECIALISTS = ["reviewer", "security", "designer", "explorer"] as const;
export type SpecialistName = (typeof SPECIALISTS)[number];

export interface SpecialistDef {
  name: SpecialistName;
  title: string;
  effort: Effort;
  tools: readonly SpecialistTool[];
  /** How a round ends: a submit_review call with a verdict, or a plain text answer. */
  ends: "review" | "answer";
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
};

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
/** The request text a review brief carries, in characters. */
const REQUEST_LIMIT = 20_000;

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
  model(agent: AgentOut): string;
}

/** The request a review is about: its text, and the files this turn changed. */
export interface RequestFacts { goal: string; changed: string[] }

interface Session { items: Item[]; busy: boolean; seen: Map<string, string>; shown: Shown }
interface Outcome { verdict: CriticReport["verdict"]; findings: FindingInput[]; text: string }
/** The commands that ran in the rounds that share one project snapshot, with the specialist that ran each. */
interface Group { ran: { name: SpecialistName; command: string }[] }

const fresh = (): Session => ({ items: [], busy: false, seen: new Map(), shown: new Map() });

/** Each conversation holds one of these. It runs specialist rounds and answers the main agent's review and explore calls. */
export class Specialists {
  private sessions = new Map<SpecialistName, Session>();
  private open = 0;
  private group: Group = { ran: [] };
  private reviews = 0;

  constructor(private readonly host: SpecialistHost, private readonly facts: () => RequestFacts) {}

  /** A new request starts, so its review rounds are numbered from one. */
  startTurn() {
    this.reviews = 0;
  }

  /** Runs the named reviewers at once, waits for all of them, and returns their findings as one message. */
  async review(names: ReviewerName[], focus: string): Promise<string> {
    const round = ++this.reviews;
    const brief = this.reviewBrief(round, focus);
    const outcomes = await this.inRound(() => Promise.all(names.map((name) => this.round(name, brief))));
    return reviewReport(round, names.map((critic, i) => ({ critic, verdict: outcomes[i]!.verdict, findings: outcomes[i]!.findings })), RETURN_LIMIT);
  }

  /** Answers one question. Several calls in one step run at the same time. */
  async explore(question: string): Promise<string> {
    const outcome = await this.inRound(() => this.round("explorer", `Question: ${question}`));
    return outcome.text ? clampAnswer(outcome.text) : "The explorer gave no answer.";
  }

  /**
   * Runs rounds inside one project snapshot. The first round takes it, and the last round to end restores whatever the
   * specialists' checks changed. The main agent waits for these rounds, so nothing else writes in the meantime.
   */
  private async inRound<T>(run: () => Promise<T>): Promise<T> {
    if (this.open === 0) this.group = { ran: [] };
    this.open++;
    const root = this.host.p.root;
    try {
      enterRound(root);
      return await run();
    } finally {
      this.open--;
      const undone = leaveRound(root);
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
      const res = await agentLoop({
        reg: this.host.reg, model: this.host.model(agent), effort: def.effort, instructions: def.instructions, input: session.items, tools,
        ctx: this.host.toolContext(agent, session), events, maxRounds: ROUND_STEPS, requireStop: false, stopTools: [], keepHead: 1,
        cacheKey: `${this.host.runId}:${agent.id}:specialist`,
      });
      this.host.setStatus(agent, "done", "Reported");
      if (res.stop?.kind === "review") return { verdict: res.stop.verdict, findings: res.stop.findings, text: res.stop.comments };
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

  private reviewBrief(round: number, focus: string): string {
    const { goal, changed } = this.facts();
    return [
      `Review round ${round} of the change made for this request.`,
      `The user's request, verbatim:\n${clip(goal, REQUEST_LIMIT)}`,
      `What the main agent changed and checked:\n${focus}`,
      `Files changed in this request:\n${changed.length ? changed.map((f) => `- ${f}`).join("\n") : "(none recorded)"}`,
    ].join("\n\n");
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
