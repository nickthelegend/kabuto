/**
 * Film takes for the v3 demo, recorded live against the deployed app and the hosted bot.
 *   node record2.mjs landing            -> takes/landing.webm
 *   node record2.mjs attack             -> takes/attack-dex.webm + takes/attack-term.webm (same start time)
 *   node record2.mjs intent             -> takes/intent.webm
 * KABUTO_STATE: Playwright storage state for https://kabuto-self.vercel.app (devnet wallet; gitignored).
 * TTYD_URL: a ttyd serving `pnpm --dir packages/bot watch` (default http://localhost:7681).
 */
import { chromium } from "playwright";
import { mkdirSync, renameSync } from "node:fs";
import { fileURLToPath } from "node:url";
const scene = process.argv[2];
const OUT = fileURLToPath(new URL("./takes/", import.meta.url)); mkdirSync(OUT, { recursive: true });
const APP = "https://kabuto-self.vercel.app";
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const b = await chromium.launch();
const ctxFor = async (dir, size, state = true) => b.newContext({ viewport: size, deviceScaleFactor: 1, recordVideo: { dir, size }, ...(state ? { storageState: process.env.KABUTO_STATE } : {}) });
const save = async (ctx, page, name) => { const v = page.video(); await ctx.close(); renameSync(await v.path(), `${OUT}/${name}.webm`); log("saved", name); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (scene === "landing") {
  const ctx = await ctxFor(OUT + "tmp", { width: 1920, height: 1080 }, false);
  const p = await ctx.newPage();
  await p.goto(`${APP}/#/`); await sleep(5500);
  const H = await p.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y < H; y += 60) { await p.mouse.wheel(0, 60); await sleep(70); }
  await sleep(1500);
  await save(ctx, p, "landing");
}

async function swap(p, label) {
  await p.fill("#dx-in", "1500"); await sleep(2500);
  const btn = p.locator(".dx-col .dx-cta").first();
  for (let i = 0; i < 3 && /Get test/.test(await btn.innerText()); i++) { await btn.click(); await p.waitForFunction(() => !document.querySelector(".dx-col .dx-cta")?.textContent?.includes("Minting"), null, { timeout: 120000 }); await sleep(3000); }
  await btn.hover(); await sleep(700); await btn.click();
  const t0 = Date.now();
  while (Date.now() - t0 < 150000) { await sleep(1000); const r = p.locator(".dx-result").first(); if (await r.count()) { const t = await r.innerText(); if (!t.includes("Waiting")) { log(label, t.replace(/\n+/g, " | ")); return t; } } }
  return "";
}

if (scene === "attack") {
  const dexCtx = await ctxFor(OUT + "tmp", { width: 1280, height: 1000 });
  const termCtx = await ctxFor(OUT + "tmp2", { width: 1100, height: 1000 }, false);
  const d = await dexCtx.newPage(), t = await termCtx.newPage();
  await Promise.all([d.goto(`${APP}/#/app`), t.goto(process.env.TTYD_URL ?? "http://localhost:7681")]);
  await sleep(6000);
  const off = await swap(d, "off");
  // wait until the hosted bot has finished its back-run and rebalance, so it is free to attack the protected swap
  for (let i = 0; i < 60; i++) { const st = await fetch("https://kabuto-bot.201-18-198-162.sslip.io/status").then((r) => r.json()).catch(() => ({})); if (st.busy === false) break; await sleep(2000); }
  await sleep(4000);
  await d.locator(".dx-switch").hover(); await sleep(600); await d.click(".dx-switch"); await sleep(1800);
  const on = await swap(d, "on");
  await sleep(14000);
  await save(dexCtx, d, "attack-dex"); await save(termCtx, t, "attack-term");
  log("RESULT off:", /Sandwiched/.test(off), "on:", /blocked/.test(on));
}

if (scene === "intent") {
  const ctx = await ctxFor(OUT + "tmp", { width: 1280, height: 1000 });
  const p = await ctx.newPage();
  await p.goto(`${APP}/#/app`); await sleep(5000);
  await p.locator('.dx-tabs button:nth-child(2)').hover(); await sleep(500); await p.click('.dx-tabs button:nth-child(2)'); await sleep(2500);
  await p.fill("#dx-int", "300"); await sleep(2000);
  await p.locator(".dx-col .dx-cta").first().click();
  const t0 = Date.now();
  while (Date.now() - t0 < 180000) { await sleep(2000); const c = p.locator(".dx-result").first(); if (await c.count() && /Received/.test(await c.innerText())) break; }
  await sleep(6000);
  await save(ctx, p, "intent");
}
await b.close();
