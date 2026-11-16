import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

const { daysBetween } = await import(pathToFileURL(path.resolve("src/dates.js")).href);
const checks = [];

function check(name, fn) {
  try {
    fn();
    checks.push({ name, pass: true });
  } catch (error) {
    checks.push({ name, pass: false, detail: String(error.message).split("\n")[0] });
  }
}

check("the project's own tests pass", () => {
  const run = spawnSync(process.execPath, ["--test", "test/dates.test.js"], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stdout.split("\n").find((l) => l.includes("not ok")) ?? "tests failed");
});
check("a leap day counts as one day", () => assert.equal(daysBetween("2024-02-28", "2024-03-01"), 2));
check("a non-leap February has no extra day", () => assert.equal(daysBetween("2023-02-28", "2023-03-01"), 1));
check("the year boundary counts as one day", () => assert.equal(daysBetween("2024-12-31T23:59:59Z", "2025-01-01T00:00:01Z"), 1));
check("a reversed range is negative", () => assert.equal(daysBetween("2024-03-11", "2024-03-01"), -10));
check("a date-only value and a date-time on the same day are zero apart", () => assert.equal(daysBetween("2024-06-15", "2024-06-15T12:00:00Z"), 0));

console.log(JSON.stringify({ checks }));
