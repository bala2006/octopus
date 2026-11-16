// Drives index.html in a browser. Not run by the eval harness: it needs the playwright package and a browser.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(pathToFileURL(path.resolve("index.html")).href);
const checks = [];

async function check(name, fn) {
  try {
    await fn();
    checks.push({ name, pass: true });
  } catch (error) {
    checks.push({ name, pass: false, detail: String(error.message).split("\n")[0] });
  }
}

await check("Enter adds a todo", async () => {
  await page.fill("#todo-input", "buy milk");
  await page.press("#todo-input", "Enter");
  await page.waitForSelector("#todo-list li:has-text('buy milk')", { timeout: 2000 });
});

await check("an empty title adds nothing", async () => {
  await page.fill("#todo-input", "   ");
  await page.click("#add-todo");
  if ((await page.locator("#todo-list li").count()) !== 1) throw new Error("an empty todo was added");
});

await check("checking a todo marks it done", async () => {
  await page.click("#todo-list li input.toggle");
  if (!(await page.isChecked("#todo-list li input.toggle"))) throw new Error("not checked");
});

await check("the done filter shows only done todos", async () => {
  await page.click('button[data-filter="active"]');
  if ((await page.locator("#todo-list li").count()) !== 0) throw new Error("done todo shown under active");
});

await check("todos survive a reload", async () => {
  await page.click('button[data-filter="all"]');
  await page.reload();
  await page.waitForSelector("#todo-list li:has-text('buy milk')", { timeout: 2000 });
});

await browser.close();
console.log(JSON.stringify({ checks }));
