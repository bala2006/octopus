import assert from "node:assert/strict";
import { test } from "node:test";
import { daysBetween } from "../src/dates.js";

test("ten days apart", () => {
  assert.equal(daysBetween("2024-03-01", "2024-03-11"), 10);
});

test("the same day is zero", () => {
  assert.equal(daysBetween("2024-03-01", "2024-03-01"), 0);
});

test("counts calendar days across midnight in UTC", () => {
  assert.equal(daysBetween("2024-03-01T23:00:00Z", "2024-03-02T01:00:00Z"), 1);
});
