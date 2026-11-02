import { afterEach, expect, it, vi } from "vitest";
import { exactSource, parseMemory, writeMemory } from "./scopedMemoryApi";

afterEach(() => vi.unstubAllGlobals());
const note = {
  id: "memory1",
  key: "Preference",
  version: 3,
  scope: "agent",
  scope_id: "ben",
  run_id: null,
  content: "Use orange",
  classification: "proposed",
  pinned: false,
  source_refs: [],
};
it.each([null, [], "not an object", 7])(
  "rejects a non-object memory response: %s",
  (value) => {
    expect(() => parseMemory(value)).toThrow("Invalid memory response");
  },
);
it("rejects malformed nested source references", () => {
  expect(() => parseMemory({ ...note, source_refs: [null] })).toThrow(
    "Invalid memory response",
  );
});
it("requires exact scope and version identity before an edit can be constructed", () => {
  expect(parseMemory(note)).toEqual(note);
  expect(() => parseMemory({ ...note, scope_id: undefined })).toThrow(
    "Missing memory identity",
  );
});
it("keeps a private fact private with a version check when promoting it", async () => {
  const fetcher = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        ...note,
        version: 4,
        classification: "verified",
        pinned: true,
      }),
    ),
  );
  vi.stubGlobal("fetch", fetcher);
  await writeMemory("w", "company", {
    scope: "agent",
    scope_id: "ben",
    run_id: null,
    key: "Preference",
    content: "Use orange",
    expected_version: 3,
    sources: [],
    classification: "verified",
    pinned: true,
    share_sources: false,
  });
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
    scope: "agent",
    scope_id: "ben",
    run_id: null,
    key: "Preference",
    content: "Use orange",
    expected_version: 3,
    sources: [],
    classification: "verified",
    pinned: true,
    share_sources: false,
  });
});
it("looks up exact source IDs and retains the truncation disclosure", async () => {
  const fetcher = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        id: "message/1",
        label: "question",
        content: "Original message",
        truncated: true,
      }),
    ),
  );
  vi.stubGlobal("fetch", fetcher);
  expect(
    await exactSource("w", "company", { kind: "message", id: "message/1" }),
  ).toMatchObject({ content: "Original message", truncated: true });
  expect(fetcher.mock.calls[0][0]).toBe(
    "/api/v1/w/w/memory/sources/message/message%2F1?company_id=company",
  );
});
it("uses the source identity when an optional label is missing", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ id: "source", content: "Original message" }),
        ),
      ),
  );
  expect(
    await exactSource("w", "company", { kind: "message", id: "source" }),
  ).toEqual({
    id: "source",
    content: "Original message",
    label: "message:source",
    truncated: false,
  });
});
