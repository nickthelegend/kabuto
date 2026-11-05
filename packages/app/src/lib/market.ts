import { erc20Abi, formatUnits, type Address } from "viem";
import { D, QUOTER } from "./config";
import { pub } from "./chain";
import { quoterAbi, stateViewAbi } from "./abi";

export type Side = "buy" | "sell"; // buy WETH with kUSD, sell WETH for kUSD
export const TOKENS = {
  kUSD: { address: D.kusd, decimals: 6, symbol: "kUSD" },
  WETH: { address: D.predeploys.weth, decimals: 18, symbol: "WETH" },
} as const;

export const zeroForOneFor = (side: Side) => (side === "buy" ? !D.wethIs0 : D.wethIs0); // input currency is currency0?
export const tokenIn = (side: Side) => (side === "buy" ? TOKENS.kUSD : TOKENS.WETH);
export const tokenOut = (side: Side) => (side === "buy" ? TOKENS.WETH : TOKENS.kUSD);

export async function sqrtPrice(): Promise<bigint> {
  const [p] = await pub.readContract({ address: D.predeploys.stateView, abi: stateViewAbi, functionName: "getSlot0", args: [D.poolId] });
  return p;
}

/** kUSD per WETH from sqrtPriceX96. */
export function priceFromSqrt(sqrtP: bigint): number {
  const s = Number(sqrtP) / 2 ** 96;
  const raw1per0 = s * s;
  return D.wethIs0 ? raw1per0 * 1e12 : 1 / (raw1per0 * 1e12);
}

export async function quote(side: Side, amountIn: bigint): Promise<bigint> {
  const { result } = await pub.simulateContract({
    address: QUOTER, abi: quoterAbi, functionName: "quoteExactInputSingle",
    args: [{ poolKey: D.poolKey, zeroForOne: zeroForOneFor(side), exactAmount: amountIn, hookData: "0x" }],
  });
  return result[0];
}

export async function balances(addr: Address) {
  const [eth, kusd, weth] = await Promise.all([
    pub.getBalance({ address: addr }),
    pub.readContract({ address: D.kusd, abi: erc20Abi, functionName: "balanceOf", args: [addr] }),
    pub.readContract({ address: D.predeploys.weth, abi: erc20Abi, functionName: "balanceOf", args: [addr] }),
  ]);
  return { eth, kusd, weth };
}

export const fmt = (v: bigint, decimals: number, dp = 4) => {
  const n = Number(formatUnits(v, decimals));
  return n.toLocaleString("en-US", { maximumFractionDigits: dp, minimumFractionDigits: Math.min(2, dp) });
};

/** Band in sqrt-price space for a +-bps band in price space. */
export function bandFor(sqrtP: bigint, priceBps: number) {
  const d = (sqrtP * BigInt(Math.max(1, Math.ceil(priceBps / 2)))) / 10_000n;
  return { min: sqrtP - d, max: sqrtP + d };
}
