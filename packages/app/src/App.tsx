import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parseUnits, type Address, type Hex } from "viem";
import { D, BOT_URL } from "./lib/config";
import { pub } from "./lib/chain";
import { balances, bandFor, fmt, priceFromSqrt, quote, sqrtPrice, tokenIn, tokenOut, type Side } from "./lib/market";
import { forget, load, onboard, shortError, STEPS, type Saved, type Step } from "./lib/wallet";
import { kabutoSwap, normalSwap, type Attempt } from "./lib/swap";
import { registryAbi, tokenAbi } from "./lib/abi";
import { sendLegacy } from "./lib/chain";
import { encodeFunctionData } from "viem";
import { Dex } from "./Dex";
import { Landing } from "./Landing";
import { postIntent, relayEvents, signIntent, type RelayEvent, type SignedIntent } from "./lib/intent";

/** Slippage of the comparison "normal wallet" swap (a common wallet default range is 0.5%-3%). */
const NORMAL_SLIPPAGE_BPS = 200;
const short = (a?: string, n = 6) => (a ? `${a.slice(0, n)}…${a.slice(-4)}` : "");
const explorerTx = (h?: string) => (h ? `${D.explorer}tx/${h}` : D.explorer);

/* ------------------------------------------------------------------ live chain state */
function useChain() {
  const [block, setBlock] = useState<bigint | null>(null);
  const [sqrtP, setSqrtP] = useState<bigint | null>(null);
  const [online, setOnline] = useState(true);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const [b, p] = await Promise.all([pub.getBlockNumber(), sqrtPrice()]);
        if (!alive) return;
        setBlock(b); setSqrtP(p); setOnline(true);
      } catch { if (alive) setOnline(false); }
    };
    tick();
    const t = setInterval(tick, 2000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  return { block, sqrtP, online };
}

/* ------------------------------------------------------------------ bot feed (packages/bot SSE) */
type BotEvent = { id: string; at: number; kind: string; text: string; pnl?: string; hashes?: Hex[] };
function useBot() {
  const [state, setState] = useState<"connecting" | "live" | "offline">("connecting");
  const [events, setEvents] = useState<BotEvent[]>([]);
  useEffect(() => {
    let es: EventSource | null = null;
    try { es = new EventSource(`${BOT_URL}/events`); } catch { setState("offline"); return; }
    es.onopen = () => setState("live");
    es.onerror = () => setState("offline");
    es.onmessage = (m) => {
      try {
        const d = JSON.parse(m.data);
        setEvents((prev) => [toBotEvent(d), ...prev].slice(0, 30));
      } catch { /* ignore malformed */ }
    };
    return () => es?.close();
  }, []);
  return { state, events };
}
function toBotEvent(d: any): BotEvent {
  const kind = String(d.type ?? d.kind ?? d.event ?? "attempt");
  const pnl = d.botPnlKusd ?? d.pnlKusd ?? d.pnl ?? d.botPnl;
  const hashes = [d.frontRunHash ?? d.frontrun?.hash, d.backRunHash ?? d.backrun?.hash].filter(Boolean);
  const text = d.summary ?? d.message ?? (kind === "victim" ? `Saw a swap in the mempool${d.pinned ? " (price-pinned)" : ""}` : "Sandwich attempt");
  return { id: String(d.id ?? `${Date.now()}-${Math.random()}`), at: Date.now(), kind, text, pnl: pnl !== undefined ? String(pnl) : undefined, hashes };
}

