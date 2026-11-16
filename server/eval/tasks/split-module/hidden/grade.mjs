import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const calls = JSON.parse(readFileSync("hidden/expected.json", "utf8")).calls;
const names = Object.keys(calls);
const mod = await import(pathToFileURL(path.resolve("src/ledger.js")).href);
const checks = [];

function check(name, fn) {
  try {
    fn();
    checks.push({ name, pass: true });
  } catch (error) {
    checks.push({ name, pass: false, detail: String(error.message).split("\n")[0] });
  }
}

check("ledger.js still exports every original function", () => {
  assert.deepEqual(names.filter((n) => typeof mod[n] !== "function"), []);
});

check("every function returns the same result as before", () => {
  const wrong = names.filter((n) => {
    try {
      assert.deepEqual(mod[n](...calls[n].args), calls[n].result);
      return false;
    } catch {
      return true;
    }
  });
  assert.deepEqual(wrong, []);
});

check("the code is in at least three modules of 300 lines or fewer", () => {
  const files = readdirSync("src").filter((f) => f.endsWith(".js"));
  const sizes = files.map((f) => readFileSync(path.join("src", f), "utf8").split("\n").length);
  assert.ok(files.length >= 3, `found ${files.length} module(s)`);
  assert.ok(sizes.every((s) => s <= 300), `largest module has ${Math.max(...sizes)} lines`);
});

console.log(JSON.stringify({ checks }));

