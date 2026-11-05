import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { encodeFunctionData, parseUnits, type Hex } from "viem";
import { D } from "./lib/config";
import { pub, sendLegacy } from "./lib/chain";
import { balances, fmt, priceFromSqrt, quote, sqrtPrice, tokenIn, tokenOut, type Side } from "./lib/market";
import { forget, load, onboard, shortError, STEPS, type Saved, type Step } from "./lib/wallet";
import { kabutoSwap, normalSwap, type Attempt } from "./lib/swap";
import { postIntent, relayEvents, signIntent, type RelayEvent, type SignedIntent } from "./lib/intent";
import { tokenAbi } from "./lib/abi";
import { AnimatePresence, motion, MotionConfig } from "motion/react";
import "./dex.css";

const spring = { type: "spring", stiffness: 520, damping: 38 } as const;
const pop = { initial: { opacity: 0, y: 18, scale: 0.98 }, animate: { opacity: 1, y: 0, scale: 1 }, exit: { opacity: 0, y: -10, scale: 0.98 }, transition: { type: "spring", stiffness: 380, damping: 32 } } as const;

const short = (a?: string, n = 6) => (a ? `${a.slice(0, n)}…${a.slice(-4)}` : "");
const txUrl = (h?: string) => `${D.explorer}tx/${h}`;
type Bals = { eth: bigint; kusd: bigint; weth: bigint };
const UNPROTECTED_SLIPPAGE_BPS = 200; // what an ordinary wallet sends (2%)
/** kUSD lost to a worse fill, from the attempt's own numbers (no live price): buy = share of kUSD paid, sell = kUSD short. */
const lossKusd = (a: Attempt) => (a.out === undefined || a.quoted <= a.out ? 0 : a.side === "buy" ? (Number(a.amountIn) / 1e6) * (Number(a.quoted - a.out) / Number(a.quoted)) : Number(a.quoted - a.out) / 1e6);
const fmtGas = (w: bigint) => (w === 0n ? "0 ETH" : w < 10n ** 12n ? `${(Number(w) / 1e9).toLocaleString("en-US", { maximumFractionDigits: 1 })} gwei` : `${fmt(w, 18, 6)} ETH`);
type Loss = { kusd: number; side: Side; amountIn: bigint };

/* ------------------------------------------------------------------ shared live state */
function useLive() {
  const [block, setBlock] = useState<bigint | null>(null);
  const [sqrtP, setSqrtP] = useState<bigint | null>(null);
  useEffect(() => {
    let alive = true;
    const tick = async () => { try { const [b, p] = await Promise.all([pub.getBlockNumber(), sqrtPrice()]); if (alive) { setBlock(b); setSqrtP(p); } } catch { /* offline */ } };
    tick(); const t = setInterval(tick, 3000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  return { block, sqrtP };
}

export function Dex() {
  const [w, setW] = useState<Saved | null>(() => { const s = load(); return s?.account && s.staked ? s : null; });
  const [tab, setTab] = useState<"swap" | "intents">("swap");
  const [connectOpen, setConnectOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const live = useLive();
  const [acct, setAcct] = useState<Bals | null>(null);
  const [eoa, setEoa] = useState<Bals | null>(null);

  const refresh = useCallback(async () => {
    if (!w) return;
    try { const [a, e] = await Promise.all([balances(w.account!), balances(w.funder)]); setAcct(a); setEoa(e); } catch { /* blip */ }
  }, [w]);
  useEffect(() => { refresh(); }, [refresh, live.block]);

  return (
    <MotionConfig reducedMotion="user">
    <div className="dx">
      <header className="dx-nav">
        <a className="dx-brand" href="#/">Kabuto</a>
        <nav className="dx-tabs" role="tablist" aria-label="Kabuto">
          {(["swap", "intents"] as const).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
              {tab === t && <motion.span className="dx-tab-pill" layoutId="dx-tab-pill" transition={spring} />}
              <span className="dx-tab-l">{t === "swap" ? "Swap" : "Intents"}</span>
            </button>
          ))}
        </nav>
        <div className="dx-right">
          {w ? (
            <div className="dx-prof">
              <button className="dx-chip" onClick={() => setMenuOpen((o) => !o)} aria-expanded={menuOpen}><i className="dx-ava" aria-hidden />{short(w.account, 6)}</button>
              {menuOpen && <Profile w={w} acct={acct} eoa={eoa} onClose={() => setMenuOpen(false)} onReset={() => { forget(); setW(null); setMenuOpen(false); }} onTopped={refresh} />}
            </div>
          ) : (
            <button className="dx-connect" onClick={() => setConnectOpen(true)}>Connect wallet</button>
          )}
        </div>
      </header>

      <main className="dx-main">
        <AnimatePresence mode="wait" initial={false}>
        <motion.div key={tab} className="dx-pane" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.2, ease: [0.2, 0.7, 0.2, 1] }}>
        {tab === "swap" ? (
          <SwapPanel w={w} acct={acct} eoa={eoa} sqrtP={live.sqrtP} onConnect={() => setConnectOpen(true)} onDone={refresh} />
        ) : (
          <IntentsPanel w={w} acct={acct} sqrtP={live.sqrtP} onConnect={() => setConnectOpen(true)} />
        )}
        </motion.div>
        </AnimatePresence>
      </main>

      {connectOpen && <Connect onClose={() => setConnectOpen(false)} onDone={(s) => { setW(s); setConnectOpen(false); }} />}
    </div>
    </MotionConfig>
  );
}

