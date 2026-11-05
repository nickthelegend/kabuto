/**
 * Deploys the shared Kabuto devnet stack to the public alt-mempool devnet (chain 1337) and writes
 * deployments/1337.json: kUSD (devnet test token with a public faucet), KabutoRouter, and a WETH/kUSD
 * Uniswap v4 pool on the predeployed PoolManager, seeded with ~3 WETH of full-range liquidity.
 * The faucet gives 1 ETH per address per hour, so helper keys are funded and swept into the deployer.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { encodeFunctionData, erc20Abi, maxUint256, parseEther, parseUnits, type Address, type Hex } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { PREDEPLOYS, LEGACY_GAS_PRICE } from "../src/config.js";
import { artifact, deploy, faucet, pub, sendLegacy } from "../src/chain.js";
import { key } from "../src/keys.js";
import { poolId, poolKey, sqrtPriceX96, POOL_KEY_ABI } from "../src/pool.js";

const log = (...a: unknown[]) => console.log("•", ...a);
const deployerPk = key("deployer");
const deployer = privateKeyToAccount(deployerPk).address;
const WETH_ABI = [{ type: "function", name: "deposit", stateMutability: "payable", inputs: [], outputs: [] }] as const;
const PM_ABI = [{ type: "function", name: "initialize", stateMutability: "nonpayable", inputs: [POOL_KEY_ABI, { name: "sqrtPriceX96", type: "uint160" }], outputs: [{ type: "int24" }] }] as const;
const router = artifact("KabutoRouter").abi, token = artifact("DevnetToken").abi;

const WETH_LIQ = parseEther(process.env.WETH_LIQ ?? "3");
const PRICE = 3000; // kUSD per WETH

// 1. collect ETH: faucet helper keys and sweep them into the deployer
let bal = await pub.getBalance({ address: deployer });
while (bal < WETH_LIQ + parseEther("0.2")) {
  const pk = generatePrivateKey();
  const a = privateKeyToAccount(pk).address;
  await faucet(a);
  const b = await pub.getBalance({ address: a });
  await sendLegacy(pk as Hex, { to: deployer, value: b - 21_000n * LEGACY_GAS_PRICE * 2n, gas: 21_000n });
  bal = await pub.getBalance({ address: deployer });
  log("deployer balance", Number(bal) / 1e18, "ETH");
}

// 2. contracts
const kusd = await deploy(deployerPk, "DevnetToken", ["Kabuto Devnet Dollar", "kUSD", 6, parseUnits("1000", 6)]);
log("kUSD", kusd);
const routerAddr = await deploy(deployerPk, "KabutoRouter", [PREDEPLOYS.poolManager]);
log("KabutoRouter", routerAddr);

// 3. pool
const k = poolKey(PREDEPLOYS.weth, kusd);
const wethIs0 = k.currency0.toLowerCase() === PREDEPLOYS.weth.toLowerCase();
const raw1per0 = wethIs0 ? (PRICE * 1e6) / 1e18 : 1e18 / (PRICE * 1e6);
await sendLegacy(deployerPk, { to: PREDEPLOYS.poolManager, data: encodeFunctionData({ abi: PM_ABI, functionName: "initialize", args: [k, sqrtPriceX96(raw1per0)] }) });
await sendLegacy(deployerPk, { to: PREDEPLOYS.weth, data: encodeFunctionData({ abi: WETH_ABI, functionName: "deposit" }), value: WETH_LIQ });
const kusdLiq = (WETH_LIQ * BigInt(PRICE) * 1_000_000n) / 10n ** 18n;
await sendLegacy(deployerPk, { to: kusd, data: encodeFunctionData({ abi: token, functionName: "mint", args: [deployer, kusdLiq * 2n] }) });
for (const t of [PREDEPLOYS.weth, kusd] as Address[]) await sendLegacy(deployerPk, { to: t, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [routerAddr, maxUint256] }) });
// full range: L = sqrt(x * y), slightly under so both sides cover it
const L = BigInt(Math.floor(Math.sqrt(Number(WETH_LIQ) * Number(kusdLiq)) * 0.98));
await sendLegacy(deployerPk, { to: routerAddr, data: encodeFunctionData({ abi: router, functionName: "modifyLiquidity", args: [k, -887220, 887220, L, ("0x" + "00".repeat(32)) as Hex] }) });
log("pool seeded: L =", L.toString());

const out = {
  chainId: 1337,
  gateway: "https://altmempoolgateway.forshtat.com/rpc",
  ethrex: "https://altmempool.forshtat.com",
  explorer: "https://explorer.altmempool.wtf/",
  predeploys: PREDEPLOYS,
  kusd, router: routerAddr, poolKey: k, poolId: poolId(k), wethIs0,
  deployedAt: new Date().toISOString(),
  block: Number(await pub.getBlockNumber()),
};
writeFileSync(fileURLToPath(new URL("../../../deployments/1337.json", import.meta.url)), JSON.stringify(out, null, 2) + "\n");
log("wrote deployments/1337.json");
