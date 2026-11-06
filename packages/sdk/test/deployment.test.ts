// Offline checks that the published deployment and SDK constants match what README.md claims.
// No RPC: everything here is derived from deployments/1337.json and the SDK source.
import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, keccak256, type Address } from 'viem';
import { devnet1337, MAX_VERIFY_GAS, SIGNATURE_GAS, FILLER_PAY_GAS, intentVerifyBudget } from '../src/index.js';

type Key = { currency0: string; currency1: string; fee: number; tickSpacing: number; hooks: string };
const poolId = (k: Key) => keccak256(encodeAbiParameters(
  [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
  [k.currency0 as Address, k.currency1 as Address, k.fee, k.tickSpacing, k.hooks as Address],
));
const ALL_HOOK_FLAGS = (1n << 14n) - 1n;
const BEFORE_SWAP_FLAG = 1n << 7n;

describe('deployments/1337.json matches the README', () => {
  it('poolId is the v4 PoolId of the WETH/kUSD 0.3% pool (tick spacing 60, no hook)', () => {
    const k = devnet1337.poolKey;
    expect(BigInt(k.currency0)).toBeLessThan(BigInt(k.currency1));
    expect([k.fee, k.tickSpacing, BigInt(k.hooks)]).toEqual([3000, 60, 0n]);
    expect(k.currency0.toLowerCase()).toBe(devnet1337.predeploys.weth.toLowerCase());
    expect(k.currency1.toLowerCase()).toBe(devnet1337.kusd.toLowerCase());
    expect(poolId(k)).toBe(devnet1337.poolId);
  });

  it('the guarded pool uses the KabutoGuard hook and its PoolId matches', () => {
    const g = devnet1337.guardPoolKey;
    expect(g.hooks).toBe(devnet1337.guardHook);
    expect(g.hooks).toBe('0x9A485379e6307A12cF380D9F783296Aa1E570080');
    expect(poolId(g)).toBe(devnet1337.guardPoolId);
    expect(devnet1337.guardPoolId).toBe('0x4869421e2f2f11bcdecdf1168a5b6183eb00c123cc1d5181b8712af074b91725');
  });

  it('the hook address encodes BEFORE_SWAP and no other v4 permission', () => {
    expect(BigInt(devnet1337.guardHook) & ALL_HOOK_FLAGS).toBe(BEFORE_SWAP_FLAG);
  });

  it('uses the predeployed v4 addresses the README lists', () => {
    expect(devnet1337.predeploys.poolManager).toBe('0x6bF9Aa9c04fd001385742d61f6818C3236429848');
    expect(devnet1337.predeploys.stateView).toBe('0xd89a052862AaA34f0B6cc7f3B6a9D080584a43FB');
    expect(devnet1337.paymaster.toLowerCase()).toBe('0x2b594f5939149537673d7d8f797186e9a27afdf9');
  });
});

describe('validation-gas budget matches the README', () => {
  it('caps VERIFY gas at 100k with 2,800 per secp256k1 and 6,700 per P256 signature', () => {
    expect(MAX_VERIFY_GAS).toBe(100_000n);
    expect(SIGNATURE_GAS).toEqual({ secp256k1: 2_800n, p256: 6_700n });
  });

  it('leaves verifyIntent the remainder after the filler pay() frame and both signatures', () => {
    expect(intentVerifyBudget('p256')).toBe(100_000n - 6_700n - 2_800n - FILLER_PAY_GAS);
    expect(intentVerifyBudget('secp256k1')).toBe(100_000n - 2_800n - 2_800n - FILLER_PAY_GAS);
    expect(intentVerifyBudget('p256') + FILLER_PAY_GAS + SIGNATURE_GAS.p256 + SIGNATURE_GAS.secp256k1).toBeLessThanOrEqual(MAX_VERIFY_GAS);
  });
});
