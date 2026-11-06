/** Where every landing number comes from. Each link opens the transaction, test or file that backs the claim. */
export const GH = "https://github.com/nickthelegend/kabuto";
export const blob = (path: string, line?: number) => `${GH}/blob/main/${path}${line ? `#L${line}` : ""}`;

export const EVIDENCE = {
  /** README "How big the problem is" (497 victims, 388 of 501, 27 h), recomputed from packages/replay/out/sandwiches.jsonl. */
  replay: `${GH}#how-big-the-problem-is-a-mainnet-replay`,
  replayMethod: blob("packages/replay/METHOD.md"),
  testing: blob("TESTING.md"),
  guardReadme: `${GH}#kabutoguard-a-uniswap-v4-pool-that-cannot-be-sandwiched-kabutoguardhook`,
  guardSource: blob("packages/contracts/src/KabutoGuardHook.sol", 59),
  guardFrameCheck: blob("packages/contracts/src/KabutoGuardHook.sol", 69),
  guardBand: blob("packages/contracts/src/KabutoGuardHook.sol", 91),
  guardTests: blob("packages/contracts/test/KabutoGuard.t.sol"),
  checkerSource: blob("packages/app/src/lib/mainnet.ts"),
} as const;

/** KabutoGuard on the chain-1337 devnet (deployments/1337.json, TESTING.md "KabutoGuard live"). */
export const GUARD = {
  hook: "0x9A485379e6307A12cF380D9F783296Aa1E570080",
  poolId: "0x4869421e2f2f11bcdecdf1168a5b6183eb00c123cc1d5181b8712af074b91725",
  pinnedSwap: "0xd1962486165f1c4afdf3aec80ad6f2c6f882063403ad81e8469165e68472f861",
  plainSwap: "0x8fd351e2cffefc53e3680916bdb4007f24cbbc9b601ae37b13a80287e3291829",
  tests: 9,
  maxBandPct: 2,
} as const;

/** The same 1,500 kUSD swap on the devnet, Nov 6 2026 (README "three ways", TESTING.md "Live app runs"). */
export const LIVE_RUN = {
  /** Protection off: sandwiched at indices 0, 1, 2 of block 407,046; 1.80% worse than quoted. */
  sandwiched: "0xbf074d561e3ed81a19eb3c4eea24efa7e6d8ec48511543fd318682d72afbde29",
  /** Protection on (±0.5%): bot front-ran it, explorer status Cancelled, no receipt, 0 gas. */
  blocked: "0x2e8b5b7ca0801c1ba0931593d33f099a19a0189ed057d775b74b9d88cf7b2e92",
} as const;
