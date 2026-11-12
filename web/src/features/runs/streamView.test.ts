import { describe, expect, it } from "vitest";
import { humanizeStream, lastField, readJsonString, tailLines } from "./streamView";

describe("readJsonString", () => {
  it("decodes escapes so code keeps its newlines and indentation", () => {
    const src = 'function jump() {\\n  if (onGround) {\\n    vy = -12;\\n  }\\n}\\n" rest';
    const r = readJsonString(src, 0);
    expect(r.closed).toBe(true);
    expect(r.value).toBe("function jump() {\n  if (onGround) {\n    vy = -12;\n  }\n}\n");
  });

  it("handles quotes, unicode and a string that is still arriving", () => {
    expect(readJsonString('say \\"hi\\" \\u2014 ok"', 0).value).toBe('say "hi" — ok');
    const partial = readJsonString("const a = 1;\\n  const b", 0);
    expect(partial).toMatchObject({ value: "const a = 1;\n  const b", closed: false });
    expect(readJsonString("line\\", 0).value).toBe("line"); // a half-received escape is not shown yet
  });
});

describe("humanizeStream", () => {
  it("shows a native write_file call as a titled, readable code block", () => {
    const raw = '\n{"action":"write_file","path":"src/game.js","content":"const SPEED = 4;\\n\\nfunction loop() {\\n  update();\\n  draw();\\n';
    const [seg] = humanizeStream(raw);
    expect(seg).toEqual({ kind: "code", title: "Writing src/game.js", language: "JavaScript",
      body: "const SPEED = 4;\n\nfunction loop() {\n  update();\n  draw();\n" });
  });

  it("splits an old-style envelope into the thought and each action", () => {
    const raw = '{"thought": "The board says T-2 is open,\\nso I\'ll send the brief.", "actions": [{"action":"send_message","to":"Ben","type":"task","content":"Please build the HUD.\\n\\nKeep it minimal."},{"action":"edit_file","path":"index.html","edits":[{"old_string":"a","new_string":"<canvas id=\\"game\\"></canvas>"}]}]}';
    const segs = humanizeStream(raw);
    expect(segs.map((s) => s.kind)).toEqual(["thought", "message", "code"]);
    expect(segs[0].body).toBe("The board says T-2 is open,\nso I'll send the brief.");
    expect(segs[1]).toMatchObject({ title: "Message to Ben (task)", body: "Please build the HUD.\n\nKeep it minimal." });
    expect(segs[2]).toMatchObject({ title: "Editing index.html", body: '<canvas id="game"></canvas>', language: "HTML" });
  });

  it("keeps the model's plain words as text and describes tools without bodies", () => {
    expect(humanizeStream("I'll check the tests first.")).toEqual([{ kind: "text", title: "Writing", body: "I'll check the tests first." }]);
    expect(humanizeStream('{"action":"search_project","query":"jump"')[0].title).toBe("Searching for “jump”");
    expect(humanizeStream('{"action":"mcp__browser__browser_navigate","url":"x"')[0].title).toBe("Using browser / browser_navigate");
    expect(humanizeStream('{"actions": [')).toEqual([]);
  });

  it("finds the last value of a field", () => {
    expect(lastField('{"path":"a.js","x":1,"path":"b.js', "path")).toBe("b.js");
    expect(tailLines("1\n2\n3\n4", 2)).toBe("3\n4");
  });
});

describe("appendStream", () => {
  it("stays bounded but keeps what is being written and resumes at a line", async () => {
    const { appendStream } = await import("./streamView");
    let s = '{"action":"write_file","path":"big.js","content":"';
    for (let i = 0; i < 3000; i++) s = appendStream(s, `line ${i};\\n`, 4000);
    expect(s.length).toBeLessThanOrEqual(4100);
    const [seg] = humanizeStream(s);
    expect(seg.title).toBe("Writing big.js");
    expect(seg.body.split("\n").at(-2)).toBe("line 2999;");
    expect(seg.body.split("\n")[1]).toMatch(/^line \d+;$/);
  });
});
