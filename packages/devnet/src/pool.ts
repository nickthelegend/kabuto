import { encodeAbiParameters, keccak256, type Address } from "viem";

export type PoolKey = { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };

export const POOL_KEY_ABI = {
  type: "tuple",
  components: [
    { name: "currency0", type: "address" }, { name: "currency1", type: "address" },
    { name: "fee", type: "uint24" }, { name: "tickSpacing", type: "int24" }, { name: "hooks", type: "address" },
  ],
} as const;

export function poolKey(a: Address, b: Address, fee = 3000, tickSpacing = 60): PoolKey {
  const [c0, c1] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
  return { currency0: c0, currency1: c1, fee, tickSpacing, hooks: "0x0000000000000000000000000000000000000000" };
}

export const poolId = (k: PoolKey) => keccak256(encodeAbiParameters([POOL_KEY_ABI], [k]));

/** sqrt(price) * 2^96 where price = amount1 / amount0 in raw units. */
export function sqrtPriceX96(raw1PerRaw0: number): bigint {
  const s = Math.sqrt(raw1PerRaw0);
  // split to keep precision: s * 2^96 = (s * 2^48) * 2^48
  return BigInt(Math.floor(s * 2 ** 48)) * (1n << 48n);
}

/** Price band: current sqrt price +- bps of PRICE (sqrt moves half as much). */
export function band(sqrtP: bigint, priceBps: number): { min: bigint; max: bigint } {
  const d = (sqrtP * BigInt(Math.ceil(priceBps / 2))) / 10_000n;
  return { min: sqrtP - d, max: sqrtP + d };
}
