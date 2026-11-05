// Full-resolution screenshot of one landing section (real page), for the film.
import { chromium } from "playwright";
const [sel, out] = process.argv.slice(2);
const b = await chromium.launch({ headless: true });
const p = await b.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
await p.goto("http://localhost:5180/#/");
await p.waitForTimeout(2500);
await p.locator(sel).scrollIntoViewIfNeeded();
await p.waitForTimeout(800);
await p.locator(sel).screenshot({ path: out });
await b.close();
console.log("saved", out);
