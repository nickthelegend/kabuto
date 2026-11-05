import { bytesToHex, hexToBytes, keccak256, type Address, type Hex } from "viem";
import { p256 } from "@noble/curves/p256";
import { profile } from "@forshtat/hegota-support/profiles/ethrex-eip8141-tracer";
import { frame, newTx, sigHash, txHash } from "@forshtat/hegota-support/tx";
import { toWire } from "@forshtat/hegota-support/rpc";
import { FRAME_MAX_FEE } from "./config";
import { rpc } from "./rpc";

export type FrameTx = ReturnType<typeof newTx>;
type Frame = ReturnType<typeof frame>;
export const ATOMIC = 0x4;

export const verifyFrame = (data: Hex, execution = 90_000n, scope: "EXECUTION_AND_PAYMENT" | "EXECUTION" = "EXECUTION_AND_PAYMENT", target: Address | null = null) =>
  frame(profile, "VERIFY", { scope, target, execution, data });
export const payerFrame = (paymaster: Address, data: Hex = "0x", execution = 60_000n) =>
  frame(profile, "VERIFY", { scope: "PAYMENT", target: paymaster, execution, data });
export const senderFrame = (target: Address, data: Hex, o: { execution?: bigint; state?: bigint; value?: bigint; atomic?: boolean } = {}) =>
  frame(profile, "SENDER", { target, data, execution: o.execution ?? 300_000n, state: o.state ?? 200_000n, value: o.value ?? 0n, flags: o.atomic ? ATOMIC : 0 });

const pad = (n: bigint) => n.toString(16).padStart(64, "0");

/** EIP-8141 P256 signer address: keccak256(qx || qy)[12:]. */
export function p256Address(priv: Hex): Address {
  const pubk = p256.getPublicKey(hexToBytes(priv), false);
  return `0x${keccak256(bytesToHex(pubk.slice(1))).slice(26)}` as Address;
}
export const randomP256Key = (): Hex => bytesToHex(p256.utils.randomPrivateKey());

/** Builds a frame tx signed with the native P256 scheme (r || s || qx || qy over the canonical signature hash). */
export function p256Tx(a: { sender: Address; owner: Address; ownerKey: Hex; nonce: bigint; frames: Frame[]; tip?: bigint }): FrameTx {
  const tx = newTx({
    chainId: 1337, sender: a.sender, nonceSeq: a.nonce, frames: a.frames,
    signatures: [{ scheme: profile.sigSchemes.P256, signer: a.owner, msg: "0x", signature: "0x" }],
    fees: { maxFeePerGas: FRAME_MAX_FEE, maxPriorityFeePerGas: a.tip },
  });
  const h = hexToBytes(sigHash(profile, tx));
  const sig = p256.sign(h, hexToBytes(a.ownerKey), { lowS: true, prehash: false });
  const pubk = p256.getPublicKey(hexToBytes(a.ownerKey), false);
  const packed = `0x${pad(sig.r)}${pad(sig.s)}${bytesToHex(pubk.slice(1)).slice(2)}` as Hex;
  return { ...tx, signatures: [{ ...tx.signatures[0], signature: packed }] };
}

export const frameHash = (tx: FrameTx) => txHash(profile, tx);
export const sendFrameTx = (tx: FrameTx) => rpc<Hex>("eth_sendFrameTransaction", [toWire(tx)]);

export type FrameStatus = "New" | "Pending" | "Submitted" | "OnChain" | "Finalized" | "Cancelled" | "Reverted";
/**
 * Lifecycle of a frame tx in the sidecar. The explorer record (`skandha_explorer_getTransaction`) is updated as the
 * bundler moves the entry; `skandha_frameTransactionStatus` can lag behind it, so it is only the fallback.
 */
export async function frameStatus(hash: Hex): Promise<{ status: FrameStatus; transaction?: Hex; reason?: string; admission?: any } | null> {
  try {
    const r = await rpc<any>("skandha_explorer_getTransaction", [hash]);
    if (r?.entry?.status) return { status: r.entry.status, transaction: r.entry.transaction ?? undefined, reason: r.entry.reason, admission: r.admission };
  } catch { /* explorer off: fall back */ }
  try { return await rpc("skandha_frameTransactionStatus", [hash]); } catch { return null; }
}
