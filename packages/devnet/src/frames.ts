import type { Address, Hex } from "viem";
import { profile } from "@forshtat/hegota-support/profiles/ethrex-eip8141-tracer";
import { frame, newTx, secp256k1Placeholder, signTx, txHash } from "@forshtat/hegota-support/tx";
import { toWire } from "@forshtat/hegota-support/rpc";
import { FRAME_MAX_FEE } from "./config.js";
import { rpc } from "./rpc.js";

export { profile };
export const ATOMIC = 0x4;

export type Frame = ReturnType<typeof frame>;
export type FrameTx = ReturnType<typeof newTx>;

export const verifyFrame = (data: Hex, execution = 200_000n, scope: "EXECUTION_AND_PAYMENT" | "EXECUTION" = "EXECUTION_AND_PAYMENT", target: Address | null = null) =>
  frame(profile, "VERIFY", { scope, target, execution, data });

export const payerFrame = (paymaster: Address, data: Hex = "0x", execution = 200_000n) =>
  frame(profile, "VERIFY", { scope: "PAYMENT", target: paymaster, execution, data });

export const senderFrame = (target: Address, data: Hex, opts: { execution?: bigint; state?: bigint; value?: bigint; atomic?: boolean } = {}) =>
  frame(profile, "SENDER", {
    target, data, execution: opts.execution ?? 300_000n, state: opts.state ?? 200_000n, value: opts.value ?? 0n,
    flags: opts.atomic ? ATOMIC : 0,
  });

export async function signedTx(a: { sender: Address; signerAddr: Address; signerKey: Hex; nonce: bigint; frames: Frame[]; nonceKeys?: bigint[]; maxFee?: bigint; tip?: bigint }) {
  const tx = newTx({
    chainId: 1337, sender: a.sender, nonceSeq: a.nonce, nonceKeys: a.nonceKeys, frames: a.frames,
    signatures: [secp256k1Placeholder(profile, a.signerAddr)],
    fees: { maxFeePerGas: a.maxFee ?? FRAME_MAX_FEE, maxPriorityFeePerGas: a.tip },
  });
  return signTx(profile, tx, a.signerKey);
}

export const hashOf = (tx: FrameTx) => txHash(profile, tx);

/** Into the standard alt-mempool via the gateway sidecar. */
export const sendFrameTx = (tx: FrameTx) => rpc<Hex>("eth_sendFrameTransaction", [toWire(tx)]);

export async function frameReceipt(hash: Hex, timeoutMs = 120_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await rpc<any>("eth_getTransactionReceipt", [hash]);
    if (r) return r;
    await new Promise((res) => setTimeout(res, 1500));
  }
  throw new Error(`frame tx ${hash} not mined within ${timeoutMs / 1000}s`);
}
