import { decodeEventLog, encodeFunctionData, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { artifact, pub } from "./chain.js";
import { frameReceipt, sendFrameTx, senderFrame, signedTx, verifyFrame } from "./frames.js";
import { key } from "./keys.js";
import { readState } from "./state.js";
import { rpc } from "./rpc.js";

const probeAddress = process.argv[2] as Address | undefined;
if (!probeAddress) throw new Error("Usage: tsx src/probe-baseline.ts <deployed-probe-address>");
const functionName = (process.argv[3] ?? "emitReading") as "emitReading" | "emitCaught" | "inspect" | "lastSucceeded";
const state = readState();
const ownerKey = key("owner");
const owner = privateKeyToAccount(ownerKey).address;
const account = artifact("KabutoAccount");
const probe = artifact("FrameProbe");
for (const call of [functionName]) {
  const nonce = BigInt(await pub.getTransactionCount({ address: state.account }));
  const tx = await signedTx({
    sender: state.account, signerAddr: owner, signerKey: ownerKey, nonce, maxFee: 5_000_000_000n, tip: 5_000_000_000n,
    frames: [
      verifyFrame(encodeFunctionData({ abi: account.abi, functionName: "verify" }), 80_000n),
      senderFrame(probeAddress, encodeFunctionData({ abi: probe.abi, functionName: call }), { execution: 100_000n, state: 100_000n }),
    ],
  });
  const hash = await sendFrameTx(tx);
  console.log(call, "hash", hash);
  const r = await frameReceipt(hash, 180_000);
  const ex = await rpc<any>("skandha_explorer_getTransaction", [hash]);
  const events = (r.logs ?? []).map((log: any) => {
    try { return decodeEventLog({ abi: probe.abi, data: log.data, topics: log.topics }); }
    catch { return log; }
  });
  console.log(call, JSON.stringify({ receiptStatus: r.status, frameStatuses: r.frameReceipts?.map((f: any) => f.status), explorerStatus: ex?.entry?.status, events }, (_k, v) => typeof v === "bigint" ? v.toString() : v));
}
