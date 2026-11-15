import { describe, expect, it } from "vitest";

import { goalTitle, parseUtc } from "./utils";

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

describe("goalTitle", () => {
  it("drops markdown markers and blank lines from the first line", () => {
    expect(goalTitle("# TASK: build the game\nmore detail")).toBe("TASK: build the game");
    expect(goalTitle("\n\n> - Fix the login bug")).toBe("Fix the login bug");
  });

  it("falls back when the goal has no text", () => {
    expect(goalTitle("")).toBe("New conversation");
    expect(goalTitle(undefined, "New chat")).toBe("New chat");
    expect(goalTitle("###  \n")).toBe("New conversation");
  });
});