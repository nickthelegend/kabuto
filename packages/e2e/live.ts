import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { encodeFunctionData, encodeDeployData, erc20Abi, parseEther, parseUnits, maxUint256, type Address, type Hex } from "viem";
import { privateKeyToAccount, sign } from "viem/accounts";
import { frame, newTx, signTx } from "@forshtat/hegota-support/tx";
import { profile, frameReceipt, sendFrameTx, senderFrame, signedTx, verifyFrame, payerFrame } from "../devnet/src/frames.js";
import { artifact, pub, sendLegacy, wallet } from "../devnet/src/chain.js";
import { PREDEPLOYS, FRAME_MAX_FEE, MIN_STAKE, LEGACY_GAS_PRICE } from "../devnet/src/config.js";
import { key } from "../devnet/src/keys.js";
import { band } from "../devnet/src/pool.js";
import { rpc } from "../devnet/src/rpc.js";
import { p256Address, p256Placeholder, signP256 } from "../devnet/src/p256.js";

export const d = JSON.parse(readFileSync(fileURLToPath(new URL("../../deployments/1337.json", import.meta.url)), "utf8"));
export const A = artifact("KabutoAccount").abi, F = artifact("KabutoFiller").abi;
export const R = artifact("KabutoRouter").abi, P = artifact("KabutoPaymaster").abi, T = artifact("DevnetToken").abi;
export const roles = Object.fromEntries(["test-deployer", "test-owner", "test-owner2", "test-filler", "test-attacker", "test-bot"].map(r => [r, { pk: key(r), address: privateKeyToAccount(key(r)).address }] )) as Record<string, { pk: Hex; address: Address }>;
export const zeroForOne = !d.wethIs0;
export const tokenOut = PREDEPLOYS.weth;
export const SV = [{ type: "function", name: "getSlot0", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint160" }, { type: "int24" }, { type: "uint24" }, { type: "uint24" }] }] as const;
export const QUOTER = "0xeEa49CC6419125E2f706bf7f95Cf34ac7e93087D" as Address;
export const QUOTER_ABI = [{ type: "function", name: "quoteExactInputSingle", stateMutability: "nonpayable", inputs: [{ type: "tuple", name: "p", components: [{ type: "tuple", name: "poolKey", components: [{ name: "currency0", type: "address" }, { name: "currency1", type: "address" }, { name: "fee", type: "uint24" }, { name: "tickSpacing", type: "int24" }, { name: "hooks", type: "address" }] }, { name: "zeroForOne", type: "bool" }, { name: "exactAmount", type: "uint128" }, { name: "hookData", type: "bytes" }] }], outputs: [{ type: "uint256" }, { type: "uint256" }] }] as const;
const STAKE = [{ type: "function", name: "addStake", stateMutability: "payable", inputs: [{ type: "uint32" }], outputs: [] }] as const;
export const balance = (token: Address, who: Address, blockNumber?: bigint) => pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [who], blockNumber });
export const slot0 = async () => (await pub.readContract({ address: PREDEPLOYS.stateView, abi: SV, functionName: "getSlot0", args: [d.poolId] }))[0];

