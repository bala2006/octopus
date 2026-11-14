/**
 * How agents in one conversation stay in step while they work. Each agent has its own chat (its sessions); the team
 * chat is shared. What reaches an agent's context is only what concerns it, delivered before its next step:
 *
 *   change notices  another agent changed a file this agent has read or written
 *   pinned posts    an interface or decision about files this agent works on (a new version replaces the old one)
 *   messages        sent to this agent by name, or mentioning it in the team chat
 *
 * Nothing is broadcast into every context: that would be paid again on every later step of every agent.
 */
import type { Item } from "../llm/azure";
import type { Mode } from "../tools";
import type { Shown, Tool, ToolContext } from "../tools/types";
import { owns } from "./ownership";

/** One agent's ongoing work on one deliverable: frozen instructions and tools, its transcript, what it has read. */
export interface Session {
  agentId: string;
  mode: Mode;
  instructions: string;
  tools: Tool[];
  input: Item[];
  seen: ToolContext["seen"];
  shown: Shown;
  /** The paths this session's task owns: what pinned posts it should hear about. */
  files: string[];
  /** Notes for the agent from outside its turn, delivered as one message before its next step. */
  inbox: string[];
}

/** A pinned post in the team chat: an interface, decision or fact the team builds on. */
export interface Pin { id: string; key: string; text: string; paths: string[]; author: string; version: number; at: string }

const PIN_CHARS = 1500;

/** Whether two path lists touch; an empty list is about the whole project. */
const touches = (a: string[], b: string[]) => !a.length || !b.length || a.some((p) => owns(b, p)) || b.some((p) => owns(a, p));

export class Collab {
  /** Who is waiting for whom: asker agent id → recipient agent id. */
  private waits = new Map<string, string>();
  /** Replies awaited by an asker, by message id. */
  private pending = new Map<string, { from: string; to: string; resolve(text: string): void }>();

  constructor(private readonly host: { sessions: Map<string, Session>; name(agentId: string): string; pins(): Pin[]; savePins(pins: Pin[]): void }) {}

  /** The agent's most recent live session, which holds what it knows right now. */
  latestSession(agentId: string): { key: string; session: Session } | undefined {
    let found: { key: string; session: Session } | undefined;
    for (const [key, session] of this.host.sessions) if (session.agentId === agentId) found = { key, session };
    return found;
  }

  /** Notes for an agent that had no live session when they were sent; its next session starts with them. */
  private held = new Map<string, string[]>();

  /** Deliver a note before the agent's next step: into its live session, or held for its next one. */
  deliver(agentId: string, note: string) {
    const live = this.latestSession(agentId);
    if (live) live.session.inbox.push(note);
    else this.held.set(agentId, [...(this.held.get(agentId) ?? []), note]);
  }

  /** Notes held for an agent, handed to the session it is starting. */
  takeHeld(agentId: string): string[] {
    const notes = this.held.get(agentId) ?? [];
    this.held.delete(agentId);
    return notes;
  }

  /**
   * Another agent wrote a file. Everyone else holding it hears so before their next step, and their copy no longer
   * counts as read, so a re-read returns the new content instead of "unchanged".
   */
  fileChanged(by: string, rel: string, summary: string) {
    for (const s of this.host.sessions.values()) {
      if (s.agentId === by || (!s.shown.has(rel) && !s.seen.has(rel))) continue;
      s.shown.delete(rel);
      const note = `${rel} was changed by ${this.host.name(by)}`;
      if (!s.inbox.some((m) => m.startsWith(note))) s.inbox.push(`${note} (${summary}). What you read of it before is out of date: read it again before relying on it.`);
    }
  }

  /** Pin an interface or decision. The same key makes a new version; sessions working on its paths hear about it. */
  pin(by: string, key: string, text: string, paths: string[], at: string): Pin {
    const pins = this.host.pins();
    const prev = pins.findLast((p) => p.key === key);
    const pin: Pin = { id: `P${pins.length + 1}`, key, text: text.slice(0, PIN_CHARS), paths, author: by, version: (prev?.version ?? 0) + 1, at };
    this.host.savePins([...pins, pin]);
    for (const s of this.host.sessions.values()) {
      if (s.agentId === by) continue;
      if (touches(paths, [...s.files, ...s.shown.keys(), ...s.seen.keys()])) s.inbox.push(formatPin(pin, this.host.name(by), prev ? "updated" : "pinned"));
    }
    return pin;
  }

  /** The current version of each pinned post about these paths, for a fresh brief. */
  pinsFor(paths: string[]): Pin[] {
    const latest = new Map<string, Pin>();
    for (const p of this.host.pins()) latest.set(p.key, p);
    return [...latest.values()].filter((p) => touches(p.paths, paths));
  }

  /** Whether `asker` waiting for `recipient` would close a cycle of agents waiting for each other. */
  wouldDeadlock(asker: string, recipient: string): boolean {
    for (let x: string | undefined = recipient, hops = 0; x && hops < 32; x = this.waits.get(x), hops++) if (x === asker) return true;
    return false;
  }

  /**
   * The reply to one message, or a note when none can come. `blocking` marks the asker as waiting on the recipient,
   * which is what deadlock detection follows; a non-blocking asker gets the reply later in its inbox.
   */
  awaitReply(messageId: string, from: string, to: string, signal: AbortSignal, timeoutMs: number, blocking: boolean): Promise<string> {
    if (blocking) this.waits.set(from, to);
    return new Promise<string>((resolve) => {
      const done = (text: string) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        this.pending.delete(messageId);
        if (this.waits.get(from) === to) this.waits.delete(from);
        resolve(text);
      };
      const onAbort = () => done("(the conversation was stopped)");
      const timer = setTimeout(() => done(`(no reply from ${this.host.name(to)} within ${Math.round(timeoutMs / 60_000)} minutes; carry on with what you know)`), timeoutMs);
      signal.addEventListener("abort", onAbort, { once: true });
      this.pending.set(messageId, { from, to, resolve: done });
    });
  }

  /** A reply arrived. Returns the asker when someone was waiting for it, so the caller knows it was consumed. */
  answer(messageId: string, text: string): string | null {
    const p = this.pending.get(messageId);
    if (!p) return null;
    p.resolve(text);
    return p.from;
  }

  /** The agent finished its turn: anyone still waiting on it is told, instead of waiting for the timeout. */
  agentIdle(agentId: string) {
    for (const p of [...this.pending.values()]) if (p.to === agentId) p.resolve(`(${this.host.name(agentId)} finished its work without replying)`);
  }
}

export function formatPin(p: Pin, author: string, verb: "pinned" | "updated" = "pinned"): string {
  return `${author} ${verb} "${p.key}" (v${p.version}${p.paths.length ? `, about ${p.paths.join(", ")}` : ""}):\n${p.text}`;
}
