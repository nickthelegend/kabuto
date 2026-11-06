/**
 * Sandwich detector for the landing checker. Pure functions, no network: the same front/victim/back rules as
 * packages/replay/src/detector.ts (possibleTriples + detect) and the same price-band rule as packages/replay/src/measure.ts.
 * See packages/replay/METHOD.md for what these rules can and cannot prove.
 */
import { decodeEventLog, parseAbiItem, toEventSelector, type Hex } from "viem";

export const MANAGER = "0x000000000004444c5dc75cb358380d2e3de08a90";
export const SWAP_EVENT = parseAbiItem("event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)");
export const SWAP_TOPIC = toEventSelector(SWAP_EVENT);
/** The ±0.5% band the replay uses; equality is inside the band. */
export const BAND = 0.005;

export type RawLog = { address: Hex; topics: Hex[]; data: Hex; blockNumber: Hex; transactionHash: Hex; transactionIndex: Hex; logIndex: Hex; removed?: boolean };
export type Tx = { hash?: Hex; from: Hex; to: Hex | null };
export type Swap = { poolId: Hex; amount0: bigint; amount1: bigint; sqrtPriceX96: bigint; block: number; txIndex: number; logIndex: number; hash: Hex };
export type Sandwich = { front: Swap; victim: Swap; back: Swap; frontTx: Tx; victimTx: Tx; backTx: Tx; match: "same sender" | "same contract" };
export type Measured = { priceMovePct: number | null; stoppedByPin: boolean | null; filledWorsePct: number | null };

const lower = (h: string) => h.toLowerCase() as Hex;

export function decodeSwap(l: RawLog): Swap {
  const { args } = decodeEventLog({ abi: [SWAP_EVENT], data: l.data, topics: l.topics as [Hex, ...Hex[]] });
  const a = args as { id: Hex; amount0: bigint; amount1: bigint; sqrtPriceX96: bigint };
  return { poolId: lower(a.id), amount0: a.amount0, amount1: a.amount1, sqrtPriceX96: a.sqrtPriceX96, block: Number(BigInt(l.blockNumber)), txIndex: Number(BigInt(l.transactionIndex)), logIndex: Number(BigInt(l.logIndex)), hash: lower(l.transactionHash) };
}

/** Only PoolManager Swap logs that were not reorged out, in chain order. */
export function swapsFromLogs(logs: RawLog[]): Swap[] {
  return logs
    .filter((l) => !l.removed && lower(l.address) === MANAGER && l.topics[0] === SWAP_TOPIC)
    .map(decodeSwap)
    .sort((a, b) => a.block - b.block || a.txIndex - b.txIndex || a.logIndex - b.logIndex);
}

/**
 * Directional triples in one block and one pool (replay's possibleTriples): strictly increasing tx index, front and
 * victim swap the same way, back swaps the other way, and the back's output is within 10% of the front's input.
 */
export function possibleTriples(swaps: Swap[]): [Swap, Swap, Swap][] {
  const out: [Swap, Swap, Swap][] = [];
  for (let i = 0; i < swaps.length; i++) for (let j = i + 1; j < swaps.length; j++) {
    const front = swaps[i], victim = swaps[j];
    if (front.txIndex >= victim.txIndex || front.amount0 === 0n || victim.amount0 === 0n || (front.amount0 > 0n) !== (victim.amount0 > 0n)) continue;
    for (let k = j + 1; k < swaps.length; k++) {
      const back = swaps[k];
      if (victim.txIndex >= back.txIndex || (front.amount0 > 0n) === (back.amount0 > 0n)) continue;
      const input = front.amount0 < 0n ? -front.amount0 : -front.amount1;
      const output = front.amount0 < 0n ? back.amount0 : back.amount1;
      if (input <= 0n || output <= 0n || (output > input ? output - input : input - output) * 10n > input) continue;
      out.push([front, victim, back]);
    }
  }
  return out;
}

/** Replay's detect() confirmation: front and back share tx.from (or a non-null tx.to), and the victim sent neither. */
export function confirm(frontTx: Tx, victimTx: Tx, backTx: Tx): Sandwich["match"] | null {
  const fromMatch = lower(frontTx.from) === lower(backTx.from);
  const toMatch = !!frontTx.to && !!backTx.to && lower(frontTx.to) === lower(backTx.to);
  if (!fromMatch && !toMatch) return null;
  const v = lower(victimTx.from);
  if (v === lower(frontTx.from) || v === lower(backTx.from)) return null;
  return fromMatch ? "same sender" : "same contract";
}

/**
 * First sandwich (in replay order) with `victimHash` in the middle, among one block's swaps of ONE pool.
 * Fetches only the transactions that appear in a directional triple.
 */
export async function findSandwich(poolSwaps: Swap[], victimHash: string, getTx: (h: Hex) => Promise<Tx>): Promise<Sandwich | null> {
  const h = lower(victimHash);
  for (const [front, victim, back] of possibleTriples(poolSwaps)) {
    if (victim.hash !== h) continue;
    const [frontTx, victimTx, backTx] = await Promise.all([getTx(front.hash), getTx(victim.hash), getTx(back.hash)]);
    const match = confirm(frontTx, victimTx, backTx);
    if (match) return { front, victim, back, frontTx, victimTx, backTx, match };
  }
  return null;
}

/** The pool price just before `front`, from earlier swaps in the same block, or null if the block has none. */
export function priceBeforeInBlock(poolSwaps: Swap[], front: Swap): bigint | null {
  let pre: bigint | null = null;
  for (const s of poolSwaps) {
    if (s.txIndex > front.txIndex || (s.txIndex === front.txIndex && s.logIndex >= front.logIndex)) break;
    pre = s.sqrtPriceX96;
  }
  return pre;
}

/**
 * Price move of the front-run against `pre` (the pool price before it), whether a ±band pin would have stopped the
 * victim (|move| > band, replay's rule), and how much worse the victim filled than `pre` (includes the pool fee and the
 * victim's own price impact; unit-free token1/token0 ratio).
 */
export function measure(front: Swap, victim: Swap, pre: bigint | null, band = BAND): Measured {
  if (!pre) return { priceMovePct: null, stoppedByPin: null, filledWorsePct: null };
  const move = (Number(front.sqrtPriceX96) / Number(pre)) ** 2 - 1;
  let worse: number | null = null;
  if (victim.amount0 !== 0n && victim.amount1 !== 0n) {
    const spot = (Number(pre) / 2 ** 96) ** 2;
    const realized = Math.abs(Number(victim.amount1)) / Math.abs(Number(victim.amount0));
    worse = victim.amount0 < 0n ? 1 - realized / spot : 1 - spot / realized;
  }
  return { priceMovePct: move * 100, stoppedByPin: Math.abs(move) > band, filledWorsePct: worse === null ? null : worse * 100 };
}

export const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
export const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** What a pasted string or a `#check=` value is. */
export function classify(input: string): "tx" | "address" | null {
  const s = input.trim();
  if (TX_HASH.test(s)) return "tx";
  if (ADDRESS.test(s)) return "address";
  return null;
}

/** `#check=<tx hash or address>` → the lower-cased value, or null. */
export function parseShareHash(hash: string): string | null {
  const m = /^#check=(0x[0-9a-fA-F]{40}(?:[0-9a-fA-F]{24})?)$/.exec(hash.trim());
  return m ? m[1].toLowerCase() : null;
}
