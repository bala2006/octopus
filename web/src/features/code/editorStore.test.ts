import { beforeEach, describe, expect, it } from "vitest";
import { useEditorStore } from "./editorStore";
import { buildExplorer } from "./Explorer";
import { parsePreviewAddress } from "./previewAddress";

const document = {
  path: "src/app.ts",
  content: "initial",
  revision: "one",
  size: 7,
};
beforeEach(() => useEditorStore.setState({ projects: {} }));

describe("workspace drafts", () => {
  it("keeps unsaved edits when reopening a file and isolates projects", () => {
    const store = useEditorStore.getState();
    store.open("one", document);
    store.edit("one", document.path, "draft");
    store.open("one", { ...document, content: "disk" });
    store.open("two", document);
    expect(useEditorStore.getState().projects.one.tabs[0].draft).toBe("draft");
    expect(useEditorStore.getState().projects.two.tabs[0].draft).toBe(
      "initial",
    );
  });
  it("preserves edits made while a save is in flight", () => {
    const store = useEditorStore.getState();
    store.open("one", document);
    store.edit("one", document.path, "submitted");
    store.edit("one", document.path, "newer edit");
    store.saved(
      "one",
      { ...document, content: "submitted", revision: "two" },
      "submitted",
    );
    expect(useEditorStore.getState().projects.one.tabs[0]).toMatchObject({
      content: "submitted",
      draft: "newer edit",
      revision: "two",
    });
  });
  it("selects a neighboring tab on close", () => {
    const store = useEditorStore.getState();
    store.open("one", document);
    store.open("one", { ...document, path: "second.ts" });
    store.close("one", "second.ts");
    expect(useEditorStore.getState().projects.one.active).toBe("src/app.ts");
  });
  it("includes empty and nested folders in the explorer", () => {
    const tree = buildExplorer(["src/app.ts"], ["src", "empty"]);
    expect(tree.children.get("empty")?.kind).toBe("folder");
    expect(tree.children.get("src")?.children.get("app.ts")?.path).toBe(
      "src/app.ts",
    );
  });
});

describe("preview addresses", () => {
  it("accepts local servers and HTTPS sites", () => {
    expect(parsePreviewAddress("localhost:3000")).toBe(
      "http://localhost:3000/",
    );
    expect(parsePreviewAddress("https://example.com/app")).toBe(
      "https://example.com/app",
    );
  });
  it("rejects unsupported protocols and credentials", () => {
    expect(() => parsePreviewAddress("javascript://alert(1)")).toThrow();
    expect(() =>
      parsePreviewAddress("https://user:secret@example.com"),
    ).toThrow();
  });
});
