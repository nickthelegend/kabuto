import { decodeEventLog, encodeDeployData, encodeFunctionData, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { artifact, pub, wallet } from "./chain.js";
import { LEGACY_GAS_PRICE } from "./config.js";
import { frameReceipt, sendFrameTx, senderFrame, signedTx, verifyFrame } from "./frames.js";
import { key } from "./keys.js";
import { readState } from "./state.js";
import { rpc } from "./rpc.js";

const deployerKey = key("deployer");
const ownerKey = key("owner");
const deployer = privateKeyToAccount(deployerKey);
const owner = privateKeyToAccount(ownerKey);
const state = readState();
if (!state.account) throw new Error("Existing Kabuto test account missing");

const deployerBalance = await pub.getBalance({ address: deployer.address });
const accountBalance = await pub.getBalance({ address: state.account });
console.log("balances", { deployer: deployer.address, deployerEth: formatEther(deployerBalance), account: state.account, accountEth: formatEther(accountBalance) });
if (deployerBalance < 10_000_000_000_000_000n) throw new Error(`Deployer ${deployer.address} needs at least 0.01 ETH for probe deployment and calls`);
if (accountBalance < 1_000_000_000_000_000n) throw new Error(`Account ${state.account} needs at least 0.001 ETH for probe frames`);

const probe = artifact("FrameProbe");
const account = artifact("KabutoAccount");
const data = encodeDeployData({ abi: probe.abi, bytecode: probe.bytecode });
const estimate = await pub.estimateGas({ account: deployer, data, gasPrice: LEGACY_GAS_PRICE });
const deployHash = await wallet(deployerKey).sendTransaction({ data, gas: estimate * 2n, gasPrice: LEGACY_GAS_PRICE, type: "legacy" } as any);
const deployed = await pub.waitForTransactionReceipt({ hash: deployHash, timeout: 120_000 });
if (deployed.status !== "success" || !deployed.contractAddress) throw new Error(`probe deploy ${deployHash} failed: ${deployed.status}`);
const addr = deployed.contractAddress;
console.log("deployment", { hash: deployHash, address: addr, gasEstimate: estimate.toString(), receiptStatus: deployed.status });

function events(logs: any[]) {
  return logs.map((log) => {
    try {
      const decoded = decodeEventLog({ abi: probe.abi, data: log.data, topics: log.topics });
      return { name: decoded.eventName, args: decoded.args };
    } catch { return { data: log.data, topics: log.topics }; }
  });
}

async function frameCall(functionName: "emitReading" | "emitCaught") {
  const nonce = BigInt(await pub.getTransactionCount({ address: state.account }));
  const tx = await signedTx({
    sender: state.account, signerAddr: owner.address, signerKey: ownerKey, nonce,
    maxFee: 5_000_000_000n, tip: 5_000_000_000n,
    frames: [
      verifyFrame(encodeFunctionData({ abi: account.abi, functionName: "verify" }), 80_000n),
      senderFrame(addr, encodeFunctionData({ abi: probe.abi, functionName }), { execution: 250_000n, state: 250_000n }),
    ],
  });
  const hash = await sendFrameTx(tx);
  const receipt = await frameReceipt(hash, 180_000);
  const explorer = await rpc<any>("skandha_explorer_getTransaction", [hash]);
  console.log("frame", functionName, JSON.stringify({ hash, receiptStatus: receipt.status, frameReceipts: receipt.frameReceipts, explorerStatus: explorer?.entry?.status, events: events(receipt.logs ?? []) }, (_k, v) => typeof v === "bigint" ? v.toString() : v));
}

async function legacyCall(functionName: "emitReading" | "emitCaught") {
  const hash = await wallet(deployerKey).sendTransaction({
    to: addr, data: encodeFunctionData({ abi: probe.abi, functionName }), gas: 300_000n,
    gasPrice: LEGACY_GAS_PRICE, type: "legacy",
  } as any);
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  console.log("legacy", functionName, JSON.stringify({ hash, receiptStatus: receipt.status, gasUsed: receipt.gasUsed, events: events(receipt.logs ?? []) }, (_k, v) => typeof v === "bigint" ? v.toString() : v));
}

await frameCall("emitReading");
await frameCall("emitCaught");
await legacyCall("emitCaught");
await legacyCall("emitReading");
