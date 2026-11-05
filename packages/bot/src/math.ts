/** Exact input v4 single active range swap arithmetic. This deployment has one full range position. */
export const Q96 = 1n << 96n;
const ceil = (n: bigint, d: bigint) => (n + d - 1n) / d;
export function simulateSwap(sqrtPriceX96: bigint, liquidity: bigint, zeroForOne: boolean, amountIn: bigint, feePips = 3000) {
  if (sqrtPriceX96 <= 0n || liquidity <= 0n || amountIn <= 0n) throw new Error("invalid pool state or swap amount");
  const net = amountIn * BigInt(1_000_000 - feePips) / 1_000_000n;
  const next = zeroForOne
    ? ceil(liquidity * Q96 * sqrtPriceX96, liquidity * Q96 + net * sqrtPriceX96)
    : sqrtPriceX96 + net * Q96 / liquidity;
  const lo = next < sqrtPriceX96 ? next : sqrtPriceX96;
  const hi = next > sqrtPriceX96 ? next : sqrtPriceX96;
  const amountOut = zeroForOne
    ? liquidity * (hi - lo) / Q96
    : liquidity * Q96 * (hi - lo) / hi / lo;
  return { amountOut, nextSqrtPriceX96: next };
}
export function chooseFront(sqrt: bigint, liquidity: bigint, direction: boolean, victimAmount: bigint, minOut: bigint, cap: bigint): bigint {
  if (cap <= 0n) return 0n;
  if (minOut === 0n) return cap;
  let lo = 0n, hi = cap;
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    const front = simulateSwap(sqrt, liquidity, direction, mid);
    const victim = simulateSwap(front.nextSqrtPriceX96, liquidity, direction, victimAmount);
    if (victim.amountOut >= minOut) lo = mid;
    else hi = mid - 1n;
  }
  // Leave room for a small amount of movement while transactions are in flight.
  return lo * 9n / 10n;
}
export function wethToKusd(weth: bigint, sqrt: bigint, wethIs0: boolean): bigint {
  return wethIs0 ? weth * sqrt * sqrt / Q96 / Q96 : weth * Q96 * Q96 / sqrt / sqrt;
}