const file = fileURLToPath(new URL(`out/run-${new Date().toISOString().replace(/[:.]/g, "-")}.json`, import.meta.url));
const record: { startedAt: string; chainId: number; cases: { name: string; hashes: Hex[]; status: string; gas?: string; error?: string }[] } = { startedAt: new Date().toISOString(), chainId: 1337, cases: [] };
export function saveCase(name: string, hashes: Hex[], status: string, gas?: bigint, error?: string) {
  record.cases.push({ name, hashes, status, gas: gas?.toString(), error });
  mkdirSync(fileURLToPath(new URL("out/", import.meta.url)), { recursive: true });
  writeFileSync(file, JSON.stringify(record, null, 2) + "\n");
}
export const runFile = file;
async function fund(address: Address, minimum: bigint) {
  if (await pub.getBalance({ address }) >= minimum) return;
  const result = await rpc<any>("skandha_explorer_faucet", [address]);
  const hash = typeof result === "string" ? result : result?.transactionHash ?? result?.hash;
  if (typeof hash === "string" && /^0x[0-9a-fA-F]{64}$/.test(hash)) saveCase("setup-faucet", [hash as Hex], "submitted");
  for (let i = 0; i < 60; i++) {
    if (await pub.getBalance({ address }) >= minimum) return;
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error(`faucet did not fund ${address} above ${minimum} within 120 s`);
}
export async function sendRecorded(name: string, tx: Parameters<typeof sendFrameTx>[0]) {
  const h = await sendFrameTx(tx);
  saveCase(`${name}-submitted`, [h], "submitted");
  return h;
}
export async function receiptRecorded(name: string, h: Hex, timeoutMs = 120_000) {
  try { return await frameReceipt(h, timeoutMs); }
  catch (e: any) {
    const explorer = await rpc<any>("skandha_explorer_getTransaction", [h]).catch(() => null);
    saveCase(name, [h], explorer?.entry?.status ?? "timeout", undefined, e.message);
    throw e;
  }
}
async function legacyRecorded(name: string, pk: Hex, tx: { to?: Address; data?: Hex; value?: bigint; gas?: bigint }) {
  try {
    const receipt = await sendLegacy(pk, tx);
    saveCase(name, [receipt.transactionHash], receipt.status, receipt.gasUsed);
    return receipt;
  } catch (e: any) {
    const hash = /0x[0-9a-fA-F]{64}/.exec(e.message)?.[0] as Hex | undefined;
    if (hash) saveCase(name, [hash], "failed", undefined, e.message);
    throw e;
  }
}
async function deployRecorded(pk: Hex, name: string, args: unknown[], value: bigint): Promise<Address> {
  const { abi, bytecode } = artifact(name);
  const data = encodeDeployData({ abi, bytecode, args });
  const est = await pub.estimateGas({ account: privateKeyToAccount(pk), data, value, gasPrice: LEGACY_GAS_PRICE });
  const receipt = await legacyRecorded(`setup-deploy-${name}`, pk, { data, value, gas: est * 2n > 30_000_000n ? 30_000_000n : est * 2n });
  if (!receipt.contractAddress) throw new Error(`${name} deployment had no contract address`);
  return receipt.contractAddress;
}

const fixtureFile = fileURLToPath(new URL("out/fixture.json", import.meta.url));
type Fixture = { account: Address; account2: Address; filler: Address; intentAccount?: Address; underpayAccount?: Address };
let setupCache: Fixture | undefined;
export async function setup() {
  if (setupCache) return setupCache;
  if (process.env.KABUTO_REUSE_FIXTURE === "1" && existsSync(fixtureFile)) {
    const old = JSON.parse(readFileSync(fixtureFile, "utf8")) as Fixture;
    if (await pub.getCode({ address: old.account }) && await pub.getCode({ address: old.account2 }) && await pub.getCode({ address: old.filler })) return (setupCache = old);
  }
  const deployer = roles["test-deployer"], owner = roles["test-owner"], owner2 = roles["test-owner2"];
  await fund(deployer.address, parseEther("0.3"));
  if (await pub.getBalance({ address: roles["test-bot"].address }) < parseEther("0.05")) {
    await legacyRecorded("setup-fund-bot", deployer.pk, { to: roles["test-bot"].address, value: parseEther("0.07") });
  }
  const account = await deployRecorded(deployer.pk, "KabutoAccount", [owner.address, PREDEPLOYS.poolManager], parseEther("0.06"));
  const account2 = await deployRecorded(deployer.pk, "KabutoAccount", [owner2.address, PREDEPLOYS.poolManager], parseEther("0.06"));
  const filler = await deployRecorded(deployer.pk, "KabutoFiller", [PREDEPLOYS.poolManager, roles["test-filler"].address], parseEther("0.1"));
  for (const a of [account, account2]) {
    await legacyRecorded("setup-kusd", deployer.pk, { to: d.kusd, data: encodeFunctionData({ abi: T, functionName: "faucet", args: [a] }) });
  }
  await legacyRecorded("setup-kusd-bot", deployer.pk, { to: d.kusd, data: encodeFunctionData({ abi: T, functionName: "faucet", args: [roles["test-bot"].address] }) });
  // Staking permits the account's VERIFY frame to read PoolManager slot0.
  for (const [a, o] of [[account, owner], [account2, owner2]] as const) {
    const nonce = BigInt(await pub.getTransactionCount({ address: a }));
    const tx = await signedTx({ sender: a, signerAddr: o.address, signerKey: o.pk, nonce, frames: [
      verifyFrame(encodeFunctionData({ abi: A, functionName: "verify" }), 60_000n),
      senderFrame(PREDEPLOYS.stakingRegistry, encodeFunctionData({ abi: STAKE, functionName: "addStake", args: [86400] }), { value: MIN_STAKE + 1n, execution: 150_000n }),
    ] });
    const h = await sendRecorded("setup-stake", tx); const r = await receiptRecorded("setup-stake", h);
    saveCase("setup-stake", [h], r.status, BigInt(r.gasUsed ?? 0));
    if (r.status !== "0x1") throw new Error(`stake ${h} failed: ${JSON.stringify(r.frameReceipts)}`);
  }
  setupCache = { account, account2, filler };
  writeFileSync(fixtureFile, JSON.stringify(setupCache, null, 2) + "\n");
  return setupCache;
}

export async function freshIntentAccount(which: "intentAccount" | "underpayAccount") {
  const fixture = await setup();
  if (fixture[which] && await pub.getCode({ address: fixture[which] })) return fixture[which];
  const deployer = roles["test-deployer"];
  const a = await deployRecorded(deployer.pk, "KabutoAccount", [roles["test-owner"].address, PREDEPLOYS.poolManager], 0n);
  await legacyRecorded(`setup-${which}-kusd`, deployer.pk, { to: d.kusd, data: encodeFunctionData({ abi: T, functionName: "faucet", args: [a] }) });
  fixture[which] = a;
  writeFileSync(fixtureFile, JSON.stringify(fixture, null, 2) + "\n");
  return a;
}

export async function newSoakAccount() {
  const deployer = roles["test-deployer"], owner = roles["test-owner"];
  const a = await deployRecorded(deployer.pk, "KabutoAccount", [owner.address, PREDEPLOYS.poolManager], parseEther("0.03"));
  await legacyRecorded("soak-kusd", deployer.pk, { to: d.kusd, data: encodeFunctionData({ abi: T, functionName: "faucet", args: [a] }), gas: 300_000n });
  const nonce = BigInt(await pub.getTransactionCount({ address: a }));
  const tx = await signedTx({ sender: a, signerAddr: owner.address, signerKey: owner.pk, nonce, frames: [
    verifyFrame(encodeFunctionData({ abi: A, functionName: "verify" }), 60_000n),
    senderFrame(PREDEPLOYS.stakingRegistry, encodeFunctionData({ abi: STAKE, functionName: "addStake", args: [86400] }), { value: MIN_STAKE + 1n, execution: 150_000n }),
  ] });
  const h = await sendRecorded("soak-stake", tx), r = await receiptRecorded("soak-stake", h);
  saveCase("soak-stake", [h], r.status, BigInt(r.gasUsed ?? 0));
  if (r.status !== "0x1") throw new Error(`soak stake ${h} failed`);
  return a;
}

export async function protectedTx(account: Address, o: { pk: Hex; address: Address }, amountIn = parseUnits("30", 6)) {
  const b = band(await slot0(), 50);
  return signedTx({ sender: account, signerAddr: o.address, signerKey: o.pk, nonce: BigInt(await pub.getTransactionCount({ address: account })), frames: [
    verifyFrame(encodeFunctionData({ abi: A, functionName: "verifyPrice", args: [d.poolId, b.min, b.max] }), 90_000n),
    senderFrame(d.kusd, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [d.router, amountIn] }), { atomic: true, execution: 100_000n }),
    senderFrame(d.router, encodeFunctionData({ abi: R, functionName: "swapExactIn", args: [d.poolKey, zeroForOne, amountIn, 0n, account] }), { execution: 400_000n }),
  ] });
}

