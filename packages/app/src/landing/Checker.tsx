import { useCallback, useEffect, useRef, useState } from "react";
import { checkMainnetTx, EXAMPLES, scanAddress, SCAN_BLOCKS, SCAN_MAX_TXS, type AddressScan, type Verdict } from "../lib/mainnet";
import { classify, parseShareHash } from "./detect";
import { ENDPOINTS, isAbort, RpcError } from "./rpc";
import { GH } from "./evidence";

type Mode = "tx" | "address";
type State =
  | { s: "idle" }
  | { s: "busy"; q: string; mode: Mode; steps: string[] }
  | { s: "error"; q: string; mode: Mode; title: string; lines: string[] }
  | { s: "tx"; q: string; v: Verdict }
  | { s: "address"; q: string; r: AddressScan };

const es = (kind: "tx" | "address", h: string) => `https://etherscan.io/${kind}/${h}`;
const short = (h: string, a = 8, b = 4) => `${h.slice(0, a)}…${h.slice(-b)}`;
const pct = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(2)}%`;
const n = (x: number) => x.toLocaleString("en-US");

function errorOf(e: unknown): { title: string; lines: string[] } {
  if (e instanceof RpcError) return { title: "Couldn't reach Ethereum mainnet", lines: [`Every public RPC failed for ${e.method}:`, ...e.failures.map((f) => `${f.name}: ${f.reason}`), "Nothing was judged. Try again in a minute."] };
  return { title: "Couldn't check", lines: [e instanceof Error ? e.message : String(e)] };
}

/** "Were you sandwiched?" against real Ethereum mainnet Uniswap v4 data, in the browser. */
export function Checker() {
  const [mode, setMode] = useState<Mode>("tx");
  const [q, setQ] = useState("");
  const [hint, setHint] = useState<string | null>(null);
  const [st, setSt] = useState<State>({ s: "idle" });
  const [copied, setCopied] = useState<"ok" | "fail" | null>(null);
  const ctl = useRef<AbortController | null>(null);
  const card = useRef<HTMLDivElement>(null);

  const run = useCallback(async (raw: string, scroll = false) => {
    const value = raw.trim().toLowerCase();
    const kind = classify(value);
    setQ(value);
    if (!kind) { setHint(mode === "tx" ? "Paste a 66-character transaction hash (0x + 64 hex characters)." : "Paste a 42-character Ethereum address (0x + 40 hex characters). ENS names aren't resolved."); return; }
    setHint(null); setMode(kind); setCopied(null);
    ctl.current?.abort();
    const c = new AbortController(); ctl.current = c;
    setSt({ s: "busy", q: value, mode: kind, steps: [] });
    if (scroll) card.current?.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    const progress = (step: string) => { if (!c.signal.aborted) setSt((p) => (p.s === "busy" ? { ...p, steps: [...p.steps, step] } : p)); };
    try {
      if (kind === "tx") { const v = await checkMainnetTx(value, { signal: c.signal, progress }); if (!c.signal.aborted) setSt({ s: "tx", q: value, v }); }
      else { const r = await scanAddress(value, { signal: c.signal, progress }); if (!c.signal.aborted) setSt({ s: "address", q: value, r }); }
      if (!c.signal.aborted) history.replaceState(null, "", `#check=${value}`);
    } catch (e) {
      if (isAbort(e) || c.signal.aborted) return;
      setSt({ s: "error", q: value, mode: kind, ...errorOf(e) });
    }
  }, [mode]);

  const cancel = () => { ctl.current?.abort(); setSt({ s: "idle" }); };

  // Shareable result URL: #check=<tx hash | address> runs on load and on hash changes.
  useEffect(() => {
    const go = () => { const v = parseShareHash(location.hash); if (v) void run(v, true); };
    go();
    window.addEventListener("hashchange", go);
    return () => { window.removeEventListener("hashchange", go); ctl.current?.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const copy = async () => {
    try { await navigator.clipboard.writeText(location.href); setCopied("ok"); } catch { setCopied("fail"); }
  };
  const busy = st.s === "busy";
  const pick = (m: Mode) => { setMode(m); setHint(null); };

  return (
    <section className="ln-chk ln-wrap" id="check" aria-labelledby="ln-chk-h">
      <div className="ln-chk-l">
        <span className="ln-tag">Ethereum mainnet · live</span>
        <h2 className="ln-h2" id="ln-chk-h">Were you<br />sandwiched?</h2>
        <p className="ln-chk-p">Paste a Uniswap v4 swap, or your address. Kabuto reads the real blocks and tells you who traded around you.</p>
        <ul className="ln-chk-how">
          <li><b>In your browser.</b> Read-only calls to public RPCs ({ENDPOINTS.map((e) => e.name).join(", ")}), with fallbacks. No wallet, no server of ours.</li>
          <li><b>Same rules as the replay.</b> Front and back by one sender or contract, around you, in one block and pool. <a href={`${GH}/blob/main/packages/replay/METHOD.md`} target="_blank" rel="noreferrer">METHOD.md ↗</a></li>
          <li><b>Honest limits.</b> Multi-block and cross-pool attacks are missed; a match is a sandwich-shaped sequence, not proof of intent.</li>
        </ul>
      </div>

      <div className="ln-chk-card" ref={card}>
        <div className="ln-seg" role="tablist" aria-label="What to check">
          <button role="tab" aria-selected={mode === "tx"} className={mode === "tx" ? "on" : ""} onClick={() => pick("tx")} disabled={busy}><b>One swap</b><small>transaction hash</small></button>
          <button role="tab" aria-selected={mode === "address"} className={mode === "address" ? "on" : ""} onClick={() => pick("address")} disabled={busy}><b>My address</b><small>last ~24 h</small></button>
        </div>
        <form onSubmit={(e) => { e.preventDefault(); if (q.trim()) void run(q); }}>
          <label htmlFor="ln-chk-in" className="sr">{mode === "tx" ? "Mainnet transaction hash" : "Mainnet address"}</label>
          <input id="ln-chk-in" value={q} onChange={(e) => { setQ(e.target.value); const k = classify(e.target.value); if (k) { setMode(k); setHint(null); } }} placeholder={mode === "tx" ? "0x… transaction hash" : "0x… your address"} spellCheck={false} autoComplete="off" autoCapitalize="off" inputMode="text" aria-invalid={!!hint} aria-describedby="ln-chk-hint" />
          <button type="submit" disabled={busy || !q.trim()}>{busy ? "Reading…" : mode === "tx" ? "Check swap" : "Scan address"}</button>
        </form>
        <div id="ln-chk-hint" className={`ln-chk-hint${hint ? " bad" : ""}`} aria-live="polite">
          {hint ?? (mode === "tx"
            ? <span className="ln-chk-ex"><span>Real victims from the replay:</span>{EXAMPLES.map((e) => <button key={e.hash} type="button" onClick={() => void run(e.hash)} disabled={busy}>{e.label}</button>)}</span>
            : <span>Scans the last {n(SCAN_BLOCKS)} blocks (~24 h) for this address's token transfers, then judges the newest {SCAN_MAX_TXS} of those transactions that swapped on Uniswap v4.</span>)}
        </div>

        <div className="ln-chk-out" aria-live="polite" aria-busy={busy}>
          {st.s === "idle" && <Idle />}
          {st.s === "busy" && <Busy steps={st.steps} mode={st.mode} onCancel={cancel} />}
          {st.s === "error" && <div className="ln-chk-r err" role="alert">
            <b>{st.title}</b>
            {st.lines.map((l, i) => <p key={i} className={i > 0 && i < st.lines.length - 1 && st.lines.length > 2 ? "mono" : ""}>{l}</p>)}
            <button className="ln-chk-btn" onClick={() => void run(st.q)}>Try again</button>
          </div>}
          {st.s === "tx" && <TxResult v={st.v} onScan={(a) => void run(a)} />}
          {st.s === "address" && <AddressResult r={st.r} onOpen={(h) => void run(h)} />}
          {(st.s === "tx" || st.s === "address") && <div className="ln-share">
            <button className="ln-chk-btn" onClick={() => void copy()}>{copied === "ok" ? "Link copied" : "Copy link to this result"}</button>
            {copied === "fail" && <span>Clipboard blocked: copy the address bar.</span>}
            <a href={es(st.s === "tx" ? "tx" : "address", st.q)} target="_blank" rel="noreferrer">Etherscan ↗</a>
          </div>}
        </div>
      </div>
    </section>
  );
}

function Idle() {
  return (
    <div className="ln-chk-idle">
      <div className="ln-lane" aria-hidden>
        <span className="b">front-run</span><span className="y">your swap</span><span className="b">back-run</span>
      </div>
      <p>Same block, same pool: a bot buys just before you and sells just after. Paste a swap and Kabuto looks for exactly that pattern.</p>
    </div>
  );
}

function Busy({ steps, mode, onCancel }: { steps: string[]; mode: Mode; onCancel: () => void }) {
  const list = steps.length ? steps : [mode === "tx" ? "Contacting mainnet" : "Contacting mainnet for your address"];
  return (
    <div className="ln-chk-busy">
      <ol>{list.map((s, i) => <li key={i} className={i === list.length - 1 ? "on" : "done"}><i aria-hidden />{s}</li>)}</ol>
      <button className="ln-chk-btn ghost" onClick={onCancel}>Cancel</button>
    </div>
  );
}

function TxResult({ v, onScan }: { v: Verdict; onScan: (a: string) => void }) {
  if (v.kind === "not-found") return <div className="ln-chk-r"><b>Not found on mainnet</b><p>Every RPC ({ENDPOINTS.map((e) => e.name).join(", ")}) answered that no mined transaction has this hash. Pending, dropped, or from another chain?</p></div>;
  if (v.kind === "failed-tx") return <div className="ln-chk-r"><b>This transaction reverted</b><p>Block {n(v.block)}. A failed swap trades nothing, so there is nothing to sandwich (you still paid its gas).</p></div>;
  if (v.kind === "no-v4-swap") return <div className="ln-chk-r"><b>No Uniswap v4 swap here</b><p>Block {n(v.block)}: this transaction didn't swap through the v4 PoolManager. v2/v3 swaps aren't checked.</p></div>;
  if (v.kind === "clean") return <div className="ln-chk-r ok"><b>Not sandwiched</b><p>Block {n(v.block)}: no front-run and back-run around this swap in its {v.pools === 1 ? "pool" : `${v.pools} pools`} ({n(v.swapsInBlock)} v4 swaps in the block checked).</p></div>;
  return (
    <div className="ln-chk-r bad">
      <b>Sandwiched in block {n(v.block)}</b>
      <dl className="ln-chk-kv">
        <div><dt>Bot moved the price first</dt><dd>{v.priceMovePct === null ? "unknown (no earlier price found)" : pct(v.priceMovePct)}</dd></div>
        <div><dt>You filled worse than the pre-attack price</dt><dd>{v.filledWorsePct === null ? "unknown" : `${Math.abs(v.filledWorsePct).toFixed(2)}%`}</dd></div>
        <div><dt>Attacker ({v.match})</dt><dd><a href={es("address", v.attacker)} target="_blank" rel="noreferrer">{short(v.attacker)} ↗</a></dd></div>
        <div><dt>Front-run · back-run</dt><dd><a href={es("tx", v.front)} target="_blank" rel="noreferrer">front ↗</a> · <a href={es("tx", v.back)} target="_blank" rel="noreferrer">back ↗</a></dd></div>
      </dl>
      {v.stoppedByPin !== null && <div className={`ln-chk-k ${v.stoppedByPin ? "yes" : "no"}`}>{v.stoppedByPin ? "With Kabuto (±0.5% pin) this swap would have been invalid: never included, 0 gas." : "This front-run stayed inside ±0.5%: a ±0.5% pin would not have stopped it (a tighter pin would)."}</div>}
      <p className="ln-chk-fine">"Filled worse" includes the pool fee and your own price impact. <button className="ln-link" onClick={() => onScan(v.victimFrom)}>Scan this sender's last ~24 h →</button></p>
    </div>
  );
}

function AddressResult({ r, onOpen }: { r: AddressScan; onOpen: (h: string) => void }) {
  const [all, setAll] = useState(false);
  const hits = r.results.filter((x) => x.kind === "sandwiched");
  const clean = r.results.filter((x) => x.kind === "clean");
  const shownClean = all ? clean : clean.slice(0, Math.max(0, 5 - hits.length));
  const window = `blocks ${n(r.fromBlock)}–${n(r.head)} (~24 h)`;
  if (!r.tokenTxs) return <div className="ln-chk-r"><b>No token activity</b><p>{short(r.address, 10, 6)} sent or received no ERC-20 in {window}, so it made no Uniswap v4 swaps there.</p></div>;
  return (
    <div className={`ln-chk-r ${hits.length ? "bad" : r.results.length ? "ok" : ""}`}>
      <b>{!r.results.length ? "No Uniswap v4 swaps" : hits.length ? `${hits.length} of ${r.results.length} v4 swaps sandwiched` : `${r.results.length} v4 swap${r.results.length === 1 ? "" : "s"}, none sandwiched`}</b>
      <p>{window}: {n(r.tokenTxs)} transaction{r.tokenTxs === 1 ? "" : "s"} moved this address's tokens; checked the newest {n(r.checked)}{r.checked < r.tokenTxs ? ` (${n(r.tokenTxs - r.checked)} older not checked)` : ""}.</p>
      {r.results.length > 0 && <ul className="ln-rows">
        {[...hits, ...shownClean].map((x) => x.kind === "sandwiched" || x.kind === "clean" ? (
          <li key={x.hash} className={x.kind}>
            <div className="t"><a href={es("tx", x.hash)} target="_blank" rel="noreferrer" className="mono">{short(x.hash, 10, 6)} ↗</a><span className={`pill ${x.kind}`}>{x.kind === "sandwiched" ? "Sandwiched" : "Clean"}</span></div>
            <div className="m"><span><small>BLOCK</small>{n(x.block)}</span>{x.kind === "sandwiched" && <span><small>BOT MOVE</small>{x.priceMovePct === null ? "?" : pct(x.priceMovePct)}</span>}{x.kind === "sandwiched" && <span><small>±0.5% PIN</small>{x.stoppedByPin === null ? "?" : x.stoppedByPin ? "stops it" : "inside"}</span>}<button className="ln-link" onClick={() => onOpen(x.hash)}>Details →</button></div>
          </li>) : null)}
      </ul>}
      {shownClean.length < clean.length && <button className="ln-chk-btn more" onClick={() => setAll(true)}>Show {clean.length - shownClean.length} more clean swap{clean.length - shownClean.length === 1 ? "" : "s"}</button>}
    </div>
  );
}
