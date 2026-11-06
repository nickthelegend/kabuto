import { AnimatePresence, motion } from "motion/react";
import { fmt, tokenOut, type Side } from "../lib/market";
import type { Attempt } from "../lib/swap";
import { amt, Icon, num, TxLink, useNow } from "./ui";

export type Loss = { kusd: number; side: Side; amountIn: bigint };
const pop = { initial: { opacity: 0, y: 18, scale: 0.98 }, animate: { opacity: 1, y: 0, scale: 1 }, exit: { opacity: 0, y: -10, scale: 0.98 }, transition: { type: "spring", stiffness: 380, damping: 32 } } as const;

export const TERMINAL = ["included", "cancelled", "rejected", "reverted", "failed"];
/** kUSD lost to a worse fill, from the attempt's own numbers (no live price): buy = share of kUSD paid, sell = kUSD short. */
export const lossKusd = (a: Attempt) => (a.out === undefined || a.quoted <= a.out ? 0 : a.side === "buy" ? (Number(a.amountIn) / 1e6) * (Number(a.quoted - a.out) / Number(a.quoted)) : Number(a.quoted - a.out) / 1e6);
export const fmtGas = (w: bigint) => (w === 0n ? "0 ETH" : w < 10n ** 12n ? `${(Number(w) / 1e9).toLocaleString("en-US", { maximumFractionDigits: 1 })} gwei` : `${fmt(w, 18, 6)} ETH`);

type StepState = "done" | "active" | "fail" | "todo";
type Step = { k: string; d: string; state: StepState; at?: number };

function steps(a: Attempt): Step[] {
  const t = (p: string) => a.phaseLog.find((x) => x.phase === p)?.at;
  const end = TERMINAL.includes(a.phase);
  const finalAt = end ? a.phaseLog[a.phaseLog.length - 1]?.at : undefined;
  const landed = a.phase === "included";
  const where = a.block !== undefined ? `Block ${num(a.block)}${a.index !== undefined ? ` · #${a.index}` : ""}` : "";
  const final: Step = landed ? { k: "Landed", d: where, state: "done", at: finalAt }
    : a.phase === "cancelled" ? { k: "Cancelled", d: "Never included", state: "fail", at: finalAt }
    : a.phase === "reverted" ? { k: "Reverted", d: where, state: "fail", at: finalAt }
    : a.phase === "rejected" || a.phase === "failed" ? { k: "Not sent", d: "", state: "fail", at: finalAt }
    : { k: a.wallet === "kabuto" ? "Landed" : "Mined", d: "", state: "todo" };
  if (a.wallet === "normal") {
    const pend = t("pending");
    return [
      { k: "Signed", d: "secp256k1", state: "done", at: t("signing") },
      { k: "Public mempool", d: "Visible to bots", state: pend ? (end ? "done" : "active") : a.phase === "failed" ? "fail" : "active", at: pend },
      final,
    ];
  }
  const adm = t("admitted"), pend = t("pending");
  const checks = a.checks?.length ? `${a.checks.filter((c) => c.verdict === "pass").length}/${a.checks.length} checks` : "ERC-8421";
  return [
    { k: "Signed", d: "P256 · 3 frames", state: "done", at: t("signing") },
    { k: "Admitted", d: a.phase === "rejected" ? "Refused" : checks, state: adm ? "done" : a.phase === "rejected" ? "fail" : "active", at: adm },
    { k: "Price pin held", d: a.phase === "cancelled" ? "Band broken" : pend || landed ? "VERIFY frame" : "", state: a.phase === "cancelled" ? "fail" : landed || (pend && end) ? "done" : pend || adm ? "active" : "todo", at: pend },
    final,
  ];
}