/* ------------------------------------------------------------------ connect + profile */
function Connect({ onClose, onDone }: { onClose: () => void; onDone: (w: Saved) => void }) {
  const [steps, setSteps] = useState<Step[]>(STEPS.map((s) => ({ ...s })));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    setBusy(true); setErr(null);
    try { onDone(await onboard((id, p) => setSteps((prev) => prev.map((s) => (s.id === id ? { ...s, ...p } : s))))); }
    catch (e: any) { setErr(shortError(e)); } finally { setBusy(false); }
  };
  return (
    <div className="dx-modal" role="dialog" aria-modal="true" aria-label="Connect wallet" onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="dx-sheet">
        <div className="dx-sheet-h"><b>Connect wallet</b><button onClick={onClose} disabled={busy} aria-label="Close">×</button></div>
        <ol className="dx-steps">
          {steps.map((s, i) => (
            <li key={s.id} data-state={s.state}><span>{s.state === "done" ? "✓" : s.state === "error" ? "!" : i + 1}</span>{s.label}</li>
          ))}
        </ol>
        {err && <div className="dx-err" role="alert">{err}</div>}
        <button className="dx-cta" onClick={go} disabled={busy}>{busy ? "Connecting…" : load() ? "Resume" : "Create wallet"}</button>
      </div>
    </div>
  );
}

function Profile({ w, acct, eoa, onClose, onReset, onTopped }: { w: Saved; acct: Bals | null; eoa: Bals | null; onClose: () => void; onReset: () => void; onTopped: () => void }) {
  const [busy, setBusy] = useState(false);
  const topUp = async () => {
    setBusy(true);
    try { for (const to of [w.account!, w.funder]) await sendLegacy(w.funderKey, { to: D.kusd, data: encodeFunctionData({ abi: tokenAbi, functionName: "faucet", args: [to] }) }); onTopped(); }
    finally { setBusy(false); }
  };
  return (
    <div className="dx-menu" role="menu">
      <div className="dx-menu-row"><small>Kabuto account</small><a href={`${D.explorer}address/${w.account}`} target="_blank" rel="noreferrer">{short(w.account, 10)}</a></div>
      <div className="dx-bal"><span>{acct ? fmt(acct.kusd, 6, 2) : "…"} <em>kUSD</em></span><span>{acct ? fmt(acct.weth, 18, 4) : "…"} <em>WETH</em></span><span>{acct ? fmt(acct.eth, 18, 4) : "…"} <em>ETH</em></span></div>
      <div className="dx-menu-row"><small>Ordinary wallet</small><span className="mono">{short(w.funder, 10)}</span></div>
      <div className="dx-bal"><span>{eoa ? fmt(eoa.kusd, 6, 2) : "…"} <em>kUSD</em></span><span>{eoa ? fmt(eoa.weth, 18, 4) : "…"} <em>WETH</em></span><span>{eoa ? fmt(eoa.eth, 18, 4) : "…"} <em>ETH</em></span></div>
      <button className="dx-menu-btn" onClick={topUp} disabled={busy}>{busy ? "Minting…" : "Get 1,000 test kUSD"}</button>
      <button className="dx-menu-btn ghost" onClick={() => { if (confirm("Forget this devnet wallet in this browser?")) onReset(); }}>Disconnect</button>
      <button className="dx-menu-x" onClick={onClose} aria-label="Close">×</button>
    </div>
  );
}