export async function sendBotSwap(amountIn = parseUnits("60", 6), gasPrice = LEGACY_GAS_PRICE) {
  const bot = roles["test-bot"];
  const allowance = await pub.readContract({ address: d.kusd, abi: erc20Abi, functionName: "allowance", args: [bot.address, d.router] });
  if (allowance < amountIn) await legacyRecorded("setup-bot-approve", bot.pk, { to: d.kusd, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [d.router, maxUint256] }) });
  const data = encodeFunctionData({ abi: R, functionName: "swapExactIn", args: [d.poolKey, zeroForOne, amountIn, 0n, bot.address] });
  const gas = (await pub.estimateGas({ account: privateKeyToAccount(bot.pk), to: d.router, data })) * 2n;
  const h = await wallet(bot.pk).sendTransaction({ to: d.router, data, gas, gasPrice, type: "legacy" } as any);
  saveCase("bot-swap-submitted", [h], "submitted");
  return h;
}
export async function botSwap(amountIn = parseUnits("60", 6), gasPrice = LEGACY_GAS_PRICE) {
  const h = await sendBotSwap(amountIn, gasPrice);
  const r = await pub.waitForTransactionReceipt({ hash: h, timeout: 120_000 });
  if (r.status !== "success") throw new Error(`bot swap ${h} reverted`);
  return { h, r };
}

