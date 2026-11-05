import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createPublicClient, createWalletClient, http, encodeDeployData, type Abi, type Address, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { devnet, GATEWAY, LEGACY_GAS_PRICE } from "./config.js";
import { rpc } from "./rpc.js";

export const pub = createPublicClient({ chain: devnet, transport: http(GATEWAY) });

export const wallet = (pk: Hex) => createWalletClient({ account: privateKeyToAccount(pk), chain: devnet, transport: http(GATEWAY) });

const OUT = fileURLToPath(new URL("../../contracts/out/", import.meta.url));
export function artifact(name: string): { abi: Abi; bytecode: Hex } {
  const j = JSON.parse(readFileSync(`${OUT}${name}.sol/${name}.json`, "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object };
}

/** Legacy tx through the gateway (forwarded to ethrex). Waits for the receipt and throws on revert. */
export async function sendLegacy(pk: Hex, tx: { to?: Address; data?: Hex; value?: bigint; gas?: bigint }) {
  const w = wallet(pk);
  if (tx.gas === undefined) {
    const est = await pub.estimateGas({ account: privateKeyToAccount(pk), to: tx.to, data: tx.data, value: tx.value ?? 0n });
    tx = { ...tx, gas: est * 3n / 2n + 50_000n };
  }
  const hash = await w.sendTransaction({
    to: tx.to, data: tx.data, value: tx.value ?? 0n, gas: tx.gas ?? 500_000n, gasPrice: LEGACY_GAS_PRICE, type: "legacy",
  } as any);
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (r.status !== "success") throw new Error(`tx ${hash} reverted`);
  return r;
}

export async function deploy(pk: Hex, name: string, args: unknown[] = [], value = 0n): Promise<Address> {
  const { abi, bytecode } = artifact(name);
  const data = encodeDeployData({ abi, bytecode, args });
  // Contract creation is charged state gas on this devnet: estimate, then leave wide headroom.
  const est = await pub.estimateGas({ account: privateKeyToAccount(pk), data, value });
  const gas = est * 2n > 30_000_000n ? 30_000_000n : est * 2n;
  const r = await sendLegacy(pk, { data, value, gas });
  if (!r.contractAddress) throw new Error(`deploy of ${name} returned no address`);
  return r.contractAddress;
}

/** The devnet faucet (1 ETH, once per address per hour). Fails loudly if it refuses. */
export async function faucet(to: Address): Promise<void> {
  await rpc("skandha_explorer_faucet", [to]);
  for (let i = 0; i < 60; i++) {
    if ((await pub.getBalance({ address: to })) > 0n) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`faucet did not fund ${to} within 120 s`);
}

export async function ensureFunded(to: Address, min: bigint) {
  if ((await pub.getBalance({ address: to })) >= min) return;
  await faucet(to);
}
