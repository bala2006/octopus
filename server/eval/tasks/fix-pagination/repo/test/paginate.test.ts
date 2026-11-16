import assert from "node:assert/strict";
import { test } from "node:test";
import { paginate } from "../src/paginate.ts";

test("an empty list has no pages", () => {
  assert.deepEqual(paginate([], 1, 10), []);
});

test("a page past the end is empty", () => {
  assert.deepEqual(paginate([1, 2, 3], 5, 10), []);
});
