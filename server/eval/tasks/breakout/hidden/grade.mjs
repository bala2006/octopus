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

const state = () => page.evaluate(() => window.game.state());

await check("window.game.state() reports the ready state", async () => {
  const s = await state();
  if (s.status !== "ready" || s.lives !== 3) throw new Error(JSON.stringify(s));
});

await check("Space starts, then pauses and resumes", async () => {
  await page.keyboard.press("Space");
  if ((await state()).status !== "playing") throw new Error("not playing after Space");
  await page.keyboard.press("Space");
  if ((await state()).status !== "paused") throw new Error("not paused after second Space");
  await page.keyboard.press("Space");
  if ((await state()).status !== "playing") throw new Error("not playing after resume");
});

await check("losing three balls ends the game and Enter restarts it", async () => {
  for (let i = 0; i < 600 && (await state()).status !== "over"; i++) await page.waitForTimeout(50);
  const over = await state();
  if (over.status !== "over") throw new Error("game did not end");
  await page.keyboard.press("Enter");
  if ((await state()).status !== "ready") throw new Error("not ready after Enter");
});

await browser.close();
console.log(JSON.stringify({ checks }));
