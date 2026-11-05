/** Deploy and prove the frame-aware v4 guard on the EF chain-1337 devnet. */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  concatHex, encodeDeployData, encodeFunctionData, erc20Abi, formatEther, getAddress, keccak256,
  maxUint256, parseEther, parseUnits, toHex, type Address, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { artifact, pub, wallet } from "./chain.js";
import { LEGACY_GAS_PRICE, PREDEPLOYS } from "./config.js";
import { band, poolId, POOL_KEY_ABI, type PoolKey } from "./pool.js";
import { frameReceipt, sendFrameTx, senderFrame, signedTx, verifyFrame } from "./frames.js";
import { key } from "./keys.js";
import { readState } from "./state.js";
import { rpc } from "./rpc.js";

const DEPLOYMENTS = fileURLToPath(new URL("../../../deployments/1337.json", import.meta.url));
const CREATE2_FACTORY = "0x4e59b44847b379578588920cA78FbF26c0B4956C" as Address;
const WETH_SEED = parseEther("0.02");
const TOPUP_WETH = parseEther("0.005");
const d = JSON.parse(readFileSync(DEPLOYMENTS, "utf8"));
const test = readState();
if (!test.account) throw new Error("Existing Kabuto test account is missing");

const deployerKey = key("deployer"), ownerKey = key("owner");
const deployer = privateKeyToAccount(deployerKey), owner = privateKeyToAccount(ownerKey);
const account = test.account as Address;
const routerAbi = artifact("KabutoRouter").abi;
const accountAbi = artifact("KabutoAccount").abi;
const tokenAbi = artifact("DevnetToken").abi;
const hookArtifact = artifact("KabutoGuardHook");
const SV = [{ type: "function", name: "getSlot0", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint160" }, { type: "int24" }, { type: "uint24" }, { type: "uint24" }] }] as const;
const PM = [{ type: "function", name: "initialize", stateMutability: "nonpayable", inputs: [POOL_KEY_ABI, { type: "uint160" }], outputs: [{ type: "int24" }] }] as const;
const WETH = [{ type: "function", name: "deposit", stateMutability: "payable", inputs: [], outputs: [] }] as const;

if (!(await pub.getCode({ address: account }))) throw new Error(`Trusted Kabuto account ${account} has no code`);
const accountManager = await pub.readContract({ address: account, abi: accountAbi, functionName: "poolManager" }) as Address;
const accountOwner = await pub.readContract({ address: account, abi: accountAbi, functionName: "owner" }) as Address;
if (accountManager.toLowerCase() !== PREDEPLOYS.poolManager.toLowerCase() || accountOwner.toLowerCase() !== owner.address.toLowerCase()) {
  throw new Error(`Trusted Kabuto account ${account} has unexpected manager or owner`);
}

async function explorer(hash: Hex) {
  try { return (await rpc<any>("skandha_explorer_getTransaction", [hash]))?.entry?.status ?? null; }
  catch (e: any) { return `error: ${e.message}`; }
}
async function printStatus(label: string, hash: Hex, receiptStatus: unknown) {
  console.log(label, JSON.stringify({ hash, receiptStatus, explorerStatus: await explorer(hash) }));
}
async function legacy(label: string, to: Address, data: Hex, value = 0n, fixedGas?: bigint) {
  const estimate = fixedGas ?? await pub.estimateGas({ account: deployer, to, data, value, gasPrice: LEGACY_GAS_PRICE });
  const gas = fixedGas ?? estimate * 3n / 2n + 50_000n;
  const hash = await wallet(deployerKey).sendTransaction({ to, data, value, gas, gasPrice: LEGACY_GAS_PRICE, type: "legacy" } as any);
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  await printStatus(label, hash, receipt.status);
  if (receipt.status !== "success") throw new Error(`${label} reverted: ${hash}`);
  return receipt;
}
async function slot0(id: Hex) {
  return (await pub.readContract({ address: PREDEPLOYS.stateView, abi: SV, functionName: "getSlot0", args: [id] }))[0];
}
async function balance(token: Address, holder: Address) {
  return pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [holder] });
}

