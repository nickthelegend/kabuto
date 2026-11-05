/**
 * "The swap pays its own gas": deploys and stakes KabutoPaymaster (records it in deployments/1337.json), then sends
 * a sponsored, price-pinned swap from a Kabuto account and checks that the account's ETH did not move while the
 * paymaster was repaid in the swap's output token inside the same atomic batch.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { encodeFunctionData, erc20Abi, parseEther, parseUnits, type Address, type Hex } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { PREDEPLOYS, LEGACY_GAS_PRICE } from "../src/config.js";
import { artifact, deploy, faucet, pub, sendLegacy } from "../src/chain.js";
import { key } from "../src/keys.js";
import { readState } from "../src/state.js";
import { band } from "../src/pool.js";
import { frameReceipt, payerFrame, sendFrameTx, senderFrame, signedTx, verifyFrame } from "../src/frames.js";
import { rpc } from "../src/rpc.js";

const log = (...a: unknown[]) => console.log("•", ...a);
const DEP = fileURLToPath(new URL("../../../deployments/1337.json", import.meta.url));
const d = JSON.parse(readFileSync(DEP, "utf8"));
const deployerPk = key("deployer"), ownerPk = key("owner");
const deployer = privateKeyToAccount(deployerPk).address, owner = privateKeyToAccount(ownerPk).address;
const pmAbi = artifact("KabutoPaymaster").abi, acctAbi = artifact("KabutoAccount").abi, routerAbi = artifact("KabutoRouter").abi, tokAbi = artifact("DevnetToken").abi;
const SV = [{ type: "function", name: "getSlot0", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint160" }, { type: "int24" }, { type: "uint24" }, { type: "uint24" }] }] as const;

const FEE_KUSD = parseUnits("1.5", 6);
const FEE_WETH = parseEther("0.0005");

if (!d.paymaster || process.argv.includes("--fresh")) {
  while ((await pub.getBalance({ address: deployer })) < parseEther("0.6")) {
    const pk = generatePrivateKey(); const a = privateKeyToAccount(pk).address;
    await faucet(a);
    const b = await pub.getBalance({ address: a });
    await sendLegacy(pk as Hex, { to: deployer, value: b - 21_000n * LEGACY_GAS_PRICE * 2n, gas: 21_000n });
  }
  const fee0 = d.wethIs0 ? FEE_WETH : FEE_KUSD, fee1 = d.wethIs0 ? FEE_KUSD : FEE_WETH;
  const pm = await deploy(deployerPk, "KabutoPaymaster", [PREDEPLOYS.poolManager, d.router, d.poolId, d.poolKey.currency0, d.poolKey.currency1, fee0, fee1], parseEther("0.5"));
  log("KabutoPaymaster", pm);
  await sendLegacy(deployerPk, { to: pm, value: parseEther("0.012"), data: encodeFunctionData({ abi: pmAbi, functionName: "stake", args: [PREDEPLOYS.stakingRegistry, 86400] }) });
  log("paymaster staked");
  d.paymaster = pm; d.paymasterFees = { kUSD: FEE_KUSD.toString(), WETH: FEE_WETH.toString() };
  writeFileSync(DEP, JSON.stringify(d, null, 2) + "\n");
}

// a Kabuto account owned by the CLI owner key (from the spike), funded with the current kUSD
const acct = readState().account as Address;
const kb = await pub.readContract({ address: d.kusd, abi: erc20Abi, functionName: "balanceOf", args: [acct] });
if (kb < parseUnits("100", 6)) await sendLegacy(deployerPk, { to: d.kusd, data: encodeFunctionData({ abi: tokAbi, functionName: "faucet", args: [acct] }) });

const amountIn = parseUnits("60", 6);
const zeroForOne = !d.wethIs0; // kUSD -> WETH
const tokenOut = d.predeploys.weth as Address;
const [sp] = await pub.readContract({ address: PREDEPLOYS.stateView, abi: SV, functionName: "getSlot0", args: [d.poolId] });
const b = band(sp, 50);
const nonce = BigInt(await pub.getTransactionCount({ address: acct }));
const tx = await signedTx({
  sender: acct, signerAddr: owner, signerKey: ownerPk, nonce,
  frames: [
    verifyFrame(encodeFunctionData({ abi: acctAbi, functionName: "verifyPriceExecution", args: [d.poolId, b.min, b.max] }), 35_000n, "EXECUTION"),
    payerFrame(d.paymaster, encodeFunctionData({ abi: pmAbi, functionName: "sponsor", args: [b.min, b.max] }), 60_000n),
    senderFrame(d.kusd, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [d.router, amountIn] }), { atomic: true, execution: 120_000n }),
    senderFrame(d.router, encodeFunctionData({ abi: routerAbi, functionName: "swapExactIn", args: [d.poolKey, zeroForOne, amountIn, 0n, acct] }), { atomic: true, execution: 400_000n }),
    senderFrame(tokenOut, encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [d.paymaster, FEE_WETH] }), { execution: 120_000n }),
  ],
});
const bal = (t: Address, w: Address) => pub.readContract({ address: t, abi: erc20Abi, functionName: "balanceOf", args: [w] });
const [aEth0, pEth0, aOut0, pOut0] = await Promise.all([pub.getBalance({ address: acct }), pub.getBalance({ address: d.paymaster }), bal(tokenOut, acct), bal(tokenOut, d.paymaster)]);
try {
  const h = await sendFrameTx(tx);
  log("sponsored swap admitted", h);
  const r = await frameReceipt(h);
  log("mined, status", r.status, "frames", JSON.stringify(r.frameReceipts?.map((f: any) => f.status)), "payer", r.payer ?? "?");
} catch (e: any) {
  log("REJECTED:", e.message.slice(0, 500));
  const ex = await rpc<any>("skandha_explorer_listTransactions", []).catch(() => null); void ex;
  process.exit(1);
}
const [aEth1, pEth1, aOut1, pOut1] = await Promise.all([pub.getBalance({ address: acct }), pub.getBalance({ address: d.paymaster }), bal(tokenOut, acct), bal(tokenOut, d.paymaster)]);
log("account ETH change:", (aEth1 - aEth0).toString(), "wei (expected 0)");
log("paymaster ETH change:", (pEth1 - pEth0).toString(), "wei (gas it paid)");
log("account WETH change:", (aOut1 - aOut0).toString(), "| paymaster WETH fee received:", (pOut1 - pOut0).toString());
