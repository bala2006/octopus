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

await page.fill("#todo-input", "buy milk");
await page.press("#todo-input", "Enter");

await check("double-click then Enter saves the new title", async () => {
  await page.dblclick("#todo-list li span");
  await page.keyboard.press("Control+A");
  await page.keyboard.type("buy oat milk");
  await page.keyboard.press("Enter");
  await page.waitForSelector("#todo-list li:has-text('buy oat milk')", { timeout: 2000 });
});

await check("Escape cancels an edit", async () => {
  await page.dblclick("#todo-list li span");
  await page.keyboard.type("x");
  await page.keyboard.press("Escape");
  if ((await page.locator("#todo-list li:has-text('buy oat milkx')").count()) !== 0) throw new Error("edit was kept");
});

await check("the filter is kept in the URL hash", async () => {
  await page.click('button[data-filter="done"]');
  if (!page.url().endsWith("#/done")) throw new Error(`url ends ${page.url().slice(-12)}`);
});

await check("a reload keeps the hash filter", async () => {
  await page.reload();
  if (!page.url().endsWith("#/done")) throw new Error("hash lost on reload");
});

await browser.close();
console.log(JSON.stringify({ checks }));