export async function intentTx(account: Address, filler: Address, attack?: "extra-sender" | "over-max" | "no-atomic" | "underpay") {
  const owner = roles["test-owner"], operator = roles["test-filler"], attacker = roles["test-attacker"];
  const amountIn = parseUnits("50", 6);
  const [{ result: quote }, nonce, block, balanceBefore] = await Promise.all([
    pub.simulateContract({ address: QUOTER, abi: QUOTER_ABI, functionName: "quoteExactInputSingle", args: [{ poolKey: d.poolKey, zeroForOne, exactAmount: amountIn, hookData: "0x" }] }),
    pub.getTransactionCount({ address: account }), pub.getBlock(), balance(tokenOut, account),
  ]);
  const intent = { tokenIn: d.kusd as Address, maxIn: amountIn, tokenOut: tokenOut as Address, startOut: quote[0] * 995n / 1000n, endOut: quote[0] * 980n / 1000n, startTime: block.timestamp, deadline: block.timestamp + 600n, nonce: BigInt(nonce) };
  const digest = await pub.readContract({ address: account, abi: A, functionName: "intentDigest", args: [intent] }) as Hex;
  const sig = await sign({ hash: digest, privateKey: owner.pk });
  const userSig = `0x${(sig.yParity ?? Number(sig.v) - 27).toString(16).padStart(2, "0")}${sig.r.slice(2)}${sig.s.slice(2)}` as Hex;
  const Fm = (mode: "VERIFY" | "SENDER" | "DEFAULT", opts: any) => frame(profile, mode, opts);
  const frames = [
    Fm("VERIFY", { scope: "EXECUTION", target: null, execution: 82_000n, data: encodeFunctionData({ abi: A, functionName: "verifyIntent", args: [intent] }) }),
    Fm("VERIFY", { scope: "PAYMENT", target: filler, execution: 12_000n, data: encodeFunctionData({ abi: F, functionName: "pay" }) }),
    Fm("SENDER", { target: d.kusd, execution: 80_000n, state: 100_000n, flags: attack === "no-atomic" ? 0 : 4, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [filler, attack === "over-max" ? amountIn + 1n : amountIn] }) }),
    ...(attack === "extra-sender" ? [Fm("SENDER", { target: d.kusd, execution: 80_000n, state: 100_000n, flags: 4, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [attacker.address, parseUnits("100", 6)] }) })] : []),
    Fm("DEFAULT", { target: filler, execution: 400_000n, state: 200_000n, flags: 4, data: encodeFunctionData({ abi: F, functionName: "fill", args: [d.poolKey, zeroForOne, amountIn, account, attack === "underpay" ? intent.endOut / 2n : intent.startOut] }) }),
    Fm("SENDER", { target: null, execution: 80_000n, data: encodeFunctionData({ abi: A, functionName: "settleIntent", args: [intent.tokenOut, balanceBefore, intent.startOut, intent.endOut, intent.startTime, intent.deadline] }) }),
  ];
  let tx = newTx({ chainId: 1337, sender: account, nonceSeq: intent.nonce, frames, signatures: [
    { scheme: profile.sigSchemes.SECP256K1, signer: owner.address, msg: digest, signature: userSig },
    { scheme: profile.sigSchemes.SECP256K1, signer: operator.address, msg: "0x", signature: "0x" },
  ], fees: { maxFeePerGas: FRAME_MAX_FEE, maxPriorityFeePerGas: 100_000_000n } });
  tx = await signTx(profile, tx, operator.pk, 1);
  return { tx, intent, balanceBefore };
}

export async function p256Case(): Promise<Hex> {
  const priv = roles["test-owner2"].pk, owner = p256Address(priv);
  const account = await deployRecorded(roles["test-deployer"].pk, "KabutoAccount", [owner, PREDEPLOYS.poolManager], parseEther("0.01"));
  const tx = newTx({ chainId: 1337, sender: account, nonceSeq: BigInt(await pub.getTransactionCount({ address: account })), signatures: [p256Placeholder(owner)], fees: { maxFeePerGas: 10_000_000_000n, maxPriorityFeePerGas: 10_000_000_000n }, frames: [
    verifyFrame(encodeFunctionData({ abi: A, functionName: "verify" }), 60_000n),
    senderFrame(roles["test-owner2"].address, "0x", { value: 1n, execution: 50_000n }),
  ] });
  return sendRecorded("p256", signP256(tx, priv));
}
