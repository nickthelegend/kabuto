// Offline: real mainnet eth_getLogs + eth_getTransactionByHash responses captured by packages/replay (test/fixtures).
// The app detector must agree with the replay's own detector on every transaction in those blocks.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { attachPreviousPrices, decodeSwap as replayDecode, detect as replayDetect } from "../../../replay/src/detector";
import { BAND, classify, confirm, findSandwich, measure, parseShareHash, possibleTriples, priceBeforeInBlock, swapsFromLogs, type RawLog, type Swap, type Tx } from "./detect";

type Fixture = { blockNumber: number; logs: RawLog[]; txs: (Tx & { hash: `0x${string}` })[] };
const load = (n: number) => JSON.parse(readFileSync(new URL(`../../../replay/test/fixtures/mainnet-${n}.json`, import.meta.url), "utf8")) as Fixture;
const FIXTURES = [load(26299987), load(26349818)];

const getter = (f: Fixture) => {
  const m = new Map(f.txs.map((t) => [t.hash.toLowerCase(), t]));
  return async (h: string) => { const t = m.get(h.toLowerCase()); if (!t) throw new Error(`fixture is missing ${h}`); return t; };
};
const byPool = (swaps: Swap[]) => { const m = new Map<string, Swap[]>(); for (const s of swaps) m.set(s.poolId, [...(m.get(s.poolId) ?? []), s]); return m; };
/** Like the checker: try every pool the transaction swapped in (a multi-hop victim can be sandwiched in any of them). */
async function judgeTx(f: Fixture, h: string) {
  const swaps = swapsFromLogs(f.logs);
  const pools = byPool(swaps);
  for (const poolId of new Set(swaps.filter((s) => s.hash === h).map((s) => s.poolId))) {
    const hit = await findSandwich(pools.get(poolId)!, h, getter(f));
    if (hit) return hit;
  }
  return null;
}

describe("sandwich detector (same rules as packages/replay)", () => {
  it("finds the replay's A-V-A sandwich in block 26,299,987", async () => {
    const f = FIXTURES[0];
    const hit = await judgeTx(f, "0x2c3d2f3f51dc4248a285fe13f9534c72f542385a9613aa221435caf9e5570485");
    expect(hit).not.toBeNull();
    expect(hit!.front.hash).toBe("0xe8dcb5b0efe9884861d21443d746fd207ab548c6a9d8254d13defce2015b048c");
    expect(hit!.back.hash).toBe("0x9e329549f88b98322afbab467917d647a007513912896b02bd6f97d88a153204");
    expect(hit!.match).toBe("same sender");
    expect(hit!.front.txIndex).toBeLessThan(hit!.victim.txIndex);
    expect(hit!.victim.txIndex).toBeLessThan(hit!.back.txIndex);
  });

  it("agrees with the replay detector on every swap transaction in both captured blocks", async () => {
    let victims = 0, checked = 0;
    for (const f of FIXTURES) {
      const getTx = getter(f);
      const replaySwaps = f.logs.map(replayDecode);
      attachPreviousPrices(replaySwaps, new Map());
      const candidates = await replayDetect(replaySwaps, getTx as never);
      for (const h of new Set(swapsFromLogs(f.logs).map((s) => s.hash))) {
        const expected = candidates.filter((c) => c.victim.transactionHash.toLowerCase() === h).map((c) => `${c.front.transactionHash}|${c.back.transactionHash}`.toLowerCase());
        const hit = await judgeTx(f, h);
        const found = hit ? `${hit.front.hash}|${hit.back.hash}` : null;
        checked++;
        if (expected.length) { victims++; expect(expected).toContain(found); } else expect(found).toBeNull();
      }
    }
    expect(checked).toBeGreaterThan(30);
    expect(victims).toBeGreaterThan(0);
  });

  it("does not call the front-runner or the back-runner a victim", async () => {
    for (const h of ["0xe8dcb5b0efe9884861d21443d746fd207ab548c6a9d8254d13defce2015b048c", "0x9e329549f88b98322afbab467917d647a007513912896b02bd6f97d88a153204"]) {
      expect(await judgeTx(FIXTURES[0], h)).toBeNull();
    }
  });

  it("drops reorged logs and logs from other contracts", () => {
    const f = FIXTURES[0];
    const n = swapsFromLogs(f.logs).length;
    const removed = f.logs.map((l, i) => (i === 0 ? { ...l, removed: true } : l));
    const foreign = f.logs.map((l, i) => (i === 1 ? { ...l, address: "0x0000000000000000000000000000000000000001" as const } : l));
    expect(swapsFromLogs(removed)).toHaveLength(n - 1);
    expect(swapsFromLogs(foreign)).toHaveLength(n - 1);
  });
});

