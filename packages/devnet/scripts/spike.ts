/**
 * Spike: prove on the public EIP-8141 devnet that a Kabuto account's VERIFY frame can pin a Uniswap v4 price.
 *   1. a price-pinned swap inside the band is admitted by the alt-mempool and mined (atomic approve+swap batch)
 *   2. after a bot moves the price, the same kind of tx is refused at admission: the user pays 0 gas
 */
import { encodeFunctionData, erc20Abi, maxUint256, parseEther, parseUnits, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { PREDEPLOYS, MIN_STAKE } from "../src/config.js";
import { artifact, deploy, ensureFunded, pub, sendLegacy } from "../src/chain.js";
import { key } from "../src/keys.js";
import { readState, writeState } from "../src/state.js";
import { band, poolId, poolKey, sqrtPriceX96, POOL_KEY_ABI } from "../src/pool.js";
import { frameReceipt, hashOf, sendFrameTx, senderFrame, signedTx, verifyFrame } from "../src/frames.js";
import { rpc } from "../src/rpc.js";

const log = (...a: unknown[]) => console.log("•", ...a);
const deployerPk = key("deployer"), ownerPk = key("owner"), botPk = key("bot");
const deployer = privateKeyToAccount(deployerPk).address, owner = privateKeyToAccount(ownerPk).address, bot = privateKeyToAccount(botPk).address;

const router = artifact("KabutoRouter").abi, account = artifact("KabutoAccount").abi, token = artifact("DevnetToken").abi;
const WETH_ABI = [{ type: "function", name: "deposit", stateMutability: "payable", inputs: [], outputs: [] }] as const;
const PM_ABI = [{ type: "function", name: "initialize", stateMutability: "nonpayable", inputs: [POOL_KEY_ABI, { name: "sqrtPriceX96", type: "uint160" }], outputs: [{ type: "int24" }] }] as const;
const STATEVIEW_ABI = [{ type: "function", name: "getSlot0", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint160" }, { type: "int24" }, { type: "uint24" }, { type: "uint24" }] }] as const;
const STAKE_ABI = [{ type: "function", name: "addStake", stateMutability: "payable", inputs: [{ type: "uint32" }], outputs: [] }] as const;

async function slot0(id: Hex) {
  const [p] = await pub.readContract({ address: PREDEPLOYS.stateView, abi: STATEVIEW_ABI, functionName: "getSlot0", args: [id] });
  return p;
}

async function setup() {
  const s = readState();
  if (s.account && (await pub.getCode({ address: s.account }))) return s;
  log("funding deployer / owner / bot from the faucet");
  await ensureFunded(deployer, parseEther("0.6"));
  await ensureFunded(bot, parseEther("0.1"));
  log("deploying kUSD (devnet test token), router");
  const kusd = await deploy(deployerPk, "DevnetToken", ["Kabuto Devnet Dollar", "kUSD", 6, parseUnits("1000", 6)]);
  const routerAddr = await deploy(deployerPk, "KabutoRouter", [PREDEPLOYS.poolManager]);
  const key0 = poolKey(PREDEPLOYS.weth, kusd);
  const wethIs0 = key0.currency0.toLowerCase() === PREDEPLOYS.weth.toLowerCase();
  // 1 WETH = 3000 kUSD
  const raw1per0 = wethIs0 ? 3000e6 / 1e18 : 1e18 / 3000e6;
  log("initializing WETH/kUSD v4 pool at 3000 kUSD per WETH");
  await sendLegacy(deployerPk, { to: PREDEPLOYS.poolManager, data: encodeFunctionData({ abi: PM_ABI, functionName: "initialize", args: [key0, sqrtPriceX96(raw1per0)] }) });
  log("adding liquidity (0.4 WETH + ~1200 kUSD, full range)");
  await sendLegacy(deployerPk, { to: PREDEPLOYS.weth, data: encodeFunctionData({ abi: WETH_ABI, functionName: "deposit" }), value: parseEther("0.45") });
  await sendLegacy(deployerPk, { to: kusd, data: encodeFunctionData({ abi: token, functionName: "mint", args: [deployer, parseUnits("1000000", 6)] }) });
  for (const t of [PREDEPLOYS.weth, kusd] as Address[]) await sendLegacy(deployerPk, { to: t, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [routerAddr, maxUint256] }) });
  // L = sqrt(x*y) for full range: sqrt(0.4e18 * 1200e6) ~= 2.19e13
  await sendLegacy(deployerPk, { to: routerAddr, data: encodeFunctionData({ abi: router, functionName: "modifyLiquidity", args: [key0, -887220, 887220, 21_900_000_000_000n, "0x" + "00".repeat(32) as Hex] }) });
  log("deploying KabutoAccount for the owner key, funded 0.05 ETH");
  const acct = await deploy(deployerPk, "KabutoAccount", [owner, PREDEPLOYS.poolManager], parseEther("0.05"));
  log("minting 5000 kUSD to the account and 100000 kUSD to the bot");
  await sendLegacy(deployerPk, { to: kusd, data: encodeFunctionData({ abi: token, functionName: "mint", args: [acct, parseUnits("5000", 6)] }) });
  await sendLegacy(deployerPk, { to: kusd, data: encodeFunctionData({ abi: token, functionName: "mint", args: [bot, parseUnits("100000", 6)] }) });
  const st = { kusd, router: routerAddr, poolKey: key0, poolId: poolId(key0), wethIs0, account: acct };
  writeState(st);
  return st;
}

async function stake(acct: Address) {
  const nonce = BigInt(await pub.getTransactionCount({ address: acct }));
  const tx = await signedTx({
    sender: acct, signerAddr: owner, signerKey: ownerPk, nonce,
    frames: [
      verifyFrame(encodeFunctionData({ abi: account, functionName: "verify" }), 80_000n),
      senderFrame(PREDEPLOYS.stakingRegistry, encodeFunctionData({ abi: STAKE_ABI, functionName: "addStake", args: [86400] }), { value: MIN_STAKE + parseEther("0.002"), state: 300_000n }),
    ],
  });
  const h = await sendFrameTx(tx);
  const r = await frameReceipt(h);
  log("staked:", h, "status", r.status);
}

async function pinnedSwap(s: any, bps: number, amountKusd: string, minSqrt?: bigint, maxSqrt?: bigint) {
  const acct = s.account as Address;
  const cur = await slot0(s.poolId);
  const b = minSqrt !== undefined ? { min: minSqrt, max: maxSqrt! } : band(cur, bps);
  const nonce = BigInt(await pub.getTransactionCount({ address: acct }));
  const amountIn = parseUnits(amountKusd, 6);
  const zeroForOne = !s.wethIs0; // kUSD -> WETH
  const tx = await signedTx({
    sender: acct, signerAddr: owner, signerKey: ownerPk, nonce,
    frames: [
      verifyFrame(encodeFunctionData({ abi: account, functionName: "verifyPrice", args: [s.poolId, b.min, b.max] }), 90_000n),
      senderFrame(s.kusd, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [s.router, amountIn] }), { atomic: true }),
      senderFrame(s.router, encodeFunctionData({ abi: router, functionName: "swapExactIn", args: [s.poolKey, zeroForOne, amountIn, 0n, acct] }), { execution: 400_000n }),
    ],
  });
  return { tx, band: b, cur };
}

