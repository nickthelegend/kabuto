import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Block, Hex, RawLog, Tx } from './types.js';

const DEFAULT_URLS = ['https://ethereum-rpc.publicnode.com', 'https://eth.llamarpc.com', 'https://rpc.ankr.com/eth', 'https://eth.drpc.org'];
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export class Rpc {
  private urls: string[];
  private active = 0;
  private serial = 0;
  constructor(readonly cacheDir: string, url = process.env.REPLAY_RPC) {
    this.urls = url ? [url] : DEFAULT_URLS;
  }
  get endpoint() { return this.urls[this.active]; }
  async call<T>(method: string, params: unknown[]): Promise<T> {
    let lastError: unknown;
    for (let endpoint = 0; endpoint < this.urls.length; endpoint++) {
      const index = (this.active + endpoint) % this.urls.length;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const response = await fetch(this.urls[index], {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: ++this.serial, method, params }),
            signal: AbortSignal.timeout(30_000)
          });
          if (response.status === 429 || response.status >= 500) throw new Error(`HTTP ${response.status}`);
          if (response.status === 401 || response.status === 403 || response.status === 525) throw new AccessError(`HTTP ${response.status}`);
          let data: { result?: T; error?: { code: number; message: string } };
          try { data = await response.json(); }
          catch { throw new AccessError(`${this.urls[index]} returned non-JSON HTTP ${response.status}`); }
          if (data.error) {
            const message = `RPC ${data.error.code}: ${data.error.message}`;
            if (/archive requests|unauthorized|authenticate|api key|personal token|keyless requests/i.test(message)) throw new AccessError(message);
            if (/range|block range|too many|limit|response size|more than/i.test(message)) throw new RangeError(message);
            throw new Error(message);
          }
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          if (data.result === undefined) throw new Error('RPC result missing');
          this.active = index;
          return data.result;
        } catch (error) {
          lastError = error;
          if (error instanceof RangeError) throw error;
          if (error instanceof AccessError) break;
          if (attempt < 2) await pause(Math.min(12_000, 500 * 2 ** attempt));
        }
      }
    }
    throw new Error(`${method} failed on all RPCs: ${String(lastError)}`);
  }
  private async cached<T>(file: string, load: () => Promise<T>): Promise<T> {
    try { return JSON.parse(await readFile(join(this.cacheDir, file), 'utf8')) as T; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const value = await load();
    await mkdir(this.cacheDir, { recursive: true });
    await writeFile(join(this.cacheDir, file), JSON.stringify(value));
    return value;
  }
  blockNumber() { return this.call<Hex>('eth_blockNumber', []).then(hex => Number(BigInt(hex))); }
  block(number: number) { return this.cached<Block>(`block-${number}.json`, () => this.call('eth_getBlockByNumber', [`0x${number.toString(16)}`, false])); }
  tx(hash: Hex) { return this.cached<Tx>(`tx-${hash.toLowerCase()}.json`, () => this.call('eth_getTransactionByHash', [hash])); }
  async logs(from: number, to: number, topic: Hex, id?: Hex): Promise<RawLog[]> {
    const key = `logs-${topic.slice(2, 10)}-${id?.slice(2) ?? 'all'}-${from}-${to}.json`;
    return this.cached(key, () => this.call<RawLog[]>('eth_getLogs', [{ address: '0x000000000004444c5dc75cB358380D2e3dE08A90', fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}`, topics: id ? [topic, id] : [topic] }]));
  }
  async *logChunks(from: number, to: number, topic: Hex, id?: Hex, startChunk = 1000): AsyncGenerator<RawLog[]> {
    let current = from;
    let chunk = startChunk;
    while (current <= to) {
      const end = Math.min(to, current + chunk - 1);
      try {
        yield await this.logs(current, end, topic, id);
        current = end + 1;
      } catch (error) {
        if (chunk === 1) throw error;
        chunk = Math.max(1, Math.floor(chunk / 2));
      }
    }
  }
}
class AccessError extends Error {}
