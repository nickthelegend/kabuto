import { useEffect, useState } from "react";
import { D } from "../lib/config";

export const short = (a?: string, n = 6) => (a ? `${a.slice(0, n)}…${a.slice(-4)}` : "");
export const txUrl = (h?: string) => `${D.explorer}tx/${h}`;
export const addrUrl = (a?: string) => `${D.explorer}address/${a}`;
export const num = (n: number | bigint) => Number(n).toLocaleString("en-US");
/** Token amount with enough precision for tiny values (4 significant digits below 1). */
export function amt(v: bigint, decimals: number) {
  const n = Number(v) / 10 ** decimals;
  return n >= 1 ? n.toLocaleString("en-US", { maximumFractionDigits: n >= 100 ? 2 : 4 }) : n.toLocaleString("en-US", { maximumSignificantDigits: 4 });
}

/** "12s", "4m", "3h" from a past timestamp (ms). */
export function ago(ms: number, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d`;
}

/** Re-render every `ms` (clocks, countdowns). */
export function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}

export function TxLink({ hash, n = 8, label }: { hash?: string; n?: number; label?: string }) {
  if (!hash) return null;
  return (
    <a className="dx-tx" href={txUrl(hash)} target="_blank" rel="noreferrer" aria-label={`Open transaction ${hash} in the explorer`}>
      {label ?? short(hash, n)}<Icon name="out" />
    </a>
  );
}

type IconName = "check" | "x" | "out" | "dot" | "shield" | "clock" | "swap" | "bolt";
export function Icon({ name }: { name: IconName }) {
  const p = { width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true, className: `dx-ic dx-ic-${name}` };
  switch (name) {
    case "check": return <svg {...p}><path d="M3.5 8.5l3 3 6-7" /></svg>;
    case "x": return <svg {...p}><path d="M4 4l8 8M12 4l-8 8" /></svg>;
    case "out": return <svg {...p} width={11} height={11}><path d="M6 3h7v7M13 3L4 12" /></svg>;
    case "dot": return <svg {...p}><circle cx="8" cy="8" r="3" fill="currentColor" stroke="none" /></svg>;
    case "shield": return <svg {...p}><path d="M8 1.8l5 1.9v4c0 3.2-2.1 5.4-5 6.5-2.9-1.1-5-3.3-5-6.5v-4z" /></svg>;
    case "clock": return <svg {...p}><circle cx="8" cy="8" r="5.6" /><path d="M8 5v3.2l2 1.3" /></svg>;
    case "swap": return <svg {...p}><path d="M4 5.5h8.5L10 3M12 10.5H3.5L6 13" /></svg>;
    case "bolt": return <svg {...p}><path d="M9 1.8L3.8 9h4l-1 5.2L12.2 7h-4z" /></svg>;
  }
}
