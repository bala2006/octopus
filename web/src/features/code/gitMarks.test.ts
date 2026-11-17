import { describe, expect, it } from "vitest";
import type { GitFile } from "@octopus/shared";
import { changesByPath, folderTones, toneOf } from "./gitMarks";

describe("toneOf", () => {
  it("reads the worktree column, so an edit to a staged file shows as modified", () => {
    expect(toneOf("??")).toBe("untracked");
    expect(toneOf(" M")).toBe("modified");
    expect(toneOf("M ")).toBe("modified");
    expect(toneOf("A ")).toBe("added");
    expect(toneOf(" D")).toBe("deleted");
    expect(toneOf("D ")).toBe("deleted");
    expect(toneOf("AD")).toBe("deleted");
  });
});

describe("changesByPath", () => {
  it("keys each changed file by its project path", () => {
    const files: GitFile[] = [
      { path: "web/app.ts", status: " M", original_path: null },
      { path: "notes.md", status: "??", original_path: null },
    ];
    expect(changesByPath(files)).toEqual(
      new Map([
        ["web/app.ts", "modified"],
        ["notes.md", "untracked"],
      ]),
    );
  });
});

describe("folderTones", () => {
  it("gives every ancestor folder the most severe tone below it", () => {
    const changes = new Map([
      ["server/src/a.ts", "untracked"],
      ["server/src/b.ts", "modified"],
      ["web/c.ts", "untracked"],
    ] as const);
    expect(folderTones(changes)).toEqual(
      new Map([
        ["server", "modified"],
        ["server/src", "modified"],
        ["web", "untracked"],
      ]),
    );
  });

  it("gives no folder a tone for a change at the project root", () => {
    expect(folderTones(new Map([["README.md", "modified"]]))).toEqual(
      new Map(),
    );
  });
});
