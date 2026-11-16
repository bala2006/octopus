import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const { paginate } = await import(pathToFileURL(path.resolve("src/paginate.ts")).href);
const nums = Array.from({ length: 10 }, (_, i) => i + 1);
const checks = [];

function check(name, fn) {
  try {
    fn();
    checks.push({ name, pass: true });
  } catch (error) {
    checks.push({ name, pass: false, detail: String(error.message).split("\n")[0] });
  }
}

check("page 1 holds a full page of 3", () => assert.deepEqual(paginate(nums, 1, 3), [1, 2, 3]));
check("page 2 holds the next full page", () => assert.deepEqual(paginate(nums, 2, 3), [4, 5, 6]));
check("the last partial page keeps its items", () => assert.deepEqual(paginate(nums, 4, 3), [10]));
check("a page past the end is empty", () => assert.deepEqual(paginate(nums, 5, 3), []));
check("a page size of 1 returns one item", () => assert.deepEqual(paginate(nums, 3, 1), [3]));

console.log(JSON.stringify({ checks }));
