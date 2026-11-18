import { supersedeStale } from "../src/engine/agent";
import type { Item } from "../src/llm/azure";
import type { Shown } from "../src/tools/types";

const long = (ch: string) => ch.repeat(600);
const call = (id: string, name: string, args: object): Item => ({ type: "function_call", call_id: id, name, arguments: JSON.stringify(args) });
const out = (id: string, text: string): Item => ({ type: "function_call_output", call_id: id, output: text });

function transcript(): Item[] {
  return [
    call("s1", "browser_snapshot", {}), out("s1", long("a")),
    call("r1", "read_file", { path: "app.js" }), out("r1", long("b")),
    call("s2", "browser_snapshot", {}), out("s2", long("c")),
    call("r2", "read_file", { path: "app.js" }), out("r2", long("d")),
    call("r3", "read_file", { path: "index.html" }), out("r3", long("e")),
    call("s3", "browser_snapshot", {}), out("s3", long("f")),
  ];
}

describe("superseded browser snapshots and file reads", () => {
  test("keeps only the newest snapshot and the newest read of each file", () => {
    const input = transcript();
    const shown: Shown = new Map([["app.js", { hash: "h", ranges: [], at: 7 }], ["index.html", { hash: "h", ranges: [], at: 9 }]]);
    expect(supersedeStale(input, shown)).toBe(3);
    expect(input[1]!.output).toMatch(/Superseded by a later browser snapshot/);
    expect(input[3]!.output).toMatch(/Superseded by a later read/);
    expect(input[5]!.output).toMatch(/Superseded by a later browser snapshot/);
    expect(input[7]!.output).toBe(long("d"));
    expect(input[9]!.output).toBe(long("e"));
    expect(input[11]!.output).toBe(long("f"));
    expect(shown.get("app.js")?.at).toBe(7);
    expect(shown.get("index.html")?.at).toBe(9);
  });

  test("a removed read is dropped from the shown map, so a later read is not answered 'unchanged, see above'", () => {
    const input = transcript();
    const shown: Shown = new Map([["app.js", { hash: "h", ranges: [], at: 3 }]]);
    supersedeStale(input, shown);
    expect(shown.has("app.js")).toBe(false);
  });

  test("a different page of a file is kept, and an 'unchanged' answer does not replace the copy it points to", () => {
    const input: Item[] = [
      call("p1", "read_file", { path: "big.js", offset: 1, limit: 100 }), out("p1", long("p")),
      call("p2", "read_file", { path: "big.js", offset: 101, limit: 100 }), out("p2", long("q")),
      call("u1", "read_file", { path: "big.js", offset: 1, limit: 100 }), out("u1", "big.js is unchanged since your last read, see above."),
    ];
    expect(supersedeStale(input, new Map())).toBe(0);
    expect(input[1]!.output).toBe(long("p"));
    expect(input[3]!.output).toBe(long("q"));
  });

  test("short outputs and a second pass change nothing", () => {
    const input: Item[] = [
      call("r1", "read_file", { path: "a.ts" }), out("r1", "tiny"),
      call("r2", "read_file", { path: "a.ts" }), out("r2", "tiny"),
    ];
    expect(supersedeStale(input, new Map())).toBe(0);
    const big: Item[] = transcript();
    supersedeStale(big, new Map());
    expect(supersedeStale(big, new Map())).toBe(0);
  });
});
