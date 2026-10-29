import { beforeEach, describe, expect, it } from "vitest";
import {
  recordedComposerSettings,
  threadKey,
  useWorkbenchStore,
} from "./workbenchStore";

beforeEach(() =>
  useWorkbenchStore.setState({
    threads: {},
    drafts: {},
    pendingPrompts: {},
    homeDraft: "",
    preferences: {},
  }),
);

describe("home prompt handoff", () => {
  it("carries a home draft through folder selection without submitting it or touching another project", () => {
    const store = useWorkbenchStore.getState();
    store.stagePrompt("other", "Keep this draft");
    store.setHomeDraft("Build a timer");
    store.stageHomePrompt("new-project");
    expect(useWorkbenchStore.getState()).toMatchObject({
      homeDraft: "",
      pendingPrompts: {
        other: "Keep this draft",
        "new-project": "Build a timer",
      },
      threads: {},
    });
  });

  it("reads recorded model settings and tolerates older conversations", () => {
    expect(
      recordedComposerSettings({
        model: { provider: "azure", model: "my-deployment" },
        reasoning_effort: "high",
      }),
    ).toEqual({
      model: { provider: "azure", model: "my-deployment" },
      reasoning_effort: "high",
    });
    expect(
      recordedComposerSettings({
        force_mock: true,
        model: { provider: "azure", model: "unused" },
      }),
    ).toEqual({
      model: { provider: "mock", model: "mock/demo" },
      reasoning_effort: "default",
    });
    expect(
      recordedComposerSettings({
        model: "old-format",
        reasoning_effort: "unknown",
      }),
    ).toEqual({ model: null, reasoning_effort: "default" });
  });
  it("opens a new conversation in the selected company and consumes the prompt once", () => {
    const key = threadKey("project", "team");
    const store = useWorkbenchStore.getState();
    store.selectThread(key, "previous-run");
    store.stagePrompt("project", "Build a timer");
    store.importPrompt("project", "team");
    expect(useWorkbenchStore.getState()).toMatchObject({
      drafts: { [key]: "Build a timer" },
      threads: { [key]: null },
      pendingPrompts: {},
    });
    store.draft(key, "Newer typing");
    store.importPrompt("project", "team");
    expect(useWorkbenchStore.getState().drafts[key]).toBe("Newer typing");
  });

  it("keeps both drafts until the user explicitly chooses to replace the current one", () => {
    const key = threadKey("project", "team");
    const store = useWorkbenchStore.getState();
    store.draft(key, "Existing draft");
    store.stagePrompt("project", "New home prompt");
    store.importPrompt("project", "team");
    expect(useWorkbenchStore.getState().drafts[key]).toBe("Existing draft");
    expect(useWorkbenchStore.getState().pendingPrompts.project).toBe(
      "New home prompt",
    );
    store.importPrompt("project", "team", true);
    expect(useWorkbenchStore.getState().drafts[key]).toBe("New home prompt");
    expect(useWorkbenchStore.getState().pendingPrompts).toEqual({});
  });

  it("waits for a company and preserves drafts and pending prompts in other projects", () => {
    const store = useWorkbenchStore.getState();
    store.draft(threadKey("other", "team"), "Other draft");
    store.stagePrompt("project", "First prompt");
    store.stagePrompt("other", "Other prompt");
    store.importPrompt("project", "");
    expect(useWorkbenchStore.getState().pendingPrompts.project).toBe(
      "First prompt",
    );
    store.importPrompt("project", "team");
    expect(
      useWorkbenchStore.getState().drafts[threadKey("other", "team")],
    ).toBe("Other draft");
    expect(useWorkbenchStore.getState().pendingPrompts).toEqual({
      other: "Other prompt",
    });
  });

  it("cancels the import without changing the existing conversation or draft", () => {
    const key = threadKey("project", "team");
    const store = useWorkbenchStore.getState();
    store.selectThread(key, "run");
    store.draft(key, "Keep this");
    store.stagePrompt("project", "Cancel this");
    store.discardPrompt("project");
    expect(useWorkbenchStore.getState().drafts[key]).toBe("Keep this");
    expect(useWorkbenchStore.getState().threads[key]).toBe("run");
    expect(useWorkbenchStore.getState().pendingPrompts).toEqual({});
  });
});