/* ------------------------------------------------------------------ swap */
function SwapPanel({ w, acct, eoa, sqrtP, onConnect, onDone }: { w: Saved | null; acct: Bals | null; eoa: Bals | null; sqrtP: bigint | null; onConnect: () => void; onDone: () => void }) {
  const [side, setSide] = useState<Side>("buy");
  const [amount, setAmount] = useState("1500");
  const [protect, setProtect] = useState(false);
  const [bandBps, setBandBps] = useState(50);
  const [q, setQ] = useState<bigint | null>(null);
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<Attempt | null>(null);
  const [loss, setLoss] = useState<Loss | null>(null);
  const tin = tokenIn(side), tout = tokenOut(side);
  const price = sqrtP ? priceFromSqrt(sqrtP) : null; // kUSD per WETH
  const amountIn = useMemo(() => { try { const v = parseUnits(amount || "0", tin.decimals); return v > 0n ? v : null; } catch { return null; } }, [amount, tin.decimals]);
  useEffect(() => {
    let alive = true;
    if (!amountIn) { setQ(null); return; }
    quote(side, amountIn).then((r) => alive && setQ(r)).catch(() => alive && setQ(null));
    return () => { alive = false; };
  }, [side, amountIn, sqrtP]);

  const src = protect ? acct : eoa;
  const have = src ? (side === "buy" ? src.kusd : src.weth) : undefined;
  const insufficient = !!amountIn && have !== undefined && amountIn > have;
  const toKusd = (v: bigint, decimals: number, isWeth: boolean) => (isWeth ? (Number(v) / 10 ** decimals) * (price ?? 0) : Number(v) / 10 ** decimals);

  const swap = async () => {
    if (!w || !amountIn) return;
    setBusy(true); setLast(null);
    try {
      const a = protect ? await kabutoSwap(w, side, amountIn, bandBps, setLast) : await normalSwap(w, side, amountIn, UNPROTECTED_SLIPPAGE_BPS, setLast);
      setLast(a);
      if (!protect && a.phase === "included") setLoss({ kusd: lossKusd(a), side: a.side, amountIn: a.amountIn });
      onDone();
    } finally { setBusy(false); }
  };

  return (
    <div className="dx-col">
      <section className="dx-card" aria-label="Swap">
        <div className="dx-card-h"><b>Swap</b><span className="dx-pill">Uniswap v4</span></div>
        <div className="dx-box">
          <label htmlFor="dx-in">You pay</label>
          <div className="dx-row">
            <input id="dx-in" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} />
            <span className="dx-token" data-t={tin.symbol}>{tin.symbol}</span>
          </div>
          <div className="dx-sub"><span>{amountIn && price ? `≈ ${toKusd(amountIn, tin.decimals, tin.symbol === "WETH").toLocaleString("en-US", { maximumFractionDigits: 0 })} kUSD` : " "}</span><span>Balance {have !== undefined ? fmt(have, tin.decimals, side === "buy" ? 2 : 4) : "–"}</span></div>
        </div>
        <button className="dx-flip" aria-label="Switch direction" onClick={() => setSide(side === "buy" ? "sell" : "buy")}>↓</button>
        <div className="dx-box">
          <label>You receive</label>
          <div className="dx-row"><output>{q !== null ? fmt(q, tout.decimals, side === "buy" ? 5 : 2) : "0"}</output><span className="dx-token" data-t={tout.symbol}>{tout.symbol}</span></div>
          <div className="dx-sub"><span>{price ? `1 WETH = ${price.toLocaleString("en-US", { maximumFractionDigits: 2 })} kUSD` : " "}</span><span> </span></div>
        </div>

        <div className={`dx-protect ${protect ? "on" : ""}`}>
          <div className="dx-protect-l"><i className="dx-shield" aria-hidden /><b>Sandwich protection</b></div>
          <span className="dx-protect-s">{protect ? "On" : "Off"}</span>
          <button role="switch" aria-checked={protect} aria-label="Sandwich protection" className="dx-switch" onClick={() => setProtect(!protect)}><motion.i animate={{ x: protect ? 22 : 0 }} transition={spring} /></button>
        </div>
        <AnimatePresence initial={false}>
          {protect && (
            <motion.div className="dx-band" role="group" aria-label="Price pin" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.22, ease: [0.2, 0.7, 0.2, 1] }} style={{ overflow: "hidden" }}>
              <span>Price pin</span>
              {[30, 50, 100].map((b) => <button key={b} aria-pressed={bandBps === b} onClick={() => setBandBps(b)}>±{(b / 100).toFixed(1)}%</button>)}
            </motion.div>
          )}
        </AnimatePresence>

        {!w ? (
          <button className="dx-cta" onClick={onConnect}>Connect wallet</button>
        ) : (
          <button className={`dx-cta ${protect ? "shu" : ""}`} disabled={busy || !amountIn || insufficient} onClick={swap}>
            {busy ? "Swapping…" : insufficient ? `Not enough ${tin.symbol}` : "Swap"}
          </button>
        )}
      </section>

      <AnimatePresence mode="popLayout">{last && <SwapResult key={last.id} a={last} protect={last.wallet === "kabuto"} loss={loss} />}</AnimatePresence>
    </div>
  );
}

