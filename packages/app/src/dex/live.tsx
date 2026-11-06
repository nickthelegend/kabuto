import { useEffect, useState } from "react";
import { pub } from "../lib/chain";
import { GUARD, poolState, type PoolState } from "../lib/guard";
import { ago, num, useNow } from "./ui";

export type Live = {
  block: bigint | null;
  /** Latest block's timestamp, ms. */
  blockTime: number | null;
  main: PoolState | null;
  guard: PoolState | null;
  error: string | null;
};

/** A chain with no new block for this long is reported as paused (devnet blocks arrive every few seconds). */
export const STALL_MS = 120_000;

export function useLive(): Live {
  const [s, setS] = useState<Live>({ block: null, blockTime: null, main: null, guard: null, error: null });
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const [b, main, guard] = await Promise.all([pub.getBlock(), poolState("main"), GUARD ? poolState("guard").catch(() => null) : Promise.resolve(null)]);
        if (alive) setS({ block: b.number, blockTime: Number(b.timestamp) * 1000, main, guard, error: null });
      } catch (e: any) {
        if (alive) setS((p) => ({ ...p, error: e?.shortMessage ?? e?.message ?? "The devnet gateway is unreachable." }));
      }
    };
    tick(); const t = setInterval(tick, 3000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  return s;
}

export const isStalled = (l: Live, now = Date.now()) => l.blockTime !== null && now - l.blockTime > STALL_MS;

/** Nav indicator: live block height, or a paused / offline state. */
export function ChainPill({ live }: { live: Live }) {
  const now = useNow(1000);
  const stalled = isStalled(live, now);
  const state = live.error && live.block === null ? "off" : stalled ? "stall" : live.block !== null ? "on" : "wait";
  const label = state === "off" ? "Devnet offline" : state === "wait" ? "Connecting…" : `${num(live.block!)}`;
  const title = state === "stall" ? `Chain 1337: no new block for ${ago(live.blockTime!, now)}` : state === "on" ? `Chain 1337, latest block ${num(live.block!)}` : live.error ?? "Chain 1337";
  return (
    <span className="dx-chain" data-state={state} title={title} aria-label={title}>
      <i aria-hidden /> <span className="dx-chain-l">{label}</span>
    </span>
  );
}

/** Shown above the cards when blocks stop: nothing can land until the chain resumes. */
export function StallBanner({ live }: { live: Live }) {
  const now = useNow(5000);
  if (live.error && live.block === null) return <div className="dx-banner" role="status"><b>Devnet unreachable</b><span>{live.error}</span></div>;
  if (!isStalled(live, now)) return null;
  return (
    <div className="dx-banner" role="status">
      <b>Chain 1337 is paused</b>
      <span>No block since #{num(live.block!)}, {ago(live.blockTime!, now)} ago. Swaps and fills wait until it resumes.</span>
    </div>
  );
}
