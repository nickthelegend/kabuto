import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { generatePrivateKey } from "viem/accounts";
import type { Hex } from "viem";

/**
 * Throwaway devnet keys, generated locally and kept in a git-ignored file (mode 600). Never printed.
 * They hold only devnet ETH from the faucet; never reuse them on a real network.
 */
const FILE = process.env.KABUTO_KEYS_FILE ?? fileURLToPath(new URL("../.devnet-keys.json", import.meta.url));

export type Role = string; // e.g. "deployer", "owner", "bot", "filler", "sdk-user", "test-owner": one key per role, never shared between concurrent jobs

export function key(role: Role): Hex {
  const all: Partial<Record<Role, Hex>> = existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : {};
  if (!all[role]) {
    all[role] = generatePrivateKey();
    writeFileSync(FILE, JSON.stringify(all, null, 2));
    chmodSync(FILE, 0o600);
  }
  return all[role]!;
}
