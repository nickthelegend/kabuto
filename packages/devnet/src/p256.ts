import { p256 } from "@noble/curves/p256";
import { bytesToHex, hexToBytes, keccak256, type Address, type Hex } from "viem";
import { profile } from "@forshtat/hegota-support/profiles/ethrex-eip8141-tracer";
import { sigHash } from "@forshtat/hegota-support/tx";
import type { FrameTx } from "./frames.js";

const pad = (n: bigint) => n.toString(16).padStart(64, "0");

/** EIP-8141 P256 signer: keccak256(qx || qy)[12:]. */
export function p256Address(priv: Hex): Address {
  const pub = p256.getPublicKey(hexToBytes(priv), false); // 0x04 || qx || qy
  return `0x${keccak256(bytesToHex(pub.slice(1))).slice(26)}` as Address;
}

export const p256Placeholder = (signer: Address) => ({ scheme: profile.sigSchemes.P256, signer, msg: "0x" as Hex, signature: "0x" as Hex });

/** Signs the canonical signature hash with a raw P256 key (low-s) and packs r || s || qx || qy. */
export function signP256(tx: FrameTx, priv: Hex, index = 0): FrameTx {
  const h = hexToBytes(sigHash(profile, tx));
  const sig = p256.sign(h, hexToBytes(priv), { lowS: true, prehash: false });
  const pub = p256.getPublicKey(hexToBytes(priv), false);
  const packed = (`0x${pad(sig.r)}${pad(sig.s)}${bytesToHex(pub.slice(1)).slice(2)}`) as Hex;
  return { ...tx, signatures: tx.signatures.map((e, i) => (i === index ? { ...e, signature: packed } : e)) };
}

export const randomP256Key = (): Hex => bytesToHex(p256.utils.randomPrivateKey());