function SwapResult({ a, protect, loss }: { a: Attempt; protect: boolean; loss: Loss | null }) {
  const tout = tokenOut(a.side);
  const pending = !["included", "cancelled", "rejected", "reverted", "failed"].includes(a.phase);
  const worse = a.out !== undefined && a.quoted > 0n ? Number(a.quoted - a.out) / Number(a.quoted) : null;
  const lostHere = lossKusd(a);
  let tone = "", title = "", body = "";
  if (pending) { title = "Waiting for a block…"; }
  else if (a.phase === "cancelled" || a.phase === "rejected") { tone = "good"; title = "Sandwich blocked"; body = "Not included · 0 gas · tokens untouched"; }
  else if (a.phase === "included" && worse !== null && worse > 0.0015) { tone = "bad"; title = `Sandwiched · ${(worse * 100).toFixed(2)}% worse`; body = `Lost ${lostHere.toLocaleString("en-US", { maximumFractionDigits: 2 })} kUSD`; }
  else if (a.phase === "included") { tone = "good"; title = "Filled at your price"; }
  else { tone = "bad"; title = "Did not complete"; body = a.error ?? ""; }
  const saved = protect && !pending && !!loss && loss.kusd > 0 && loss.side === a.side && loss.amountIn === a.amountIn && (a.phase === "cancelled" || a.phase === "rejected" || (a.phase === "included" && (worse ?? 0) <= 0.0015));
  return (
    <motion.section layout {...pop} className={`dx-result ${tone}`} aria-live="polite">
      <div className="dx-result-h"><span className="dx-tag">{protect ? "Protected" : "Unprotected"}</span>{a.hash && <a href={txUrl(a.hash)} target="_blank" rel="noreferrer">{short(a.hash, 8)} ↗</a>}</div>
      <b>{title}</b>
      {body && <p>{body}</p>}
      <div className="dx-kv">
        <div><small>Quoted</small><span>{a.quoted ? `${fmt(a.quoted, tout.decimals, 5)} ${tout.symbol}` : "…"}</span></div>
        <div><small>Received</small><span>{a.out !== undefined ? `${fmt(a.out, tout.decimals, 5)} ${tout.symbol}` : pending ? "…" : "—"}</span></div>
        <div><small>Gas</small><span>{a.gasWei !== undefined ? fmtGas(a.gasWei) : a.phase === "cancelled" || a.phase === "rejected" ? "0 ETH" : "…"}</span></div>
      </div>
      <AnimatePresence>{saved && <motion.div className="dx-saved" initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} transition={{ type: "spring", stiffness: 300, damping: 18 }}><small>You saved vs. the same swap unprotected</small><b>{loss!.kusd.toLocaleString("en-US", { maximumFractionDigits: 2 })} kUSD</b></motion.div>}</AnimatePresence>
    </motion.section>
  );
}

