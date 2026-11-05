import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { account, deployment, gatewayRpc, pub, routerAbi, stateAbi } from "../src/common.js";
import { start } from "../src/main.js";
import { chooseFront, simulateSwap } from "../src/math.js";
import { sendVictim } from "../src/victim-eoa.js";
import { frameHash, frameSwaps } from "../src/watch.js";

const attemptsFile = fileURLToPath(new URL("../data/attempts.jsonl", import.meta.url));
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe("live devnet 1337", () => {
  it("decodes a captured real price-pinned frame from the explorer", () => {
    const fixture = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/pinned-frame.json", import.meta.url)), "utf8"));
    expect(fixture.source).toBe("skandha_explorer_getTransaction");
    expect(frameHash(fixture.tx)).toBe(fixture.hash);
    const swaps = frameSwaps([fixture.tx]);
    expect(swaps).toHaveLength(1);
    expect(swaps[0]).toMatchObject({ hash: fixture.hash, kind: "frame", pinned: true });
  });

  it("reconstructs hashes from the real read-only bundler dump", async () => {
    const dump = await gatewayRpc<Array<Parameters<typeof frameHash>[0]>>("debug_bundler_dumpMempool");
    expect(dump.length).toBeGreaterThan(0);
    const hash = frameHash(dump[0]);
    const explorer = await gatewayRpc<{ hash: string; entry: { status: string } }>("skandha_explorer_getTransaction", [hash]);
    expect(explorer.hash.toLowerCase()).toBe(hash.toLowerCase());
    expect(explorer.entry.status).toMatch(/New|Pending|Submitted|OnChain|Cancelled|Reverted/);
  }, 30_000);

  it("sizes against a real eth_call quote on the shared pool", async () => {
    const blockNumber = await pub.getBlockNumber();
    const [slot, liquidity] = await Promise.all([
      pub.readContract({ address: deployment.predeploys.stateView, abi: stateAbi, functionName: "getSlot0", args: [deployment.poolId], blockNumber }),
      pub.readContract({ address: deployment.predeploys.stateView, abi: stateAbi, functionName: "getLiquidity", args: [deployment.poolId], blockNumber }),
    ]);
    const amount = 30_000_000n;
    const direction = !deployment.wethIs0;
    const quote = await pub.simulateContract({ address: deployment.router, abi: routerAbi, functionName: "swapExactIn", args: [deployment.poolKey, direction, amount, 0n, account("victim").address], account: account("victim").address, blockNumber });
    const simulated = simulateSwap(slot[0], liquidity, direction, amount);
    expect(simulated.amountOut).toBe(quote.result);
    const min = simulated.amountOut * 99n / 100n;
    const size = chooseFront(slot[0], liquidity, direction, amount, min, 1_500_000_000n);
    expect(size).toBeGreaterThan(0n);
    const afterFront = simulateSwap(slot[0], liquidity, direction, size);
    expect(simulateSwap(afterFront.nextSqrtPriceX96, liquidity, direction, amount).amountOut).toBeGreaterThanOrEqual(min);
  }, 30_000);

  it("watches a real EOA pending swap and records both bot receipts", async () => {
    const occupied = await fetch("http://[::1]:8787/attempts", { signal: AbortSignal.timeout(3000) }).then(r => r.ok).catch(() => false);
    if (occupied) throw new Error("Port 8787 is already occupied; stop the other bot before the live e2e test");
    const abort = new AbortController();
    const running = start(abort.signal);
    try {
      let ready = false;
      for (let i = 0; i < 120; i++) {
        ready = await fetch("http://[::1]:8787/attempts", { signal: AbortSignal.timeout(3000) }).then(r => r.ok).catch(() => false);
        if (ready) break;
        await Promise.race([pause(500), running.then(() => { throw new Error("watcher stopped before readiness"); })]);
      }
      expect(ready).toBe(true);
      const victim = await sendVictim();
      let attempt: any;
      for (let i = 0; i < 120; i++) {
        const rows = existsSync(attemptsFile) ? readFileSync(attemptsFile, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
        attempt = rows.find((row: any) => row.victimHash?.toLowerCase() === victim.hash.toLowerCase());
        if (attempt) break;
        await pause(1000);
      }
      expect(attempt, `no watcher attempt for ${victim.hash}`).toBeDefined();
      expect(attempt.front?.status).toBe("success");
      expect(attempt.back?.status).toBe("success");
      expect(attempt.victim?.hash.toLowerCase()).toBe(victim.hash.toLowerCase());
    } finally {
      abort.abort();
      await running.catch(() => undefined);
    }
  }, 180_000);
});
