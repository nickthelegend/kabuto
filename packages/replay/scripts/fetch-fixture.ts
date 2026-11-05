import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SWAP_TOPIC } from '../src/abi.js';
import { decodeSwap } from '../src/detector.js';
import { Rpc } from '../src/rpc.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const from = Number(process.argv[2]);
const to = Number(process.argv[3] ?? from + 99);
if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to - from > 999) throw new Error('Usage: pnpm fixture <fromBlock> [toBlock], up to 1000 blocks');
const rpc = new Rpc(join(root, 'cache'));
const logs = await rpc.logs(from, to, SWAP_TOPIC);
const swaps = logs.map(decodeSwap);
const byBlock = new Map<number, typeof swaps>();
for (const swap of swaps) byBlock.set(swap.blockNumber, [...(byBlock.get(swap.blockNumber) ?? []), swap]);
const chosen = [...byBlock.entries()].sort((a, b) => {
  const maxPool = (list: typeof swaps) => Math.max(0, ...[...new Set(list.map(x => x.poolId))].map(id => list.filter(x => x.poolId === id).length));
  return maxPool(b[1]) - maxPool(a[1]);
})[0];
if (!chosen) throw new Error('No swaps in requested range');
const selected = logs.filter(log => Number(BigInt(log.blockNumber)) === chosen[0]);
const hashes = [...new Set(selected.map(log => log.transactionHash))];
const txs = await Promise.all(hashes.map(hash => rpc.tx(hash)));
const fixture = { source: 'eth_getLogs + eth_getTransactionByHash', rpcEndpoint: rpc.endpoint, fetchedAt: new Date().toISOString(), requestedRange: { from, to }, blockNumber: chosen[0], logs: selected, txs };
await mkdir(join(root, 'test', 'fixtures'), { recursive: true });
const file = join(root, 'test', 'fixtures', `mainnet-${chosen[0]}.json`);
await writeFile(file, JSON.stringify(fixture, null, 2) + '\n');
console.log(file);