/* ------------------------------------------------------------------ intents */
type Posted = { id: string; at: number; signed: SignedIntent; side: Side; outBefore: bigint };
function IntentsPanel({ w, acct, sqrtP, onConnect }: { w: Saved | null; acct: Bals | null; sqrtP: bigint | null; onConnect: () => void }) {
  const [amount, setAmount] = useState("300");
  const [windowSec, setWindowSec] = useState(120);
  const [q, setQ] = useState<bigint | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [posted, setPosted] = useState<Posted[]>([]);
  const [events, setEvents] = useState<RelayEvent[]>([]);
  const [relayUp, setRelayUp] = useState<boolean | null>(null);
  const side: Side = "buy";
  const tin = tokenIn(side), tout = tokenOut(side);
  const amountIn = useMemo(() => { try { const v = parseUnits(amount || "0", 6); return v > 0n ? v : null; } catch { return null; } }, [amount]);
  useEffect(() => { let alive = true; if (!amountIn) { setQ(null); return; } quote(side, amountIn).then((r) => alive && setQ(r)).catch(() => alive && setQ(null)); return () => { alive = false; }; }, [amountIn, sqrtP]);
  const es = useRef<EventSource | null>(null);
  useEffect(() => {
    try { es.current = relayEvents(); } catch { setRelayUp(false); return; }
    es.current.onopen = () => setRelayUp(true);
    es.current.onerror = () => setRelayUp(false);
    const on = (m: MessageEvent) => { try { setEvents((p) => [...p, JSON.parse(m.data)].slice(-300)); } catch { /* skip */ } };
    for (const t of ["intent_posted", "fill_submitted", "fill_landed", "fill_refused", "fill_replaced"]) es.current.addEventListener(t, on as EventListener);
    return () => es.current?.close();
  }, []);
  const post = async () => {
    if (!w || !amountIn) return;
    setBusy(true); setErr(null);
    try { const before = await balances(w.account!); const { signed } = await signIntent(w, side, amountIn, { startBps: 30, endBps: 200, windowSec }); const id = await postIntent(signed); setPosted((p) => [{ id, at: Date.now(), signed, side, outBefore: side === "buy" ? before.weth : before.kusd }, ...p]); }
    catch (e: any) { setErr(shortError(e)); } finally { setBusy(false); }
  };
  const insufficient = !!amountIn && acct !== null && amountIn > acct.kusd;
  return (
    <div className="dx-col">
      <section className="dx-card" aria-label="Post an intent">
        <div className="dx-card-h"><b>Intent</b><span className={`dx-pill ${relayUp ? "live" : ""}`}>{relayUp ? "Fillers online" : relayUp === false ? "Relay offline" : "Connecting…"}</span></div>
        <div className="dx-box">
          <label htmlFor="dx-int">You sell</label>
          <div className="dx-row"><input id="dx-int" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} /><span className="dx-token" data-t={tin.symbol}>{tin.symbol}</span></div>
          <div className="dx-sub"><span> </span><span>Balance {acct ? fmt(acct.kusd, 6, 2) : "–"}</span></div>
        </div>
        <div className="dx-box">
          <label>You get at least</label>
          <div className="dx-row"><output>{q ? fmt((q * 9970n) / 10_000n, tout.decimals, 5) : "0"}</output><span className="dx-token" data-t={tout.symbol}>{tout.symbol}</span></div>
          <div className="dx-sub"><span>→ {q ? fmt((q * 9800n) / 10_000n, tout.decimals, 5) : "…"} by the deadline</span><span> </span></div>
        </div>
        <div className="dx-band" role="group" aria-label="Auction window"><span>Window</span>{[60, 120, 300].map((s) => <button key={s} aria-pressed={windowSec === s} onClick={() => setWindowSec(s)}>{s < 120 ? `${s}s` : `${s / 60} min`}</button>)}</div>
        {err && <div className="dx-err" role="alert">{err}</div>}
        {!w ? <button className="dx-cta" onClick={onConnect}>Connect wallet</button> : <button className="dx-cta" disabled={busy || !amountIn || insufficient} onClick={post}>{busy ? "Signing…" : insufficient ? "Not enough kUSD" : "Sign intent"}</button>}
      </section>
      <AnimatePresence initial={false}>{posted.map((p) => <IntentCard key={p.id} p={p} events={events.filter((e) => e.intentId === p.id)} />)}</AnimatePresence>
    </div>
  );
}

