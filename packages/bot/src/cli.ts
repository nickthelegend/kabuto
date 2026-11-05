/**
 * Terminal view of the sandwich bot. Read-only: subscribes to the bot's /events stream (and optionally replays its
 * last attempts) and prints what happened to each victim swap, with the bot's own measured numbers.
 *
 *   pnpm --dir packages/bot watch                       # live, against the hosted bot
 *   pnpm --dir packages/bot watch -- --history 3        # also print the last 3 recorded attempts first
 *   BOT_URL=http://localhost:8787 pnpm --dir packages/bot watch
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const BOT_URL = (process.env.BOT_URL ?? "https://kabuto-bot.201-18-198-162.sslip.io").replace(/\/$/, "");
const EXPLORER = "https://explorer.altmempool.wtf/tx/";
const D = JSON.parse(readFileSync(fileURLToPath(new URL("../../../deployments/1337.json", import.meta.url)), "utf8"));
const wethIs0: boolean = D.wethIs0;
const historyArg = process.argv.indexOf("--history");
const HISTORY = historyArg > 0 ? Number(process.argv[historyArg + 1] ?? 3) : 0;

const c = { dim: "\x1b[2m", b: "\x1b[1m", red: "\x1b[38;5;203m", gold: "\x1b[38;5;222m", green: "\x1b[38;5;151m", grey: "\x1b[38;5;245m", x: "\x1b[0m" };
const short = (h?: string | null) => (h ? `${h.slice(0, 10)}…${h.slice(-4)}` : "—");
const time = (t?: string) => (t ? new Date(t) : new Date()).toISOString().slice(11, 19);
const tok = (currency0In: boolean) => (currency0In === wethIs0 ? { inSym: "WETH", inDec: 18, outSym: "kUSD", outDec: 6 } : { inSym: "kUSD", inDec: 6, outSym: "WETH", outDec: 18 });
const units = (v: string | bigint | null | undefined, d: number, dp = 6) => (v === null || v === undefined ? "—" : (Number(BigInt(v)) / 10 ** d).toLocaleString("en-US", { maximumFractionDigits: dp }));
const loc = (r: any) => (r ? `block ${r.blockNumber} · index ${r.transactionIndex}${r.status === "success" ? "" : ` · ${r.status}`}` : "not in a block");

function victim(e: any) {
  const t = tok(e.direction === true || e.direction === "currency0To1");
  const who = e.pinned ? `${c.gold}Kabuto swap (price pinned in VERIFY)${c.x}` : `${c.b}ordinary wallet swap${c.x}`;
  console.log(`\n${c.grey}${time()}${c.x}  ${c.b}VICTIM${c.x}   ${short(e.hash)}  ${who}`);
  console.log(`           ${units(e.amountIn, t.inDec, 4)} ${t.inSym} → ${t.outSym}${e.pinned ? "" : ` · accepts ≥ ${units(e.minAmountOut, t.outDec)} ${t.outSym}`}`);
  console.log(`${c.dim}           bot: building front-run + back-run…${c.x}`);
}

function attempt(a: any) {
  const t = tok(a.direction === "currency0To1");
  console.log(`${c.grey}${time(a.timestamp)}${c.x}  ${c.b}ATTACK${c.x}   front-run ${short(a.frontRunHash)}  ${loc(a.front)}`);
  console.log(`                   victim    ${short(a.victimHash)}  ${a.victim ? loc(a.victim) : a.victimStatus === "Cancelled" ? `${c.green}never included (Cancelled)${c.x}` : `status ${a.victimStatus}`}`);
  if (a.backRunHash) console.log(`                   back-run  ${short(a.backRunHash)}  ${loc(a.back)}`);
  if (a.sandwichObserved && a.victimLoss) {
    const quote = BigInt(a.noSandwichQuote), got = BigInt(a.victimRealizedOutput), loss = BigInt(a.victimLoss);
    const pct = (Number(loss) / Number(quote)) * 100;
    console.log(`         ${c.red}${c.b}SANDWICHED${c.x}  victim got ${units(got, t.outDec)} ${t.outSym}, quote without the bot ${units(quote, t.outDec)} ${t.outSym}`);
    console.log(`         ${c.red}${c.b}LOSS${c.x}        −${units(loss, t.outDec)} ${t.outSym}  (${c.red}−${pct.toFixed(2)}%${c.x})`);
  } else if (a.pinned && a.victimStatus === "Cancelled") {
    console.log(`         ${c.green}${c.b}BLOCKED${c.x}     the front-run moved the price out of the victim's band → its VERIFY frame fails → never included, 0 gas`);
    console.log(`         ${c.green}${c.b}LOSS${c.x}        0 ${t.outSym} — the bot is left holding its own front-run`);
  } else {
    console.log(`         ${c.grey}${a.summary}${c.x}`);
  }
  console.log(`         ${c.dim}bot P&L ${a.pnlKusd} kUSD (marked at the pool)${c.x}`);
  for (const [k, h] of [["front", a.frontRunHash], ["victim", a.victimHash], ["back", a.backRunHash]]) if (h) console.log(`         ${c.dim}${k.padEnd(6)} ${EXPLORER}${h}${c.x}`);
}

async function main() {
  const st = await fetch(`${BOT_URL}/status`).then((r) => r.json()).catch(() => null);
  if (!st) throw new Error(`Bot not reachable at ${BOT_URL}/status`);
  console.log(`${c.b}kabuto sandwich bot${c.x} ${c.grey}· ${BOT_URL}${c.x}`);
  console.log(`${c.grey}bot ${st.bot} · watching ${st.watching} · ${units(st.balances.kusd, 6, 2)} kUSD · ${units(st.balances.weth, 18, 4)} WETH · victims seen ${st.detected}${c.x}`);
  if (HISTORY > 0) {
    const past: any[] = await fetch(`${BOT_URL}/attempts`).then((r) => r.json());
    console.log(`\n${c.grey}── last ${Math.min(HISTORY, past.length)} recorded attempts ──${c.x}`);
    for (const a of past.slice(0, HISTORY).reverse()) { console.log(); attempt(a); }
    console.log(`\n${c.grey}── live ──${c.x}`);
  }
  const res = await fetch(`${BOT_URL}/events`, { headers: { Accept: "text/event-stream" } });
  if (!res.ok || !res.body) throw new Error(`No event stream at ${BOT_URL}/events (${res.status})`);
  const dec = new TextDecoder(); let buf = "";
  for await (const chunk of res.body as any) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i); buf = buf.slice(i + 2);
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (!data) continue;
      const e = JSON.parse(data); const ev = e.type;
      if (ev === "victim") victim(e);
      else if (ev === "attempt") attempt(e);
      else if (ev === "skipped") console.log(`${c.grey}${time()}  SKIPPED  ${short(e.victimHash)}  ${e.reason}${c.x}`);
    }
  }
}

main().catch((e) => { console.error(`${c.red}${e instanceof Error ? e.message : e}${c.x}`); process.exitCode = 1; });
