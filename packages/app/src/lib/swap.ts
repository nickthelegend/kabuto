import { encodeFunctionData, erc20Abi, maxUint256, type Address, type Hex } from "viem";
import { D } from "./config";
import { pub, sendLegacy } from "./chain";
import { accountArtifact, routerAbi } from "./abi";
import { bandFor, quote, sqrtPrice, tokenIn, tokenOut, zeroForOneFor, type Side } from "./market";
import { frameHash, p256Tx, sendFrameTx, senderFrame, verifyFrame } from "./frames";
import { rpc } from "./rpc";
import { waitFrame, type Saved } from "./wallet";

export type Attempt = {
  id: string;
  wallet: "kabuto" | "normal";
  side: Side;
  amountIn: bigint;
  quoted: bigint;
  minOut: bigint;
  bandBps?: number;
  slippageBps?: number;
  hash?: Hex;
  phase: "signing" | "admitted" | "pending" | "included" | "cancelled" | "rejected" | "reverted" | "failed";
  phaseLog: { phase: string; at: number; note?: string }[];
  block?: bigint;
  index?: number;
  out?: bigint;
  gasWei?: bigint;
  error?: string;
  startedAt: number;
};

const bal = (t: Address, who: Address) => pub.readContract({ address: t, abi: erc20Abi, functionName: "balanceOf", args: [who] });
const now = () => Date.now();

/** Kabuto swap: the VERIFY frame pins the pool price to +-bandBps; approve + swap run as one atomic batch. */
export async function kabutoSwap(w: Saved, side: Side, amountIn: bigint, bandBps: number, on: (a: Attempt) => void): Promise<Attempt> {
  const a: Attempt = { id: crypto.randomUUID(), wallet: "kabuto", side, amountIn, quoted: 0n, minOut: 0n, bandBps, phase: "signing", phaseLog: [{ phase: "signing", at: now() }], startedAt: now() };
  const push = (phase: Attempt["phase"], note?: string) => { a.phase = phase; a.phaseLog.push({ phase, at: now(), note }); on({ ...a }); };
  on({ ...a });
  try {
    const acct = w.account!;
    const [sp, q] = await Promise.all([sqrtPrice(), quote(side, amountIn)]);
    a.quoted = q;
    a.minOut = (q * BigInt(10_000 - bandBps)) / 10_000n;
    const b = bandFor(sp, bandBps);
    const tin = tokenIn(side).address, tout = tokenOut(side).address;
    const [out0, eth0, nonce] = await Promise.all([bal(tout, acct), pub.getBalance({ address: acct }), pub.getTransactionCount({ address: acct })]);
    const tx = p256Tx({
      sender: acct, owner: w.owner, ownerKey: w.ownerKey, nonce: BigInt(nonce), tip: 1_000_000_000n,
      frames: [
        verifyFrame(encodeFunctionData({ abi: accountArtifact.abi, functionName: "verifyPrice", args: [D.poolId, b.min, b.max] }), 90_000n),
        senderFrame(tin, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [D.router, amountIn] }), { atomic: true, execution: 120_000n }),
        senderFrame(D.router, encodeFunctionData({ abi: routerAbi, functionName: "swapExactIn", args: [D.poolKey, zeroForOneFor(side), amountIn, a.minOut, acct] }), { execution: 400_000n }),
      ],
    });
    a.hash = frameHash(tx);
    try {
      await sendFrameTx(tx);
    } catch (e: any) {
      a.error = humanize(e?.message ?? String(e));
      a.gasWei = 0n;
      push("rejected", a.error);
      return a;
    }
    push("admitted", "standard alt-mempool (ERC-8421)");
    const st = await waitFrame(a.hash, (s) => { if (s === "Submitted" || s === "Pending") push("pending", s); });
    if (st.status === "Cancelled") {
      a.gasWei = (await pub.getBalance({ address: acct })) === eth0 ? 0n : eth0 - (await pub.getBalance({ address: acct }));
      push("cancelled", "price left the signed band before inclusion");
      return a;
    }
    if (st.status === "Reverted") { push("reverted", st.reason); return a; }
    const r = await rpc<any>("eth_getTransactionReceipt", [st.transaction ?? a.hash]);
    if (r) { a.block = BigInt(r.blockNumber); a.index = Number(BigInt(r.transactionIndex)); }
    const [out1, eth1] = await Promise.all([bal(tout, acct), pub.getBalance({ address: acct })]);
    a.out = out1 - out0;
    a.gasWei = eth0 - eth1;
    push("included");
    return a;
  } catch (e: any) {
    a.error = humanize(e?.message ?? String(e));
    push("failed", a.error);
    return a;
  }
}

/** The same swap from an ordinary EOA wallet: router call with a slippage floor, in the public mempool. */
export async function normalSwap(w: Saved, side: Side, amountIn: bigint, slippageBps: number, on: (a: Attempt) => void): Promise<Attempt> {
  const a: Attempt = { id: crypto.randomUUID(), wallet: "normal", side, amountIn, quoted: 0n, minOut: 0n, slippageBps, phase: "signing", phaseLog: [{ phase: "signing", at: now() }], startedAt: now() };
  const push = (phase: Attempt["phase"], note?: string) => { a.phase = phase; a.phaseLog.push({ phase, at: now(), note }); on({ ...a }); };
  on({ ...a });
  try {
    const eoa = w.funder;
    const tin = tokenIn(side).address, tout = tokenOut(side).address;
    const allowance = await pub.readContract({ address: tin, abi: erc20Abi, functionName: "allowance", args: [eoa, D.router] });
    if (allowance < amountIn) await sendLegacy(w.funderKey, { to: tin, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [D.router, maxUint256] }) });
    const q = await quote(side, amountIn);
    a.quoted = q;
    a.minOut = (q * BigInt(10_000 - slippageBps)) / 10_000n;
    const out0 = await bal(tout, eoa);
    push("pending", "public mempool");
    const r = await sendLegacy(w.funderKey, { to: D.router, data: encodeFunctionData({ abi: routerAbi, functionName: "swapExactIn", args: [D.poolKey, zeroForOneFor(side), amountIn, a.minOut, eoa] }) }).catch((e) => { throw e; });
    a.hash = r.transactionHash;
    a.block = r.blockNumber; a.index = r.transactionIndex;
    a.gasWei = r.gasUsed * r.effectiveGasPrice;
    a.out = (await bal(tout, eoa)) - out0;
    push("included");
    return a;
  } catch (e: any) {
    a.error = humanize(e?.message ?? String(e));
    push(/reverted/i.test(a.error) ? "reverted" : "failed", a.error);
    return a;
  }
}

export function humanize(m: string): string {
  if (/0x8ad5a9c0|PriceOutOfBand/i.test(m)) return "Price already outside your band, so the network refused the swap. No gas was spent.";
  if (/exceeds MAX_VERIFY_GAS/i.test(m)) return "Validation gas over the mempool cap (100k).";
  if (/unstaked/i.test(m)) return "This account isn't staked yet, so the alt-mempool won't accept a price-pinned swap.";
  if (/TooLittleReceived|0x8b063d73/i.test(m)) return "Output fell below your slippage floor, so the swap reverted (gas was still paid).";
  return m.length > 220 ? m.slice(0, 220) + "…" : m;
}
