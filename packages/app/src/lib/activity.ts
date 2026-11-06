/**
 * The user's own trades, read from chain 1337: ERC-20 Transfer logs (kUSD, WETH) to or from the Kabuto account and the
 * ordinary wallet, grouped per transaction, then each transaction's receipt for its type, payer and the pool it hit.
 * Faucet mints (from 0x0) are left out. Transactions that never reached a block (a Cancelled frame tx) have no logs by
 * definition; the app adds those from this browser session instead.
 */
import { parseAbiItem, type Address, type Hex } from "viem";
import { D } from "./config";
import { pub } from "./chain";
import { rpc } from "./rpc";
import { TOKENS } from "./market";
import { GUARD, type Route } from "./guard";

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const SWAP_TOPIC = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f"; // v4 PoolManager Swap
const ZERO = "0x0000000000000000000000000000000000000000";

export type Activity = {
  hash: Hex;
  block: bigint;
  index: number;
  /** Block time in ms (the gateway includes blockTimestamp in logs). */
  time?: number;
  who: "kabuto" | "normal";
  kind: "swap" | "fill";
  paid: { symbol: string; decimals: number; amount: bigint };
  got: { symbol: string; decimals: number; amount: bigint };
  route?: Route | "other";
  frames?: number;
  payer?: Address;
};

const tokenOf = (addr: string) => Object.values(TOKENS).find((t) => t.address.toLowerCase() === addr.toLowerCase());

export async function readActivity(account: Address | undefined, funder: Address, limit = 12): Promise<Activity[]> {
  const owners = [account, funder].filter(Boolean) as Address[];
  const fromBlock = BigInt((D as any).block ?? 0);
  const address = [TOKENS.kUSD.address, TOKENS.WETH.address];
  const [outs, ins] = await Promise.all([
    pub.getLogs({ address, event: TRANSFER, args: { from: owners }, fromBlock, toBlock: "latest" }),
    pub.getLogs({ address, event: TRANSFER, args: { to: owners }, fromBlock, toBlock: "latest" }),
  ]);
  type Net = { block: bigint; index: number; time?: number; who: Address; delta: Map<string, bigint>; mint: boolean };
  const byTx = new Map<string, Net>();
  const add = (l: (typeof outs)[number], who: Address, sign: 1n | -1n) => {
    const k = `${l.transactionHash}:${who.toLowerCase()}`;
    const ts = (l as any).blockTimestamp;
    const n = byTx.get(k) ?? { block: l.blockNumber!, index: l.transactionIndex!, time: ts !== undefined && ts !== null ? Number(BigInt(ts)) * 1000 : undefined, who, delta: new Map(), mint: false };
    if (l.args.from?.toLowerCase() === ZERO) n.mint = true;
    n.delta.set(l.address.toLowerCase(), (n.delta.get(l.address.toLowerCase()) ?? 0n) + sign * (l.args.value ?? 0n));
    byTx.set(k, n);
  };
  for (const l of outs) for (const o of owners) if (l.args.from?.toLowerCase() === o.toLowerCase()) add(l, o, -1n);
  for (const l of ins) for (const o of owners) if (l.args.to?.toLowerCase() === o.toLowerCase()) add(l, o, 1n);

  const rows: Activity[] = [];
  for (const [k, n] of byTx) {
    if (n.mint) continue;
    const entries = [...n.delta.entries()];
    const paid = entries.find(([, v]) => v < 0n), got = entries.find(([, v]) => v > 0n);
    if (!paid || !got) continue; // approvals and one-sided transfers are not trades
    const tp = tokenOf(paid[0]), tg = tokenOf(got[0]);
    if (!tp || !tg) continue;
    rows.push({
      hash: k.split(":")[0] as Hex, block: n.block, index: n.index, time: n.time,
      who: account && n.who.toLowerCase() === account.toLowerCase() ? "kabuto" : "normal", kind: "swap",
      paid: { symbol: tp.symbol, decimals: tp.decimals, amount: -paid[1] }, got: { symbol: tg.symbol, decimals: tg.decimals, amount: got[1] },
    });
  }
  rows.sort((a, b) => (a.block === b.block ? b.index - a.index : a.block > b.block ? -1 : 1));
  const top = rows.slice(0, limit);
  await Promise.all(top.map(async (r) => {
    try {
      const rc = await rpc<any>("eth_getTransactionReceipt", [r.hash]);
      if (!rc) return;
      const swap = (rc.frameReceipts?.flatMap((f: any) => f.logs) ?? rc.logs ?? []).find((l: any) => l.topics?.[0] === SWAP_TOPIC);
      const pool = swap?.topics?.[1]?.toLowerCase();
      r.route = pool === D.poolId.toLowerCase() ? "main" : GUARD && pool === GUARD.id.toLowerCase() ? "guard" : swap ? "other" : undefined;
      r.frames = rc.frameReceipts?.length;
      if (rc.payer && rc.from && rc.payer.toLowerCase() !== rc.from.toLowerCase()) { r.kind = "fill"; r.payer = rc.payer; }
    } catch { /* receipt is an extra; the row still stands on its logs */ }
  }));
  return top;
}

/** Exact amount of `token` that reached `to` in one transaction, from its receipt logs. */
export async function receivedIn(hash: Hex, token: Address, to: Address): Promise<{ amount: bigint; payer?: Address; block: bigint } | null> {
  const rc = await rpc<any>("eth_getTransactionReceipt", [hash]);
  if (!rc) return null;
  const logs: any[] = rc.frameReceipts?.flatMap((f: any) => f.logs) ?? rc.logs ?? [];
  const topic = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, "0")}`;
  let amount = 0n;
  for (const l of logs) {
    if (l.address?.toLowerCase() !== token.toLowerCase() || l.topics?.[0] !== "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef") continue;
    if (l.topics?.[2]?.toLowerCase() === topic(to)) amount += BigInt(l.data);
  }
  return { amount, payer: rc.payer, block: BigInt(rc.blockNumber) };
}
