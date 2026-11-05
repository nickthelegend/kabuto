import { describe, beforeAll, it, expect } from "vitest";
import { encodeFunctionData, erc20Abi, parseEther, parseUnits, type Address, type Hex } from "viem";
import { payerFrame, senderFrame, signedTx, verifyFrame } from "../devnet/src/frames.js";
import { pub } from "../devnet/src/chain.js";
import { band } from "../devnet/src/pool.js";
import { rpc } from "../devnet/src/rpc.js";
import { A, P, R, d, roles, setup, freshIntentAccount, protectedTx, botSwap, sendBotSwap, slot0, balance, tokenOut, zeroForOne, intentTx, p256Case, saveCase, sendRecorded, receiptRecorded } from "./live.js";

const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
const status = (r: any) => r.status === "0x1";
async function explorer(h: Hex) { return rpc<any>("skandha_explorer_getTransaction", [h]); }

describe.sequential("Kabuto public devnet", () => {
  let account: Address, account2: Address, filler: Address;
  beforeAll(async () => {
    expect(await pub.getChainId()).toBe(1337);
    try { ({ account, account2, filler } = await setup()); }
    catch (e: any) { saveCase("setup", [], "failed", undefined, e.message); throw e; }
  }, 240_000);

  it("protected swap lands", async () => {
    const tx = await protectedTx(account, roles["test-owner"]);
    const h = await sendRecorded("protected-swap", tx), r = await receiptRecorded("protected-swap", h);
    saveCase("protected-swap", [h], r.status, BigInt(r.gasUsed ?? 0));
    expect(status(r), JSON.stringify(r.frameReceipts)).toBe(true);
  }, 180_000);

  it("out-of-band swap is refused and costs zero gas", async () => {
    const tx = await protectedTx(account, roles["test-owner"]);
    const before = await pub.getBalance({ address: account });
    const moved = await botSwap(parseUnits("60", 6));
    let h: Hex | undefined, error: string | undefined;
    try { h = await sendRecorded("frame", tx); } catch (e: any) { error = e.message; }
    saveCase("out-of-band", [moved.h, ...(h ? [h] : [])], h ? "admitted" : "refused", moved.r.gasUsed, error);
    expect(h, error).toBeUndefined();
    expect(error).toContain("0x8ad5a9c0");
    expect(await pub.getBalance({ address: account })).toBe(before);
  }, 180_000);

  it("bot-first race cancels the pinned swap with zero account gas", async () => {
    const tx = await protectedTx(account2, roles["test-owner2"]);
    const before = await pub.getBalance({ address: account2 });
    // Send the high-fee legacy swap first, then the signed frame tx immediately.
    const moveHash = await sendBotSwap(parseUnits("60", 6), 50_000_000_000n);
    let h: Hex | undefined, rejection: string | undefined;
    try { h = await sendRecorded("frame", tx); } catch (e: any) { rejection = e.message; }
    if (!h) {
      const move = await pub.waitForTransactionReceipt({ hash: moveHash, timeout: 120_000 });
      saveCase("bot-first-race", [moveHash], "admission-refused", move.gasUsed, rejection);
      throw new Error(`race tx refused before admission, so Cancelled was not observed: ${rejection}`);
    }
    const move = await pub.waitForTransactionReceipt({ hash: moveHash, timeout: 120_000 });
    let ex: any;
    for (let i = 0; i < 45; i++) { ex = await explorer(h); if (ex?.entry?.status === "Cancelled") break; await pause(2000); }
    const receipt = await rpc<any>("eth_getTransactionReceipt", [h]);
    saveCase("bot-first-race", [moveHash, h], ex?.entry?.status ?? "unknown", move.gasUsed);
    expect(ex?.entry?.status).toBe("Cancelled"); expect(receipt).toBeNull();
    expect(await pub.getBalance({ address: account2 })).toBe(before);
  }, 240_000);

  it("sponsored swap preserves account ETH and pays the fee", async () => {
    const sponsored = account2, sponsoredOwner = roles["test-owner2"];
    const price = await slot0(), b = band(price, 50), amountIn = parseUnits("60", 6), fee = BigInt(d.paymasterFees.WETH);
    const nonce = BigInt(await pub.getTransactionCount({ address: sponsored }));
    const tx = await signedTx({ sender: sponsored, signerAddr: sponsoredOwner.address, signerKey: sponsoredOwner.pk, nonce, frames: [
      verifyFrame(encodeFunctionData({ abi: A, functionName: "verifyPriceExecution", args: [d.poolId, b.min, b.max] }), 35_000n, "EXECUTION"),
      payerFrame(d.paymaster, encodeFunctionData({ abi: P, functionName: "sponsor", args: [b.min, b.max] }), 60_000n),
      senderFrame(d.kusd, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [d.router, amountIn] }), { atomic: true, execution: 120_000n }),
      senderFrame(d.router, encodeFunctionData({ abi: R, functionName: "swapExactIn", args: [d.poolKey, zeroForOne, amountIn, 0n, sponsored] }), { atomic: true, execution: 400_000n }),
      senderFrame(tokenOut, encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [d.paymaster, fee] }), { execution: 120_000n }),
    ] });
    const [eth0, fee0] = await Promise.all([pub.getBalance({ address: sponsored }), balance(tokenOut, d.paymaster)]);
    const h = await sendRecorded("sponsored-swap", tx), r = await receiptRecorded("sponsored-swap", h);
    const [eth1, fee1] = await Promise.all([pub.getBalance({ address: sponsored }), balance(tokenOut, d.paymaster)]);
    saveCase("sponsored-swap", [h], r.status, BigInt(r.gasUsed ?? 0));
    expect(status(r), JSON.stringify(r.frameReceipts)).toBe(true); expect(eth1).toBe(eth0); expect(fee1 - fee0).toBe(fee);
  }, 180_000);

  it("P256-signed frame transaction lands", async () => {
    const h = await p256Case(), r = await receiptRecorded("p256", h);
    saveCase("p256", [h], r.status, BigInt(r.gasUsed ?? 0));
    expect(status(r), JSON.stringify(r.frameReceipts)).toBe(true);
  }, 180_000);

  it("open intent pays at least startOut", async () => {
    const intentAccount = await freshIntentAccount("intentAccount");
    const { tx, intent, balanceBefore } = await intentTx(intentAccount, filler);
    const h = await sendRecorded("intent-fill", tx), r = await receiptRecorded("intent-fill", h);
    const after = await balance(tokenOut, intentAccount);
    saveCase("intent-fill", [h], r.status, BigInt(r.gasUsed ?? 0));
    expect(status(r), JSON.stringify(r.frameReceipts)).toBe(true); expect(after - balanceBefore >= intent.startOut).toBe(true);
  }, 180_000);

  for (const attack of ["extra-sender", "over-max", "no-atomic"] as const) {
    it(`${attack} attack is refused at admission`, async () => {
      const attackAccount = await freshIntentAccount("underpayAccount");
      const { tx } = await intentTx(attackAccount, filler, attack);
      const before = await pub.getBalance({ address: attackAccount });
      let h: Hex | undefined, error: string | undefined;
      try { h = await sendRecorded("frame", tx); } catch (e: any) { error = e.message; }
      saveCase(attack, h ? [h] : [], h ? "admitted" : "refused", undefined, error);
      expect(h, error).toBeUndefined();
      expect(error).toContain(`0x9cf7c987${({ "extra-sender": 9, "over-max": 6, "no-atomic": 7 } as const)[attack].toString(16).padStart(64, "0")}`);
      expect(await pub.getBalance({ address: attackAccount })).toBe(before);
    }, 180_000);
  }

  it("underpay mines with settle failed and rolls tokenIn back", async () => {
    const underpayAccount = await freshIntentAccount("underpayAccount");
    const { tx } = await intentTx(underpayAccount, filler, "underpay");
    const h = await sendRecorded("underpay", tx), r = await receiptRecorded("underpay", h);
    const block = BigInt(r.blockNumber);
    const [before, after] = await Promise.all([balance(d.kusd, underpayAccount, block - 1n), balance(d.kusd, underpayAccount, block)]);
    const frames = r.frameReceipts?.map((f: any) => f.status);
    saveCase("underpay", [h], r.status, BigInt(r.gasUsed ?? 0));
    expect(frames?.at(-1), JSON.stringify(frames)).not.toBe("0x1");
    expect(after).toBe(before);
  }, 180_000);
});
