import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { encodeFunctionData, formatUnits, parseUnits } from "viem";
import { D } from "./lib/config";
import { sendLegacy } from "./lib/chain";
import { balances, fmt, priceFromSqrt, tokenIn, tokenOut, TOKENS, type Side } from "./lib/market";
import { forget, load, onboard, shortError, STEPS, type Saved, type Step } from "./lib/wallet";
import { kabutoSwap, normalSwap, type Attempt } from "./lib/swap";
import { postIntent, relayEvents, signIntent, type RelayEvent } from "./lib/intent";
import { tokenAbi } from "./lib/abi";
import { ARKIV_WRITER, readArkivBoard, type BoardFill, type BoardIntent } from "./lib/arkiv";
import { bandWithinGuard, GUARD, guardMaxBandBps, localQuote, quoteOn, type Route } from "./lib/guard";
import { ChainPill, StallBanner, useLive, type Live } from "./dex/live";
import { lossKusd, SwapResult, type Loss } from "./dex/Result";
import { Activity, type SessionAttempt } from "./dex/Activity";
import { IntentCard, type Posted } from "./dex/IntentCard";
import { addrUrl, Icon, short, TxLink } from "./dex/ui";
import { AnimatePresence, motion, MotionConfig } from "motion/react";
import "./dex.css";

const spring = { type: "spring", stiffness: 520, damping: 38 } as const;

type Bals = { eth: bigint; kusd: bigint; weth: bigint };
/** Mint devnet kUSD (1,000 per faucet call) to `to` until it holds at least `need`. Real transactions from the funder key. */
async function mintKusd(w: Saved, to: `0x${string}`, need: bigint) {
  for (let i = 0; i < 6; i++) {
    const b = await balances(to);
    if (b.kusd >= need) return;
    await sendLegacy(w.funderKey, { to: D.kusd, data: encodeFunctionData({ abi: tokenAbi, functionName: "faucet", args: [to] }) });
  }
}
const UNPROTECTED_SLIPPAGE_BPS = 200; // what an ordinary wallet sends (2%)
/** Starting amounts sized to each pool's depth (the guarded pool was seeded with ~0.02 WETH), used until the user types. */
const DEFAULT_AMOUNT: Record<Route, Record<Side, string>> = { main: { buy: "1500", sell: "0.03" }, guard: { buy: "10", sell: "0.0002" } };
const TABS = ["swap", "intents"] as const;

/** Close on Escape and on a click outside `ref`. */
function useDismiss(open: boolean, close: () => void, ref: React.RefObject<HTMLElement>) {
  useEffect(() => {
    if (!open) return;
    const key = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape") close(); };
    const down = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) close(); };
    window.addEventListener("keydown", key);
    window.addEventListener("mousedown", down);
    return () => { window.removeEventListener("keydown", key); window.removeEventListener("mousedown", down); };
  }, [open, close, ref]);
}