let hookAddress: Address;
let guardKey: PoolKey;
let guardId: Hex;
if (d.guardHook && d.guardPoolKey && d.guardPoolId && !process.argv.includes("--fresh")) {
  hookAddress = d.guardHook;
  guardKey = d.guardPoolKey;
  guardId = d.guardPoolId;
  if (!(await pub.getCode({ address: hookAddress }))) throw new Error(`Recorded guard hook ${hookAddress} has no code`);
  console.log("resuming existing guard", hookAddress, guardId);
} else {
// Build the CREATE2 transaction and compute the worst-case cost before spending any deployer ETH.
const initCode = encodeDeployData({ abi: hookArtifact.abi, bytecode: hookArtifact.bytecode, args: [PREDEPLOYS.poolManager, 200] });
const initHash = keccak256(initCode);
let salt: Hex = "0x";
hookAddress = "0x0000000000000000000000000000000000000000";
for (let i = 0; ; ++i) {
  salt = toHex(i, { size: 32 });
  const hash = keccak256(concatHex(["0xff", CREATE2_FACTORY, salt, initHash]));
  const candidate = getAddress(`0x${hash.slice(-40)}`);
  if ((BigInt(candidate) & 0x3fffn) === 0x80n) { hookAddress = candidate; break; }
}
const deployData = concatHex([salt, initCode]);
const deployEstimate = await pub.estimateGas({ account: deployer, to: CREATE2_FACTORY, data: deployData, gasPrice: LEGACY_GAS_PRICE });
const deployGas = deployEstimate * 2n;
const available = await pub.getBalance({ address: deployer.address });
const required = deployGas * LEGACY_GAS_PRICE + WETH_SEED + parseEther("0.005");
console.log("deployer balance", deployer.address, formatEther(available), "ETH; minimum needed", formatEther(required), "ETH");
if (available < required) throw new Error(`Deployer ${deployer.address} needs ${formatEther(required - available)} ETH more`);
if (!(await pub.getCode({ address: CREATE2_FACTORY }))) throw new Error("CREATE2 factory is missing");

const deployHash = await wallet(deployerKey).sendTransaction({ to: CREATE2_FACTORY, data: deployData, gas: deployGas, gasPrice: LEGACY_GAS_PRICE, type: "legacy" } as any);
const deployReceipt = await pub.waitForTransactionReceipt({ hash: deployHash, timeout: 120_000 });
await printStatus("hook deployment", deployHash, deployReceipt.status);
if (deployReceipt.status !== "success" || !(await pub.getCode({ address: hookAddress }))) throw new Error(`Hook deployment failed: ${deployHash}`);
console.log("guard hook", hookAddress, "salt", salt, "flag bits", `0x${(BigInt(hookAddress) & 0x3fffn).toString(16)}`);

guardKey = { ...d.poolKey, hooks: hookAddress };
guardId = poolId(guardKey);
const mainPrice = await slot0(d.poolId);
console.log("main pool sqrtPriceX96", mainPrice.toString(), "guard pool id", guardId);
await legacy("guard pool initialize", PREDEPLOYS.poolManager, encodeFunctionData({ abi: PM, functionName: "initialize", args: [guardKey, mainPrice] }));

// Full-range L is approximately amount0 * sqrtP when WETH is currency0.
// Use only 80% of the wrapped amount so rounding and full-range endpoints leave a reserve.
const liquidity = WETH_SEED * mainPrice / (1n << 96n) * 8n / 10n;
if (liquidity == 0n) throw new Error("Calculated liquidity is zero");
await legacy("wrap WETH", PREDEPLOYS.weth, encodeFunctionData({ abi: WETH, functionName: "deposit" }), WETH_SEED, 300_000n);
await legacy("kUSD faucet", d.kusd, encodeFunctionData({ abi: tokenAbi, functionName: "faucet", args: [deployer.address] }));
const kusdNeeded = liquidity * mainPrice / (1n << 96n) * 2n;
while ((await balance(d.kusd, deployer.address)) < kusdNeeded) {
  await legacy("kUSD faucet", d.kusd, encodeFunctionData({ abi: tokenAbi, functionName: "faucet", args: [deployer.address] }));
}
for (const token of [PREDEPLOYS.weth, d.kusd] as Address[]) {
  const allowance = await pub.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [deployer.address, d.router] });
  if (allowance < (token.toLowerCase() === PREDEPLOYS.weth.toLowerCase() ? WETH_SEED : kusdNeeded)) {
    await legacy("approve liquidity token", token, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [d.router, maxUint256] }));
  }
}
await legacy("guard liquidity", d.router, encodeFunctionData({ abi: routerAbi, functionName: "modifyLiquidity", args: [guardKey, -887220, 887220, liquidity, toHex(0, { size: 32 })] }));
console.log("guard liquidity L", liquidity.toString());

