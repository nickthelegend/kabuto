import { decodeEventLog } from 'viem';
import { INITIALIZE, SWAP } from './abi.js';
import type { Candidate, Hex, Pool, RawLog, Swap, Tx } from './types.js';

const number = (hex: Hex) => Number(BigInt(hex));
export function decodeSwap(log: RawLog): Swap {
  const { args } = decodeEventLog({ abi: [SWAP], data: log.data, topics: log.topics as [Hex, ...Hex[]] });
  const a = args as { id: Hex; sender: Hex; amount0: bigint; amount1: bigint; sqrtPriceX96: bigint; liquidity: bigint; tick: number; fee: number };
  return { poolId: a.id.toLowerCase() as Hex, sender: a.sender, amount0: a.amount0, amount1: a.amount1, sqrtPriceX96: a.sqrtPriceX96, liquidity: a.liquidity, tick: a.tick, fee: a.fee, blockNumber: number(log.blockNumber), transactionIndex: number(log.transactionIndex), logIndex: number(log.logIndex), transactionHash: log.transactionHash, prePriceX96: null };
}
export function decodeInitialize(log: RawLog): Pool {
  const { args } = decodeEventLog({ abi: [INITIALIZE], data: log.data, topics: log.topics as [Hex, ...Hex[]] });
  const a = args as { id: Hex; currency0: Hex; currency1: Hex; fee: number; hooks: Hex; tickSpacing: number };
  return { id: a.id.toLowerCase() as Hex, currency0: a.currency0.toLowerCase() as Hex, currency1: a.currency1.toLowerCase() as Hex, fee: a.fee, hooks: a.hooks.toLowerCase() as Hex, tickSpacing: a.tickSpacing, initializeBlock: number(log.blockNumber) };
}
export function attachPreviousPrices(swaps: Swap[], previous: Map<string, bigint>): void {
  swaps.sort((a, b) => a.blockNumber - b.blockNumber || a.transactionIndex - b.transactionIndex || a.logIndex - b.logIndex);
  for (const swap of swaps) {
    swap.prePriceX96 = previous.get(swap.poolId) ?? null;
    previous.set(swap.poolId, swap.sqrtPriceX96);
  }
}
export function possibleTriples(swaps: Swap[]): [Swap, Swap, Swap][] {
  const result: [Swap, Swap, Swap][] = [];
  for (let i = 0; i < swaps.length; i++) for (let j = i + 1; j < swaps.length; j++) {
    const front = swaps[i], victim = swaps[j];
    if (front.transactionIndex >= victim.transactionIndex || front.amount0 === 0n || victim.amount0 === 0n || (front.amount0 > 0n) !== (victim.amount0 > 0n)) continue;
    for (let k = j + 1; k < swaps.length; k++) {
      const back = swaps[k];
      if (victim.transactionIndex >= back.transactionIndex || (front.amount0 > 0n) === (back.amount0 > 0n)) continue;
      const input = front.amount0 < 0n ? -front.amount0 : -front.amount1;
      const output = front.amount0 < 0n ? back.amount0 : back.amount1;
      if (input <= 0n || output <= 0n || (output > input ? output - input : input - output) * 10n > input) continue;
      result.push([front, victim, back]);
    }
  }
  return result;
}
export async function detect(swaps: Swap[], tx: (hash: Hex) => Promise<Tx>): Promise<Candidate[]> {
  const byBlockPool = new Map<string, Swap[]>();
  for (const swap of swaps) {
    const key = `${swap.blockNumber}:${swap.poolId}`;
    const list = byBlockPool.get(key) ?? [];
    list.push(swap);
    byBlockPool.set(key, list);
  }
  const triples = [...byBlockPool.values()].flatMap(group => possibleTriples(group));
  const hashes = [...new Set(triples.flatMap(triple => triple.map(s => s.transactionHash)))];
  const txs = new Map<string, Tx>();
  for (let i = 0; i < hashes.length; i += 8) {
    const batch = hashes.slice(i, i + 8);
    const values = await Promise.all(batch.map(hash => tx(hash)));
    batch.forEach((hash, index) => txs.set(hash, values[index]));
  }
  const results: Candidate[] = [];
  const seen = new Set<string>();
  for (const [front, victim, back] of triples) {
    const frontTx = txs.get(front.transactionHash)!, victimTx = txs.get(victim.transactionHash)!, backTx = txs.get(back.transactionHash)!;
    const fromMatch = frontTx.from.toLowerCase() === backTx.from.toLowerCase();
    const toMatch = frontTx.to !== null && backTx.to !== null && frontTx.to.toLowerCase() === backTx.to.toLowerCase();
    if ((!fromMatch && !toMatch) || victimTx.from.toLowerCase() === frontTx.from.toLowerCase() || victimTx.from.toLowerCase() === backTx.from.toLowerCase()) continue;
    const key = [front.transactionHash, victim.transactionHash, back.transactionHash, front.logIndex, victim.logIndex, back.logIndex].join(':');
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({ front, victim, back, frontTx, victimTx, backTx, attackerMatch: fromMatch ? 'from' : 'to' });
  }
  return results;
}
