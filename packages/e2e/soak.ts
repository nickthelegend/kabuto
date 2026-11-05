import { parseUnits, type Hex } from "viem";
import { pub } from "../devnet/src/chain.js";
import { roles, setup, newSoakAccount, protectedTx, intentTx, saveCase, sendRecorded, receiptRecorded } from "./live.js";

const n = Number(process.argv[2] ?? 20);
if (!Number.isInteger(n) || n < 1) throw new Error("soak count must be a positive integer");
if (await pub.getChainId() !== 1337) throw new Error("wrong chain: expected public devnet 1337");
process.env.KABUTO_REUSE_FIXTURE ??= "1";
let account, filler;
try { ({ filler } = await setup()); account = await newSoakAccount(); }
catch (e: any) {
  saveCase("soak-setup", [], "failed", undefined, e.message);
  console.table([{ round: 0, kind: "setup", outcome: "FAILED", gas: "—", hash: "—" }]);
  throw e;
}
const rows: { round: number; kind: string; outcome: string; gas: string; hash: string }[] = [];
for (let round = 1; round <= n; round++) {
  const kind = round % 3 === 1 ? "protected" : round % 3 === 2 ? "intent" : "attack";
  let hash: Hex | undefined;
  try {
    if (kind === "protected") {
      hash = await sendRecorded(`soak-${round}-protected`, await protectedTx(account, roles["test-owner"], parseUnits("5", 6)));
    } else {
      const { tx } = await intentTx(account, filler, kind === "attack" ? "over-max" : undefined);
      hash = await sendRecorded(`soak-${round}-${kind}`, tx);
    }
    if (kind === "attack") throw new Error(`attack unexpectedly admitted: ${hash}`);
    const receipt = await receiptRecorded(`soak-${round}-${kind}`, hash);
    const outcome = receipt.status === "0x1" ? "mined" : "reverted";
    const gas = BigInt(receipt.gasUsed ?? 0);
    saveCase(`soak-${round}-${kind}`, [hash], outcome, gas);
    rows.push({ round, kind, outcome, gas: gas.toString(), hash });
    if (outcome !== "mined") throw new Error(`${kind} ${hash} ${outcome}`);
  } catch (e: any) {
    if (kind === "attack" && !hash) {
      saveCase(`soak-${round}-attack`, [], "refused", 0n, e.message);
      rows.push({ round, kind, outcome: "refused", gas: "0", hash: "—" });
    } else {
      rows.push({ round, kind, outcome: "FAILED", gas: "—", hash: hash ?? "—" });
      console.table(rows);
      throw e;
    }
  }
}
console.table(rows);
console.log(`${rows.filter(r => r.outcome === "mined" || r.outcome === "refused").length}/${n} expected outcomes`);