// Set only the requested guard fields. Existing main pool and paymaster data remain intact.
d.guardHook = hookAddress;
d.guardPoolKey = guardKey;
d.guardPoolId = guardId;
writeFileSync(DEPLOYMENTS, JSON.stringify(d, null, 2) + "\n");
}

// Optional supplemental position, funded through the public kUSD faucet and WETH wrapping.
if (process.argv.includes("--topup")) {
  const available = await pub.getBalance({ address: deployer.address });
  const required = TOPUP_WETH + parseEther("0.002");
  console.log("topup deployer balance", deployer.address, formatEther(available), "ETH; minimum needed", formatEther(required), "ETH");
  if (available < required) throw new Error(`Deployer ${deployer.address} needs ${formatEther(required - available)} ETH more`);
  await legacy("wrap supplemental WETH", PREDEPLOYS.weth, encodeFunctionData({ abi: WETH, functionName: "deposit" }), TOPUP_WETH, 300_000n);
  await legacy("mint supplemental kUSD via faucet", d.kusd, encodeFunctionData({ abi: tokenAbi, functionName: "faucet", args: [deployer.address] }));
  const price = await slot0(guardId);
  const extraLiquidity = TOPUP_WETH * price / (1n << 96n) * 8n / 10n;
  await legacy("add supplemental guard liquidity", d.router, encodeFunctionData({ abi: routerAbi, functionName: "modifyLiquidity", args: [guardKey, -887220, 887220, extraLiquidity, toHex(0, { size: 32 })] }));
  console.log("supplemental guard liquidity L", extraLiquidity.toString());
  process.exit(0);
}

const amountIn = parseUnits("1", 6);
if ((await balance(d.kusd, account)) < amountIn) {
  await legacy("fund Kabuto account via kUSD faucet", d.kusd, encodeFunctionData({ abi: tokenAbi, functionName: "faucet", args: [account] }));
}
const current = await slot0(guardId);
const pin = band(current, 50);
const nonce = BigInt(await pub.getTransactionCount({ address: account }));
const tx = await signedTx({
  sender: account, signerAddr: owner.address, signerKey: ownerKey, nonce,
  maxFee: 5_000_000_000n, tip: 5_000_000_000n,
  frames: [
    verifyFrame(encodeFunctionData({ abi: accountAbi, functionName: "verifyPrice", args: [guardId, pin.min, pin.max] }), 90_000n),
    senderFrame(d.kusd, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [d.router, amountIn] }), { atomic: true, execution: 150_000n }),
    senderFrame(d.router, encodeFunctionData({ abi: routerAbi, functionName: "swapExactIn", args: [guardKey, !d.wethIs0, amountIn, 0n, account] }), { execution: 800_000n, state: 300_000n }),
  ],
});
const frameHash = await sendFrameTx(tx);
console.log("protected swap submitted", frameHash);
let frameResult: any;
try { frameResult = await frameReceipt(frameHash, 180_000); }
catch (e: any) { console.log("protected swap receipt wait", e.message); }
await printStatus("protected swap", frameHash, frameResult?.status ?? null);
if (frameResult?.status !== "0x1") throw new Error(`Protected swap did not mine successfully: ${frameHash}`);
let frameExplorer = await explorer(frameHash);
for (let i = 0; i < 30 && frameExplorer !== "OnChain"; ++i) {
  await new Promise((resolve) => setTimeout(resolve, 2000));
  frameExplorer = await explorer(frameHash);
}
console.log("protected swap final explorer status", frameExplorer);

// The same router path from an ordinary EOA must be rejected by the hook.
const legacySwapData = encodeFunctionData({ abi: routerAbi, functionName: "swapExactIn", args: [guardKey, !d.wethIs0, amountIn, 0n, deployer.address] });
try {
  await pub.estimateGas({ account: deployer, to: d.router, data: legacySwapData, gasPrice: LEGACY_GAS_PRICE });
  console.log("legacy swap estimate unexpectedly succeeded");
} catch (e: any) {
  console.log("legacy swap estimate refused", e.message.slice(0, 500));
}
const legacyHash = await wallet(deployerKey).sendTransaction({ to: d.router, data: legacySwapData, gas: 600_000n, gasPrice: LEGACY_GAS_PRICE, type: "legacy" } as any);
const legacyReceipt = await pub.waitForTransactionReceipt({ hash: legacyHash, timeout: 120_000 });
await printStatus("legacy swap", legacyHash, legacyReceipt.status);
if (legacyReceipt.status !== "reverted") throw new Error(`Plain legacy swap unexpectedly succeeded: ${legacyHash}`);
