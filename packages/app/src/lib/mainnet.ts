/**
 * "Was I sandwiched?" on real Ethereum mainnet. Read-only: public RPCs, the Uniswap v4 PoolManager Swap logs of the
 * transaction's block, and the same front/victim/back rules as packages/replay (detector.ts, measure.ts).
 */
import { decodeEventLog, parseAbiItem, toEventSelector, type Hex } from "viem";

const URLS = ["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org"];
export const MANAGER = "0x000000000004444c5dc75cb358380d2e3de08a90";
const SWAP = parseAbiItem("event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)");
const SWAP_TOPIC = toEventSelector(SWAP);
export const BAND = 0.005;

type RawLog = { address: Hex; topics: Hex[]; data: Hex; blockNumber: Hex; transactionHash: Hex; transactionIndex: Hex; logIndex: Hex; removed?: boolean };
type Swap = { poolId: Hex; amount0: bigint; amount1: bigint; sqrtPriceX96: bigint; txIndex: number; logIndex: number; hash: Hex; pre: bigint | null };

let serial = 0;
async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  let last: unknown;
  // publicnode refuses old-block log queries without a paid token; dRPC serves them in small windows.
  for (const url of method === "eth_getLogs" ? [...URLS].reverse() : URLS) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++serial, method, params }) });
      const j = await r.json();
      if (j.error) throw new Error(j.error.message);
      return j.result as T;
    } catch (e) { last = e; }
  }
  throw new Error(`Mainnet RPC unavailable (${last instanceof Error ? last.message : String(last)})`);
}

const decode = (l: RawLog): Swap => {
  const { args } = decodeEventLog({ abi: [SWAP], data: l.data, topics: l.topics as [Hex, ...Hex[]] });
  const a = args as { id: Hex; amount0: bigint; amount1: bigint; sqrtPriceX96: bigint };
  return { poolId: a.id.toLowerCase() as Hex, amount0: a.amount0, amount1: a.amount1, sqrtPriceX96: a.sqrtPriceX96, txIndex: Number(BigInt(l.transactionIndex)), logIndex: Number(BigInt(l.logIndex)), hash: l.transactionHash, pre: null };
};
const hex = (n: number) => `0x${n.toString(16)}`;

/** Latest Swap price in this pool before `block`: scan back in 100-block windows (dRPC's free limit), five at a time, up to 3,000 blocks. Logs only, no archive state. */
async function priceBefore(poolId: Hex, block: number): Promise<bigint | null> {
  for (let top = block - 1; top > 0 && top > block - 3000; top -= 500) {
    const windows = [0, 1, 2, 3, 4].map((k) => top - k * 100).filter((t) => t > 0);
    const results = await Promise.all(windows.map((t) => rpc<RawLog[]>("eth_getLogs", [{ fromBlock: hex(Math.max(0, t - 99)), toBlock: hex(t), address: MANAGER, topics: [SWAP_TOPIC, poolId] }])));
    for (const logs of results) if (logs.length) return decode(logs[logs.length - 1]).sqrtPriceX96;
  }
  return null;
}

export type Verdict =
  | { kind: "not-found" }
  | { kind: "no-v4-swap"; block: number }
  | { kind: "clean"; block: number; poolId: Hex }
  | { kind: "sandwiched"; block: number; poolId: Hex; front: Hex; back: Hex; attacker: Hex; match: "same sender" | "same contract"; priceMovePct: number | null; stoppedByPin: boolean | null; filledWorsePct: number | null };

