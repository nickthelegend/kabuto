/**
 * Fallback devnet faucet for the Kabuto DEX, used only when the public devnet faucet (skandha_explorer_faucet) is
 * empty. Sends DRIP ETH from the git-ignored "kabuto-faucet" devnet key (packages/devnet/.devnet-keys.json) to a
 * fresh address, once per address, with a global cap. Devnet only: this ETH has no value.
 *   POST /drip {"address":"0x…"}  ->  {"hash":"0x…"}      GET /status -> {address, balance, drips}
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, defineChain, formatEther, http, isAddress, parseEther, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const GATEWAY = process.env.KABUTO_GATEWAY ?? "https://altmempool.forshtat.com/rpc";
const DRIP = parseEther(process.env.DRIP_ETH ?? "0.06");
const MAX_DRIPS = Number(process.env.MAX_DRIPS ?? 40);
const PORT = Number(process.env.PORT ?? 8789);
const chain = defineChain({ id: 1337, name: "EIP-8141 devnet", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [GATEWAY] } } });
const keys = JSON.parse(readFileSync(fileURLToPath(new URL("../devnet/.devnet-keys.json", import.meta.url)), "utf8")) as Record<string, Hex>;
if (!keys["kabuto-faucet"]) throw new Error('No "kabuto-faucet" key in packages/devnet/.devnet-keys.json. Create it with key("kabuto-faucet") and fund it.');
const account = privateKeyToAccount(keys["kabuto-faucet"]);
const pub = createPublicClient({ chain, transport: http(GATEWAY) });
const wallet = createWalletClient({ account, chain, transport: http(GATEWAY) });
const served = new Set<string>();

const send = (res: any, code: number, body: unknown) => {
  res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET,POST,OPTIONS" });
  res.end(JSON.stringify(body));
};

createServer(async (req, res) => {
  if (req.method === "OPTIONS") return send(res, 204, {});
  if (req.method === "GET" && req.url === "/status") {
    return send(res, 200, { address: account.address, balance: formatEther(await pub.getBalance({ address: account.address })), drips: served.size, max: MAX_DRIPS, dripEth: formatEther(DRIP) });
  }
  if (req.method === "POST" && req.url === "/drip") {
    try {
      let body = ""; for await (const c of req) { body += c; if (body.length > 2000) throw new Error("Request too large"); }
      const { address } = JSON.parse(body);
      if (!isAddress(address)) throw new Error("Invalid address");
      const key = address.toLowerCase();
      if (served.has(key)) throw new Error("This address already got a drip");
      if (served.size >= MAX_DRIPS) throw new Error("The Kabuto fallback faucet has reached its cap");
      if ((await pub.getBalance({ address })) >= DRIP) throw new Error("Address already has enough devnet ETH");
      served.add(key);
      // a transfer to a brand-new account is charged state gas on this devnet: 21000 is not enough
      const hash = await wallet.sendTransaction({ to: address, value: DRIP, gas: 300_000n, gasPrice: 2_000_000n, type: "legacy" } as any);
      const r = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
      if (r.status !== "success") { served.delete(key); throw new Error(`Drip transaction ${hash} reverted`); }
      return send(res, 200, { hash });
    } catch (e: any) { return send(res, 400, { error: e?.message ?? String(e) }); }
  }
  send(res, 404, { error: "Not found" });
}).listen(PORT, "0.0.0.0", () => console.log(`Kabuto fallback faucet on :${PORT} from ${account.address}`));
