import { bytesToHex, hexToBytes, type Address, type Hex } from "viem";
import { p256 } from "@noble/curves/p256";
import { D, RELAY_URL } from "./config";
import { pub } from "./chain";
import { accountArtifact } from "./abi";
import { quote, tokenIn, tokenOut, type Side } from "./market";
import type { Saved } from "./wallet";

export type Intent = { tokenIn: Address; maxIn: bigint; tokenOut: Address; startOut: bigint; endOut: bigint; startTime: bigint; deadline: bigint; nonce: bigint };
export type SignedIntent = { intent: Intent; digest: Hex; signature: Hex; account: Address; owner: Address; scheme: "p256" };

const pad = (n: bigint) => n.toString(16).padStart(64, "0");
const json = (x: unknown) => JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v));

/**
 * Signs an open intent with the account's P256 owner key. Nothing is sent on chain and no gas is paid: the signature is
 * over the intent digest only (EIP-8141 explicit `msg`). The minimum output decays from quote - startBps to
 * quote - endBps over `windowSec`, a Dutch auction the account enforces in its settle frame.
 */
export async function signIntent(w: Saved, side: Side, amountIn: bigint, o: { startBps: number; endBps: number; windowSec: number }): Promise<{ signed: SignedIntent; quoted: bigint }> {
  const acct = w.account!;
  const [q, nonce, block] = await Promise.all([quote(side, amountIn), pub.getTransactionCount({ address: acct }), pub.getBlock()]);
  const intent: Intent = {
    tokenIn: tokenIn(side).address, maxIn: amountIn, tokenOut: tokenOut(side).address,
    startOut: (q * BigInt(10_000 - o.startBps)) / 10_000n, endOut: (q * BigInt(10_000 - o.endBps)) / 10_000n,
    startTime: block.timestamp, deadline: block.timestamp + BigInt(o.windowSec), nonce: BigInt(nonce),
  };
  let digest: Hex;
  try {
    digest = (await pub.readContract({ address: acct, abi: accountArtifact.abi, functionName: "intentDigest", args: [intent] })) as Hex;
  } catch {
    throw new Error("This Kabuto account predates open intents. Reset it (account card → reset) to create a new one.");
  }
  const sig = p256.sign(hexToBytes(digest), hexToBytes(w.ownerKey), { lowS: true, prehash: false });
  const pubk = p256.getPublicKey(hexToBytes(w.ownerKey), false);
  const signature = `0x${pad(sig.r)}${pad(sig.s)}${bytesToHex(pubk.slice(1)).slice(2)}` as Hex;
  return { signed: { intent, digest, signature, account: acct, owner: w.owner, scheme: "p256" }, quoted: q };
}

export async function postIntent(signed: SignedIntent): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${RELAY_URL}/intents`, { method: "POST", headers: { "content-type": "application/json" }, body: json({ signedIntent: signed }) });
  } catch {
    throw new Error(`The intent relay is offline (${RELAY_URL}). Start it with: pnpm --dir packages/filler relay`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Relay refused the intent (HTTP ${res.status})`);
  return body.intentId as string;
}

export type RelayEvent = { type: string; intentId?: string; hash?: Hex; reason?: string; time: number; [k: string]: unknown };
export const relayEvents = () => new EventSource(`${RELAY_URL}/events`);
export const intentDeployment = D;
