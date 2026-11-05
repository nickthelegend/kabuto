import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { decodeEventLog, formatUnits, parseUnits, type Address, type Hex, type TransactionReceipt } from "viem";
import { account, balance, deployment, ensureAssets, ethrexRpc, gatewayRpc, pub, routerAbi, sleep, swapData, wallet, type Swap } from "./common.js";
import { chooseFront, simulateSwap, wethToKusd } from "./math.js";
import { eoaSwaps, frameSwaps, scanMempools } from "./watch.js";

const DATA = fileURLToPath(new URL("../data/attempts.jsonl", import.meta.url));
const PORT = 8787;
const HIGH_GAS = BigInt(process.env.BOT_HIGH_GAS_WEI ?? "50000000000");
const LOW_GAS = BigInt(process.env.BOT_LOW_GAS_WEI ?? "2000000");
const MAX_KUSD = parseUnits(process.env.BOT_MAX_KUSD ?? "1500", 6);
const MAX_WETH = parseUnits(process.env.BOT_MAX_WETH ?? "0.5", 18);
type Json = Record<string, unknown>;
const stringify = (v: unknown) => JSON.stringify(v, (_k, x) => typeof x === "bigint" ? x.toString() : x);
const clients = new Set<ServerResponse>();
const state = { watching: false, busy: false, lastError: "", lastScan: "", detected: 0 };
const seen = new Set<string>();
let cachedPool: Awaited<ReturnType<typeof pool>>;
let nextNonce = 0;

