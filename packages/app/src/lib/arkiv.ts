/** Public, read-only Rabdi board. No writer key is bundled into the app. */
import { createPublicClient } from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { addr, bytes, defineSchema, key, str, u64 } from "@arkiv-network/sdk/schema";
import { and, eq, gt } from "@arkiv-network/sdk/query";
import { bytesToString, hexToBytes, http, isAddress, type Address } from "viem";
import type { SignedIntent } from "./intent";

const Intent = defineSchema("kabuto.intent.v1", {
  account: addr().indexed(), tokenIn: addr().indexed(), tokenOut: addr().indexed(),
  status: str().indexed(), deadline: u64().indexed(), chainId: u64().indexed(), intent: bytes(),
});
const Fill = defineSchema("kabuto.fill.v1", {
  intentKey: key().indexed(), filler: addr().indexed(), outcome: str().indexed(),
  txHash: str(), reason: str().optional(),
});
const client = createPublicClient({ chain: rabdi({ accessKey: "" }), transport: http() });
export const ARKIV_WRITER = import.meta.env.VITE_ARKIV_WRITER as Address | undefined;
export type BoardIntent = { entityKey: `0x${string}`; signed: SignedIntent; deadline: bigint };
export type BoardFill = { entityKey: `0x${string}`; outcome: string; txHash: string; reason?: string };

export async function readArkivBoard(): Promise<{ intents: BoardIntent[]; fills: BoardFill[] }> {
  if (!ARKIV_WRITER || !isAddress(ARKIV_WRITER)) throw new Error("Arkiv board: setup required");
  const now = BigInt(Math.floor(Date.now() / 1000));
  const writer = ARKIV_WRITER;
  const allIntents = async () => {
    const filter = and(eq("status", "open"), eq("chainId", u64(1337n)), gt("deadline", u64(now)));
    const fetchPage = (offset: number) => client.select().from(Intent).where(filter).ownedBy(writer).limit(100).offset(offset).fetch();
    const first = await fetchPage(0);
    const rows = [...first.entities];
    for (let offset = 100; rows.length === offset; offset += 100) rows.push(...(await fetchPage(offset)).entities);
    return rows;
  };
  const allFills = async () => {
    const first = await client.select().from(Fill).ownedBy(writer).limit(100).fetch();
    const rows = [...first.entities];
    for (let offset = 100; rows.length === offset; offset += 100) {
      const page = await client.select().from(Fill).ownedBy(writer).limit(100).offset(offset).fetch();
      rows.push(...page.entities);
    }
    return rows;
  };
  const [intentRows, fillRows] = await Promise.all([allIntents(), allFills()]);
  const intents = intentRows.map(row => {
    const x = JSON.parse(bytesToString(hexToBytes(row.intent.value)));
    const signed = { ...x, intent: { ...x.intent, maxIn: BigInt(x.intent.maxIn), startOut: BigInt(x.intent.startOut),
      endOut: BigInt(x.intent.endOut), startTime: BigInt(x.intent.startTime), deadline: BigInt(x.intent.deadline), nonce: BigInt(x.intent.nonce) } } as SignedIntent;
    return { entityKey: row.$key, signed, deadline: row.deadline.value };
  });
  const fills = fillRows.sort((a, b) => Number(b.$createdAt - a.$createdAt)).slice(0, 5).map(row => ({ entityKey: row.$key, outcome: row.outcome.value,
    txHash: row.txHash.value, reason: row.reason?.value }));
  return { intents, fills };
}
