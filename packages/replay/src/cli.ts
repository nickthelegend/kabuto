import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DECIMALS, INITIALIZE_TOPIC, MANAGER, STABLES, SWAP_TOPIC, USDC, WETH } from './abi.js';
import { attachPreviousPrices, decodeInitialize, decodeSwap, detect } from './detector.js';
import { measure, price1Per0 } from './measure.js';
import { Rpc } from './rpc.js';
import type { Candidate, Hex, Pool, Swap } from './types.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
function flag(name: string, fallback: number) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = Number(args[index + 1]);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid ${name}`);
  return value;
}
const blocks = flag('--blocks', 50_000);
const band = flag('--band', 0.005);
const initLookback = flag('--init-lookback', 5_000);
const rpc = new Rpc(join(root, 'cache'));
const poolCache = new Map<string, Pool | null>();
async function decimalsFor(currency: Hex): Promise<number | undefined> {
  const address = currency.toLowerCase();
  if (DECIMALS[address] !== undefined) return DECIMALS[address];
  const file = join(root, 'cache', `decimals-${address}.json`);
  try { const value = JSON.parse(await readFile(file, 'utf8')) as number; DECIMALS[address] = value; return value; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  try {
    const result = await rpc.call<Hex>('eth_call', [{ to: address, data: '0x313ce567' }, 'latest']);
    const decimals = Number(BigInt(result));
    if (decimals < 0 || decimals > 36) return undefined;
    DECIMALS[address] = decimals;
    await writeFile(file, JSON.stringify(decimals));
    return decimals;
  } catch { return undefined; }
}
function summaries(rows: ReturnType<typeof measure>[], start: number, end: number, elapsedSeconds: number, timestamps: { start: number; end: number }, metadata: { fromBlock: number; toBlock: number; candidatePools: number; candidatePoolsFound: number; poolsNeededForPricing: number; poolsFoundForPricing: number }) {
  const known = (key: 'victimLossUsd' | 'attackerGrossProfitUsd') => rows.filter(r => r[key].value !== null);
  const total = (items: ReturnType<typeof measure>[], key: 'victimLossUsd' | 'attackerGrossProfitUsd') => items.reduce((sum, r) => sum + (r[key].value ?? 0), 0);
  const breakdown: Record<string, ReturnType<typeof summaryPool>> = {};
  function summaryPool(items: ReturnType<typeof measure>[]) {
    return { sandwiches: items.length, stopped: items.filter(r => r.stopped === true).length, evaluated: items.filter(r => r.stopped !== null).length,
      victimLossUsdKnown: total(items, 'victimLossUsd'), victimLossUsdKnownCount: known('victimLossUsd').filter(r => items.includes(r)).length,
      attackerGrossProfitUsdKnown: total(items, 'attackerGrossProfitUsd'), attackerGrossProfitUsdKnownCount: known('attackerGrossProfitUsd').filter(r => items.includes(r)).length };
  }
  for (const id of new Set(rows.map(r => r.poolId))) breakdown[id] = summaryPool(rows.filter(r => r.poolId === id));
  const stopped = rows.filter(r => r.stopped === true).length;
  const evaluated = rows.filter(r => r.stopped !== null).length;
  return {
    generatedAt: new Date().toISOString(), rpcEndpoint: rpc.endpoint, rpcEndpointNote: 'Configured endpoint for uncached requests; cached responses may have been fetched from other public endpoints in earlier runs', manager: MANAGER,
    window: { fromBlock: start, toBlock: end, fromTimestamp: timestamps.start, toTimestamp: timestamps.end, fromIso: new Date(timestamps.start * 1000).toISOString(), toIso: new Date(timestamps.end * 1000).toISOString(), blocksRequested: blocks, blocksScanned: end - start + 1 },
    elapsedSeconds, band, metadata, counts: { sandwiches: rows.length, stopped, evaluated, unknownStop: rows.length - evaluated, stoppedShare: evaluated ? stopped / evaluated : null, stoppedShareOfAll: rows.length ? stopped / rows.length : null },
    totals: { victimLossUsdKnown: total(rows, 'victimLossUsd'), victimLossUsdKnownCount: known('victimLossUsd').length, attackerGrossProfitUsdKnown: total(rows, 'attackerGrossProfitUsd'), attackerGrossProfitUsdKnownCount: known('attackerGrossProfitUsd').length, usdCoverage: rows.length ? known('victimLossUsd').length / rows.length : null,
      caveat: 'Known-USD sums are partial, use a 1 USD stablecoin peg, and include ordinary fee/price-impact effects. Gross attacker values omit gas, builder payments, hook deltas and other legs.' },
    perPool: breakdown,
    top10: [...rows].filter(r => r.priceMove !== null).sort((a, b) => Math.abs(b.priceMove ?? 0) - Math.abs(a.priceMove ?? 0)).slice(0, 10),
    top10Basis: 'Largest absolute front-run spot-price movement among candidates with a known pre-front price; USD pricing is not required',
    method: 'See METHOD.md'
  };
}

async function main() {
  const started = Date.now();
  await mkdir(join(root, 'cache'), { recursive: true });
  await mkdir(join(root, 'out'), { recursive: true });
  const end = args.includes('--to-block') ? flag('--to-block', 0) : await rpc.blockNumber();
  const start = Math.max(0, end - blocks + 1);
  console.log(`Scanning ${start}-${end} (${blocks} blocks) via ${rpc.endpoint}`);
  const candidates: Candidate[] = [];
  const lastPrices = new Map<string, bigint>();
  const candidateBlockSwaps = new Map<number, Swap[]>();
  let scanned = 0;
  for await (const chunk of rpc.logChunks(start, end, SWAP_TOPIC)) {
    const swaps = chunk.filter(log => !log.removed).map(decodeSwap);
    attachPreviousPrices(swaps, lastPrices);
    const detected = await detect(swaps, hash => rpc.tx(hash));
    candidates.push(...detected);
    for (const candidate of detected) candidateBlockSwaps.set(candidate.front.blockNumber, swaps.filter(s => s.blockNumber === candidate.front.blockNumber));
    scanned += swaps.length;
    if (scanned && scanned % 10000 < swaps.length) console.log(`Read ${scanned} swaps; ${candidates.length} candidate sandwiches`);
  }
  console.log(`Swaps ${scanned}; sandwiches ${candidates.length}; resolving pools`);
  const candidateIds = new Set(candidates.map(c => c.front.poolId));
  const neededIds = new Set<string>(candidateIds);
  // Inspect other pools in candidate blocks to locate a same-block WETH/USDC v4 price.
  for (const swaps of candidateBlockSwaps.values()) for (const s of swaps) neededIds.add(s.poolId);
  const metadataFrom = Math.max(0, start - initLookback);
  if (neededIds.size) for await (const chunk of rpc.logChunks(metadataFrom, end, INITIALIZE_TOPIC)) {
    for (const log of chunk) {
      const id = log.topics[1]?.toLowerCase();
      if (id && neededIds.has(id)) poolCache.set(id, decodeInitialize(log));
    }
  }
  for (const id of neededIds) if (!poolCache.has(id)) poolCache.set(id, null);
  for (const pool of poolCache.values()) if (pool) { await decimalsFor(pool.currency0); await decimalsFor(pool.currency1); }
  const rows: ReturnType<typeof measure>[] = [];
  for (const candidate of candidates) {
    let wethUsd: number | null = null;
    for (const swap of candidateBlockSwaps.get(candidate.front.blockNumber) ?? []) {
      const pool = poolCache.get(swap.poolId);
      if (!pool || ![pool.currency0, pool.currency1].includes(WETH) || ![pool.currency0, pool.currency1].includes(USDC)) continue;
      const d0 = DECIMALS[pool.currency0], d1 = DECIMALS[pool.currency1];
      const price = price1Per0(swap.sqrtPriceX96, d0, d1);
      wethUsd = pool.currency0 === WETH ? price : 1 / price;
      break;
    }
    rows.push(measure(candidate, poolCache.get(candidate.front.poolId) ?? null, DECIMALS, band, wethUsd));
  }
  const out = join(root, 'out');
  await writeFile(join(out, 'sandwiches.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''));
  const [firstBlock, lastBlock] = await Promise.all([rpc.block(start), rpc.block(end)]);
  const summary = summaries(rows, start, end, (Date.now() - started) / 1000, { start: Number(BigInt(firstBlock.timestamp)), end: Number(BigInt(lastBlock.timestamp)) }, { fromBlock: metadataFrom, toBlock: end, candidatePools: candidateIds.size, candidatePoolsFound: [...candidateIds].filter(id => poolCache.get(id)).length, poolsNeededForPricing: neededIds.size, poolsFoundForPricing: [...poolCache.values()].filter(Boolean).length });
  await writeFile(join(out, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify({ window: summary.window, counts: summary.counts, totals: summary.totals, elapsedSeconds: summary.elapsedSeconds }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
