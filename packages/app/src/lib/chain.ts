import { createPublicClient, createWalletClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { D, devnet, LEGACY_GAS_PRICE } from "./config";
import { rpc } from "./rpc";

export const pub = createPublicClient({ chain: devnet, transport: http(D.gateway), pollingInterval: 1000 });

/** Legacy tx from a secp256k1 EOA, gas estimated with headroom (contract creation is charged state gas here). */
export async function sendLegacy(pk: Hex, tx: { to?: Address; data?: Hex; value?: bigint }, headroom = 3n) {
  const account = privateKeyToAccount(pk);
  const w = createWalletClient({ account, chain: devnet, transport: http(D.gateway) });
  const est = await pub.estimateGas({ account, to: tx.to, data: tx.data, value: tx.value ?? 0n });
  const gas = (est * headroom) / 2n + 50_000n;
  const hash = await w.sendTransaction({ to: tx.to ?? null, data: tx.data, value: tx.value ?? 0n, gas, gasPrice: LEGACY_GAS_PRICE, type: "legacy" } as any);
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (r.status !== "success") throw new Error(`Transaction ${hash.slice(0, 10)}… reverted on chain.`);
  return r;
}

/** Devnet faucet: 1 ETH, once per address per hour. */
export async function faucet(to: Address) {
  await rpc("skandha_explorer_faucet", [to]);
  for (let i = 0; i < 60; i++) {
    if ((await pub.getBalance({ address: to })) > 0n) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("The devnet faucet did not fund the address within 2 minutes.");
}
