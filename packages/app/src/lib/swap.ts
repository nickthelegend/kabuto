import { createWalletClient, encodeFunctionData, erc20Abi, http, maxUint256, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { D, devnet, LEGACY_GAS_PRICE } from "./config";
import { pub, sendLegacy } from "./chain";
import { accountArtifact, routerAbi } from "./abi";
import { bandFor, tokenIn, tokenOut, zeroForOneFor, type Side } from "./market";
import { frameHash, frameStatus, p256Tx, sendFrameTx, senderFrame, verifyFrame } from "./frames";
import { guardErrorIn, poolIdFor, poolKeyFor, poolState, quoteOn, type Route } from "./guard";
import { rpc } from "./rpc";
import { waitFrame, type Saved } from "./wallet";

export type Attempt = {
  id: string;
  wallet: "kabuto" | "normal";
  route: Route;
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
  /** Per-frame outcome from the frame tx receipt (VERIFY, approve, swap). */
  frames?: { label: string; ok: boolean; gas: bigint }[];
  /** Alt-mempool admission checks recorded by the devnet explorer for this frame tx. */
  checks?: { rule: string; verdict: string }[];
  /** KabutoGuard hook outcome when the swap was routed through the guarded pool. */
  guard?: { admitted: boolean; code?: string };
};

const FRAME_LABELS = ["VERIFY · price pin", "SENDER · approve", "SENDER · swap"];

const bal = (t: Address, who: Address) => pub.readContract({ address: t, abi: erc20Abi, functionName: "balanceOf", args: [who] });
const now = () => Date.now();

/** Kabuto swap: the VERIFY frame pins the pool price to +-bandBps; approve + swap run as one atomic batch. */
export async function kabutoSwap(w: Saved, side: Side, amountIn: bigint, bandBps: number, on: (a: Attempt) => void, route: Route = "main"): Promise<Attempt> {
  const a: Attempt = { id: crypto.randomUUID(), wallet: "kabuto", route, side, amountIn, quoted: 0n, minOut: 0n, bandBps, phase: "signing", phaseLog: [{ phase: "signing", at: now() }], startedAt: now() };
  const push = (phase: Attempt["phase"], note?: string) => { a.phase = phase; a.phaseLog.push({ phase, at: now(), note }); on({ ...a }); };
  on({ ...a });
  try {
    const acct = w.account!;
    const [{ sqrtP: sp }, q] = await Promise.all([poolState(route), quoteOn(route, side, amountIn)]);
    a.quoted = q;
    a.minOut = (q * BigInt(10_000 - bandBps)) / 10_000n;
    const b = bandFor(sp, bandBps);
    const tin = tokenIn(side).address, tout = tokenOut(side).address;
    const [out0, eth0, nonce] = await Promise.all([bal(tout, acct), pub.getBalance({ address: acct }), pub.getTransactionCount({ address: acct })]);
    const tx = p256Tx({
      sender: acct, owner: w.owner, ownerKey: w.ownerKey, nonce: BigInt(nonce), tip: 1_000_000_000n,
      frames: [
        verifyFrame(encodeFunctionData({ abi: accountArtifact.abi, functionName: "verifyPrice", args: [poolIdFor(route), b.min, b.max] }), 90_000n),
        senderFrame(tin, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [D.router, amountIn] }), { atomic: true, execution: 120_000n }),
        // the guard hook reads the enclosing frames (FRAMEPARAM / FRAMEDATACOPY), so its swap gets more room
        senderFrame(D.router, encodeFunctionData({ abi: routerAbi, functionName: "swapExactIn", args: [poolKeyFor(route), zeroForOneFor(side), amountIn, a.minOut, acct] }),
          route === "guard" ? { execution: 800_000n, state: 300_000n } : { execution: 400_000n }),
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
    a.checks = admissionChecks(st.admission) ?? admissionChecks((await frameStatus(a.hash).catch(() => null))?.admission);
    if (st.status === "Reverted") { a.error = st.reason; push("reverted", st.reason); return a; }
    const r = await rpc<any>("eth_getTransactionReceipt", [st.transaction ?? a.hash]);
    if (r) {
      a.block = BigInt(r.blockNumber); a.index = Number(BigInt(r.transactionIndex));
      a.frames = (r.frameReceipts ?? []).map((f: any, i: number) => ({ label: FRAME_LABELS[i] ?? `Frame ${i}`, ok: f.status === "0x1", gas: BigInt(f.gasUsed ?? 0) }));
    }
    const [out1, eth1] = await Promise.all([bal(tout, acct), pub.getBalance({ address: acct })]);
    a.out = out1 - out0;
    a.gasWei = eth0 - eth1;
    const swapOk = !a.frames?.length || a.frames.every((f) => f.ok);
    if (route === "guard") a.guard = { admitted: swapOk };
    if (!swapOk) {
      // the tx is on chain but a frame failed: the atomic approve rolled back with it and no tokens moved
      a.error = `${a.frames!.find((f) => !f.ok)!.label} failed on chain.`;
      push("reverted", a.error);
      return a;
    }
    push("included");
    return a;
  } catch (e: any) {
    a.error = humanize(e?.message ?? String(e));
    push("failed", a.error);
    return a;
  }
}

/** The same swap from an ordinary EOA wallet: router call with a slippage floor, in the public mempool. */
export async function normalSwap(w: Saved, side: Side, amountIn: bigint, slippageBps: number, on: (a: Attempt) => void, route: Route = "main"): Promise<Attempt> {
  const a: Attempt = { id: crypto.randomUUID(), wallet: "normal", route, side, amountIn, quoted: 0n, minOut: 0n, slippageBps, phase: "signing", phaseLog: [{ phase: "signing", at: now() }], startedAt: now() };
  const push = (phase: Attempt["phase"], note?: string) => { a.phase = phase; a.phaseLog.push({ phase, at: now(), note }); on({ ...a }); };
  on({ ...a });
  try {
    const eoa = w.funder;
    const tin = tokenIn(side).address, tout = tokenOut(side).address;
    const allowance = await pub.readContract({ address: tin, abi: erc20Abi, functionName: "allowance", args: [eoa, D.router] });
    if (allowance < amountIn) await sendLegacy(w.funderKey, { to: tin, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [D.router, maxUint256] }) });
    const q = await quoteOn(route, side, amountIn);
    a.quoted = q;
    a.minOut = (q * BigInt(10_000 - slippageBps)) / 10_000n;
    const out0 = await bal(tout, eoa);
    const data = encodeFunctionData({ abi: routerAbi, functionName: "swapExactIn", args: [poolKeyFor(route), zeroForOneFor(side), amountIn, a.minOut, eoa] });
    if (route === "guard") return await plainIntoGuard(w, a, data, out0, push);
    push("pending", "public mempool");
    const r = await sendLegacy(w.funderKey, { to: D.router, data });
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

/**
 * An ordinary wallet's swap into the KabutoGuard pool. Simulated first to read the hook's verdict, then sent for real
 * (fixed gas, since estimation fails on a revert) so the refusal is a transaction anyone can open in the explorer.
 */
async function plainIntoGuard(w: Saved, a: Attempt, data: Hex, out0: bigint, push: (p: Attempt["phase"], note?: string) => void): Promise<Attempt> {
  const account = privateKeyToAccount(w.funderKey);
  let code: string | undefined;
  try { await pub.call({ account, to: D.router, data, gasPrice: LEGACY_GAS_PRICE } as any); }
  catch (e: any) { code = guardErrorIn(revertData(e)); }
  push("pending", "public mempool");
  const wc = createWalletClient({ account, chain: devnet, transport: http(D.gateway) });
  const hash = await wc.sendTransaction({ to: D.router, data, gas: 600_000n, gasPrice: LEGACY_GAS_PRICE, type: "legacy" } as any);
  a.hash = hash;
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  a.block = r.blockNumber; a.index = r.transactionIndex;
  a.gasWei = r.gasUsed * r.effectiveGasPrice;
  if (r.status === "success") {
    a.guard = { admitted: true };
    a.out = (await bal(tokenOut(a.side).address, w.funder)) - out0;
    push("included");
    return a;
  }
  a.guard = { admitted: false, code };
  a.error = code ? `KabutoGuard refused it: ${code}()` : "Reverted on chain.";
  push("reverted", a.error);
  return a;
}

function revertData(e: any): string | undefined {
  for (let c = e; c; c = c.cause) {
    if (typeof c.data === "string") return c.data;
    if (typeof c.data?.data === "string") return c.data.data;
    if (typeof c.raw === "string") return c.raw;
  }
  return typeof e?.message === "string" ? e.message : undefined;
}

function admissionChecks(adm: any): Attempt["checks"] | undefined {
  if (!Array.isArray(adm?.checks)) return undefined;
  return adm.checks.map((c: any) => ({ rule: String(c.rule) + (c.frameIndex !== undefined ? ` · frame ${c.frameIndex}` : ""), verdict: String(c.verdict) }));
}

export function humanize(m: string): string {
  if (/0x8ad5a9c0|PriceOutOfBand/i.test(m)) return "Price already outside your band, so the network refused the swap. No gas was spent.";
  if (/exceeds MAX_VERIFY_GAS/i.test(m)) return "Validation gas over the mempool cap (100k).";
  if (/unstaked/i.test(m)) return "This account isn't staked yet, so the alt-mempool won't accept a price-pinned swap.";
  if (/NotFrameTx|NoPricePin|BandTooWide/.test(m)) return m;
  if (/TooLittleReceived|0x8b063d73/i.test(m)) return "Output fell below your slippage floor, so the swap reverted (gas was still paid).";
  return m.length > 220 ? m.slice(0, 220) + "…" : m;
}
