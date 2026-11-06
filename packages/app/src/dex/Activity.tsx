import { useEffect, useMemo, useState } from "react";
import { readActivity, type Activity as Row } from "../lib/activity";
import { tokenIn, tokenOut } from "../lib/market";
import type { Saved } from "../lib/wallet";
import { shortError } from "../lib/wallet";
import type { Attempt } from "../lib/swap";
import { TERMINAL } from "./Result";
import { ago, amt, Icon, num, short, TxLink, useNow } from "./ui";

/** A session attempt that never left a trace in token logs (cancelled, refused, reverted). */
export type SessionAttempt = Attempt & { atBlock?: bigint };
type Item =
  | { src: "chain"; key: string; block: bigint; r: Row }
  | { src: "session"; key: string; block: bigint; a: SessionAttempt };

type Filter = "all" | "kabuto" | "normal";
const FILTERS: { id: Filter; label: string }[] = [{ id: "all", label: "All" }, { id: "kabuto", label: "Protected" }, { id: "normal", label: "Ordinary" }];

export function Activity({ w, refreshKey, session }: { w: Saved; refreshKey: unknown; session: SessionAttempt[] }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const now = useNow(15_000);

  useEffect(() => {
    let alive = true;
    readActivity(w.account, w.funder).then((r) => { if (alive) { setRows(r); setErr(null); } }).catch((e) => alive && setErr(shortError(e)));
    return () => { alive = false; };
  }, [w.account, w.funder, refreshKey, Math.floor(now / 30_000)]);

  const items = useMemo<Item[]>(() => {
    const chain: Item[] = (rows ?? []).map((r) => ({ src: "chain", key: r.hash, block: r.block, r }));
    const seen = new Set((rows ?? []).map((r) => r.hash.toLowerCase()));
    const extra: Item[] = session
      .filter((a) => TERMINAL.includes(a.phase) && a.phase !== "included" && !(a.hash && seen.has(a.hash.toLowerCase())))
      .map((a) => ({ src: "session", key: a.id, block: a.block ?? a.atBlock ?? 0n, a }));
    return [...extra, ...chain].sort((x, y) => (x.block === y.block ? (x.src === "session" ? -1 : 1) : x.block > y.block ? -1 : 1));
  }, [rows, session]);

  const who = (i: Item) => (i.src === "chain" ? i.r.who : i.a.wallet);
  const count = (f: Filter) => items.filter((i) => f === "all" || who(i) === f).length;
  const shown = items.filter((i) => filter === "all" || who(i) === filter);

  return (
    <section className="dx-act" aria-label="Your activity">
      <div className="dx-act-h">
        <b>Activity</b>
        <div className="dx-seg" role="radiogroup" aria-label="Filter activity">
          {FILTERS.map((f) => (
            <button key={f.id} role="radio" aria-checked={filter === f.id} onClick={() => setFilter(f.id)}>
              {f.label}<em>{rows ? count(f.id) : "–"}</em>
            </button>
          ))}
        </div>
      </div>
      {err && !rows ? (
        <p className="dx-act-empty" role="alert">Couldn't read activity from chain 1337: {err}</p>
      ) : !rows ? (
        <ul className="dx-act-list" aria-busy="true">{[0, 1, 2].map((i) => <li key={i} className="dx-skel" aria-hidden><span /><span /></li>)}</ul>
      ) : shown.length === 0 ? (
        <p className="dx-act-empty">{filter === "all" ? "No trades from this wallet yet." : `No ${filter === "kabuto" ? "protected" : "ordinary"} trades yet.`}</p>
      ) : (
        <ul className="dx-act-list">
          {shown.map((i) => (i.src === "chain" ? <ChainRow key={i.key} r={i.r} now={now} /> : <SessionRow key={i.key} a={i.a} />))}
        </ul>
      )}
    </section>
  );
}

const routeName = (r?: string) => (r === "guard" ? "KabutoGuard" : r === "main" ? "Uniswap v4" : r === "other" ? "Other v4 pool" : "");

function ChainRow({ r, now }: { r: Row; now: number }) {
  const fill = r.kind === "sponsored";
  return (
    <li className="dx-act-row" data-who={r.who}>
      <span className="dx-act-ic" aria-hidden><Icon name={r.who === "kabuto" ? (fill ? "bolt" : "shield") : "swap"} /></span>
      <div className="dx-act-m">
        <b>{amt(r.paid.amount, r.paid.decimals)} {r.paid.symbol} <span aria-label="to">→</span> {amt(r.got.amount, r.got.decimals)} {r.got.symbol}</b>
        <span>
          {fill ? `Gas paid by ${short(r.payer, 6)}` : r.kind === "paymaster" ? "Protected · paymaster" : r.who === "kabuto" ? "Protected" : "Ordinary wallet"}
          {r.route ? ` · ${routeName(r.route)}` : ""}
        </span>
      </div>
      <div className="dx-act-r">
        <span className="dx-chip-s" data-tone="ok">Landed</span>
        <TxLink hash={r.hash} n={6} label={`#${num(r.block)}${r.time ? ` · ${ago(r.time, now)}` : ""}`} />
      </div>
    </li>
  );
}

function SessionRow({ a }: { a: SessionAttempt }) {
  const tin = tokenIn(a.side), tout = tokenOut(a.side);
  const label = a.route === "guard" && a.guard && !a.guard.admitted ? "Refused" : a.phase === "cancelled" ? "Cancelled" : a.phase === "rejected" ? "Refused" : a.phase === "reverted" ? "Reverted" : "Failed";
  const tone = a.wallet === "kabuto" && (a.phase === "cancelled" || a.phase === "rejected") ? "shu" : "bad";
  return (
    <li className="dx-act-row" data-who={a.wallet}>
      <span className="dx-act-ic" aria-hidden><Icon name={a.wallet === "kabuto" ? "shield" : "swap"} /></span>
      <div className="dx-act-m">
        <b>{amt(a.amountIn, tin.decimals)} {tin.symbol} <span aria-label="to">→</span> {tout.symbol}</b>
        <span>{a.wallet === "kabuto" ? "Protected" : "Ordinary wallet"} · {routeName(a.route)} · {a.phase === "cancelled" ? "no gas" : a.guard?.code ? `${a.guard.code}()` : "this session"}</span>
      </div>
      <div className="dx-act-r">
        <span className="dx-chip-s" data-tone={tone}>{label}</span>
        {a.hash ? <TxLink hash={a.hash} n={6} label={a.block !== undefined ? `#${num(a.block)}` : short(a.hash, 6)} /> : <span className="dx-act-meta">not sent</span>}
      </div>
    </li>
  );
}