describe("confirmation rule", () => {
  const A = "0x00000000000000000000000000000000000000aa", B = "0x00000000000000000000000000000000000000bb", R = "0x00000000000000000000000000000000000000cc", V = "0x00000000000000000000000000000000000000dd";
  it("same sender, or same non-null contract, and the victim is neither outer sender", () => {
    expect(confirm({ from: A, to: R }, { from: V, to: R }, { from: A, to: B })).toBe("same sender");
    expect(confirm({ from: A, to: R }, { from: V, to: R }, { from: B, to: R })).toBe("same contract");
    expect(confirm({ from: A, to: null }, { from: V, to: R }, { from: B, to: null })).toBeNull();
    expect(confirm({ from: A, to: R }, { from: A, to: R }, { from: A, to: R })).toBeNull();
    expect(confirm({ from: A.toUpperCase().replace("0X", "0x") as `0x${string}`, to: R }, { from: V, to: R }, { from: A, to: B })).toBe("same sender");
  });
});

describe("price band (replay's measure.ts rule)", () => {
  const Q96 = 2n ** 96n;
  const s = (sqrt: bigint, a0: bigint, a1: bigint, txIndex: number): Swap => ({ poolId: "0x01", amount0: a0, amount1: a1, sqrtPriceX96: sqrt, block: 1, txIndex, logIndex: txIndex, hash: `0x${txIndex.toString(16).padStart(64, "0")}` });
  it("stops the victim only when the front-run moved the price by more than the band", () => {
    const pre = Q96 * 1000n;
    const inside = s((pre * 10024n) / 10000n, -1n, 1n, 1); // (1.0024)^2 ≈ +0.48%
    const outside = s((pre * 10030n) / 10000n, -1n, 1n, 1); // ≈ +0.60%
    expect(measure(inside, inside, pre).stoppedByPin).toBe(false);
    expect(measure(outside, outside, pre).stoppedByPin).toBe(true);
    expect(measure(outside, outside, pre).priceMovePct!).toBeCloseTo(0.6009, 3);
    expect(BAND).toBe(0.005);
  });
  it("reports unknown, never a guess, when the pre-attack price is missing", () => {
    expect(measure(s(Q96, -1n, 1n, 1), s(Q96, -1n, 1n, 2), null)).toEqual({ priceMovePct: null, stoppedByPin: null, filledWorsePct: null });
  });
  it("takes the pre-attack price from the swap just before the front-run in the same block", () => {
    const a = s(Q96 * 3n, 1n, -1n, 0), front = s(Q96 * 4n, -1n, 1n, 2), later = s(Q96 * 5n, 1n, -1n, 5);
    expect(priceBeforeInBlock([a, front, later], front)).toBe(Q96 * 3n);
    expect(priceBeforeInBlock([front, later], front)).toBeNull();
  });
  it("needs a back-run within 10% of the front-run's input", () => {
    const front = s(Q96, -1000n, 990n, 0), victim = s(Q96, -50n, 49n, 1);
    expect(possibleTriples([front, victim, s(Q96, 1100n, -1000n, 2)])).toHaveLength(1);
    expect(possibleTriples([front, victim, s(Q96, 1101n, -1000n, 2)])).toHaveLength(0);
    expect(possibleTriples([front, victim, s(Q96, -5n, 5n, 2)])).toHaveLength(0);
  });
});

describe("input and share links", () => {
  it("classifies tx hashes and addresses", () => {
    expect(classify(" 0x2c3d2f3f51dc4248a285fe13f9534c72f542385a9613aa221435caf9e5570485 ")).toBe("tx");
    expect(classify("0x192acbd4e6331b06a500729cb68882214ef4a234")).toBe("address");
    expect(classify("0x1234")).toBeNull();
    expect(classify("vitalik.eth")).toBeNull();
  });
  it("parses #check=<hash|address> and nothing else", () => {
    expect(parseShareHash("#check=0x2C3D2f3f51dc4248a285fe13f9534c72f542385a9613aa221435caf9e5570485")).toBe("0x2c3d2f3f51dc4248a285fe13f9534c72f542385a9613aa221435caf9e5570485");
    expect(parseShareHash("#check=0x192acbd4e6331b06a500729cb68882214ef4a234")).toBe("0x192acbd4e6331b06a500729cb68882214ef4a234");
    expect(parseShareHash("#check=0x1234")).toBeNull();
    expect(parseShareHash("#check")).toBeNull();
    expect(parseShareHash("#/app")).toBeNull();
  });
});
