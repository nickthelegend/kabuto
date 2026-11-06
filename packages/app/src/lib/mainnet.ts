/**
 * "Was I sandwiched?" on real Ethereum mainnet. Read-only: keyless public RPCs (src/landing/rpc.ts), the Uniswap v4
 * PoolManager Swap logs of the transaction's block, and the same front/victim/back rules as packages/replay
 * (src/landing/detect.ts mirrors detector.ts and measure.ts).
 */
import { pad, type Hex } from "viem";
import { BAND, MANAGER, SWAP_TOPIC, findSandwich, measure, priceBeforeInBlock, swapsFromLogs, TX_HASH, ADDRESS, type RawLog, type Tx } from "../landing/detect";
import { call, ENDPOINTS, getLogs, lastLogBefore, lookup, type Endpoint } from "../landing/rpc";

export { BAND, MANAGER };
/** How far back the pre-attack price is looked up when the front-run is the pool's first swap in its block. */
export const PRICE_LOOKBACK = 3000;
/** Address mode bounds: ~24 h of blocks, and at most this many of the newest transactions. */
export const SCAN_BLOCKS = 7200;
export const SCAN_MAX_TXS = 30;

export type Progress = (step: string) => void;
export type Verdict =
  | { kind: "not-found"; hash: Hex }
  | { kind: "failed-tx"; hash: Hex; block: number }
  | { kind: "no-v4-swap"; hash: Hex; block: number }
  | { kind: "clean"; hash: Hex; block: number; pools: number; swapsInBlock: number }
  | { kind: "sandwiched"; hash: Hex; block: number; poolId: Hex; front: Hex; back: Hex; attacker: Hex; victimFrom: Hex; match: "same sender" | "same contract"; priceMovePct: number | null; stoppedByPin: boolean | null; filledWorsePct: number | null };

const lower = (h: string) => h.toLowerCase() as Hex;

function txFetcher(signal?: AbortSignal) {
  const cache = new Map<string, Promise<Tx>>();
  return (h: Hex) => {
    let p = cache.get(h);
    if (!p) {
      p = lookup<Tx>("eth_getTransactionByHash", [h], signal).then((t) => { if (!t) throw new Error(`No RPC returned transaction ${h}, although its swap log exists`); return t; });
      cache.set(h, p);
    }
    return p;
  };
}

/** Judge one transaction given every PoolManager Swap log of its block. */
async function judge(h: Hex, block: number, blockLogs: RawLog[], getTx: (h: Hex) => Promise<Tx>, signal?: AbortSignal, progress?: Progress): Promise<Verdict> {
  const all = swapsFromLogs(blockLogs);
  const mine = all.filter((s) => s.hash === h);
  if (!mine.length) return { kind: "no-v4-swap", hash: h, block };
  const pools = [...new Set(mine.map((s) => s.poolId))];
  for (const poolId of pools) {
    const poolSwaps = all.filter((s) => s.poolId === poolId);
    progress?.(`Testing ${poolSwaps.length} swaps in pool ${poolId.slice(0, 10)}… for a front-run and back-run`);
    const hit = await findSandwich(poolSwaps, h, getTx);
    if (!hit) continue;
    progress?.("Sandwich found. Reading the pool price before the front-run");
    let pre: bigint | null = priceBeforeInBlock(poolSwaps, hit.front);
    if (pre === null) {
      const prev = await lastLogBefore({ address: MANAGER, topics: [SWAP_TOPIC, poolId] }, block, PRICE_LOOKBACK, signal);
      pre = prev ? swapsFromLogs([prev])[0]?.sqrtPriceX96 ?? null : null;
    }
    const m = measure(hit.front, hit.victim, pre);
    return { kind: "sandwiched", hash: h, block, poolId, front: hit.front.hash, back: hit.back.hash, attacker: hit.match === "same sender" ? lower(hit.frontTx.from) : lower(hit.frontTx.to!), victimFrom: lower(hit.victimTx.from), match: hit.match, ...m };
  }
  return { kind: "clean", hash: h, block, pools: pools.length, swapsInBlock: all.length };
}

