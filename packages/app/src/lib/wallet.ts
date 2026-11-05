import { encodeDeployData, encodeFunctionData, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { D, STAKE } from "./config";
import { faucet, pub, sendLegacy } from "./chain";
import { accountArtifact, registryAbi, tokenAbi } from "./abi";
import { frameStatus, p256Address, p256Tx, randomP256Key, sendFrameTx, senderFrame, verifyFrame } from "./frames";

/**
 * Devnet-only keys, kept in this browser's localStorage. The owner key is a raw P256 key (EIP-8141 signature
 * scheme 2); the funder is a secp256k1 EOA that takes the faucet drip, deploys the account, and doubles as the
 * "normal wallet" in the side-by-side comparison. Never use these keys on a real network.
 */
export type Saved = { ownerKey: Hex; owner: Address; funderKey: Hex; funder: Address; account?: Address; staked?: boolean };
const KEY = "kabuto.devnet.wallet.v1";

export function load(): Saved | null {
  try { const s = localStorage.getItem(KEY); return s ? (JSON.parse(s) as Saved) : null; } catch { return null; }
}
function save(s: Saved) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* private mode: session only */ } }
export function forget() { try { localStorage.removeItem(KEY); } catch { /* ignore */ } }

export type Step = { id: string; label: string; state: "todo" | "doing" | "done" | "error"; detail?: string; hash?: Hex };
export const STEPS: Step[] = [
  { id: "keys", label: "Create a P256 signing key on this device", state: "todo" },
  { id: "faucet", label: "Collect devnet ETH from the faucet", state: "todo" },
  { id: "deploy", label: "Deploy your Kabuto account", state: "todo" },
  { id: "stake", label: "Stake it in the ERC-8421 registry", state: "todo" },
  { id: "tokens", label: "Mint test kUSD for the demo", state: "todo" },
];

export async function onboard(onStep: (id: string, patch: Partial<Step>) => void): Promise<Saved> {
  let s = load();
  const run = async <T,>(id: string, fn: () => Promise<T>) => {
    onStep(id, { state: "doing" });
    try { const r = await fn(); onStep(id, { state: "done" }); return r; }
    catch (e: any) { onStep(id, { state: "error", detail: e?.message ?? String(e) }); throw e; }
  };
  await run("keys", async () => {
    if (!s) {
      const ownerKey = randomP256Key(), funderKey = generatePrivateKey();
      s = { ownerKey, owner: p256Address(ownerKey), funderKey, funder: privateKeyToAccount(funderKey).address };
      save(s);
    }
  });
  const st = s!;
  await run("faucet", async () => {
    if ((await pub.getBalance({ address: st.funder })) < 200_000_000_000_000_000n) await faucet(st.funder);
  });
  await run("deploy", async () => {
    if (st.account && (await pub.getCode({ address: st.account }))) return;
    const data = encodeDeployData({ abi: accountArtifact.abi, bytecode: accountArtifact.bytecode, args: [st.owner, D.predeploys.poolManager] });
    const r = await sendLegacy(st.funderKey, { data, value: 80_000_000_000_000_000n }, 4n); // 0.08 ETH: stake + gas
    st.account = r.contractAddress!;
    onStep("deploy", { hash: r.transactionHash });
    save(st);
  });
  await run("stake", async () => {
    const [stake] = await pub.readContract({ address: D.predeploys.stakingRegistry, abi: registryAbi, functionName: "getDepositInfo", args: [st.account!] });
    if (stake > 0n) { st.staked = true; save(st); return; }
    const nonce = BigInt(await pub.getTransactionCount({ address: st.account! }));
    const tx = p256Tx({
      sender: st.account!, owner: st.owner, ownerKey: st.ownerKey, nonce,
      frames: [
        verifyFrame(encodeFunctionData({ abi: accountArtifact.abi, functionName: "verify" }), 60_000n),
        senderFrame(D.predeploys.stakingRegistry, encodeFunctionData({ abi: registryAbi, functionName: "addStake", args: [86400] }), { value: STAKE, state: 300_000n, execution: 150_000n }),
      ],
    });
    const hash = await sendFrameTx(tx);
    onStep("stake", { hash });
    await waitFrame(hash);
    st.staked = true; save(st);
  });
  await run("tokens", async () => {
    for (const to of [st.account!, st.funder]) {
      const bal = await pub.readContract({ address: D.kusd, abi: tokenAbi, functionName: "balanceOf", args: [to] }) as bigint;
      if (bal < 500_000_000n) await sendLegacy(st.funderKey, { to: D.kusd, data: encodeFunctionData({ abi: tokenAbi, functionName: "faucet", args: [to] }) });
    }
  });
  return st;
}

/** Polls the sidecar until the frame tx is on chain, cancelled or reverted. */
export async function waitFrame(hash: Hex, onUpdate?: (s: string) => void, timeoutMs = 120_000) {
  const t0 = Date.now();
  let last = "";
  while (Date.now() - t0 < timeoutMs) {
    const st = await frameStatus(hash);
    if (st && st.status !== last) { last = st.status; onUpdate?.(st.status); }
    if (st && ["OnChain", "Finalized"].includes(st.status)) return st;
    if (st && ["Cancelled", "Reverted"].includes(st.status)) return st;
    await new Promise((r) => setTimeout(r, 800));
  }
  throw new Error("The frame transaction did not settle within 2 minutes.");
}
