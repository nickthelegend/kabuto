import { useEffect, useState } from "react";
import { motion } from "motion/react";
import type { Address, Hex } from "viem";
import { fmt, tokenIn, tokenOut, type Side } from "../lib/market";
import type { RelayEvent, SignedIntent } from "../lib/intent";
import { receivedIn } from "../lib/activity";
import { addrUrl, Icon, num, short, TxLink, useNow } from "./ui";

export type Posted = { id: string; at: number; signed: SignedIntent; side: Side };
const pop = { initial: { opacity: 0, y: 18, scale: 0.98 }, animate: { opacity: 1, y: 0, scale: 1 }, exit: { opacity: 0, y: -10, scale: 0.98 }, transition: { type: "spring", stiffness: 380, damping: 32 } } as const;

/** Same formula as KabutoAccount.decayedMinOut. */
function decayed(i: SignedIntent["intent"], t: bigint) {
  if (t <= i.startTime || i.deadline <= i.startTime) return i.startOut;
  if (t >= i.deadline) return i.endOut;
  return i.startOut - ((i.startOut - i.endOut) * (t - i.startTime)) / (i.deadline - i.startTime);
}

const fillerName = (e: RelayEvent) => (typeof e.role === "string" ? e.role.replace(/^filler-/, "Filler ").replace(/^Filler (\w)/, (_m, c) => `Filler ${c.toUpperCase()}`) : "Filler");

export function IntentCard({ p, events }: { p: Posted; events: RelayEvent[] }) {
  const now = useNow(1000);
  const i = p.signed.intent;
  const tout = tokenOut(p.side), tin = tokenIn(p.side);
  const landed = events.find((e) => e.type === "fill_landed");
  const [fill, setFill] = useState<{ amount: bigint; payer?: Address; block: bigint } | null>(null);
  const [fillErr, setFillErr] = useState(false);
  useEffect(() => {
    if (!landed?.hash) return;
    let alive = true;
    receivedIn(landed.hash as Hex, tout.address, p.signed.account).then((r) => alive && setFill(r)).catch(() => alive && setFillErr(true));
    return () => { alive = false; };
  }, [landed?.hash]);

  // chain clock: the intent's startTime is the block timestamp when it was signed
  const skew = Number(i.startTime) - p.at / 1000;
  const chainNow = BigInt(Math.floor(now / 1000 + skew));
  const left = Number(i.deadline - chainNow);
  const expired = !landed && left <= 0;
  const bids = events.filter((e) => e.type === "fill_submitted" || e.type === "fill_refused" || e.type === "fill_replaced");
  const status = landed ? "Filled" : expired ? "Expired" : bids.some((e) => e.type === "fill_submitted") ? "Fillers racing" : "Open";
  const minNow = decayed(i, chainNow < i.deadline ? chainNow : i.deadline);
  const pct = Math.min(100, Math.max(0, (Number(chainNow - i.startTime) / Number(i.deadline - i.startTime)) * 100));

  return (
    <motion.section layout {...pop} className={`dx-result dx-intent ${landed ? "good" : ""}`} aria-label={`Intent ${fmt(i.maxIn, tin.decimals, 0)} ${tin.symbol} to ${tout.symbol}`}>
      <div className="dx-result-h">
        <span className="dx-tag">{fmt(i.maxIn, tin.decimals, 0)} {tin.symbol} → {tout.symbol}</span>
        <span className="dx-chip-s" data-tone={landed ? "ok" : expired ? "mute" : "gold"} aria-live="polite">{status}</span>
      </div>

      {landed ? (
        <div className="dx-intent-big">
          <small>Received</small>
          <b>{fill ? `${fmt(fill.amount, tout.decimals, 6)} ${tout.symbol}` : fillErr ? "Receipt unavailable" : "…"}</b>
          <span>Signed minimum {fmt(i.startOut, tout.decimals, 6)} → {fmt(i.endOut, tout.decimals, 6)} · your gas 0 ETH</span>
        </div>
      ) : (
        <div className="dx-intent-big">
          <small>{expired ? "Expired unfilled · nothing moved" : "Minimum right now"}</small>
          <b>{fmt(minNow, tout.decimals, 6)} {tout.symbol}</b>
          <div className="dx-decay" role="progressbar" aria-label="Auction window elapsed" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}><i style={{ width: `${pct}%` }} /></div>
          <span><Icon name="clock" /> {expired ? "Deadline passed" : `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")} left`} · floor {fmt(i.endOut, tout.decimals, 6)}</span>
        </div>
      )}

      {bids.length > 0 && (
        <ul className="dx-bids" aria-label="Filler activity">
          {bids.map((e, k) => (
            <li key={k} data-type={e.type}>
              <Icon name={e.type === "fill_submitted" ? (landed && landed.hash === e.hash ? "check" : "bolt") : "x"} />
              <span>{fillerName(e)}{typeof e.filler === "string" && <a href={addrUrl(e.filler)} target="_blank" rel="noreferrer" className="dx-mono-l">{short(e.filler, 6)}</a>}</span>
              <em>{e.type === "fill_submitted" ? (landed && landed.hash === e.hash ? "won" : "bid") : e.type === "fill_replaced" ? "outbid" : (e.reason ?? "refused")}</em>
            </li>
          ))}
        </ul>
      )}

      <div className="dx-kv">
        <div><small>Filler</small><span>{fill?.payer ? <a href={addrUrl(fill.payer)} target="_blank" rel="noreferrer">{short(fill.payer, 6)}</a> : landed && typeof landed.filler === "string" ? short(landed.filler, 6) : "—"}</span></div>
        <div><small>Block</small><span>{fill ? num(fill.block) : "—"}</span></div>
        <div><small>Fill tx</small><span>{landed?.hash ? <TxLink hash={landed.hash} n={6} /> : "—"}</span></div>
      </div>
    </motion.section>
  );
}