/** `endpoints` reorders the receipt lookup (tests use it to put a pruned node first). "not-found" only when every endpoint answered null. */
export async function checkMainnetTx(hash: string, opts: { signal?: AbortSignal; progress?: Progress; endpoints?: Endpoint[] } = {}): Promise<Verdict> {
  const { signal, progress, endpoints = ENDPOINTS } = opts;
  const h = lower(hash.trim());
  if (!TX_HASH.test(h)) throw new Error("That isn't a transaction hash. Paste the 66-character 0x… hash from Etherscan or your wallet.");
  progress?.("Reading the transaction receipt");
  const receipt = await lookup<{ blockNumber: Hex; status: Hex; logs: RawLog[] }>("eth_getTransactionReceipt", [h], signal, endpoints);
  if (!receipt) return { kind: "not-found", hash: h };
  const block = Number(BigInt(receipt.blockNumber));
  if (receipt.status === "0x0") return { kind: "failed-tx", hash: h, block };
  if (!swapsFromLogs(receipt.logs).length) return { kind: "no-v4-swap", hash: h, block };
  progress?.(`Reading every Uniswap v4 swap in block ${block.toLocaleString("en-US")}`);
  const blockLogs = await getLogs({ address: MANAGER, topics: [SWAP_TOPIC] }, block, block, signal);
  return judge(h, block, blockLogs, txFetcher(signal), signal, progress);
}

export type AddressScan = {
  address: Hex; head: number; fromBlock: number;
  /** Transactions in the window where this address sent or received an ERC-20. */
  tokenTxs: number;
  /** How many of those (newest first) were checked; < tokenTxs when the cap was hit. */
  checked: number;
  results: Verdict[];
};

/**
 * Scan an address's recent Uniswap v4 swaps. Finds transactions where the address sent or received an ERC-20 in the
 * last SCAN_BLOCKS blocks (every v4 swap moves at least one ERC-20 unless both sides are native ETH, which v4 can't
 * pair), keeps the ones with a PoolManager Swap, and judges each with the single-transaction rules.
 */
export async function scanAddress(address: string, opts: { signal?: AbortSignal; progress?: Progress } = {}): Promise<AddressScan> {
  const { signal, progress } = opts;
  const a = lower(address.trim());
  if (!ADDRESS.test(a)) throw new Error("That isn't an address. Paste a 42-character 0x… Ethereum address.");
  progress?.("Reading the latest mainnet block");
  const head = Number(BigInt(await call<Hex>("eth_blockNumber", [], signal)));
  const fromBlock = head - SCAN_BLOCKS + 1;
  const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as Hex;
  const topic = pad(a);
  progress?.(`Finding token transfers to and from ${a.slice(0, 8)}… in blocks ${fromBlock.toLocaleString("en-US")}–${head.toLocaleString("en-US")}`);
  const [sent, got] = await Promise.all([
    getLogs({ topics: [TRANSFER, topic] }, fromBlock, head, signal),
    getLogs({ topics: [TRANSFER, null, topic] }, fromBlock, head, signal),
  ]);
  const txs = new Map<Hex, { block: number; index: number }>();
  for (const l of [...sent, ...got]) if (!l.removed) txs.set(lower(l.transactionHash), { block: Number(BigInt(l.blockNumber)), index: Number(BigInt(l.transactionIndex)) });
  const newest = [...txs.entries()].sort((x, y) => y[1].block - x[1].block || y[1].index - x[1].index).slice(0, SCAN_MAX_TXS);
  const blocks = [...new Set(newest.map(([, t]) => t.block))];
  const byBlock = new Map<number, RawLog[]>();
  let done = 0;
  for (const b of blocks) {
    progress?.(`Reading Uniswap v4 swaps in block ${b.toLocaleString("en-US")} (${++done} of ${blocks.length})`);
    byBlock.set(b, await getLogs({ address: MANAGER, topics: [SWAP_TOPIC] }, b, b, signal));
  }
  const getTx = txFetcher(signal);
  const results: Verdict[] = [];
  for (const [h, t] of newest) {
    const logs = byBlock.get(t.block)!;
    if (!logs.some((l) => lower(l.transactionHash) === h)) continue;
    results.push(await judge(h, t.block, logs, getTx, signal, progress));
  }
  return { address: a, head, fromBlock, tokenTxs: txs.size, checked: newest.length, results };
}

/** Real victims from the 27-hour mainnet replay (packages/replay/out/sandwiches.jsonl), loss in USDT as measured there. */
export const EXAMPLES = [
  { hash: "0x0c7b1b22dff71b916c51e2cc832d4ce8c37b2c808c2b06bc210eafc7f4b59c50", label: "lost ≈ $415" },
  { hash: "0xc6405b682dbb93ae51719fb0266282a49e5959f091e5b43a49a77641ec5864f9", label: "lost ≈ $338" },
  { hash: "0x2404c6e9ded46d867827fb8d72adce5d6da694b6e8f58699b8c2f27d08669f83", label: "lost ≈ $132" },
];
