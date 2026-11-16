import assert from "node:assert/strict";
import { test } from "node:test";
import { readCell2, sumColumn0 } from "../src/ledger.js";

const rows = [
  ["2024-01-03", "food", "12.5", "lunch"],
  ["2024-01-04", "travel", "40", "train"],
];

test("readCell2 reads the third cell as a number", () => {
  assert.equal(readCell2("2024-01-03;food;12.5;lunch"), 12.5);
});

test("sumColumn0 returns a number for rows with a text first cell", () => {
  assert.equal(typeof sumColumn0(rows), "number");
});