function IntentCard({ p, events }: { p: Posted; events: RelayEvent[] }) {
  const tout = tokenOut(p.side), tin = tokenIn(p.side);
  const landed = events.find((e) => e.type === "fill_landed");
  const [received, setReceived] = useState<bigint | null>(null);
  useEffect(() => {
    if (!landed) return;
    balances(p.signed.account).then((b) => setReceived((p.side === "buy" ? b.weth : b.kusd) - p.outBefore)).catch(() => {});
  }, [!!landed]);
  const submitted = events.filter((e) => e.type === "fill_submitted").length;
  const refused = events.filter((e) => e.type === "fill_refused").length;
  const steps = [
    { k: "Signed", on: true, d: "0 gas" },
    { k: "Posted", on: true, d: "" },
    { k: "Fillers racing", on: submitted > 0, d: submitted ? `${submitted} bid${submitted > 1 ? "s" : ""}${refused ? ` · ${refused} refused` : ""}` : "" },
    { k: "Filled", on: !!landed, d: landed ? "filler paid gas" : "" },
  ];
  return (
    <motion.section layout {...pop} className={`dx-result ${landed ? "good" : ""}`}>
      <div className="dx-result-h"><span className="dx-tag">{fmt(p.signed.intent.maxIn, tin.decimals, 0)} {tin.symbol} → {tout.symbol}</span>{landed?.hash && <a href={txUrl(landed.hash as Hex)} target="_blank" rel="noreferrer">{short(landed.hash, 8)} ↗</a>}</div>
      <ol className="dx-track">{steps.map((s) => <li key={s.k} data-on={s.on}><motion.i animate={{ scale: s.on ? [1, 1.5, 1] : 1 }} transition={{ duration: 0.45 }} /><b>{s.k}</b><span>{s.d}</span></li>)}</ol>
      <div className="dx-kv">
        {received !== null && <div><small>Received</small><span>{fmt(received, tout.decimals, 5)} {tout.symbol}</span></div>}
        <div><small>Minimum</small><span>{fmt(p.signed.intent.startOut, tout.decimals, 5)} → {fmt(p.signed.intent.endOut, tout.decimals, 5)} {tout.symbol}</span></div>
        <div><small>Your gas</small><span>0 ETH</span></div>
      </div>
    </motion.section>
  );
}
