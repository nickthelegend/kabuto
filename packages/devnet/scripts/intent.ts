/**
 * Open intents on the 8141 devnet ("SIGHASH_ANYONECANPAY for Ethereum").
 * The owner signs only an intent digest (explicit 32-byte signature msg). A filler builds the rest of the tx:
 * its own VERIFY(payment) frame, the user's tokenIn transfer, its DEFAULT swap frame through Uniswap v4, and the
 * account's settle frame; it co-signs the full tx as signature entry 1 and pays the gas.
 *   --attack extra-sender   adds a SENDER frame that sends the account's kUSD to the attacker   (must be refused)
 *   --attack over-max       pulls more than maxIn                                               (must be refused)
 *   --attack no-atomic      drops the atomic flag so the transfer could survive a failed settle (must be refused)
 *   --attack underpay       pays the account less than the decayed minimum                      (must revert / not land)
 */
import { encodeFunctionData, erc20Abi, parseEther, parseUnits, keccak256, encodeAbiParameters, type Address, type Hex } from "viem";
import { privateKeyToAccount, sign } from "viem/accounts";
import { profile } from "@forshtat/hegota-support/profiles/ethrex-eip8141-tracer";
import { frame, newTx, signTx } from "@forshtat/hegota-support/tx";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { artifact, deploy, ensureFunded, pub, sendLegacy } from "../src/chain.js";
import { key } from "../src/keys.js";
import { PREDEPLOYS, FRAME_MAX_FEE } from "../src/config.js";
import { frameReceipt, sendFrameTx, hashOf } from "../src/frames.js";
import { readState, writeState } from "../src/state.js";
import { rpc } from "../src/rpc.js";

const log = (...a: unknown[]) => console.log("•", ...a);
const attack = process.argv.includes("--attack") ? process.argv[process.argv.indexOf("--attack") + 1] : null;
const d = JSON.parse(readFileSync(fileURLToPath(new URL("../../../deployments/1337.json", import.meta.url)), "utf8"));
const deployerPk = key("deployer"), ownerPk = key("owner"), fillerPk = key("filler"), attackerPk = key("attacker");
const owner = privateKeyToAccount(ownerPk).address, operator = privateKeyToAccount(fillerPk).address, attacker = privateKeyToAccount(attackerPk).address;
const acctAbi = artifact("KabutoAccount").abi, fillerAbi = artifact("KabutoFiller").abi, tokAbi = artifact("DevnetToken").abi;
const QUOTER = "0xeEa49CC6419125E2f706bf7f95Cf34ac7e93087D" as Address;
const QUOTER_ABI = [{ type: "function", name: "quoteExactInputSingle", stateMutability: "nonpayable", inputs: [{ type: "tuple", name: "p", components: [{ type: "tuple", name: "poolKey", components: [{ name: "currency0", type: "address" }, { name: "currency1", type: "address" }, { name: "fee", type: "uint24" }, { name: "tickSpacing", type: "int24" }, { name: "hooks", type: "address" }] }, { name: "zeroForOne", type: "bool" }, { name: "exactAmount", type: "uint128" }, { name: "hookData", type: "bytes" }] }], outputs: [{ type: "uint256" }, { type: "uint256" }] }] as const;

// --- one-time setup: an intent account (k1 owner) and a filler contract
let st = readState();
if (!st.intentAccount || !(await pub.getCode({ address: st.intentAccount })) || process.argv.includes("--fresh")) {
  await ensureFunded(deployer(), parseEther("0.3"));
  const acct = await deploy(deployerPk, "KabutoAccount", [owner, PREDEPLOYS.poolManager], parseEther("0.01"));
  await sendLegacy(deployerPk, { to: d.kusd, data: encodeFunctionData({ abi: tokAbi, functionName: "faucet", args: [acct] }) });
  const filler = await deploy(deployerPk, "KabutoFiller", [PREDEPLOYS.poolManager, operator], parseEther("0.1"));
  writeState({ intentAccount: acct, filler });
  st = readState();
  log("intent account", acct, "filler", filler);
}
function deployer() { return privateKeyToAccount(deployerPk).address; }
const acct = st.intentAccount as Address, filler = st.filler as Address;

