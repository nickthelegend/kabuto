// Live, read-only: the real checker pipeline against Ethereum mainnet public RPCs. No mocks; fails if every RPC fails.
import { describe, expect, it } from "vitest";
import { checkMainnetTx, EXAMPLES, scanAddress, SCAN_BLOCKS, SCAN_MAX_TXS } from "../lib/mainnet";

describe("mainnet checker (live)", () => {
  it("reproduces the replay's verdict for the ≈$415 example victim", async () => {
    const v = await checkMainnetTx(EXAMPLES[0].hash);
    expect(v.kind).toBe("sandwiched");
    if (v.kind !== "sandwiched") return;
    // packages/replay/out/sandwiches.jsonl: front 0x3a5dac70…, back 0x67f8d848…, priceMove 0.3788, stopped true
    expect(v.front.startsWith("0x3a5dac70")).toBe(true);
    expect(v.back.startsWith("0x67f8d848")).toBe(true);
    expect(v.priceMovePct!).toBeCloseTo(37.88, 1);
    expect(v.stoppedByPin).toBe(true);
    expect(v.victimFrom).toBe("0x192acbd4e6331b06a500729cb68882214ef4a234");
  }, 120_000);

  it("says not-found for a hash that was never mined", async () => {
    expect((await checkMainnetTx(`0x${"ab".repeat(32)}`)).kind).toBe("not-found");
  }, 60_000);

  it("calls the front-runner's own transaction clean, not a victim", async () => {
    const v = await checkMainnetTx("0xe8dcb5b0efe9884861d21443d746fd207ab548c6a9d8254d13defce2015b048c");
    expect(v.kind).toBe("clean");
  }, 120_000);

  it("rejects garbage input with a readable error", async () => {
    await expect(checkMainnetTx("0x1234")).rejects.toThrow(/transaction hash/);
    await expect(scanAddress("hello")).rejects.toThrow(/address/);
  });

  it("scans an address over a bounded ~24 h window", async () => {
    const s = await scanAddress("0x192acbd4e6331b06a500729cb68882214ef4a234");
    expect(s.head - s.fromBlock + 1).toBe(SCAN_BLOCKS);
    expect(s.checked).toBeLessThanOrEqual(SCAN_MAX_TXS);
    expect(s.checked).toBeLessThanOrEqual(s.tokenTxs);
    for (const r of s.results) expect(["clean", "sandwiched"]).toContain(r.kind);
  }, 180_000);
});