export async function checkMainnetTx(hash: string): Promise<Verdict> {
  const h = hash.trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(h)) throw new Error("Paste a 66-character Ethereum transaction hash (0x…)");
  const receipt = await rpc<{ blockNumber: Hex; logs: RawLog[] } | null>("eth_getTransactionReceipt", [h]);
  if (!receipt) return { kind: "not-found" };
  const block = Number(BigInt(receipt.blockNumber));
  const mine = receipt.logs.filter((l) => l.address.toLowerCase() === MANAGER && l.topics[0] === SWAP_TOPIC).map(decode);
  if (!mine.length) return { kind: "no-v4-swap", block };
  const victimSwap = mine[0];
  const logs = await rpc<RawLog[]>("eth_getLogs", [{ fromBlock: hex(block), toBlock: hex(block), address: MANAGER, topics: [SWAP_TOPIC, victimSwap.poolId] }]);
  const swaps = logs.filter((l) => !l.removed).map(decode).sort((a, b) => a.txIndex - b.txIndex || a.logIndex - b.logIndex);
  let prev = await priceBefore(victimSwap.poolId, block);
  for (const s of swaps) { s.pre = prev; prev = s.sqrtPriceX96; }
  const vi = swaps.findIndex((s) => s.hash.toLowerCase() === h);
  if (vi < 0) return { kind: "clean", block, poolId: victimSwap.poolId };
  const victim = swaps[vi];
  const tx = (x: Hex) => rpc<{ from: Hex; to: Hex | null }>("eth_getTransactionByHash", [x]);
  const vtx = await tx(victim.hash);
  // Same rules as packages/replay/src/detector.ts possibleTriples + detect.
  for (const front of swaps.slice(0, vi)) {
    if (front.txIndex >= victim.txIndex || front.amount0 === 0n || victim.amount0 === 0n || (front.amount0 > 0n) !== (victim.amount0 > 0n)) continue;
    for (const back of swaps.slice(vi + 1)) {
      if (victim.txIndex >= back.txIndex || (front.amount0 > 0n) === (back.amount0 > 0n)) continue;
      const input = front.amount0 < 0n ? -front.amount0 : -front.amount1;
      const output = front.amount0 < 0n ? back.amount0 : back.amount1;
      if (input <= 0n || output <= 0n || (output > input ? output - input : input - output) * 10n > input) continue;
      const [ftx, btx] = await Promise.all([tx(front.hash), tx(back.hash)]);
      const fromMatch = ftx.from.toLowerCase() === btx.from.toLowerCase();
      const toMatch = !!ftx.to && !!btx.to && ftx.to.toLowerCase() === btx.to.toLowerCase();
      if ((!fromMatch && !toMatch) || vtx.from.toLowerCase() === ftx.from.toLowerCase() || vtx.from.toLowerCase() === btx.from.toLowerCase()) continue;
      const move = front.pre ? (Number(front.sqrtPriceX96) / Number(front.pre)) ** 2 - 1 : null;
      // Unit-free: the victim's realized token1/token0 ratio against the pool's raw spot before the front-run (includes the pool fee and the victim's own price impact).
      let worse: number | null = null;
      if (front.pre && victim.amount0 !== 0n && victim.amount1 !== 0n) {
        const spot = (Number(front.pre) / 2 ** 96) ** 2;
        const realized = Math.abs(Number(victim.amount1)) / Math.abs(Number(victim.amount0));
        worse = victim.amount0 < 0n ? 1 - realized / spot : 1 - spot / realized;
      }
      return { kind: "sandwiched", block, poolId: victim.poolId, front: front.hash, back: back.hash, attacker: fromMatch ? ftx.from : (ftx.to as Hex), match: fromMatch ? "same sender" : "same contract", priceMovePct: move === null ? null : move * 100, stoppedByPin: move === null ? null : Math.abs(move) > BAND, filledWorsePct: worse === null ? null : worse * 100 };
    }
  }
  return { kind: "clean", block, poolId: victim.poolId };
}

/** Real victims from the 27-hour mainnet replay (packages/replay/out/sandwiches.jsonl), loss in USDT as measured there. */
export const EXAMPLES = [
  { hash: "0x0c7b1b22dff71b916c51e2cc832d4ce8c37b2c808c2b06bc210eafc7f4b59c50", label: "lost ≈ $415" },
  { hash: "0xc6405b682dbb93ae51719fb0266282a49e5959f091e5b43a49a77641ec5864f9", label: "lost ≈ $338" },
  { hash: "0x2404c6e9ded46d867827fb8d72adce5d6da694b6e8f58699b8c2f27d08669f83", label: "lost ≈ $132" },
];
