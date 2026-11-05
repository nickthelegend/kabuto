import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, decodeFunctionData, encodeFunctionData, erc20Abi, http, maxUint256, parseUnits, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { artifact } from "../../devnet/src/chain.js";
import { devnet } from "../../devnet/src/config.js";
import { key } from "../../devnet/src/keys.js";

export interface Deployment { chainId: number; gateway: string; ethrex: string; kusd: Address; router: Address; poolKey: { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address }; poolId: Hex; wethIs0: boolean; predeploys: { weth: Address; stateView: Address } }
export const deployment = JSON.parse(readFileSync(fileURLToPath(new URL("../../../deployments/1337.json", import.meta.url)), "utf8")) as Deployment;
export const routerAbi = artifact("KabutoRouter").abi;
export const tokenAbi = artifact("DevnetToken").abi;
export const wethAbi = [{ type: "function", name: "deposit", stateMutability: "payable", inputs: [], outputs: [] }] as const;
export const stateAbi = [
  { type: "function", name: "getSlot0", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint160" }, { type: "int24" }, { type: "uint24" }, { type: "uint24" }] },
  { type: "function", name: "getLiquidity", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint128" }] },
] as const;
export const pub = createPublicClient({ chain: devnet, transport: http(deployment.gateway) });
export const wallet = (role: "bot" | "victim") => createWalletClient({ chain: devnet, account: privateKeyToAccount(key(role)), transport: http(deployment.gateway) });
export const account = (role: "bot" | "victim") => privateKeyToAccount(key(role));
let rpcId = 0;
export async function rawRpc<T>(url: string, method: string, params: unknown[] = []): Promise<T> {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }), signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`);
  const body = await response.json() as { result?: T; error?: { message: string; code: number } };
  if (body.error) throw new Error(`${method}: ${body.error.message} (${body.error.code})`);
  if (body.result === undefined) throw new Error(`${method}: RPC result missing`);
  return body.result as T;
}
export const gatewayRpc = <T>(method: string, params: unknown[] = []) => rawRpc<T>(deployment.gateway, method, params);
export const ethrexRpc = <T>(method: string, params: unknown[] = []) => rawRpc<T>(deployment.ethrex, method, params);
export const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
export const swapData = (zeroForOne: boolean, amount: bigint, min: bigint, recipient: Address) => encodeFunctionData({ abi: routerAbi, functionName: "swapExactIn", args: [deployment.poolKey, zeroForOne, amount, min, recipient] });
export interface Swap { hash: Hex; sender: Address; zeroForOne: boolean; amountIn: bigint; minAmountOut: bigint; kind: "eoa" | "frame"; pinned: boolean }
export function decodeSwap(data: Hex, hash: Hex, sender: Address, kind: "eoa" | "frame", pinned = false): Swap | null {
  try {
    const decoded = decodeFunctionData({ abi: routerAbi, data });
    if (decoded.functionName !== "swapExactIn") return null;
    const [pool, zeroForOne, amountIn, minAmountOut] = decoded.args as unknown as [Deployment["poolKey"], boolean, bigint, bigint, Address];
    const k = deployment.poolKey;
    if (pool.currency0.toLowerCase() !== k.currency0.toLowerCase() || pool.currency1.toLowerCase() !== k.currency1.toLowerCase() || pool.fee !== k.fee || pool.tickSpacing !== k.tickSpacing || pool.hooks.toLowerCase() !== k.hooks.toLowerCase()) return null;
    return { hash, sender, zeroForOne, amountIn, minAmountOut, kind, pinned };
  } catch { return null; }
}
export const balance = (token: Address, who: Address) => pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [who] });
export async function ensureAssets(role: "bot" | "victim", kusdTarget: bigint, wethTarget: bigint) {
  const w = wallet(role), who = w.account.address;
  // Only ask the devnet faucet when gas money is genuinely low (front-runs cost ~0.00003 ETH at 0.2 gwei).
  if (await pub.getBalance({ address: who }) < parseUnits("0.01", 18)) {
    await gatewayRpc("skandha_explorer_faucet", [who]);
    for (let i = 0; i < 60 && await pub.getBalance({ address: who }) < parseUnits("0.01", 18); i++) await sleep(1000);
    if (await pub.getBalance({ address: who }) < parseUnits("0.01", 18)) throw new Error(`ETH faucet did not fund ${who}`);
  }
  let k = await balance(deployment.kusd, who);
  for (let i = 0; k < kusdTarget && i < 50; i++) {
    const h = await w.writeContract({ address: deployment.kusd, abi: tokenAbi, functionName: "faucet", args: [who], gasPrice: 2_000_000n, type: "legacy" });
    const r = await pub.waitForTransactionReceipt({ hash: h, timeout: 120_000 });
    if (r.status !== "success") throw new Error(`kUSD faucet reverted: ${h}`);
    k = await balance(deployment.kusd, who);
  }
  if (k < kusdTarget) throw new Error(`Could not mint enough kUSD for ${who}`);
  const weth = deployment.predeploys.weth;
  const wb = await balance(weth, who);
  if (wb < wethTarget) {
    const h = await w.writeContract({ address: weth, abi: wethAbi, functionName: "deposit", value: wethTarget - wb, gasPrice: 2_000_000n, type: "legacy" });
    const r = await pub.waitForTransactionReceipt({ hash: h, timeout: 120_000 });
    if (r.status !== "success") throw new Error(`WETH deposit reverted: ${h}`);
  }
  for (const token of [deployment.kusd, weth]) {
    const allowance = await pub.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [who, deployment.router] });
    if (allowance < maxUint256 / 2n) {
      const h = await w.writeContract({ address: token, abi: erc20Abi, functionName: "approve", args: [deployment.router, maxUint256], gasPrice: 2_000_000n, type: "legacy" });
      const r = await pub.waitForTransactionReceipt({ hash: h, timeout: 120_000 });
      if (r.status !== "success") throw new Error(`approval reverted: ${h}`);
    }
  }
}
