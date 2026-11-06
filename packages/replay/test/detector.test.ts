import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SWAP_TOPIC } from '../src/abi.js';
import { attachPreviousPrices, decodeSwap, detect } from '../src/detector.js';
import { Rpc } from '../src/rpc.js';
import type { RawLog, Tx } from '../src/types.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = JSON.parse(readFileSync(join(root, 'test/fixtures/mainnet-26299987.json'), 'utf8')) as { blockNumber: number; logs: RawLog[]; txs: Tx[]; source: string };
const expected = {
  front: '0xe8dcb5b0efe9884861d21443d746fd207ab548c6a9d8254d13defce2015b048c',
  victim: '0x2c3d2f3f51dc4248a285fe13f9534c72f542385a9613aa221435caf9e5570485',
  back: '0x9e329549f88b98322afbab467917d647a007513912896b02bd6f97d88a153204',
};
const triples = async (logs: RawLog[], txs: Map<string, Tx>) => {
  const swaps = logs.map(decodeSwap);
  attachPreviousPrices(swaps, new Map());
  return detect(swaps, async hash => {
    const tx = txs.get(hash.toLowerCase());
    if (!tx) throw new Error(`Fixture is missing actual mainnet transaction ${hash}`);
    return tx;
  });
};

describe('mainnet v4 detector', () => {
  it('finds the A-V-A sequence in captured eth_getLogs and transaction responses', async () => {
    expect(fixture.source).toBe('eth_getLogs + eth_getTransactionByHash');
    const txs = new Map(fixture.txs.map(tx => [tx.hash.toLowerCase(), tx]));
    const candidates = await triples(fixture.logs, txs);
    expect(candidates).toHaveLength(1);
    const candidate = candidates[0];
    expect({ front: candidate.front.transactionHash, victim: candidate.victim.transactionHash, back: candidate.back.transactionHash }).toEqual(expected);
    expect(candidate.front.transactionIndex).toBeLessThan(candidate.victim.transactionIndex);
    expect(candidate.victim.transactionIndex).toBeLessThan(candidate.back.transactionIndex);
    expect(candidate.frontTx.from.toLowerCase()).toBe(candidate.backTx.from.toLowerCase());
    expect(candidate.victimTx.from.toLowerCase()).not.toBe(candidate.frontTx.from.toLowerCase());
  });

  it('fetches that block from public mainnet RPC and reproduces the candidate', async () => {
    await mkdir(join(root, 'cache'), { recursive: true }); // cache/ is git-ignored, so a clean checkout lacks it
    const cache = await mkdtemp(join(root, 'cache', 'live-test-'));
    try {
      const rpc = new Rpc(cache);
      const logs = await rpc.logs(fixture.blockNumber, fixture.blockNumber, SWAP_TOPIC);
      expect(logs.map(log => log.transactionHash)).toEqual(fixture.logs.map(log => log.transactionHash));
      const txs = new Map<string, Tx>();
      for (const hash of new Set(logs.map(log => log.transactionHash))) txs.set(hash.toLowerCase(), await rpc.tx(hash));
      const candidates = await triples(logs, txs);
      expect(candidates.map(candidate => [candidate.front.transactionHash, candidate.victim.transactionHash, candidate.back.transactionHash])).toContainEqual([expected.front, expected.victim, expected.back]);
    } finally { await rm(cache, { recursive: true, force: true }); }
  }, 120_000);
});
