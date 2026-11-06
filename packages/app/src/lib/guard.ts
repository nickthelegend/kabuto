/**
 * KabutoGuard pool (Uniswap v4 hook that only admits price-pinned frame transactions).
 *
 * The v4 Quoter can't price this pool: it simulates a plain call, and the hook refuses every plain call with
 * NotFrameTx(). So the app prices it from the pool's own on-chain state (slot0 + active liquidity) with the same
 * integer math as v4's SwapMath for one full-range position, which is how the pool was seeded (packages/devnet/src/guard.ts).
 * The swap's own minOut floor still applies on chain, so a rounding difference can only make a swap revert, never underpay.
 */
import { toFunctionSelector, type Address, type Hex } from "viem";
import { D } from "./config";
import { pub } from "./chain";
import { stateViewAbi } from "./abi";
import { bandFor, quote, zeroForOneFor, type Side } from "./market";

type PoolKey = { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };
const G = D as typeof D & { guardHook?: Address; guardPoolKey?: PoolKey; guardPoolId?: Hex };

export type Route = "main" | "guard";
export const GUARD = G.guardHook && G.guardPoolKey && G.guardPoolId ? { hook: G.guardHook, key: G.guardPoolKey, id: G.guardPoolId } : null;
export const poolKeyFor = (r: Route) => (r === "guard" && GUARD ? GUARD.key : D.poolKey);
export const poolIdFor = (r: Route) => (r === "guard" && GUARD ? GUARD.id : D.poolId);

/** Hook errors as they appear inside v4's WrappedError revert data. */
export const GUARD_ERRORS = ["NotFrameTx", "NoPricePin", "BandTooWide"].map((n) => ({ name: n, sel: toFunctionSelector(`${n}()`).slice(2) }));
export const guardErrorIn = (data?: string) => (data ? GUARD_ERRORS.find((e) => data.toLowerCase().includes(e.sel))?.name : undefined);

const hookAbi = [{ type: "function", name: "MAX_BAND_BPS", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] }] as const;
let maxBand: Promise<number> | null = null;
/** The hook's own band cap, read from the contract (immutable, so cached). */
export const guardMaxBandBps = () => (maxBand ??= GUARD ? pub.readContract({ address: GUARD.hook, abi: hookAbi, functionName: "MAX_BAND_BPS" }).then(Number) : Promise.reject(new Error("KabutoGuard is not deployed in deployments/1337.json")));

export type PoolState = { sqrtP: bigint; liquidity: bigint };
export async function poolState(r: Route): Promise<PoolState> {
  const id = poolIdFor(r);
  const [[sqrtP], liquidity] = await Promise.all([
    pub.readContract({ address: D.predeploys.stateView, abi: stateViewAbi, functionName: "getSlot0", args: [id] }),
    pub.readContract({ address: D.predeploys.stateView, abi: stateViewAbi, functionName: "getLiquidity", args: [id] }),
  ]);
  return { sqrtP, liquidity };
}

const Q96 = 1n << 96n;
const divUp = (a: bigint, b: bigint) => (a + b - 1n) / b;

/** v4 exact-input swap step inside one liquidity range (SwapMath.computeSwapStep without crossing a tick). */
export function localQuote(s: PoolState, fee: number, side: Side, amountIn: bigint): bigint {
  const { sqrtP, liquidity: L } = s;
  if (L === 0n || amountIn <= 0n) return 0n;
  const less = (amountIn * BigInt(1_000_000 - fee)) / 1_000_000n;
  if (zeroForOneFor(side)) {
    // getNextSqrtPriceFromAmount0RoundingUp(add) then getAmount1Delta(roundDown)
    const n1 = L << 96n;
    const next = divUp(n1 * sqrtP, n1 + less * sqrtP);
    return (L * (sqrtP - next)) / Q96;
  }
  // getNextSqrtPriceFromAmount1RoundingDown(add) then getAmount0Delta(roundDown)
  const next = sqrtP + (less << 96n) / L;
  return ((L << 96n) * (next - sqrtP)) / next / sqrtP;
}

/** Same check as KabutoGuardHook.beforeSwap: (maxSqrt/minSqrt)^2 must stay within 1 + MAX_BAND_BPS. */
export function bandWithinGuard(sqrtP: bigint, bandBps: number, maxBandBps: number) {
  const { min, max } = bandFor(sqrtP, bandBps);
  if (min === 0n || max < min || max >= min * 2n) return false;
  const highest = divUp(max * max, min);
  return highest <= min + (min * BigInt(maxBandBps)) / 10_000n;
}

/** Quote on either pool: the v4 Quoter for the plain pool, on-chain state + v4 math for the guarded one. */
export async function quoteOn(r: Route, side: Side, amountIn: bigint): Promise<bigint> {
  if (r === "main" || !GUARD) return quote(side, amountIn);
  return localQuote(await poolState("guard"), GUARD.key.fee, side, amountIn);
}