async function botMovePrice(s: any, kusdAmount: string) {
  const zeroForOne = !s.wethIs0;
  await sendLegacy(botPk, { to: s.kusd, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [s.router, maxUint256] }) });
  await sendLegacy(botPk, { to: s.router, data: encodeFunctionData({ abi: router, functionName: "swapExactIn", args: [s.poolKey, zeroForOne, parseUnits(kusdAmount, 6), 0n, bot] }) });
}

const s = await setup();
log("state:", { account: s.account, kusd: s.kusd, router: s.router, poolId: s.poolId });
const staked = await rpc<any>("skandha_explorer_listReputation", []).catch(() => null);
if (!readState().staked) { await stake(s.account); writeState({ staked: true }); }

log("slot0 sqrtPriceX96 =", (await slot0(s.poolId)).toString());

// 1. in-band pinned swap: admitted and mined
const ok = await pinnedSwap(s, 50, "30");
const okBal0 = await pub.getBalance({ address: s.account });
try {
  const h = await sendFrameTx(ok.tx);
  const r = await frameReceipt(h);
  log("IN-BAND swap mined:", h, "status", r.status, "frames", JSON.stringify(r.frameReceipts?.map((f: any) => f.status)));
} catch (e: any) { log("IN-BAND swap FAILED:", e.message); }

// 2. sign a pinned swap, then a bot moves the price, then submit: refused, 0 gas
const pinned = await pinnedSwap(s, 50, "30");
log("signed a swap pinned to +-0.5%; bot now buys WETH with 400 kUSD (moves price ~ +60%... of a small pool)");
await botMovePrice(s, "60");
log("slot0 after bot =", (await slot0(s.poolId)).toString(), "band", pinned.band.min.toString(), "-", pinned.band.max.toString());
const bal0 = await pub.getBalance({ address: s.account });
try {
  const h = await sendFrameTx(pinned.tx);
  log("UNEXPECTED: out-of-band tx admitted", h);
  const r = await frameReceipt(h, 30_000).catch((e) => e.message);
  log(r);
} catch (e: any) {
  log("OUT-OF-BAND swap refused at admission:", e.message.slice(0, 400));
}
const bal1 = await pub.getBalance({ address: s.account });
log("account ETH before/after refused tx:", bal0.toString(), bal1.toString(), bal0 === bal1 ? "(paid 0 gas)" : "(CHANGED)");
void okBal0; void staked; void hashOf;
