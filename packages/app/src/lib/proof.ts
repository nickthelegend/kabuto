/** Real transactions from our live runs on the EIP-8141 devnet (chain 1337). Every row links to the explorer. */
export type Proof = { what: string; result: string; hash: `0x${string}`; tone: "ok" | "shu" | "gold" };
export const PROOF: Proof[] = [
  { what: "Protected swap, price inside the signed band", result: "Mined: price check, approve and swap as one batch", hash: "0x45345cfa137774ca97c8a1b8e3d58f51b19940a4db3ef765ea9680f135a1e08a", tone: "ok" },
  { what: "Bot front-runs a protected swap already in the mempool", result: "Bot mined first", hash: "0x3ac90a6ef90e45519256f33fb90efe3e4e2af6aab50b2337ad0eb3c4ce888149", tone: "gold" },
  { what: "…the protected swap it targeted", result: "Never included (Cancelled). Gas paid: 0", hash: "0xbc0334ead2575f8a6c6c54d06292da3c71dd5bfb6a20c5097fcfd29c0fe2ea80", tone: "shu" },
  { what: "Swap pays its own gas (Kabuto paymaster)", result: "Mined, 5/5 frames; account ETH moved 0 wei", hash: "0x7559cff5fa0398cc452800c66261f03c90bf9925164f5e4c51628c4eef707cde", tone: "ok" },
  { what: "Open intent filled by a third-party filler", result: "Mined, 5/5 frames; filler paid gas, account got its minimum", hash: "0xefebea6a0a5c7b3e75229c5a9980ee823cd1273945e036a897d12f00fb38cce3", tone: "ok" },
  { what: "Filler underpays the intent", result: "Settle frame failed, batch rolled back, user lost nothing", hash: "0xb0a236ccb9451dcefe266fb3f1db4d12a72b86d1b21fa832fa0c4fac11685e64", tone: "shu" },
  { what: "Owner key on the native P256 signature scheme", result: "Mined, 2/2 frames", hash: "0xfe70566620a7e2798002ea376b598d7a6614fee279c861b2cc6146978178b7d3", tone: "ok" },
];

/** Tampered fills refused at admission: never in a block, so there is no tx hash and no gas. */
export const REFUSED = [
  { attack: "Slip in an extra SENDER frame that sends the user's tokens to the attacker", code: "BadIntentShape(9)" },
  { attack: "Pull more than the signed maxIn", code: "BadIntentShape(6)" },
  { attack: "Drop the atomic flag so the transfer survives a failed settlement", code: "BadIntentShape(7)" },
  { attack: "Swap after the pool price left the signed band", code: "PriceOutOfBand" },
];

/**
 * From packages/replay/out (read-only scan of Uniswap v4 PoolManager Swap logs on Ethereum mainnet). Counts only
 * triples whose front and back legs share tx.from (the stricter rule); see packages/replay/METHOD.md for the
 * heuristic and its false-positive/negative risks. No dollar figure: USD coverage was ~1% of pools.
 */
export const REPLAY = {
  fromBlock: 26299825, toBlock: 26307824, fromIso: "2026-10-29T17:14Z", toIso: "2026-10-30T20:00Z", hours: 27,
  sameSenderTriples: 503, uniqueVictims: 497, evaluated: 501, stopped: 388, bandPct: 0.5,
};
