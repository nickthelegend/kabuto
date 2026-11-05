// Records the real Kabuto DEX on the live devnet with Playwright (1440x900), for the demo film.
// Nothing is staged: every click sends real transactions. Usage: node record.mjs <scene> [--url http://localhost:5180]
//   scenes: landing | protected | intent
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const scene = process.argv[2] ?? "landing";
const url = process.argv.includes("--url") ? process.argv[process.argv.indexOf("--url") + 1] : "http://localhost:5180";
const out = fileURLToPath(new URL(`./out/${scene}/`, import.meta.url));
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, recordVideo: { dir: out, size: { width: 1440, height: 900 } }, storageState: process.env.KABUTO_STATE });
const page = await ctx.newPage();
const pause = (ms) => page.waitForTimeout(ms);
const smooth = (y) => page.evaluate((y) => window.scrollTo({ top: y, behavior: "smooth" }), y);

try {
  if (scene === "landing") {
    await page.goto(url + "/#/");
    await pause(6000);
    for (const sel of ["#how", ".l-two", "#security", "#proof", "#sdk"]) {
      await page.locator(sel).first().scrollIntoViewIfNeeded();
      await pause(3500);
    }
  } else if (scene === "protected") {
    await page.goto(url + "/#/app");
    await page.getByText("Protected swap").first().click();
    await pause(2500);
    await page.getByRole("button", { name: "Swap with Kabuto" }).click();
    await page.waitForSelector("text=/Included|Never included|Refused/", { timeout: 180_000 });
    await pause(4000);
    await page.getByRole("button", { name: /Same swap from a normal wallet/ }).click();
    await page.waitForTimeout(25_000);
  } else if (scene === "intent") {
    await page.goto(url + "/#/app");
    await page.getByText("Post an intent").first().click();
    await pause(2000);
    await page.getByRole("button", { name: /Sign intent/ }).click();
    await page.waitForSelector("text=/Filled/", { timeout: 240_000 });
    await pause(5000);
  }
} finally {
  if (process.env.SAVE_STATE) await ctx.storageState({ path: process.env.SAVE_STATE });
  await ctx.close();
  await browser.close();
  console.log("video saved under", out);
}