function push(event: string, data: Json) {
  const message = stringify({ type: event, ...data });
  for (const c of clients) c.write(`data: ${message}\n\n`);
}
function record(attempt: Json) {
  mkdirSync(fileURLToPath(new URL("../data/", import.meta.url)), { recursive: true });
  appendFileSync(DATA, `${stringify(attempt)}\n`);
  push("attempt", attempt);
}
function swappedOutput(receipt: TransactionReceipt, payer: Address): bigint | null {
  if (receipt.status !== "success") return null;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== deployment.router.toLowerCase()) continue;
    try {
      const e = decodeEventLog({ abi: routerAbi, data: log.data, topics: log.topics });
      if (e.eventName === "Swapped" && (e.args as unknown as { payer: Address }).payer.toLowerCase() === payer.toLowerCase()) return (e.args as unknown as { amountOut: bigint }).amountOut;
    } catch { /* unrelated router event */ }
  }
  return null;
}
async function pool(blockNumber?: bigint) {
  const opts = blockNumber === undefined ? {} : { blockNumber };
  const [slot, liquidity] = await Promise.all([
    pub.readContract({ address: deployment.predeploys.stateView, abi: [
      { type: "function", name: "getSlot0", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint160" }, { type: "int24" }, { type: "uint24" }, { type: "uint24" }] },
    ] as const, functionName: "getSlot0", args: [deployment.poolId], ...opts }),
    pub.readContract({ address: deployment.predeploys.stateView, abi: [
      { type: "function", name: "getLiquidity", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint128" }] },
    ] as const, functionName: "getLiquidity", args: [deployment.poolId], ...opts }),
  ]);
  return { sqrt: slot[0], liquidity };
}
async function frameStatus(hash: Hex): Promise<{ status: string; transaction?: Hex }> {
  try {
    const result = await gatewayRpc<unknown>("skandha_explorer_getTransaction", [hash]);
    if (result && typeof result === "object") {
      const record = result as { entry?: { status?: string; transaction?: Hex }; admission?: { outcome?: string } };
      const entry = record.entry;
      if (entry?.status) return { status: entry.status, transaction: entry.transaction };
      if (record.admission?.outcome) return { status: `Admission: ${record.admission.outcome}` };
    }
    return { status: "Unknown" };
  } catch (e) { return { status: `Unknown: ${e instanceof Error ? e.message : String(e)}` }; }
}
async function victimReceipt(v: Swap): Promise<{ receipt: TransactionReceipt | null; status: string }> {
  let cancelledSince: number | null = null;
  for (let i = 0; i < (v.kind === "frame" ? 180 : 60); i++) {
    const lifecycle = v.kind === "frame" ? await frameStatus(v.hash) : { status: "Pending" };
    const r = await pub.getTransactionReceipt({ hash: lifecycle.transaction ?? v.hash }).catch(() => null);
    if (r) return { receipt: r, status: v.kind === "frame" ? lifecycle.status : "OnChain" };
    if (v.kind === "frame") {
      if (lifecycle.status === "Cancelled") {
        cancelledSince ??= Date.now();
        if (Date.now() - cancelledSince >= 15_000) return { receipt: null, status: lifecycle.status };
      } else {
        cancelledSince = null;
        if (/Reverted|Admission: replaced/i.test(lifecycle.status)) return { receipt: null, status: lifecycle.status };
      }
    }
    await sleep(1000);
  }
  return { receipt: null, status: v.kind === "frame" ? (await frameStatus(v.hash)).status : "NotIncludedWithin60s" };
}
const loc = (r: TransactionReceipt | null) => r ? { hash: r.transactionHash, blockNumber: r.blockNumber.toString(), transactionIndex: r.transactionIndex, status: r.status } : null;

async function attack(v: Swap) {
  const bot = account("bot").address;
  const start = cachedPool;
  const inputToken = v.zeroForOne ? deployment.poolKey.currency0 : deployment.poolKey.currency1;
  const configuredCap = v.zeroForOne === deployment.wethIs0 ? MAX_WETH : MAX_KUSD;
  const available = await balance(inputToken, bot);
  const cap = available < configuredCap ? available : configuredCap;
  const size = v.pinned ? cap : chooseFront(start.sqrt, start.liquidity, v.zeroForOne, v.amountIn, v.minAmountOut, cap);
  if (size === 0n) { push("skipped", { victimHash: v.hash, reason: "slippage leaves no safe front-run" }); return; }
  const frontSim = simulateSwap(start.sqrt, start.liquidity, v.zeroForOne, size);
  // Ensure a small inventory buffer for arithmetic rounding before entering the nonce pair.
  // The back-run sells the predicted front output. The wallet has a pre-funded buffer of both assets.
  const backAmount = frontSim.amountOut;
  const nonce = nextNonce;
  nextNonce += v.pinned ? 1 : 2;
  const signer = account("bot");
  const frontRaw = await signer.signTransaction({ chainId: 1337, to: deployment.router, data: swapData(v.zeroForOne, size, 0n, bot), nonce, gas: 500_000n, gasPrice: HIGH_GAS, type: "legacy" });
  const backRaw = v.pinned ? null : await signer.signTransaction({ chainId: 1337, to: deployment.router, data: swapData(!v.zeroForOne, backAmount, 0n, bot), nonce: nonce + 1, gas: 500_000n, gasPrice: LOW_GAS, type: "legacy" });
  let frontHash: Hex;
  try { frontHash = await ethrexRpc<Hex>("eth_sendRawTransaction", [frontRaw]); }
  catch (e) {
    nextNonce = await pub.getTransactionCount({ address: bot, blockTag: "pending" });
    record({ timestamp: new Date().toISOString(), victimHash: v.hash, kind: v.kind, pinned: v.pinned, frontHash: null, backHash: null, error: `front-run submission failed: ${e instanceof Error ? e.message : String(e)}` });
    throw e;
  }
  let backHash: Hex | null = null;
  if (backRaw) {
    try {
      backHash = await ethrexRpc<Hex>("eth_sendRawTransaction", [backRaw]);
    } catch (e) {
      state.lastError = `back-run submission failed after ${frontHash}: ${e instanceof Error ? e.message : String(e)}`;
      record({ timestamp: new Date().toISOString(), victimHash: v.hash, kind: v.kind, pinned: v.pinned, frontHash, backHash: null, error: state.lastError });
      return;
    }
  }
  const [front, back, victim] = await Promise.all([
    pub.waitForTransactionReceipt({ hash: frontHash, timeout: 120_000 }).catch(() => null),
    backHash ? pub.waitForTransactionReceipt({ hash: backHash, timeout: 120_000 }).catch(() => null) : Promise.resolve(null),
    victimReceipt(v),
  ]);
  const valuationBlock = v.pinned && front ? front.blockNumber - 1n : back?.blockNumber ?? front?.blockNumber ?? await pub.getBlockNumber();
  const quoteBlock = (victim.receipt && victim.receipt.blockNumber < (front?.blockNumber ?? valuationBlock) ? victim.receipt.blockNumber : (front?.blockNumber ?? valuationBlock)) - 1n;
  const quotePool = await pool(quoteBlock);
  const quote = simulateSwap(quotePool.sqrt, quotePool.liquidity, v.zeroForOne, v.amountIn).amountOut;
  const endPool = await pool(valuationBlock);
  const frontOut = front ? swappedOutput(front, bot) : null;
  const backOut = back ? swappedOutput(back, bot) : null;
  const frontInputDelta = frontOut === null ? 0n : -size;
  const frontOutputDelta = frontOut ?? 0n;
  const backInputDelta = backOut === null ? 0n : -backAmount;
  const backOutputDelta = backOut ?? 0n;
  const deltaWeth = (v.zeroForOne === deployment.wethIs0 ? frontInputDelta + backOutputDelta : frontOutputDelta + backInputDelta);
  const deltaKusd = (v.zeroForOne === deployment.wethIs0 ? frontOutputDelta + backInputDelta : frontInputDelta + backOutputDelta);
  const tokenPnl = deltaKusd + wethToKusd(deltaWeth, endPool.sqrt, deployment.wethIs0);
  const gasCostWei = [front, back].reduce((n, r) => n + (r ? r.gasUsed * r.effectiveGasPrice : 0n), 0n);
  const pnl = tokenPnl - wethToKusd(gasCostWei, endPool.sqrt, deployment.wethIs0);
  const victimOut = victim.receipt ? swappedOutput(victim.receipt, v.sender) : null;
  const before = (a: TransactionReceipt | null, b: TransactionReceipt | null) => !!a && !!b && (a.blockNumber < b.blockNumber || a.blockNumber === b.blockNumber && a.transactionIndex < b.transactionIndex);
  const sandwichObserved = front?.status === "success" && victim.receipt?.status === "success" && back?.status === "success" && before(front, victim.receipt) && before(victim.receipt, back);
  const attempt = {
    timestamp: new Date().toISOString(), victimHash: v.hash, kind: v.kind, pinned: v.pinned,
    frontRunHash: frontHash, backRunHash: backHash,
    direction: v.zeroForOne ? "currency0To1" : "currency1To0", amountIn: v.amountIn.toString(), minAmountOut: v.minAmountOut.toString(),
    frontSize: size.toString(), plannedBackAmount: backHash ? backAmount.toString() : null, front: loc(front), victim: loc(victim.receipt), back: loc(back), victimStatus: victim.status,
    victimIncluded: victim.receipt !== null, sandwichObserved, victimRealizedOutput: victimOut?.toString() ?? null, noSandwichQuote: quote.toString(),
    victimLoss: victimOut === null ? null : (quote - victimOut).toString(),
    quoteMethod: "StateView slot0 and active full-range liquidity at block before earliest included victim/front transaction; v4 exact-input arithmetic",
    quoteBlock: quoteBlock.toString(),
    pnlKusdRaw: pnl.toString(), pnlKusd: formatUnits(pnl, 6),
    pnlType: v.pinned ? "open position marked at pre-front spot" : "included bot legs marked at post-back spot",
    positionOpen: v.pinned && frontOut !== null,
    valuationMethod: v.pinned
      ? "front receipt input/output and gas cost; unhedged WETH valued at the pool spot in the block before front-run, avoiding self-induced spot appreciation; kUSD has 6 decimals"
      : "router Swapped outputs and submitted inputs in the included bot receipts; WETH residual and receipt gas costs valued at StateView pool spot at valuationBlock; kUSD has 6 decimals",
    valuationBlock: valuationBlock.toString(),
    botBalanceChanges: { kusdRaw: deltaKusd.toString(), wethRaw: deltaWeth.toString(), ethRaw: (-gasCostWei).toString() },
    gasCostWei: gasCostWei.toString(),
    summary: sandwichObserved ? "Victim landed between bot legs" : v.pinned && victim.status === "Cancelled" ? "Price-pinned victim cancelled; bot holds front-run output" : v.pinned ? "Price-pinned victim outcome recorded; bot holds front-run output" : "Bot attempted swap; receipt order did not form a sandwich",
  };
  record(attempt);
  console.log(`${new Date().toISOString()} attempt ${v.hash}: front ${frontHash} ${front?.status ?? "missing"}, back ${backHash} ${back?.status ?? "missing"}, victim ${victim.status}, P&L ${attempt.pnlKusd} kUSD`);
}

export async function start(signal?: AbortSignal) {
  if (deployment.chainId !== 1337 || await pub.getChainId() !== 1337) throw new Error("Refusing to run outside devnet 1337");
  // Fail early on missing read-only RPCs.
  for (const pending of await scanMempools()) seen.add(pending.hash);
  cachedPool = await pool();
  await ensureAssets("bot", MAX_KUSD + parseUnits("100", 6), MAX_WETH + parseUnits("0.05", 18));
  nextNonce = await pub.getTransactionCount({ address: account("bot").address, blockTag: "pending" });
  const server = createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    if (req.method === "OPTIONS") { res.writeHead(204).end(); return; }
    if (req.url === "/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      res.write(": connected\n\n"); clients.add(res); req.on("close", () => clients.delete(res)); return;
    }
    if (req.url === "/attempts") {
      const lines = existsSync(DATA) ? readFileSync(DATA, "utf8").trim().split("\n").filter(Boolean) : [];
      res.writeHead(200, { "Content-Type": "application/json" }).end(`[${lines.slice(-50).reverse().join(",")}]`); return;
    }
    if (req.url === "/status") {
      const bot = account("bot").address;
      const [eth, weth, kusd] = await Promise.all([pub.getBalance({ address: bot }), balance(deployment.predeploys.weth, bot), balance(deployment.kusd, bot)]);
      res.writeHead(200, { "Content-Type": "application/json" }).end(stringify({ bot, balances: { eth: eth.toString(), weth: weth.toString(), kusd: kusd.toString() }, ...state })); return;
    }
    res.writeHead(404).end("Not found");
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(PORT, resolve); });
  console.log(`Bot ${account("bot").address} watching on :${PORT}`);
  state.watching = true;
  let running = true;
  const stop = () => { running = false; state.watching = false; server.close(); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  signal?.addEventListener("abort", stop, { once: true });
  const accept = (v: Swap) => {
    if (seen.has(v.hash) || v.sender.toLowerCase() === account("bot").address.toLowerCase() || v.kind === "frame" && !v.pinned) return;
    seen.add(v.hash); state.detected++;
    push("victim", { hash: v.hash, kind: v.kind, pinned: v.pinned, direction: v.zeroForOne, amountIn: v.amountIn.toString(), minAmountOut: v.minAmountOut.toString() });
    if (v.pinned) console.log(`price-pinned victim ${v.hash}`);
    if (state.busy) return;
    state.busy = true;
    void attack(v).catch(e => { state.lastError = e instanceof Error ? e.message : String(e); console.error("attack error:", state.lastError); }).finally(() => { state.busy = false; });
  };
  const loop = async (name: string, read: () => Promise<Swap[]>) => {
    while (running) {
      try { for (const v of await read()) accept(v); state.lastScan = new Date().toISOString(); }
      catch (e) { state.lastError = `${name}: ${e instanceof Error ? e.message : String(e)}`; console.error("watcher error:", state.lastError); }
      await sleep(150);
    }
  };
  await Promise.all([
    loop("ethrex", async () => eoaSwaps(await ethrexRpc("txpool_content"))),
    loop("gateway", async () => frameSwaps(await gatewayRpc("debug_bundler_dumpMempool"))),
    loop("pool", async () => { cachedPool = await pool(); return []; }),
  ]);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) start().catch(e => { console.error(e); process.exitCode = 1; });
