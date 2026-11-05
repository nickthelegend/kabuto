/** Deploy a KabutoAccount owned by a P256 key and send a P256-signed frame tx on the devnet. */
import { encodeFunctionData, parseEther } from "viem";
import { newTx } from "@forshtat/hegota-support/tx";
import { artifact, deploy, pub } from "../src/chain.js";
import { key } from "../src/keys.js";
import { PREDEPLOYS, FRAME_MAX_FEE } from "../src/config.js";
import { frameReceipt, sendFrameTx, senderFrame, verifyFrame } from "../src/frames.js";
import { p256Address, p256Placeholder, randomP256Key, signP256 } from "../src/p256.js";

const priv = randomP256Key();
const owner = p256Address(priv);
console.log("• P256 owner address", owner);
const acct = await deploy(key("deployer"), "KabutoAccount", [owner, PREDEPLOYS.poolManager], parseEther("0.01"));
console.log("• account", acct);
const nonce = BigInt(await pub.getTransactionCount({ address: acct }));
const tx = newTx({
  chainId: 1337, sender: acct, nonceSeq: nonce, signatures: [p256Placeholder(owner)], fees: { maxFeePerGas: FRAME_MAX_FEE },
  frames: [
    verifyFrame(encodeFunctionData({ abi: artifact("KabutoAccount").abi, functionName: "verify" }), 60_000n),
    senderFrame("0x8943545177806ED17B9F23F0a21ee5948eCaa776", "0x", { value: 1n, execution: 50_000n }),
  ],
});
const h = await sendFrameTx(signP256(tx, priv));
const r = await frameReceipt(h);
console.log("• P256-signed frame tx", h, "status", r.status, "frames", JSON.stringify(r.frameReceipts?.map((f: any) => f.status)));
