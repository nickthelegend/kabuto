/**
 * Read-only Ethereum mainnet JSON-RPC from the browser, over keyless public endpoints with fallbacks. Each endpoint has
 * its own eth_getLogs block-range limit (measured Nov 6 2026); when every endpoint fails the error names each one and
 * why, so the checker never pretends.
 */
import type { Hex } from "viem";
import type { RawLog } from "./detect";

export type Endpoint = { name: string; url: string; maxLogRange: number };
/** maxLogRange 0 = don't use for eth_getLogs (PublicNode refuses address-less and archive log queries without a token). */
export const ENDPOINTS: Endpoint[] = [
  { name: "Tenderly", url: "https://mainnet.gateway.tenderly.co", maxLogRange: 5000 },
  { name: "MEV Blocker", url: "https://rpc.mevblocker.io", maxLogRange: 5000 },
  { name: "dRPC", url: "https://eth.drpc.org", maxLogRange: 100 },
  { name: "PublicNode", url: "https://ethereum-rpc.publicnode.com", maxLogRange: 0 },
];
const TIMEOUT_MS = 15_000;

export class RpcError extends Error {
  constructor(readonly method: string, readonly failures: { name: string; reason: string }[]) {
    super(`Couldn't read Ethereum mainnet (${method}). ${failures.map((f) => `${f.name}: ${f.reason}`).join(" · ")}`);
    this.name = "RpcError";
  }
}
export const isAbort = (e: unknown) => e instanceof DOMException && e.name === "AbortError";

let serial = 0;
async function post<T>(ep: Endpoint, method: string, params: unknown[], signal?: AbortSignal): Promise<T> {
  const ctl = new AbortController();
  const onAbort = () => ctl.abort(signal?.reason);
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => ctl.abort(new Error(`timed out after ${TIMEOUT_MS / 1000} s`)), TIMEOUT_MS);
  try {
    const r = await fetch(ep.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++serial, method, params }), signal: ctl.signal });
    if (r.status === 429) throw new Error("rate limited (HTTP 429)");
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    let j: { result?: T; error?: { message?: string } };
    try { j = await r.json(); } catch { throw new Error("answered with something that isn't JSON"); }
    if (j.error) throw new Error(j.error.message ?? "RPC error");
    if (!("result" in j)) throw new Error("no result in the answer");
    return j.result as T;
  } catch (e) {
    if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
    if (ctl.signal.aborted && ctl.signal.reason instanceof Error) throw ctl.signal.reason;
    throw e instanceof TypeError ? new Error("network or CORS failure") : e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

const preferred = new Map<string, number>();
/** One call, trying each endpoint in turn (starting with the last one that worked for this method). */
export async function call<T>(method: string, params: unknown[], signal?: AbortSignal, eligible: (e: Endpoint) => boolean = () => true): Promise<T> {
  const list = ENDPOINTS.filter(eligible);
  const start = Math.min(preferred.get(method) ?? 0, list.length - 1);
  const failures: { name: string; reason: string }[] = [];
  for (let i = 0; i < list.length; i++) {
    const ep = list[(start + i) % list.length];
    try {
      const out = await post<T>(ep, method, params, signal);
      preferred.set(method, (start + i) % list.length);
      return out;
    } catch (e) {
      if (isAbort(e)) throw e;
      failures.push({ name: ep.name, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  throw new RpcError(method, failures);
}

const hex = (n: number) => `0x${n.toString(16)}`;
export type LogFilter = { address?: Hex; topics: (Hex | null)[] };

async function pool<T, R>(items: T[], width: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

/**
 * eth_getLogs over [from, to], split into each endpoint's range limit. If any window fails on an endpoint the whole
 * range moves to the next endpoint, so results never mix a partial answer with a missing one.
 */
export async function getLogs(filter: LogFilter, from: number, to: number, signal?: AbortSignal): Promise<RawLog[]> {
  const failures: { name: string; reason: string }[] = [];
  for (const ep of ENDPOINTS.filter((e) => e.maxLogRange > 0)) {
    const windows: [number, number][] = [];
    for (let a = from; a <= to; a += ep.maxLogRange) windows.push([a, Math.min(to, a + ep.maxLogRange - 1)]);
    try {
      const parts = await pool(windows, 4, ([a, b]) => post<RawLog[]>(ep, "eth_getLogs", [{ fromBlock: hex(a), toBlock: hex(b), ...filter }], signal));
      return parts.flat();
    } catch (e) {
      if (isAbort(e)) throw e;
      failures.push({ name: ep.name, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  throw new RpcError("eth_getLogs", failures);
}

/** The latest log matching `filter` strictly before `block`, scanning back in 500-block steps up to `lookback` blocks. */
export async function lastLogBefore(filter: LogFilter, block: number, lookback: number, signal?: AbortSignal): Promise<RawLog | null> {
  for (let top = block - 1; top > 0 && top >= block - lookback; top -= 500) {
    const logs = await getLogs(filter, Math.max(0, top - 499, block - lookback), top, signal);
    if (logs.length) return logs[logs.length - 1];
  }
  return null;
}