// --- the user's intent: sell 50 kUSD for WETH, Dutch decay from quote-0.5% to quote-2% over 10 minutes
const amountIn = parseUnits("50", 6);
const zeroForOne = !d.wethIs0; // kUSD -> WETH
const [{ result: q }, nonce, block] = await Promise.all([
  pub.simulateContract({ address: QUOTER, abi: QUOTER_ABI, functionName: "quoteExactInputSingle", args: [{ poolKey: d.poolKey, zeroForOne, exactAmount: amountIn, hookData: "0x" }] }),
  pub.getTransactionCount({ address: acct }),
  pub.getBlock(),
]);
const quoteOut = q[0];
const intent = {
  tokenIn: d.kusd as Address, maxIn: amountIn, tokenOut: PREDEPLOYS.weth as Address,
  startOut: (quoteOut * 995n) / 1000n, endOut: (quoteOut * 980n) / 1000n,
  startTime: block.timestamp, deadline: block.timestamp + 600n, nonce: BigInt(nonce),
};
const digest = await pub.readContract({ address: acct, abi: acctAbi, functionName: "intentDigest", args: [intent] }) as Hex;
const us = await sign({ hash: digest, privateKey: ownerPk });
const userSig = `0x${(us.yParity ?? Number(us.v) - 27).toString(16).padStart(2, "0")}${us.r.slice(2)}${us.s.slice(2)}` as Hex;
log("user signed ONLY the intent digest", digest.slice(0, 18) + "…", "nonce", intent.nonce, "quote", quoteOut);

// --- the filler builds the rest
const wethBal0 = await pub.readContract({ address: PREDEPLOYS.weth, abi: erc20Abi, functionName: "balanceOf", args: [acct] });
const payOut = attack === "underpay" ? intent.endOut / 2n : intent.startOut; // pay the current (undecayed) minimum
const pullAmount = attack === "over-max" ? amountIn + 1n : amountIn;
const settleData = encodeFunctionData({ abi: acctAbi, functionName: "settleIntent", args: [intent.tokenOut, wethBal0, intent.startOut, intent.endOut, intent.startTime, intent.deadline] });
const F = (mode: "VERIFY" | "SENDER" | "DEFAULT", o: any) => frame(profile, mode as any, o);
const frames = [
  F("VERIFY", { scope: "EXECUTION", target: null, execution: 82_000n, data: encodeFunctionData({ abi: acctAbi, functionName: "verifyIntent", args: [intent] }) }),
  F("VERIFY", { scope: "PAYMENT", target: filler, execution: 12_000n, data: encodeFunctionData({ abi: fillerAbi, functionName: "pay" }) }),
  F("SENDER", { target: d.kusd, execution: 80_000n, state: 100_000n, flags: attack === "no-atomic" ? 0 : 0x4, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [filler, pullAmount] }) }),
  ...(attack === "extra-sender" ? [F("SENDER", { target: d.kusd, execution: 80_000n, state: 100_000n, flags: 0x4, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [attacker, parseUnits("100", 6)] }) })] : []),
  F("DEFAULT", { target: filler, execution: 400_000n, state: 200_000n, flags: 0x4, data: encodeFunctionData({ abi: fillerAbi, functionName: "fill", args: [d.poolKey, zeroForOne, amountIn, acct, payOut] }) }),
  F("SENDER", { target: null, execution: 80_000n, data: settleData }),
];
let tx = newTx({
  chainId: 1337, sender: acct, nonceSeq: intent.nonce, frames,
  signatures: [
    { scheme: profile.sigSchemes.SECP256K1, signer: owner, msg: digest, signature: userSig },
    { scheme: profile.sigSchemes.SECP256K1, signer: operator, msg: "0x", signature: "0x" },
  ],
  fees: { maxFeePerGas: FRAME_MAX_FEE, maxPriorityFeePerGas: 100_000_000n },
});
tx = await signTx(profile, tx, fillerPk, 1);

const [aEth0, fEth0] = await Promise.all([pub.getBalance({ address: acct }), pub.getBalance({ address: filler })]);
try {
  const h = await sendFrameTx(tx);
  log(attack ? `ATTACK ${attack}: ADMITTED (bad)` : "intent fill admitted", h);
  const r = await frameReceipt(h, 90_000);
  log("mined status", r.status, "frames", JSON.stringify(r.frameReceipts?.map((f: any) => f.status)), "payer", r.payer);
} catch (e: any) {
  log(attack ? `ATTACK ${attack}: REFUSED (good)` : "intent fill REFUSED", "→", e.message.slice(0, 300));
}
const [aEth1, fEth1, wethBal1] = await Promise.all([pub.getBalance({ address: acct }), pub.getBalance({ address: filler }), pub.readContract({ address: PREDEPLOYS.weth, abi: erc20Abi, functionName: "balanceOf", args: [acct] })]);
log("account ETH change", (aEth1 - aEth0).toString(), "| filler ETH change", (fEth1 - fEth0).toString(), "| account WETH received", (wethBal1 - wethBal0).toString(), "min", intent.startOut.toString());
void hashOf; void rpc; void writeFileSync; void keccak256; void encodeAbiParameters;
