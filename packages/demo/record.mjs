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
// fit the swap card and the live lane on one 1440x900 screen so nothing scrolls out of view
if (process.env.ZOOM) await page.addInitScript((z) => { document.addEventListener("DOMContentLoaded", () => { document.documentElement.style.zoom = z; }); }, process.env.ZOOM);
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
  } else if (scene === "protected2") {
    // the protected swap alone, started only when the live bot is idle; every attempt stays in the footage
    const botIdle = async () => { for (let i = 0; i < 60; i++) { try { const st = await (await fetch("http://localhost:8787/status")).json(); if (!st.busy) return; } catch {} await pause(1000); } };
    await page.goto(url + "/#/app");
    await page.getByText("Protected swap").first().click();
    await page.fill("#amt", ""); await page.type("#amt", "1000", { delay: 60 });
    await pause(4000);
    for (let attempt = 0; attempt < 3; attempt++) {
      await botIdle();
      const before = await page.locator(".feed > li").count().catch(() => 0);
      await page.getByRole("button", { name: "Swap with Kabuto" }).click();
      await page.waitForFunction((n) => { const li = [...document.querySelectorAll(".feed > li")].find((x) => x.innerText.startsWith("Kabuto")); return li && /Included\n|Never included|Refused at the door|Failed/.test(li.innerText) && document.querySelectorAll(".feed > li").length > n; }, before, { timeout: 180_000 });
      await pause(6000);
      const top = await page.locator(".feed > li", { hasText: "Kabuto" }).first().innerText();
      console.log("attempt", attempt + 1, top.split("\n").slice(0, 4).join(" | "));
      if (/Never included|Refused at the door/.test(top)) break;
      await pause(8000);
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
  } else if (scene === "full") {
    const setAmount = async (v) => { await page.fill("#amt", ""); await page.type("#amt", v, { delay: 60 }); await pause(2500); };
    const feedHas = (re) => page.waitForFunction((src) => new RegExp(src).test(document.querySelector(".feed")?.innerText ?? ""), re.source, { timeout: 240_000 });
    await page.goto(url + "/#/app");
    await pause(2000);
    if (!(await page.locator(".modes").count())) {
      await page.getByRole("button", { name: /Create my Kabuto account|Resume setup/ }).click();
      await page.waitForSelector(".modes", { timeout: 300_000 });
    }
    await pause(2500);
    // top up until both the Kabuto account and the comparison wallet hold enough kUSD for the 1,500 swap
    for (let i = 0; i < 2; i++) {
      await page.getByRole("button", { name: /test kUSD/ }).click();
      await page.waitForFunction(() => !/minting/.test([...document.querySelectorAll("button")].map((b) => b.innerText).join(" ")), null, { timeout: 120_000 });
    }
    await pause(6000);
    // 1. the ordinary wallet: the live bot sandwiches it
    await setAmount("1500");
    await page.getByRole("button", { name: /Same swap from a normal wallet/ }).click();
    await feedHas(/Filled .*worse|Filled at the quoted/);
    await pause(6000);
    // 2. the same swap with Kabuto, started once the live bot is idle; every attempt stays in the footage
    const botIdle = async () => { for (let i = 0; i < 90; i++) { try { const st = await (await fetch("http://localhost:8787/status")).json(); if (!st.busy) return; } catch {} await pause(1000); } };
    for (let attempt = 0; attempt < 3; attempt++) {
      await botIdle();
      await pause(3000);
      const n = await page.locator(".feed > li", { hasText: "pin ±" }).count();
      await page.getByRole("button", { name: "Swap with Kabuto" }).click();
      await page.waitForFunction((n) => { const rows = [...document.querySelectorAll(".feed > li")].filter((x) => x.innerText.includes("pin ±")); return rows.length > n && /Included\n|Never included|Refused at the door|Failed/.test(rows[0].innerText); }, n, { timeout: 180_000 });
      await pause(7000);
      const top = await page.locator(".feed > li", { hasText: "pin ±" }).first().innerText();
      console.log("kabuto attempt", attempt + 1, top.split("\n").slice(0, 4).join(" | "));
      if (/Never included|Refused at the door/.test(top)) break;
    }
    // 3. open intent: sign, a filler races and fills
    await page.getByText("Post an intent").first().click();
    await setAmount("300");
    await page.getByRole("button", { name: /Sign intent/ }).click();
    await feedHas(/Filled\nA filler completed/);
    await pause(7000);
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
