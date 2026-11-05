import { describe, expect, it } from 'vitest';
import { createPublicClient } from '@arkiv-network/sdk';
import { rabdi } from '@arkiv-network/sdk/chains';
import { http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { SignedIntent } from '@kabuto/sdk';
import { encodeIntent, decodeIntent, publishIntent, writerBalance } from '../src/arkiv.js';

const sample = (): SignedIntent => {
  const account = '0x1111111111111111111111111111111111111111' as const;
  const now = BigInt(Math.floor(Date.now() / 1000));
  return { account, owner: account, scheme: 'secp256k1', digest: `0x${'11'.repeat(32)}` as Hex,
    signature: `0x${'22'.repeat(65)}` as Hex,
    intent: { tokenIn: account, tokenOut: '0x2222222222222222222222222222222222222222', maxIn: 12345678901234567890n,
      startOut: 987654321n, endOut: 876543210n, startTime: now, deadline: now + 600n, nonce: 7n } };
};

describe('Arkiv intent bytes', () => {
  it('round-trips the signed intent with bigint fields', () => {
    const signed = sample();
    expect(decodeIntent(encodeIntent(signed))).toEqual(signed);
  });
});

describe('Rabdi live RPC', () => {
  it('reads entities with a raw query string', async () => {
    const client = createPublicClient({ chain: rabdi({ accessKey: process.env.ARKIV_ACCESS_KEY ?? '' }), transport: http() });
    const page = await client.query('EXISTS(arkiv.schema)', { select: { $key: true }, limit: 3 });
    expect(Array.isArray(page.entities)).toBe(true);
  });
});

const privateKey = process.env.ARKIV_PRIVATE_KEY as Hex | undefined;
const address = privateKey ? privateKeyToAccount(privateKey).address : '0x8eD225Ae7f4b445Bfee6ad5dd9719C59426Af3aF';
const balance = privateKey ? await writerBalance(address).catch(() => 0n) : 0n;
const write = privateKey && balance > 0n ? it : it.skip;
write(`writes and reads an intent on Rabdi (fund ${address} to enable)`, async () => {
  const result = await publishIntent(sample(), 'arkiv-live-test');
  expect(result.entityKey).toMatch(/^0x[0-9a-fA-F]{64}$/);
  expect(result.txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
  const client = createPublicClient({ chain: rabdi({ accessKey: process.env.ARKIV_ACCESS_KEY ?? '' }), transport: http() });
  const entity = await client.getEntity(result.entityKey);
  expect(entity.$key).toBe(result.entityKey);
});