export function SwapResult({ a, loss }: { a: Attempt; loss: Loss | null }) {
  useNow(500); // live elapsed counter while pending
  const protect = a.wallet === "kabuto";
  const tout = tokenOut(a.side);
  const pending = !TERMINAL.includes(a.phase);
  const worse = a.out !== undefined && a.quoted > 0n ? Number(a.quoted - a.out) / Number(a.quoted) : null;
  const lostHere = lossKusd(a);
  let tone = "", title = "", body = "";
  if (pending) { title = a.phase === "signing" ? "Signing…" : "Waiting for a block…"; }
  else if (a.route === "guard" && a.guard && !a.guard.admitted) { tone = "guard"; title = "Refused by KabutoGuard"; body = a.guard.code ? `${a.guard.code}() · a plain transaction can't swap in this pool` : (a.error ?? ""); }
  else if (a.phase === "cancelled" || a.phase === "rejected") { tone = "good"; title = "Sandwich blocked"; body = a.phase === "rejected" ? (a.error ?? "Refused before the mempool · 0 gas") : "Not included · 0 gas · tokens untouched"; }
  else if (a.phase === "included" && worse !== null && worse > 0.0015) { tone = "bad"; title = `Sandwiched · ${(worse * 100).toFixed(2)}% worse`; body = `Lost ${lostHere.toLocaleString("en-US", { maximumFractionDigits: 2 })} kUSD`; }
  else if (a.phase === "included") { tone = "good"; title = "Filled at your price"; }
  else { tone = "bad"; title = "Did not complete"; body = a.error ?? ""; }
  const saved = protect && !pending && !!loss && loss.kusd > 0 && loss.side === a.side && loss.amountIn === a.amountIn && (a.phase === "cancelled" || a.phase === "rejected");
  const st = steps(a);
  const t0 = a.startedAt;
  const passed = a.checks?.filter((c) => c.verdict === "pass").length ?? 0;

  return (
    <motion.section layout {...pop} className={`dx-result ${tone}`} aria-label="Swap status">
      <div className="dx-result-h">
        <span className="dx-tag">{protect ? "Protected" : "Unprotected"} · {a.route === "guard" ? "KabutoGuard" : "Uniswap v4"}</span>
        <TxLink hash={a.hash} />
      </div>
      <div aria-live="polite" aria-atomic="true">
        <b className="dx-result-t">{title}</b>
        {body && <p>{body}</p>}
      </div>

      <ol className="dx-life" style={{ ["--n" as any]: st.length }}>
        {st.map((s, i) => (
          <li key={s.k} data-state={s.state}>
            <i aria-hidden>{s.state === "done" ? <Icon name="check" /> : s.state === "fail" ? <Icon name="x" /> : null}</i>
            <b>{s.k}</b>
            <span>{s.d}</span>
            <em>{s.at ? `+${((s.at - t0) / 1000).toFixed(1)}s` : s.state === "active" ? `${((Date.now() - t0) / 1000).toFixed(1)}s` : ""}</em>
            <span className="sr">{s.state === "done" ? "done" : s.state === "fail" ? "failed" : s.state === "active" ? "in progress" : "not reached"}{i < st.length - 1 ? "," : ""}</span>
          </li>
        ))}
      </ol>

      <div className="dx-kv">
        <div><small>Quoted</small><span>{a.quoted ? `${amt(a.quoted, tout.decimals)} ${tout.symbol}` : "…"}</span></div>
        <div><small>Received</small><span>{a.out !== undefined && a.phase === "included" ? `${amt(a.out, tout.decimals)} ${tout.symbol}` : pending ? "…" : `0 ${tout.symbol}`}</span></div>
        <div><small>Gas</small><span>{a.gasWei !== undefined ? fmtGas(a.gasWei) : a.phase === "cancelled" || a.phase === "rejected" ? "0 ETH" : "…"}</span></div>
      </div>

      {(a.frames?.length || a.checks?.length || (a.route === "guard" && a.guard)) ? (
        <div className="dx-frames">
          {a.frames?.map((f) => (
            <div key={f.label} className="dx-frame" data-ok={f.ok}>
              <Icon name={f.ok ? "check" : "x"} /><span>{f.label}</span><em>{num(f.gas)} gas</em>
            </div>
          ))}
          {a.route === "guard" && a.guard && (
            <div className="dx-frame" data-ok={a.guard.admitted}>
              <Icon name="shield" /><span>KabutoGuard beforeSwap</span><em>{a.guard.admitted ? "pin found" : a.guard.code ? `${a.guard.code}()` : "refused"}</em>
            </div>
          )}
          {!!a.checks?.length && (
            <details className="dx-checks">
              <summary>Mempool admission <em>{passed}/{a.checks.length} passed</em></summary>
              <ul>{a.checks.map((c, i) => <li key={i} data-ok={c.verdict === "pass"}><span>{c.rule}</span><em>{c.verdict}</em></li>)}</ul>
            </details>
          )}
        </div>
      ) : null}

      <AnimatePresence>{saved && <motion.div className="dx-saved" initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} transition={{ type: "spring", stiffness: 300, damping: 18 }}><small>You saved vs. the same swap unprotected</small><b>{loss!.kusd.toLocaleString("en-US", { maximumFractionDigits: 2 })} kUSD</b></motion.div>}</AnimatePresence>
    </motion.section>
  );
}
