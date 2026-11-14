import { Collab, type Pin, type Session } from "../src/engine/collab";

const session = (agentId: string, files: string[] = []): Session =>
  ({ agentId, mode: "worker", instructions: "", tools: [], input: [], seen: new Map(), shown: new Map(), files, inbox: [] });

function setup() {
  const sessions = new Map<string, Session>();
  let pins: Pin[] = [];
  const collab = new Collab({ sessions, name: (id) => id.toUpperCase(), pins: () => pins, savePins: (p) => { pins = p; } });
  return { sessions, collab };
}

test("a changed file is announced only to the agents holding it, and no longer counts as read", () => {
  const { sessions, collab } = setup();
  const a = session("lena");
  const b = session("alex");
  a.shown.set("src/contracts.ts", { hash: "h1", ranges: [[1, 40]] });
  sessions.set("lena:T1", a).set("alex:T2", b);
  collab.fileChanged("ava", "src/contracts.ts", "40 → 80 lines");
  collab.fileChanged("ava", "src/contracts.ts", "80 → 81 lines");
  expect(a.inbox).toEqual([expect.stringContaining("src/contracts.ts was changed by AVA (40 → 80 lines)")]);
  expect(a.shown.has("src/contracts.ts")).toBe(false);
  expect(b.inbox).toEqual([]);
  collab.fileChanged("lena", "src/other.ts", "new file");
  expect(a.inbox).toHaveLength(1);
});

test("pins reach sessions working on their paths; the latest version is the one briefs get", () => {
  const { sessions, collab } = setup();
  const core = session("lena", ["src/core"]);
  const ui = session("alex", ["src/ui"]);
  sessions.set("lena:T1", core).set("alex:T2", ui);
  collab.pin("marcus", "contract: Port", "v1 text", ["src/core/port.ts"], "t");
  collab.pin("marcus", "contract: Port", "v2 text", ["src/core/port.ts"], "t");
  expect(core.inbox).toEqual([expect.stringContaining("pinned \"contract: Port\" (v1"), expect.stringContaining("updated \"contract: Port\" (v2")]);
  expect(ui.inbox).toEqual([]);
  expect(collab.pinsFor(["src/core"]).map((p) => p.text)).toEqual(["v2 text"]);
  expect(collab.pinsFor(["src/ui"])).toEqual([]);
});

test("notes for an agent with no live session wait for its next one", () => {
  const { sessions, collab } = setup();
  collab.deliver("sam", "hello");
  expect(collab.takeHeld("sam")).toEqual(["hello"]);
  sessions.set("sam:T3", session("sam"));
  collab.deliver("sam", "again");
  expect(sessions.get("sam:T3")!.inbox).toEqual(["again"]);
});

test("waiting that would close a cycle is detected; replies and idle agents release waiters", async () => {
  const { collab } = setup();
  const signal = new AbortController().signal;
  const first = collab.awaitReply("m1", "lena", "alex", signal, 60_000, true);
  expect(collab.wouldDeadlock("alex", "lena")).toBe(true);
  expect(collab.wouldDeadlock("sam", "lena")).toBe(false);
  expect(collab.answer("m1", "blue")).toBe("lena");
  await expect(first).resolves.toBe("blue");
  expect(collab.wouldDeadlock("alex", "lena")).toBe(false);
  const second = collab.awaitReply("m2", "sam", "alex", signal, 60_000, true);
  collab.agentIdle("alex");
  await expect(second).resolves.toContain("ALEX finished its work without replying");
});