export function Dex() {
  const [w, setW] = useState<Saved | null>(() => { const s = load(); return s?.account && s.staked ? s : null; });
  const [tab, setTab] = useState<(typeof TABS)[number]>("swap");
  const [connectOpen, setConnectOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const live = useLive();
  const [acct, setAcct] = useState<Bals | null>(null);
  const [eoa, setEoa] = useState<Bals | null>(null);
  const [session, setSession] = useState<SessionAttempt[]>([]);
  const [activityKey, setActivityKey] = useState(0);
  const prof = useRef<HTMLDivElement>(null);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  useDismiss(menuOpen, closeMenu, prof);

  const refresh = useCallback(async () => {
    if (!w) return;
    try { const [a, e] = await Promise.all([balances(w.account!), balances(w.funder)]); setAcct(a); setEoa(e); } catch { /* blip */ }
  }, [w]);
  useEffect(() => { refresh(); }, [refresh, live.block]);

  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const next = TABS[(TABS.indexOf(tab) + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length];
    setTab(next);
    document.getElementById(`dx-tab-${next}`)?.focus();
  };

  return (
    <MotionConfig reducedMotion="user">
    <div className="dx">
      <header className="dx-nav">
        <a className="dx-brand" href="#/">Kabuto</a>
        <nav className="dx-tabs" role="tablist" aria-label="Kabuto">
          {TABS.map((t) => (
            <button key={t} id={`dx-tab-${t}`} role="tab" aria-selected={tab === t} aria-controls="dx-panel" tabIndex={tab === t ? 0 : -1} onClick={() => setTab(t)} onKeyDown={onTabKey}>
              {tab === t && <motion.span className="dx-tab-pill" layoutId="dx-tab-pill" transition={spring} />}
              <span className="dx-tab-l">{t === "swap" ? "Swap" : "Intents"}</span>
            </button>
          ))}
        </nav>
        <div className="dx-right">
          <ChainPill live={live} />
          {w ? (
            <div className="dx-prof" ref={prof}>
              <button className="dx-chip" onClick={() => setMenuOpen((o) => !o)} aria-expanded={menuOpen} aria-haspopup="dialog" aria-label={`Wallet ${w.account}`}><i className="dx-ava" aria-hidden /><span className="dx-chip-a">{short(w.account, 6)}</span></button>
              {menuOpen && <Profile w={w} acct={acct} eoa={eoa} onClose={closeMenu} onReset={() => { forget(); setW(null); setMenuOpen(false); setSession([]); }} onTopped={refresh} />}
            </div>
          ) : (
            <button className="dx-connect" onClick={() => setConnectOpen(true)}>Connect wallet</button>
          )}
        </div>
      </header>

      <main className="dx-main">
        <StallBanner live={live} />
        <AnimatePresence mode="wait" initial={false}>
        <motion.div key={tab} id="dx-panel" role="tabpanel" aria-labelledby={`dx-tab-${tab}`} className="dx-pane" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.2, ease: [0.2, 0.7, 0.2, 1] }}>
        {tab === "swap" ? (
          <SwapPanel w={w} acct={acct} eoa={eoa} live={live} onConnect={() => setConnectOpen(true)}
            onAttempt={(a) => setSession((s) => [{ ...a, atBlock: live.block ?? undefined }, ...s.filter((x) => x.id !== a.id)].slice(0, 30))}
            onDone={() => { refresh(); setActivityKey((k) => k + 1); }}
            activity={w ? <Activity w={w} refreshKey={activityKey} session={session} /> : null} />
        ) : (
          <IntentsPanel w={w} acct={acct} live={live} onConnect={() => setConnectOpen(true)} onFilled={() => { refresh(); setActivityKey((k) => k + 1); }} />
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
  useEffect(() => {
    const key = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [busy, onClose]);
  const go = async () => {
    setBusy(true); setErr(null);
    try { onDone(await onboard((id, p) => setSteps((prev) => prev.map((s) => (s.id === id ? { ...s, ...p } : s))))); }
    catch (e: any) { setErr(shortError(e)); } finally { setBusy(false); }
  };
  return (
    <div className="dx-modal" role="dialog" aria-modal="true" aria-labelledby="dx-connect-t" onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="dx-sheet">
        <div className="dx-sheet-h"><b id="dx-connect-t">Connect wallet</b><button onClick={onClose} disabled={busy} aria-label="Close"><Icon name="x" /></button></div>
        <ol className="dx-steps" aria-live="polite">
          {steps.map((s, i) => (
            <li key={s.id} data-state={s.state}>
              <span aria-hidden>{s.state === "done" ? <Icon name="check" /> : s.state === "error" ? "!" : i + 1}</span>
              <div><p>{s.label}</p>{s.hash && <TxLink hash={s.hash} n={8} />}{s.state === "error" && s.detail && <small>{s.detail}</small>}</div>
            </li>
          ))}
        </ol>
        {err && <div className="dx-err" role="alert">{err}</div>}
        <button className="dx-cta" onClick={go} disabled={busy} autoFocus>{busy ? "Connecting…" : load() ? "Resume" : "Create wallet"}</button>
      </div>
    </div>
  );
}

function Profile({ w, acct, eoa, onClose, onReset, onTopped }: { w: Saved; acct: Bals | null; eoa: Bals | null; onClose: () => void; onReset: () => void; onTopped: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const topUp = async () => {
    setBusy(true); setErr(null);
    try { for (const to of [w.account!, w.funder]) await mintKusd(w, to, 3_000_000_000n); onTopped(); }
    catch (e) { setErr(shortError(e)); }
    finally { setBusy(false); }
  };
  const bal = (b: Bals | null) => (
    <div className="dx-bal"><span>{b ? fmt(b.kusd, 6, 2) : "…"} <em>kUSD</em></span><span>{b ? fmt(b.weth, 18, 4) : "…"} <em>WETH</em></span><span>{b ? fmt(b.eth, 18, 4) : "…"} <em>ETH</em></span></div>
  );
  return (
    <div className="dx-menu" role="dialog" aria-label="Wallet">
      <div className="dx-menu-row"><small><Icon name="shield" /> Kabuto account</small><a href={addrUrl(w.account)} target="_blank" rel="noreferrer">{short(w.account, 10)}</a></div>
      {bal(acct)}
      <div className="dx-menu-row"><small>Ordinary wallet</small><a href={addrUrl(w.funder)} target="_blank" rel="noreferrer">{short(w.funder, 10)}</a></div>
      {bal(eoa)}
      {err && <div className="dx-err" role="alert">{err}</div>}
      <button className="dx-menu-btn" onClick={topUp} disabled={busy}>{busy ? "Minting…" : "Top up test kUSD"}</button>
      <button className="dx-menu-btn ghost" onClick={() => { if (confirm("Forget this devnet wallet in this browser?")) onReset(); }}>Disconnect</button>
      <button className="dx-menu-x" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
    </div>
  );
}

/* ------------------------------------------------------------------ swap */
function SwapPanel({ w, acct, eoa, live, onConnect, onDone, onAttempt, activity }: {
  w: Saved | null; acct: Bals | null; eoa: Bals | null; live: Live; onConnect: () => void; onDone: () => void;
  onAttempt: (a: Attempt) => void; activity: React.ReactNode;
}) {
  const [side, setSide] = useState<Side>("buy");
  const [route, setRoute] = useState<Route>("main");
  const [amount, setAmountRaw] = useState(DEFAULT_AMOUNT.main.buy);
  const [touched, setTouched] = useState(false);
  const setAmount = (v: string) => { setTouched(true); setAmountRaw(v); };
  useEffect(() => { if (!touched) setAmountRaw(DEFAULT_AMOUNT[route][side]); }, [route, side]);
  const [protect, setProtect] = useState(false);
  const [bandBps, setBandBps] = useState(50);
  const [maxBand, setMaxBand] = useState<number | null>(null);
  const [q, setQ] = useState<bigint | null>(null);
  const [qErr, setQErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<Attempt | null>(null);
  const [loss, setLoss] = useState<Loss | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const tin = tokenIn(side), tout = tokenOut(side);
  const pool = route === "guard" ? live.guard : live.main;
  const price = pool ? priceFromSqrt(pool.sqrtP) : null; // kUSD per WETH, this pool
  const amountIn = useMemo(() => { try { const v = parseUnits(amount || "0", tin.decimals); return v > 0n ? v : null; } catch { return null; } }, [amount, tin.decimals]);

  useEffect(() => { if (GUARD) guardMaxBandBps().then(setMaxBand).catch(() => setMaxBand(null)); }, []);
  // quote: v4 Quoter on the plain pool; on-chain state + v4 math on the guarded pool (its hook refuses the Quoter)
  useEffect(() => {
    let alive = true;
    if (!amountIn) { setQ(null); setQErr(null); return; }
    if (route === "guard") { if (live.guard && GUARD) { setQ(localQuote(live.guard, GUARD.key.fee, side, amountIn)); setQErr(null); } return; }
    quoteOn(route, side, amountIn).then((r) => { if (alive) { setQ(r); setQErr(null); } }).catch((e) => { if (alive) { setQ(null); setQErr(shortError(e)); } });
    return () => { alive = false; };
  }, [side, amountIn, route, route === "guard" ? live.guard : live.main?.sqrtP]);

  const guardBandOk = (b: number) => route !== "guard" || !live.guard || maxBand === null || bandWithinGuard(live.guard.sqrtP, b, maxBand);
  useEffect(() => { if (!guardBandOk(bandBps)) { const ok = [50, 30].find(guardBandOk); if (ok) setBandBps(ok); } }, [route, maxBand, live.guard?.sqrtP]);

  const src = protect ? acct : eoa;
  const have = src ? (side === "buy" ? src.kusd : src.weth) : undefined;
  const insufficient = !!amountIn && have !== undefined && amountIn > have;
  const inKusd = amountIn && price ? (tin.symbol === "WETH" ? (Number(amountIn) / 1e18) * price : Number(amountIn) / 1e6) : null;
  // price impact against this pool's spot, net of the 0.3% LP fee
  const impact = amountIn && q !== null && price ? (() => {
    const fee = 1 - (route === "guard" && GUARD ? GUARD.key.fee : D.poolKey.fee) / 1e6;
    const ideal = side === "buy" ? (Number(amountIn) / 1e6 / price) * fee : (Number(amountIn) / 1e18) * price * fee;
    const got = Number(q) / 10 ** tout.decimals;
    return ideal > 0 ? Math.max(0, 1 - got / ideal) : null;
  })() : null;
  const minOut = q !== null ? (q * BigInt(10_000 - (protect ? bandBps : UNPROTECTED_SLIPPAGE_BPS))) / 10_000n : null;
  const noLiquidity = q === 0n && !!amountIn;

  const [minting, setMinting] = useState(false);
  const topUp = async () => {
    if (!w || !amountIn) return;
    setBusy(true); setMinting(true); setErr(null);
    try { await mintKusd(w, protect ? w.account! : w.funder, amountIn); onDone(); }
    catch (e) { setErr(shortError(e)); }
    finally { setBusy(false); setMinting(false); }
  };
  const swap = async () => {
    if (!w || !amountIn) return;
    setBusy(true); setLast(null); setErr(null);
    try {
      const on = (a: Attempt) => setLast(a);
      const a = protect ? await kabutoSwap(w, side, amountIn, bandBps, on, route) : await normalSwap(w, side, amountIn, UNPROTECTED_SLIPPAGE_BPS, on, route);
      setLast(a);
      onAttempt(a);
      if (!protect && route === "main" && a.phase === "included") setLoss({ kusd: lossKusd(a), side: a.side, amountIn: a.amountIn });
      onDone();
    } finally { setBusy(false); }
  };

  const guardRow = route === "guard" ? (
    !protect ? { tone: "shu", v: "Refuses plain transactions" }
    : maxBand === null ? { tone: "", v: "Reading hook…" }
    : guardBandOk(bandBps) ? { tone: "ok", v: `Pin ±${(bandBps / 100).toFixed(1)}% · within cap` }
    : { tone: "shu", v: "Pin wider than the hook allows" }
  ) : null;

  return (
    <div className="dx-col">
      <section className="dx-card" aria-label="Swap">
        <div className="dx-card-h">
          <b>Swap</b>
          {GUARD && (
            <div className="dx-seg dx-route" role="radiogroup" aria-label="Pool">
              {(["main", "guard"] as const).map((r) => (
                <button key={r} role="radio" aria-checked={route === r} onClick={() => setRoute(r)}>
                  {r === "guard" && <Icon name="shield" />}{r === "main" ? "Uniswap v4" : "KabutoGuard"}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="dx-box">
          <label htmlFor="dx-in">You pay</label>
          <div className="dx-row">
            <input id="dx-in" inputMode="decimal" autoComplete="off" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} aria-describedby="dx-in-sub" />
            <span className="dx-token" data-t={tin.symbol}>{tin.symbol}</span>
          </div>
          <div className="dx-sub" id="dx-in-sub">
            <span>{inKusd !== null && tin.symbol === "WETH" ? `≈ ${inKusd.toLocaleString("en-US", { maximumFractionDigits: 0 })} kUSD` : " "}</span>
            <span>{w ? <>Balance {have !== undefined ? fmt(have, tin.decimals, side === "buy" ? 2 : 4) : "…"}{have !== undefined && have > 0n && <button className="dx-max" onClick={() => setAmount(formatUnits(have, tin.decimals))}>Max</button>}</> : " "}</span>
          </div>
        </div>
        <button className="dx-flip" aria-label={`Switch to ${side === "buy" ? "selling WETH" : "buying WETH"}`} onClick={() => setSide(side === "buy" ? "sell" : "buy")}><Icon name="swap" /></button>
        <div className="dx-box">
          <label id="dx-out-l">You receive</label>
          <div className="dx-row"><output aria-labelledby="dx-out-l" data-empty={q === null}>{q !== null ? fmt(q, tout.decimals, side === "buy" ? 5 : 2) : amountIn && !qErr ? "…" : "0"}</output><span className="dx-token" data-t={tout.symbol}>{tout.symbol}</span></div>
          <div className="dx-sub"><span>{price ? `1 WETH = ${price.toLocaleString("en-US", { maximumFractionDigits: 2 })} kUSD` : live.error ? "Pool unreachable" : "Reading pool…"}</span><span> </span></div>
        </div>

        {(amountIn && q !== null) || qErr ? (
          <dl className="dx-meta">
            {qErr ? <div data-tone="shu"><dt>Quote</dt><dd>{qErr}</dd></div> : <>
              <div data-tone={impact !== null && impact > 0.05 ? "shu" : ""}><dt>Price impact</dt><dd>{noLiquidity ? "No liquidity" : impact !== null ? `${(impact * 100).toFixed(impact < 0.001 ? 3 : 2)}%` : "…"}</dd></div>
              <div><dt>{protect ? "Min. received (pin)" : "Min. received (2%)"}</dt><dd>{minOut !== null ? `${fmt(minOut, tout.decimals, side === "buy" ? 5 : 2)} ${tout.symbol}` : "…"}</dd></div>
              {guardRow && <div data-tone={guardRow.tone}><dt><Icon name="shield" /> Guard</dt><dd>{guardRow.v}</dd></div>}
            </>}
          </dl>
        ) : null}

        <div className={`dx-protect ${protect ? "on" : ""}`}>
          <div className="dx-protect-l"><i className="dx-shield" aria-hidden /><b aria-hidden>Sandwich protection</b></div>
          <span className="dx-protect-s" aria-hidden>{protect ? "On" : "Off"}</span>
          <button role="switch" aria-checked={protect} aria-label="Sandwich protection" className="dx-switch" onClick={() => setProtect(!protect)}><motion.i animate={{ x: protect ? 22 : 0 }} transition={spring} /></button>
        </div>
        <AnimatePresence initial={false}>
          {protect && (
            <motion.div className="dx-band" role="radiogroup" aria-label="Price pin" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.22, ease: [0.2, 0.7, 0.2, 1] }} style={{ overflow: "hidden" }}>
              <span>Price pin</span>
              {[30, 50, 100].map((b) => {
                const ok = guardBandOk(b);
                return <button key={b} role="radio" aria-checked={bandBps === b} disabled={!ok} title={ok ? undefined : "Wider than KabutoGuard's cap"} onClick={() => setBandBps(b)}>±{(b / 100).toFixed(1)}%</button>;
              })}
            </motion.div>
          )}
        </AnimatePresence>

        {err && <div className="dx-err" role="alert">{err}</div>}
        {!w ? (
          <button className="dx-cta" onClick={onConnect}>Connect wallet</button>
        ) : (
          <button className={`dx-cta ${protect ? "shu" : ""}`} disabled={busy || !amountIn || noLiquidity || (insufficient && side === "sell") || (protect && !guardBandOk(bandBps))} onClick={insufficient && side === "buy" ? topUp : swap} aria-busy={busy}>
            {busy ? (minting ? "Minting test kUSD…" : <span className="dx-busy">Swapping</span>) : !amountIn ? "Enter an amount" : insufficient ? (side === "buy" ? "Get test kUSD" : `Not enough ${tin.symbol}`) : protect ? "Swap protected" : "Swap"}
          </button>
        )}
      </section>

      <AnimatePresence mode="popLayout">{last && <SwapResult key={last.id} a={last} loss={loss} />}</AnimatePresence>
      {activity}
    </div>
  );
}

/* ------------------------------------------------------------------ intents */
function IntentsPanel({ w, acct, live, onConnect, onFilled }: { w: Saved | null; acct: Bals | null; live: Live; onConnect: () => void; onFilled: () => void }) {
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
  useEffect(() => { let alive = true; if (!amountIn) { setQ(null); return; } quoteOn("main", side, amountIn).then((r) => alive && setQ(r)).catch(() => alive && setQ(null)); return () => { alive = false; }; }, [amountIn, live.main?.sqrtP]);
  const es = useRef<EventSource | null>(null);
  useEffect(() => {
    try { es.current = relayEvents(); } catch { setRelayUp(false); return; }
    es.current.onopen = () => setRelayUp(true);
    es.current.onerror = () => setRelayUp(false);
    const on = (m: MessageEvent) => { try { setEvents((p) => [...p, JSON.parse(m.data)].slice(-300)); } catch { /* skip */ } };
    for (const t of ["intent_posted", "fill_submitted", "fill_landed", "fill_refused", "fill_replaced"]) es.current.addEventListener(t, on as EventListener);
    return () => es.current?.close();
  }, []);
  const landedCount = events.filter((e) => e.type === "fill_landed" && posted.some((p) => p.id === e.intentId)).length;
  useEffect(() => { if (landedCount) onFilled(); }, [landedCount]);
  const post = async () => {
    if (!w || !amountIn) return;
    setBusy(true); setErr(null);
    try { const { signed } = await signIntent(w, side, amountIn, { startBps: 30, endBps: 200, windowSec }); const id = await postIntent(signed); setPosted((p) => [{ id, at: Date.now(), signed, side }, ...p]); }
    catch (e: any) { setErr(shortError(e)); } finally { setBusy(false); }
  };
  const insufficient = !!amountIn && acct !== null && amountIn > acct.kusd;
  return (
    <div className="dx-col">
      <section className="dx-card" aria-label="Post an intent">
        <div className="dx-card-h"><b>Intent</b><span className={`dx-pill ${relayUp ? "live" : relayUp === false ? "down" : ""}`} role="status">{relayUp ? "Fillers online" : relayUp === false ? "Relay offline" : "Connecting…"}</span></div>
        <div className="dx-box">
          <label htmlFor="dx-int">You sell</label>
          <div className="dx-row"><input id="dx-int" inputMode="decimal" autoComplete="off" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} /><span className="dx-token" data-t={tin.symbol}>{tin.symbol}</span></div>
          <div className="dx-sub"><span> </span><span>{w ? `Balance ${acct ? fmt(acct.kusd, 6, 2) : "…"}` : " "}</span></div>
        </div>
        <div className="dx-box">
          <label id="dx-int-out">You get at least</label>
          <div className="dx-row"><output aria-labelledby="dx-int-out">{q ? fmt((q * 9970n) / 10_000n, tout.decimals, 5) : amountIn ? "…" : "0"}</output><span className="dx-token" data-t={tout.symbol}>{tout.symbol}</span></div>
          <div className="dx-sub"><span>{q ? `→ ${fmt((q * 9800n) / 10_000n, tout.decimals, 5)} by the deadline` : " "}</span><span> </span></div>
        </div>
        <div className="dx-band" role="radiogroup" aria-label="Auction window"><span>Window</span>{[60, 120, 300].map((s) => <button key={s} role="radio" aria-checked={windowSec === s} onClick={() => setWindowSec(s)}>{s < 120 ? `${s}s` : `${s / 60} min`}</button>)}</div>
        {err && <div className="dx-err" role="alert">{err}</div>}
        {!w ? <button className="dx-cta" onClick={onConnect}>Connect wallet</button> : <button className="dx-cta" disabled={busy || !amountIn} onClick={insufficient ? async () => { setBusy(true); setErr(null); try { await mintKusd(w, w.account!, amountIn!); } catch (e) { setErr(shortError(e)); } finally { setBusy(false); } } : post}>{busy ? (insufficient ? "Minting test kUSD…" : "Signing…") : !amountIn ? "Enter an amount" : insufficient ? "Get test kUSD" : "Sign intent"}</button>}
      </section>
      <AnimatePresence initial={false}>{posted.map((p) => <IntentCard key={p.id} p={p} events={events.filter((e) => e.intentId === p.id)} />)}</AnimatePresence>
      <ArkivBoard />
    </div>
  );
}

function ArkivBoard() {
  const [intents, setIntents] = useState<BoardIntent[] | null>(null);
  const [fills, setFills] = useState<BoardFill[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    if (!ARKIV_WRITER) return;
    let alive = true;
    const refresh = () => { void readArkivBoard().then(board => { if (alive) { setIntents(board.intents); setFills(board.fills); setError(null); setNow(Math.floor(Date.now() / 1000)); } }).catch(e => { if (alive) setError(shortError(e)); }); };
    refresh(); const timer = setInterval(refresh, 4000);
    return () => { alive = false; clearInterval(timer); };
  }, []);
  if (!ARKIV_WRITER) return null; // the board appears once a funded Arkiv writer is configured (see README)
  const token = (address: string) => Object.values(TOKENS).find(t => t.address.toLowerCase() === address.toLowerCase());
  return (
    <section className="dx-act" aria-label="Arkiv intent board">
      <div className="dx-act-h"><b>Open board</b><span className="dx-pill">Arkiv · Rabdi</span></div>
      {error ? <p className="dx-act-empty" role="alert">{error}</p> : intents === null ? (
        <ul className="dx-act-list" aria-busy="true">{[0, 1].map((i) => <li key={i} className="dx-skel" aria-hidden><span /><span /></li>)}</ul>
      ) : (
        <>
          {intents.length === 0 ? <p className="dx-act-empty">No open intents.</p> : (
            <ul className="dx-act-list">
              {intents.map(row => { const i = row.signed.intent; const tIn = token(i.tokenIn), tOut = token(i.tokenOut); return (
                <li className="dx-act-row" key={row.entityKey}>
                  <span className="dx-act-ic" aria-hidden><Icon name="clock" /></span>
                  <div className="dx-act-m"><b>{tIn ? fmt(i.maxIn, tIn.decimals, 2) : i.maxIn.toString()} {tIn?.symbol ?? short(i.tokenIn)} → {tOut?.symbol ?? short(i.tokenOut)}</b><span>{short(row.signed.account, 6)}</span></div>
                  <div className="dx-act-r"><span className="dx-chip-s" data-tone="gold">{Math.max(0, Number(row.deadline) - now)}s</span><a className="dx-tx" href={`https://rabdi.explorer.arkiv.network/entity/${row.entityKey}`} target="_blank" rel="noreferrer">{short(row.entityKey, 6)}<Icon name="out" /></a></div>
                </li>
              ); })}
            </ul>
          )}
          {fills.length > 0 && (
            <ul className="dx-act-list dx-act-sub" aria-label="Recent fills">
              {fills.map(fill => (
                <li className="dx-act-row" key={fill.entityKey}>
                  <span className="dx-act-ic" aria-hidden><Icon name={fill.outcome === "landed" ? "check" : "x"} /></span>
                  <div className="dx-act-m"><b>Fill {fill.outcome}</b><span>{fill.reason ?? "chain 1337"}</span></div>
                  <div className="dx-act-r"><span className="dx-chip-s" data-tone={fill.outcome === "landed" ? "ok" : "shu"}>{fill.outcome === "landed" ? "Landed" : "Refused"}</span>{fill.txHash ? <TxLink hash={fill.txHash} n={6} /> : null}</div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
