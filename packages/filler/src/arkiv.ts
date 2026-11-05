/** Rabdi is a public intent board. Settlement and signature checks remain on chain 1337. */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, ExpirationTime } from '@arkiv-network/sdk';
import { rabdi } from '@arkiv-network/sdk/chains';
import { addr, bytes, defineSchema, key, str, u64 } from '@arkiv-network/sdk/schema';
import { and, eq, gt } from '@arkiv-network/sdk/query';
import { bytesToString, hexToBytes, http, isHex, stringToBytes, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { SignedIntent } from '@kabuto/sdk';

export const Intent = defineSchema('kabuto.intent.v1', {
  account: addr().indexed(), tokenIn: addr().indexed(), tokenOut: addr().indexed(),
  status: str().indexed(), deadline: u64().indexed(), chainId: u64().indexed(), intent: bytes(),
});
export const Fill = defineSchema('kabuto.fill.v1', {
  intentKey: key().indexed(), filler: addr().indexed(), outcome: str().indexed(),
  txHash: str(), reason: str().optional(),
});
export const ARKIV_QUERY = "arkiv.schema = str('kabuto.intent.v1') AND status = str('open') AND chainId = u64(1337)";
const chain = () => rabdi({ accessKey: process.env.ARKIV_ACCESS_KEY ?? '' });
const reader = () => createPublicClient({ chain: chain(), transport: http() });
export function arkivWriter() {
  let privateKey = process.env.ARKIV_PRIVATE_KEY;
  if (!privateKey) {
    const file = process.env.KABUTO_KEYS_FILE ?? fileURLToPath(new URL('../../devnet/.devnet-keys.json', import.meta.url));
    privateKey = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { arkiv?: string }).arkiv : undefined;
  }
  if (!privateKey) return null;
  if (!isHex(privateKey) || privateKey.length !== 66) throw new Error('Invalid Arkiv writer key');
  return createWalletClient({ chain: chain(), transport: http(), account: privateKeyToAccount(privateKey as Hex) });
}
export function encodeIntent(signed: SignedIntent): Uint8Array {
  return stringToBytes(JSON.stringify(signed, (_k, v) => typeof v === 'bigint' ? v.toString() : v));
}
export function decodeIntent(data: Uint8Array): SignedIntent {
  const x = JSON.parse(bytesToString(data));
  return { ...x, intent: { ...x.intent, maxIn: BigInt(x.intent.maxIn), startOut: BigInt(x.intent.startOut),
    endOut: BigInt(x.intent.endOut), startTime: BigInt(x.intent.startTime), deadline: BigInt(x.intent.deadline), nonce: BigInt(x.intent.nonce) } };
}
export async function publishIntent(signed: SignedIntent, _intentId: string) {
  const writer = arkivWriter();
  if (!writer) throw new Error('Arkiv writer is not configured');
  const i = signed.intent;
  const { entityKey, txHash } = await writer.createEntity(Intent, {
    account: addr(signed.account), tokenIn: addr(i.tokenIn), tokenOut: addr(i.tokenOut),
    status: 'open', deadline: u64(i.deadline), chainId: u64(1337n), intent: encodeIntent(signed),
  }, { expiration: ExpirationTime.atDate(new Date(Number(i.deadline) * 1000)) });
  return { entityKey, txHash };
}
export async function publishFill(x: { intentKey: Hex; filler: Address; outcome: 'landed' | 'refused'; txHash?: Hex; reason?: string }) {
  const writer = arkivWriter();
  if (!writer) throw new Error('Arkiv writer is not configured');
  const encoder = new TextEncoder();
  let reason = '';
  for (const char of x.reason ?? '') { if (encoder.encode(reason + char).length > 128) break; reason += char; }
  return writer.createEntity(Fill, { intentKey: key(x.intentKey), filler: addr(x.filler), outcome: x.outcome,
    txHash: x.txHash ?? '', reason: x.reason === undefined ? undefined : reason }, { expiration: ExpirationTime.fromDays(30) });
}
export async function markIntent(entityKey: Hex, status: 'open' | 'filled' | 'refused' | 'cancelled') {
  const writer = arkivWriter();
  if (!writer) throw new Error('Arkiv writer is not configured');
  return writer.patchEntity(Intent, entityKey, { set: { status } });
}
export async function listOpenIntents(writer: Address) {
  const filter = and(eq('status', 'open'), eq('chainId', u64(1337n)), gt('deadline', u64(BigInt(Math.floor(Date.now() / 1000)))));
  const fetchPage = (offset: number) => reader().select().from(Intent).where(filter).ownedBy(writer).limit(100).offset(offset).fetch();
  const first = await fetchPage(0);
  const rows = [...first.entities];
  for (let offset = 100; rows.length === offset; offset += 100) rows.push(...(await fetchPage(offset)).entities);
  return rows.map(row => ({ entityKey: row.$key, owner: row.$owner, account: row.account.value,
    tokenIn: row.tokenIn.value, tokenOut: row.tokenOut.value, deadline: row.deadline.value,
    status: row.status.value, signedIntent: decodeIntent(hexToBytes(row.intent.value)) }));
}
export async function listFills(writer: Address, intentKey?: Hex) {
  const fetchPage = (offset: number) => {
    const base = reader().select().from(Fill);
    return (intentKey ? base.where(eq('intentKey', key(intentKey))) : base).ownedBy(writer).limit(100).offset(offset).fetch();
  };
  const first = await fetchPage(0);
  const rows = [...first.entities];
  for (let offset = 100; rows.length === offset; offset += 100) rows.push(...(await fetchPage(offset)).entities);
  return rows.map(row => ({ entityKey: row.$key, intentKey: row.intentKey.value, filler: row.filler.value,
    outcome: row.outcome.value, txHash: row.txHash.value, reason: row.reason?.value }));
}
export async function writerBalance(writer: Address) { return reader().getBalance({ address: writer }); }
