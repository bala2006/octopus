import { describe, expect, it } from "vitest";

import { parseUtc } from "./utils";

describe("parseUtc", () => {
  it("reads a naive backend timestamp as UTC instead of local time", () => {
    expect(parseUtc("2026-11-06T10:42:05.974298")).toBe(
      Date.parse("2026-11-06T10:42:05.974Z"),
    );
  });

  it("keeps a timestamp that already carries a zone", () => {
    expect(parseUtc("2026-11-06T10:42:05Z")).toBe(
      Date.parse("2026-11-06T10:42:05Z"),
    );
    expect(parseUtc("2026-11-06T16:12:05+05:30")).toBe(
      Date.parse("2026-11-06T10:42:05Z"),
    );
  });
});
