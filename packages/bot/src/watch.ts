import { decodeFunctionData, type Address, type Hex } from "viem";
import { artifact } from "../../devnet/src/chain.js";
import { hashOf, type FrameTx } from "../../devnet/src/frames.js";
import { decodeSwap, deployment, ethrexRpc, gatewayRpc, type Swap } from "./common.js";

type Tx = { hash?: Hex; to?: Address; input?: Hex; data?: Hex; from?: Address };
export function eoaSwaps(content: unknown): Swap[] {
  const pending = (content as { pending?: Record<string, Record<string, Tx>> })?.pending ?? {};
  const found: Swap[] = [];
  for (const nonces of Object.values(pending)) for (const tx of Object.values(nonces)) {
    if (!tx.hash || !tx.from || tx.to?.toLowerCase() !== deployment.router.toLowerCase()) continue;
    const swap = decodeSwap(tx.input ?? tx.data ?? "0x", tx.hash, tx.from, "eoa");
    if (swap) found.push(swap);
  }
  return found;
}
const verifyAbi = artifact("KabutoAccount").abi;
type WireFrame = { mode: string | number; flags: string | number; target: Address | null; limits: { execution: Hex; state: Hex }; value: Hex; data: Hex };
type WireTx = { hash?: Hex; chainId: Hex; nonceKeys: Hex[]; nonceSeq: Hex; sender: Address; frames: WireFrame[]; signatures: Array<{ scheme: string | number; signer: Hex; msg: Hex; signature: Hex }>; fees: { maxPriorityFeePerGas: Hex; maxFeePerGas: Hex; maxFeePerBlobGas: Hex }; blobVersionedHashes: Hex[]; recentRootReferences: Array<{ sourceId: Hex; slot: Hex; root: Hex }> };
const numeric = (value: string | number) => Number(value);
/** The read-only bundler dump contains wire transactions without hashes. Recreate the canonical EIP-8141 hash. */
export function frameHash(wire: WireTx): Hex {
  if (wire.hash) return wire.hash;
  const tx: FrameTx = {
    chainId: BigInt(wire.chainId), nonceKeys: wire.nonceKeys.map(BigInt), nonceSeq: BigInt(wire.nonceSeq), sender: wire.sender,
    frames: wire.frames.map(f => ({ mode: numeric(f.mode), flags: numeric(f.flags), target: f.target, limits: { execution: BigInt(f.limits.execution), state: BigInt(f.limits.state) }, value: BigInt(f.value), data: f.data })),
    signatures: wire.signatures.map(s => ({ scheme: numeric(s.scheme), signer: s.signer, msg: s.msg, signature: s.signature })),
    fees: { maxPriorityFeePerGas: BigInt(wire.fees.maxPriorityFeePerGas), maxFeePerGas: BigInt(wire.fees.maxFeePerGas), maxFeePerBlobGas: BigInt(wire.fees.maxFeePerBlobGas) },
    blobVersionedHashes: wire.blobVersionedHashes, recentRootReferences: wire.recentRootReferences.map(r => ({ sourceId: r.sourceId, slot: BigInt(r.slot), root: r.root })),
  };
  return hashOf(tx);
}
function findFrames(value: unknown): { hash: Hex; sender: Address; frames: WireFrame[] }[] {
  const results: ReturnType<typeof findFrames> = [];
  const visit = (node: unknown, inheritedHash?: Hex, inheritedSender?: Address) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const item of node) visit(item, inheritedHash, inheritedSender); return; }
    const o = node as Record<string, unknown>;
    const hash = (o.hash ?? o.txHash ?? o.transactionHash ?? inheritedHash ?? (Array.isArray(o.frames) && o.chainId ? frameHash(o as WireTx) : undefined)) as Hex | undefined;
    const sender = (o.sender ?? o.from ?? inheritedSender) as Address | undefined;
    if (Array.isArray(o.frames) && hash && sender) results.push({ hash, sender, frames: o.frames as WireFrame[] });
    for (const [k, v] of Object.entries(o)) if (k !== "frames" && typeof v === "object") visit(v, hash, sender);
  };
  visit(value);
  return results;
}
export function frameSwaps(dump: unknown): Swap[] {
  const found: Swap[] = [];
  for (const tx of findFrames(dump)) {
    const pinned = tx.frames.some(f => {
      if (!f.data || numeric(f.mode) !== 1 || f.target && f.target.toLowerCase() !== tx.sender.toLowerCase()) return false;
      try {
        const decoded = decodeFunctionData({ abi: verifyAbi, data: f.data });
        return ["verifyPrice", "verifyPriceExecution"].includes(decoded.functionName) && String(decoded.args?.[0]).toLowerCase() === deployment.poolId.toLowerCase();
      } catch { return false; }
    });
    for (const f of tx.frames) {
      if (numeric(f.mode) !== 2 || f.target?.toLowerCase() !== deployment.router.toLowerCase() || !f.data) continue;
      const swap = decodeSwap(f.data, tx.hash, tx.sender, "frame", pinned);
      if (swap) found.push(swap);
    }
  }
  return found;
}
export async function scanMempools(): Promise<Swap[]> {
  const [content, dump] = await Promise.all([
    ethrexRpc<unknown>("txpool_content"),
    gatewayRpc<unknown>("debug_bundler_dumpMempool"),
  ]);
  return [...eoaSwaps(content), ...frameSwaps(dump)];
}
