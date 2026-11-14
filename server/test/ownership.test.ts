import { canRunBeside, owns } from "../src/engine/ownership";

test("a folder owns what is inside it, not its namesakes", () => {
  expect(owns(["src/game"], "src/game/world.js")).toBe(true);
  expect(owns(["src/game/"], "src/game")).toBe(true);
  expect(owns(["src/game/**"], "src/game/a/b.js")).toBe(true);
  expect(owns(["src/game"], "src/gameplay.js")).toBe(false);
  expect(owns(["index.html"], "index.html")).toBe(true);
  expect(owns(["."], "anything.txt")).toBe(true);
});

test("a glob owns at least the folder before its wildcard", () => {
  expect(owns(["src/**/*.ts"], "src/game/world.ts")).toBe(true);
  expect(owns(["src/**/*.ts"], "src/game/world.css")).toBe(true);
  expect(owns(["src/game/*.js"], "src/ui/hud.js")).toBe(false);
  expect(owns(["*.html"], "index.html")).toBe(true);
  expect(canRunBeside({ kind: "build", files: ["src/**/*.ts"] }, [{ kind: "build", files: ["src/ui/"] }])).toBe(false);
});

test("writers run side by side only when what they own does not overlap", () => {
  const build = (files: string[]) => ({ kind: "build" as const, files });
  expect(canRunBeside(build(["src/a/"]), [build(["src/b/"])])).toBe(true);
  expect(canRunBeside(build(["src/"]), [build(["src/b/x.js"])])).toBe(false);
  expect(canRunBeside(build([]), [build(["src/b/"])])).toBe(false);
  expect(canRunBeside(build(["src/a/"]), [build([])])).toBe(false);
  expect(canRunBeside({ kind: "review", files: [] }, [build([])])).toBe(true);
  expect(canRunBeside(build(["src/a/"]), [{ kind: "review", files: [] }])).toBe(true);
});
