import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ProjectFs } from "../src/safety/paths";

describe("ProjectFs.list", () => {
  it("lists one folder at a time and skips dependencies and Octopus internals", () => {
    const root = mkdtempSync(path.join(tmpdir(), "octopus-list-"));
    mkdirSync(path.join(root, "src", "lib"), { recursive: true });
    mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
    mkdirSync(path.join(root, ".octopus"), { recursive: true });
    writeFileSync(path.join(root, "README.md"), "readme");
    writeFileSync(path.join(root, "src", "app.ts"), "app");
    writeFileSync(path.join(root, "src", "lib", "util.ts"), "util");
    const fs = new ProjectFs(root);

    expect(fs.list("")).toEqual({ folders: ["src"], files: ["README.md"] });
    expect(fs.list("src")).toEqual({ folders: ["src/lib"], files: ["src/app.ts"] });
    expect(fs.list("src/lib")).toEqual({ folders: [], files: ["src/lib/util.ts"] });
  });
});
