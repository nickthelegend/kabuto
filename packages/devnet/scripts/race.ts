/**
 * The real race on the public devnet: a price-pinned Kabuto swap is admitted to the alt-mempool, then a bot
 * front-runs it with a much higher fee. Expected: the front-run lands, the pinned swap's VERIFY frame fails at
 * inclusion time, the swap is never included, and the account pays nothing.
 */
import { encodeFunctionData, erc20Abi, maxUint256, parseUnits, parseGwei, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { artifact, pub, wallet } from "../src/chain.js";
import { key } from "../src/keys.js";
import { readState } from "../src/state.js";
import { band } from "../src/pool.js";
import { sendFrameTx, senderFrame, signedTx, verifyFrame } from "../src/frames.js";
import { rpc } from "../src/rpc.js";
import { PREDEPLOYS } from "../src/config.js";

const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 23), "•", ...a);
const s = readState();
const ownerPk = key("owner"), botPk = key("bot");
const owner = privateKeyToAccount(ownerPk).address, bot = privateKeyToAccount(botPk).address;
const router = artifact("KabutoRouter").abi, account = artifact("KabutoAccount").abi;
const SV = [{ type: "function", name: "getSlot0", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint160" }, { type: "int24" }, { type: "uint24" }, { type: "uint24" }] }] as const;
const slot0 = async () => (await pub.readContract({ address: PREDEPLOYS.stateView, abi: SV, functionName: "getSlot0", args: [s.poolId] }))[0];

const zeroForOne = !s.wethIs0;
const cur = await slot0();
const b = band(cur, 50);
const amountIn = parseUnits("30", 6);
const nonce = BigInt(await pub.getTransactionCount({ address: s.account }));
const tx = await signedTx({
  sender: s.account, signerAddr: owner, signerKey: ownerPk, nonce, tip: 1_000_000_000n,
  frames: [
    verifyFrame(encodeFunctionData({ abi: account, functionName: "verifyPrice", args: [s.poolId, b.min, b.max] }), 90_000n),
    senderFrame(s.kusd, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [s.router, amountIn] }), { atomic: true }),
    senderFrame(s.router, encodeFunctionData({ abi: router, functionName: "swapExactIn", args: [s.poolKey, zeroForOne, amountIn, 0n, s.account] }), { execution: 400_000n }),
  ],
});

// pre-sign the bot's front-run so both go out back to back
const bw = wallet(botPk);
const allowance = await pub.readContract({ address: s.kusd, abi: erc20Abi, functionName: "allowance", args: [bot, s.router] });
if (allowance < parseUnits("1000000", 6)) {
  const h = await bw.sendTransaction({ to: s.kusd, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [s.router, maxUint256] }), gasPrice: parseGwei("0.002"), type: "legacy" } as any);
  await pub.waitForTransactionReceipt({ hash: h });
}
const frontData = encodeFunctionData({ abi: router, functionName: "swapExactIn", args: [s.poolKey, zeroForOne, parseUnits("60", 6), 0n, bot] });
const frontGas = await pub.estimateGas({ account: privateKeyToAccount(botPk), to: s.router, data: frontData });

const bal0 = await pub.getBalance({ address: s.account });
const startBlock = await pub.getBlockNumber();
const BOT_FIRST = process.argv.includes("--bot-first");
let victimHash: Hex, frontHash: Hex;
if (BOT_FIRST) {
  frontHash = await bw.sendTransaction({ to: s.router, data: frontData, gas: frontGas * 2n, gasPrice: parseGwei("50"), type: "legacy" } as any);
  log("bot front-run sent FIRST with 50 gwei:", frontHash);
  victimHash = await sendFrameTx(tx);
  log("pinned swap ADMITTED right after:", victimHash, "band +-0.5%");
} else {
  victimHash = await sendFrameTx(tx);
  log("pinned swap ADMITTED to the alt-mempool:", victimHash, "band +-0.5%");
  frontHash = await bw.sendTransaction({ to: s.router, data: frontData, gas: frontGas * 2n, gasPrice: parseGwei("50"), type: "legacy" } as any);
  log("bot front-run sent with 50 gwei:", frontHash);
}

const fr = await pub.waitForTransactionReceipt({ hash: frontHash, timeout: 120_000 });
log("bot front-run mined in block", fr.blockNumber, "index", fr.transactionIndex, fr.status);

let victim: any = null;
for (let i = 0; i < 30 && !victim; i++) {
  victim = await rpc("eth_getTransactionReceipt", [victimHash]);
  if (!victim) await new Promise((r) => setTimeout(r, 2000));
}
if (victim) {
  log("pinned swap MINED in block", BigInt(victim.blockNumber), "index", BigInt(victim.transactionIndex), "status", victim.status,
    BigInt(victim.blockNumber) < fr.blockNumber || (victim.blockNumber === `0x${fr.blockNumber.toString(16)}` && BigInt(victim.transactionIndex) < fr.transactionIndex) ? "(BEFORE the bot: bot lost the race)" : "(AFTER the bot?!)");
} else {
  log("pinned swap NOT included after 60 s (expected when the bot landed first)");
}
const ex = await rpc<any>("skandha_explorer_getTransaction", [victimHash]).catch((e) => ({ error: e.message }));
log("explorer lifecycle:", JSON.stringify(ex).slice(0, 600));
const bal1 = await pub.getBalance({ address: s.account });
log("account ETH change:", (bal1 - bal0).toString(), "wei; blocks", startBlock, "->", await pub.getBlockNumber());
log("slot0 now", (await slot0()).toString(), "band", b.min.toString(), b.max.toString());