/* ------------------------------------------------------------------ intent relay (packages/filler) */
export type PostedIntent = { id: string; at: number; signed: SignedIntent; quoted: bigint; side: Side; events: RelayEvent[] };
function useRelay() {
  const [state, setState] = useState<"connecting" | "live" | "offline">("connecting");
  const [events, setEvents] = useState<RelayEvent[]>([]);
  useEffect(() => {
    let es: EventSource | null = null;
    try { es = relayEvents(); } catch { setState("offline"); return; }
    es.onopen = () => setState("live");
    es.onerror = () => setState("offline");
    const on = (m: MessageEvent) => { try { setEvents((p) => [JSON.parse(m.data) as RelayEvent, ...p].slice(0, 200)); } catch { /* ignore */ } };
    for (const t of ["intent_posted", "fill_submitted", "fill_landed", "fill_refused", "fill_replaced"]) es.addEventListener(t, on as EventListener);
    return () => es?.close();
  }, []);
  return { state, events };
}

/* ------------------------------------------------------------------ app */
function useRoute() {
  const [hash, setHash] = useState(() => location.hash);
  useEffect(() => {
    const on = () => { setHash(location.hash); if (location.hash.startsWith("#/")) window.scrollTo(0, 0); };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash.startsWith("#/app") ? "app" : "home";
}

export function App() {
  const route = useRoute();
  return route === "app" ? <Dex /> : <Home />;
}

function Home() {
  const [wallet, setWallet] = useState<Saved | null>(() => load());
  const route = "home" as "home" | "app";
  const chain = useChain();
  const ready = !!wallet?.account && !!wallet.staked;
  return (
    <div className="shell">
      <Top chain={chain} route={route} />
      {route === "home" ? (
        <Landing />
      ) : ready ? (
        <Wallet w={wallet!} chain={chain} onReset={() => { forget(); setWallet(null); }} />
      ) : (
        <Onboarding onDone={setWallet} />
      )}
      <footer className="foot">
        <span>Kabuto DEX runs on the Ethereum Foundation's public EIP-8141 / ERC-8421 alt-mempool devnet (chain 1337) with Uniswap v4. Keys stay in this browser and are for the devnet only.</span>
        <span><a href="https://github.com/nickthelegend/kabuto" target="_blank" rel="noreferrer">Source (MIT)</a> · <a href={D.explorer} target="_blank" rel="noreferrer">Explorer</a></span>
      </footer>
    </div>
  );
}

function Top({ chain, route }: { chain: ReturnType<typeof useChain>; route: "app" | "home" }) {
  return (
    <header className="top">
      <a className="brand" href="#/" aria-label="Kabuto home"><b>Kabuto</b></a>
      {route === "home" && (
        <nav className="nav-links" aria-label="Sections">
          <a href="#how">How it works</a>
          <a href="#sdk">SDK</a>
          <a href="#proof">Proof</a>
        </nav>
      )}
      <div className="net" aria-live="polite">
        {route === "home" ? <a className="btn-moon sm" href="#/app">Launch app</a> : <a className="btn-line sm" href="#/">Home</a>}
      </div>
    </header>
  );
}

/* ------------------------------------------------------------------ onboarding */
function Onboarding({ onDone }: { onDone: (w: Saved) => void }) {
  const [steps, setSteps] = useState<Step[]>(STEPS.map((s) => ({ ...s })));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const start = async () => {
    setBusy(true); setErr(null);
    try {
      const w = await onboard((id, patch) => setSteps((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s))));
      onDone(w);
    } catch (e: any) { setErr(shortError(e)); }
    finally { setBusy(false); }
  };
  const resumable = !!load();
  return (
    <section className="hero">
      <div>
        <div className="kicker">Kabuto DEX · one-time setup</div>
        <h1>Set up once, then <em>swap at your price.</em></h1>
        <p className="lede">
          Every Kabuto swap carries a price check inside the transaction's own validation frame. If a bot moves the pool before your swap lands,
          the swap stops being a valid transaction: it is never included, the bot is left holding its trade, and you pay nothing.
        </p>
        <div className="facts">
          <div><b>0 gas</b><span>when the price moves: an invalid tx can't be charged</span></div>
          <div><b>1 tx</b><span>price pin, approve and swap ride together, all or nothing</span></div>
          <div><b>P256</b><span>signed with the native passkey curve, no seed phrase</span></div>
        </div>
      </div>
      <div className="card onb">
        <div className="card-h"><h2>Create your Kabuto account</h2><span className="chip">devnet</span></div>
        <div className="card-b">
          <ol>
            {steps.map((s, i) => (
              <li key={s.id} data-state={s.state}>
                <span className="n">{s.state === "done" ? "✓" : s.state === "error" ? "!" : i + 1}</span>
                <div>
                  <div>{s.label}</div>
                  {s.hash && <p><a className="hashlink" href={explorerTx(s.hash)} target="_blank" rel="noreferrer">{short(s.hash, 10)}</a></p>}
                  {s.detail && s.state === "error" && <p>{s.detail}</p>}
                </div>
              </li>
            ))}
          </ol>
          {err && <div className="err" role="alert">{err} <br />The faucet allows one drip per address per hour; if it refused, try again later.</div>}
          <button className="btn" onClick={start} disabled={busy}>{busy ? "Setting up on the devnet…" : resumable ? "Resume setup" : "Create my Kabuto account"}</button>
          <p className="hint">Takes about a minute. Every step is a real transaction on the public devnet; nothing is simulated.</p>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ wallet */
function Wallet({ w, chain, onReset }: { w: Saved; chain: ReturnType<typeof useChain>; onReset: () => void }) {
  const [bals, setBals] = useState<{ eth: bigint; kusd: bigint; weth: bigint } | null>(null);
  const [nbals, setNbals] = useState<{ eth: bigint; kusd: bigint; weth: bigint } | null>(null);
  const [stake, setStake] = useState<bigint | null>(null);
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [intents, setIntents] = useState<PostedIntent[]>([]);
  const bot = useBot();
  const relay = useRelay();

  const refresh = useCallback(async () => {
    try {
      const [a, n, st] = await Promise.all([
        balances(w.account!), balances(w.funder),
        pub.readContract({ address: D.predeploys.stakingRegistry, abi: registryAbi, functionName: "getDepositInfo", args: [w.account!] }),
      ]);
      setBals(a); setNbals(n); setStake(st[0]);
    } catch { /* network blip; chain hook shows offline */ }
  }, [w]);
  useEffect(() => { refresh(); }, [refresh, chain.block]);

  const upsert = useCallback((a: Attempt) => setAttempts((prev) => {
    const i = prev.findIndex((x) => x.id === a.id);
    if (i < 0) return [a, ...prev];
    const next = prev.slice(); next[i] = a; return next;
  }), []);

  return (
    <div className="grid">
      <div>
        <Account w={w} bals={bals} stake={stake} onReset={onReset} />
        <SwapCard w={w} sqrtP={chain.sqrtP} bals={bals} nbals={nbals} onAttempt={upsert} onIntent={(p) => setIntents((x) => [p, ...x])} relayLive={relay.state === "live"} />
      </div>
      <Lane chain={chain} attempts={attempts} bot={bot} intents={intents} relay={relay} />
    </div>
  );
}

function Account({ w, bals, stake, onReset }: { w: Saved; bals: any; stake: bigint | null; onReset: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <section className="card">
      <div className="card-h"><h2>Your account</h2>{stake !== null && (stake > 0n ? <span className="chip ok">staked {fmt(stake, 18, 3)} ETH</span> : <span className="chip shu">not staked</span>)}</div>
      <div className="card-b">
        <div className="addr">
          <a className="hashlink" href={`${D.explorer}address/${w.account}`} target="_blank" rel="noreferrer">{short(w.account, 10)}</a>
          <button onClick={() => { navigator.clipboard?.writeText(w.account!); setCopied(true); setTimeout(() => setCopied(false), 1200); }}>{copied ? "Copied" : "Copy"}</button>
        </div>
        <div className="bals">
          <div className="bal"><small>kUSD</small><b>{bals ? fmt(bals.kusd, 6, 2) : "…"}</b></div>
          <div className="bal"><small>WETH</small><b>{bals ? fmt(bals.weth, 18, 5) : "…"}</b></div>
          <div className="bal"><small>ETH · gas</small><b>{bals ? fmt(bals.eth, 18, 4) : "…"}</b></div>
        </div>
        <div className="meta">
          <span className="chip gold">P256 signer {short(w.owner, 6)}</span>
          <span className="chip">alt-mempool</span>
          <TopUp w={w} />
          <button className="chip" style={{ cursor: "pointer", background: "none" }} onClick={() => { if (confirm("Forget this devnet account in this browser?")) onReset(); }}>reset</button>
        </div>
      </div>
    </section>
  );
}

function TopUp({ w }: { w: Saved }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    setBusy(true); setErr(null);
    try {
      for (const to of [w.account!, w.funder]) await sendLegacy(w.funderKey, { to: D.kusd, data: encodeFunctionData({ abi: tokenAbi, functionName: "faucet", args: [to] }) });
    } catch (e: any) { setErr(e?.shortMessage ?? e?.message ?? String(e)); }
    finally { setBusy(false); }
  };
  return (
    <button className="chip gold" style={{ cursor: "pointer" }} disabled={busy} onClick={go} title={err ?? "Mint 1,000 devnet kUSD to your Kabuto account and to the comparison wallet"}>
      {busy ? "minting…" : err ? "top-up failed" : "+1,000 test kUSD"}
    </button>
  );
}

function SwapCard({ w, sqrtP, bals, nbals, onAttempt, onIntent, relayLive }: { w: Saved; sqrtP: bigint | null; bals: any; nbals: any; onAttempt: (a: Attempt) => void; onIntent: (p: PostedIntent) => void; relayLive: boolean }) {
  const [mode, setMode] = useState<"protected" | "intent">("protected");
  const [windowSec, setWindowSec] = useState(120);
  const [intentErr, setIntentErr] = useState<string | null>(null);
  const [side, setSide] = useState<Side>("buy");
  const [amount, setAmount] = useState("300");
  const [bandBps, setBandBps] = useState(50);
  const [q, setQ] = useState<bigint | null>(null);
  const [qErr, setQErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<"kabuto" | "normal" | "intent" | null>(null);
  const signedCenter = useRef<bigint | null>(null);
  const tin = tokenIn(side), tout = tokenOut(side);

  const amountIn = useMemo(() => { try { const v = parseUnits(amount || "0", tin.decimals); return v > 0n ? v : null; } catch { return null; } }, [amount, tin.decimals]);
  useEffect(() => {
    let alive = true;
    if (!amountIn) { setQ(null); return; }
    quote(side, amountIn).then((r) => { if (alive) { setQ(r); setQErr(null); } }).catch((e) => { if (alive) { setQ(null); setQErr(e?.shortMessage ?? "Quote failed"); } });
    return () => { alive = false; };
  }, [side, amountIn, sqrtP]);

  const have = side === "buy" ? bals?.kusd : bals?.weth;
  const short_ = !!amountIn && have !== undefined && amountIn > have;

  const go = async (which: "kabuto" | "normal") => {
    if (!amountIn) return;
    setBusy(which);
    try {
      if (which === "kabuto") { signedCenter.current = sqrtP; await kabutoSwap(w, side, amountIn, bandBps, onAttempt); }
      else await normalSwap(w, side, amountIn, NORMAL_SLIPPAGE_BPS, onAttempt);
    } finally { setBusy(null); signedCenter.current = null; }
  };

  const post = async () => {
    if (!amountIn) return;
    setBusy("intent"); setIntentErr(null);
    try {
      const { signed, quoted } = await signIntent(w, side, amountIn, { startBps: 30, endBps: 200, windowSec });
      const id = await postIntent(signed);
      onIntent({ id, at: Date.now(), signed, quoted, side, events: [] });
    } catch (e: any) { setIntentErr(e?.message ?? String(e)); }
    finally { setBusy(null); }
  };

  return (
    <section className="card">
      <div className="card-h"><h2>Swap · Uniswap v4</h2><span className="chip">WETH / kUSD · 0.30%</span></div>
      <div className="card-b">
        <div className="modes" role="tablist" aria-label="How to swap">
          <button role="tab" aria-selected={mode === "protected"} onClick={() => setMode("protected")}><b>Protected swap</b><span>You route it. Sandwich = invalid, 0 gas.</span></button>
          <button role="tab" aria-selected={mode === "intent"} onClick={() => setMode("intent")}><b>Post an intent</b><span>Anyone routes it. Fillers pay the gas.</span></button>
        </div>
        <div className="seg" role="group" aria-label="Direction">
          <button aria-pressed={side === "buy"} onClick={() => setSide("buy")}>Buy WETH</button>
          <button aria-pressed={side === "sell"} onClick={() => setSide("sell")}>Sell WETH</button>
        </div>
        <div className="field">
          <label htmlFor="amt"><span>You pay</span><span>balance {have !== undefined ? fmt(have, tin.decimals, side === "buy" ? 2 : 5) : "…"}</span></label>
          <div className="row">
            <input id="amt" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} aria-label={`Amount of ${tin.symbol}`} />
            <span className="tok">{tin.symbol}</span>
          </div>
          <div className="out"><span>You get (Uniswap v4 Quoter)</span><b>{q !== null ? `${fmt(q, tout.decimals, side === "buy" ? 5 : 2)} ${tout.symbol}` : qErr ?? "…"}</b></div>
        </div>
        {mode === "protected" ? (
          <>
            <Band sqrtP={sqrtP} bandBps={bandBps} setBandBps={setBandBps} signed={signedCenter.current} />
            {short_ && <div className="err">Not enough {tin.symbol} in the Kabuto account.</div>}
            <button className="btn shu" disabled={!amountIn || !!busy || !!short_} onClick={() => go("kabuto")}>{busy === "kabuto" ? "Pinned swap in flight…" : "Swap with Kabuto"}</button>
            <button className="btn ghost" disabled={!amountIn || !!busy || (nbals && (side === "buy" ? nbals.kusd : nbals.weth) < (amountIn ?? 0n))} onClick={() => go("normal")}>
              {busy === "normal" ? "Normal swap in flight…" : `Same swap from a normal wallet (${(NORMAL_SLIPPAGE_BPS / 100).toFixed(1)}% slippage)`}
            </button>
            <p className="hint">The normal wallet is an ordinary EOA ({short(w.funder, 6)}) sending the same router call to the public mempool with a slippage floor.</p>
          </>
        ) : (
          <>
            <div className="intent-box">
              <div className="row2"><span>Minimum you accept</span><b className="mono">{q ? `${fmt((q * 9970n) / 10_000n, tout.decimals, 5)} → ${fmt((q * 9800n) / 10_000n, tout.decimals, 5)} ${tout.symbol}` : "…"}</b></div>
              <div className="row2"><span>Decays over</span>
                <span className="seg mini" role="group" aria-label="Auction window">
                  {[60, 120, 300].map((s) => <button key={s} aria-pressed={windowSec === s} onClick={() => setWindowSec(s)}>{s < 120 ? `${s}s` : `${s / 60} min`}</button>)}
                </span>
              </div>
              <p className="hint">You sign one digest: up to {amount || "0"} {tin.symbol} out, at least the decaying minimum back. No transaction, no gas. Fillers race to complete it through Uniswap v4; your account rejects any fill that breaks the shape.</p>
            </div>
            {short_ && <div className="err">Not enough {tin.symbol} in the Kabuto account.</div>}
            {intentErr && <div className="err" role="alert">{intentErr}</div>}
            <button className="btn moon-btn" disabled={!amountIn || !!busy || !!short_} onClick={post}>{busy === "intent" ? "Signing…" : "Sign intent · no gas"}</button>
            {!relayLive && <p className="hint">Intent relay offline. Start it with <code>pnpm --dir packages/filler relay</code> and a filler with <code>pnpm --dir packages/filler filler</code>.</p>}
          </>
        )}
      </div>
    </section>
  );
}

function Band({ sqrtP, bandBps, setBandBps, signed }: { sqrtP: bigint | null; bandBps: number; setBandBps: (n: number) => void; signed: bigint | null }) {
  const center = signed ?? sqrtP;
  const price = sqrtP ? priceFromSqrt(sqrtP) : null;
  // meter spans +-3% of price around the center
  const SPAN = 300;
  const pos = (() => {
    if (!center || !sqrtP) return 50;
    const pc = priceFromSqrt(center), pn = priceFromSqrt(sqrtP);
    const bps = ((pn - pc) / pc) * 10_000;
    return Math.min(98, Math.max(2, 50 + (bps / SPAN) * 50));
  })();
  const zoneW = (bandBps / SPAN) * 100;
  const out = center && sqrtP ? (() => { const b = bandFor(center, bandBps); return sqrtP < b.min || sqrtP > b.max; })() : false;
  return (
    <div className="band">
      <div className="band-top"><span>Price pin (checked in the VERIFY frame)</span><b>±{(bandBps / 100).toFixed(2)}%</b></div>
      <input type="range" min={10} max={200} step={10} value={bandBps} onChange={(e) => setBandBps(Number(e.target.value))} aria-label="Price band width" />
      <div className="meter" aria-hidden>
        <div className="zone" style={{ left: `${50 - zoneW}%`, width: `${zoneW * 2}%` }} />
        <div className={`mark ${out ? "out" : ""}`} style={{ left: `${pos}%` }} />
        <span className="lbl" style={{ left: 8 }}>−3%</span>
        <span className="lbl" style={{ right: 8 }}>+3%</span>
      </div>
      <p className="hint">Pool price now <span className="mono">{price ? price.toLocaleString("en-US", { maximumFractionDigits: 2 }) : "…"} kUSD</span> per WETH. If it leaves the shaded band before your swap is included, the swap is invalid and costs nothing.</p>
    </div>
  );
}

/* ------------------------------------------------------------------ lane */
function Lane({ chain, attempts, bot, intents, relay }: { chain: ReturnType<typeof useChain>; attempts: Attempt[]; bot: ReturnType<typeof useBot>; intents: PostedIntent[]; relay: ReturnType<typeof useRelay> }) {
  const saved = attempts.filter((a) => a.wallet === "kabuto" && (a.phase === "cancelled" || a.phase === "rejected")).length;
  const price = chain.sqrtP ? priceFromSqrt(chain.sqrtP) : null;
  type Row = { at: number; el: JSX.Element };
  const rows: Row[] = [
    ...attempts.map((a) => ({ at: a.startedAt, el: <AttemptRow key={a.id} a={a} /> })),
    ...bot.events.map((e) => ({ at: e.at, el: <BotRow key={e.id} e={e} /> })),
    ...intents.map((p) => ({ at: p.at, el: <IntentRow key={p.id} p={p} events={relay.events.filter((e) => e.intentId === p.id)} /> })),
  ].sort((x, y) => y.at - x.at);
  return (
    <section className="card" aria-label="Mempool lane">
      <div className="lane-head">
        <div className="stat"><small>Pool price</small><b>{price ? price.toLocaleString("en-US", { maximumFractionDigits: 2 }) : "…"}<em>kUSD/WETH</em></b></div>
        <div className="stat"><small>Block</small><b>{chain.block?.toString() ?? "…"}</b></div>
        <div className="stat"><small>Sandwich bot</small><b style={{ fontSize: 16, marginTop: 14 }}>{bot.state === "live" ? <span className="chip shu">watching mempool</span> : bot.state === "offline" ? <span className="chip">offline</span> : <span className="chip">connecting…</span>}</b></div>
      </div>
      <div className="hatch" aria-hidden />
      {rows.length === 0 ? (
        <div className="empty">
          <h3>No swaps yet</h3>
          <p>Send a swap from Kabuto and from the normal wallet. Each one shows up here with its block, position in the block, output and the gas it cost.{bot.state !== "live" && " The sandwich bot is offline: start it with `pnpm --filter @kabuto/bot start` to see attacks."}</p>
        </div>
      ) : (
        <ul className="feed">{rows.map((r) => r.el)}</ul>
      )}
      {saved > 0 && <div className="card-b" style={{ borderTop: "1px solid var(--hair)" }}><span className="chip shu">{saved} swap{saved > 1 ? "s" : ""} refused at 0 gas after the price moved</span></div>}
    </section>
  );
}

const PHASES: Record<Attempt["phase"], string> = {
  signing: "Signing", admitted: "In alt-mempool", pending: "Waiting for a block", included: "Included",
  cancelled: "Never included", rejected: "Refused at the door", reverted: "Reverted on chain", failed: "Failed",
};

function AttemptRow({ a }: { a: Attempt }) {
  const tin = tokenIn(a.side), tout = tokenOut(a.side);
  const k = a.wallet === "kabuto";
  const loss = a.out !== undefined && a.quoted > 0n ? Number(a.quoted - a.out) / Number(a.quoted) : null;
  const title = (() => {
    if (a.phase === "cancelled") return "The price moved, so this swap stopped existing. Nobody could fill it, and it cost 0 gas.";
    if (a.phase === "rejected") return a.error ?? "Refused before entering the mempool.";
    if (a.phase === "included" && loss !== null) return loss > 0.0015 ? `Filled ${(loss * 100).toFixed(2)}% worse than the quote.` : "Filled at the quoted price.";
    if (a.phase === "reverted" || a.phase === "failed") return a.error ?? "Did not complete.";
    return `${fmt(a.amountIn, tin.decimals, 4)} ${tin.symbol} → ${tout.symbol}`;
  })();
  const tone = a.phase === "included" ? (loss !== null && loss > 0.0015 ? "shu" : "ok") : a.phase === "cancelled" || a.phase === "rejected" ? "gold" : a.phase === "reverted" || a.phase === "failed" ? "shu" : "";
  return (
    <li>
      <div className="ev-top">
        <span className="ev-who">{k ? <img className="av" src="/logo-128.png" alt="" /> : <i style={{ background: "var(--dim)" }} />}{k ? "Kabuto" : "Normal wallet"}<span className="faint mono" style={{ fontWeight: 400, fontSize: 12 }}>{k ? `pin ±${((a.bandBps ?? 0) / 100).toFixed(2)}%` : `slippage ${((a.slippageBps ?? 0) / 100).toFixed(1)}%`}</span></span>
        <span className={`chip ${tone}`}>{PHASES[a.phase]}</span>
      </div>
      <div className="ev-title">{title}</div>
      <div className="ev-grid">
        <div><small>Paid</small><b>{fmt(a.amountIn, tin.decimals, 4)} {tin.symbol}</b></div>
        <div><small>Quoted · got</small><b>{a.quoted ? fmt(a.quoted, tout.decimals, 5) : "…"} · {a.out !== undefined ? fmt(a.out, tout.decimals, 5) : a.phase === "cancelled" || a.phase === "rejected" ? "none" : "…"}</b></div>
        <div><small>Block · index</small><b>{a.block !== undefined ? `${a.block} · ${a.index}` : a.phase === "cancelled" || a.phase === "rejected" ? "never" : "…"}</b></div>
        <div><small>Gas paid</small><b>{a.gasWei !== undefined ? `${fmt(a.gasWei, 18, 7)} ETH` : "…"}</b></div>
      </div>
      <div className="steps">
        {a.phaseLog.map((p, i) => <span key={i} className={i === a.phaseLog.length - 1 ? "on" : ""}>{PHASES[p.phase as Attempt["phase"]] ?? p.phase}</span>)}
        {a.hash && <a className="hashlink" style={{ marginLeft: "auto" }} href={explorerTx(a.hash)} target="_blank" rel="noreferrer">{short(a.hash, 10)}</a>}
      </div>
    </li>
  );
}

function IntentRow({ p, events }: { p: PostedIntent; events: RelayEvent[] }) {
  const tin = tokenIn(p.side), tout = tokenOut(p.side);
  const ev = [...events].sort((a, b) => a.time - b.time);
  const landed = ev.find((e) => e.type === "fill_landed");
  const refused = ev.filter((e) => e.type === "fill_refused");
  const submitted = ev.filter((e) => e.type === "fill_submitted");
  const status = landed ? "Filled" : submitted.length ? `${submitted.length} filler${submitted.length > 1 ? "s" : ""} racing` : "Waiting for fillers";
  const got = landed && (landed as any).amountOut !== undefined ? BigInt(String((landed as any).amountOut)) : null;
  return (
    <li>
      <div className="ev-top">
        <span className="ev-who"><img className="av" src="/filler-a.jpg" alt="" />Open intent<span className="faint mono" style={{ fontWeight: 400, fontSize: 12 }}>nonce {String(p.signed.intent.nonce)}</span></span>
        <span className={`chip ${landed ? "ok" : "gold"}`}>{status}</span>
      </div>
      <div className="ev-title">{landed ? "A filler completed your intent and paid the gas." : "Signed, posted, no gas spent. Fillers are quoting it now."}</div>
      <div className="ev-grid">
        <div><small>Up to</small><b>{fmt(p.signed.intent.maxIn, tin.decimals, 4)} {tin.symbol}</b></div>
        <div><small>Min (decaying)</small><b>{fmt(p.signed.intent.startOut, tout.decimals, 5)} → {fmt(p.signed.intent.endOut, tout.decimals, 5)}</b></div>
        <div><small>Got</small><b>{got !== null ? `${fmt(got, tout.decimals, 5)} ${tout.symbol}` : landed ? "landed" : "…"}</b></div>
        <div><small>Refused fills</small><b>{refused.length}</b></div>
      </div>
      <div className="steps">
        {ev.map((e, i) => (
          <span key={i} className={i === ev.length - 1 ? "on" : ""} title={e.reason ?? ""}>
            {e.type.replace("_", " ")}{(e as any).filler ? ` · ${String((e as any).filler)}` : ""}{e.type === "fill_refused" && e.reason ? ` · ${String(e.reason).slice(0, 40)}` : ""}
          </span>
        ))}
        {landed?.hash && <a className="hashlink" style={{ marginLeft: "auto" }} href={explorerTx(landed.hash)} target="_blank" rel="noreferrer">{short(landed.hash, 10)}</a>}
      </div>
    </li>
  );
}

function BotRow({ e }: { e: BotEvent }) {
  const pnl = e.pnl !== undefined ? Number(e.pnl) : null;
  return (
    <li>
      <div className="ev-top">
        <span className="ev-who"><img className="av" src="/attacker.jpg" alt="" />Sandwich bot</span>
        {pnl !== null && !Number.isNaN(pnl) && <span className={`chip ${pnl < 0 ? "ok" : "shu"}`}>bot P&amp;L {pnl >= 0 ? "+" : ""}{pnl.toFixed(2)} kUSD</span>}
      </div>
      <div className="ev-title">{e.text}</div>
      {e.hashes && e.hashes.length > 0 && <div className="steps">{e.hashes.map((h) => <a key={h} className="hashlink" href={explorerTx(h)} target="_blank" rel="noreferrer">{short(h, 10)}</a>)}</div>}
    </li>
  );
}

export type { Address };
