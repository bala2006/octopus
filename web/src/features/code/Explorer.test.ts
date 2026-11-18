import { describe, expect, it } from "vitest";
import { flattenTree, type Listing } from "./Explorer";

const listings: Record<string, Listing> = {
  "": { folders: ["src", "empty"], files: ["README.md"] },
  src: { folders: ["src/lib"], files: ["src/app.ts"] },
  "src/lib": { folders: [], files: ["src/lib/util.ts"] },
  empty: { folders: [], files: [] },
};
const listingOf = (path: string) => listings[path];
const names = (items: { node: { name: string } }[]) => items.map((item) => item.node.name);

describe("flattenTree", () => {
  it("shows only the top level while every folder is collapsed", () => {
    expect(names(flattenTree(listingOf, new Set()))).toEqual(["src", "empty", "README.md"]);
  });

  it("lists a folder's children only while that folder is expanded", () => {
    expect(names(flattenTree(listingOf, new Set(["src"])))).toEqual(["src", "lib", "app.ts", "empty", "README.md"]);
  });

  it("nests deeper folders and reports each row's depth", () => {
    const items = flattenTree(listingOf, new Set(["src", "src/lib"]));

    expect(items.map((item) => [item.node.name, item.depth])).toEqual([
      ["src", 0],
      ["lib", 1],
      ["util.ts", 2],
      ["app.ts", 1],
      ["empty", 0],
      ["README.md", 0],
    ]);
  });

  it("shows nothing under an expanded folder whose listing has not loaded yet", () => {
    const rootOnly = (path: string) => (path === "" ? listings[""] : undefined);

    expect(names(flattenTree(rootOnly, new Set(["src"])))).toEqual(["src", "empty", "README.md"]);
  });
});
