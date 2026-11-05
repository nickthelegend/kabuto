# Kabuto: pitch and judge Q&A

## 30-second pitch
"A sandwich needs your swap to land after the bot's. Today it always can, because your transaction is valid whatever the price does. Kabuto moves the price check into the transaction's own VERIFY frame. If a bot moves the price, your swap stops being a valid transaction: it's never included and you pay nothing. Or skip routing: sign one intent, anyone can fill it through Uniswap v4 and pay the gas, and your account rejects any fill that breaks the shape. No settlement contract, no auction server: the mempool is the auction. Live on the EF frame-transaction devnet with real Uniswap v4."

## Demo beats (4 min)
1. Mainnet number (497 sandwiched swaps in 27 h; 77% stoppable at ±0.5%).
2. Normal wallet swap → real bot sandwiches it → filled 1.8% worse.
3. Same swap with Kabuto → bot front-runs → "Never included · 0 gas" → open the Cancelled tx on the explorer.
4. Post an intent → filler fills through v4, pays gas → attacker filler's tampered fill refused.
5. SDK + proof table.

## Q&A
**Why not slippage 0 / minOut?** A failed swap still lands and you pay for it, and the bot still takes everything up to your limit. Kabuto's check runs before the transaction is valid, so a moved price means there is nothing to pay for.

**Why not Flashbots Protect / MEV Blocker / CoW?** Those are trusted relays or solvers. Kabuto's guarantee is enforced by the protocol: any builder, any mempool.

**EIP-8141 isn't on mainnet.** Correct, it's considered for Hegotá. We built on the EF's public devnet with Uniswap v4's real mainnet bytecode, so it's ready when frame transactions ship. The SDK can fall back to router-level slippage + private RPC on today's chains.

**What stops a filler from stealing?** `verifyIntent` binds the signature to every frame, as EIP-8141's security section requires: one tokenIn transfer ≤ maxIn (exactly 68 bytes of calldata), filler frames are DEFAULT (caller ENTRY_POINT, cannot act as the account), the whole thing is one atomic batch with no value, and the last frame settles against the balance read during VERIFY. We tried extra SENDER frames, over-max pulls and a dropped atomic flag: all refused before a block. An underpaying fill lands, fails settlement, and rolls back; only the filler pays.

**Doesn't a cancelled swap hurt the account's reputation?** ERC-8421 counts admitted-but-not-included txs against staked entities. That's the honest open question; we documented it in EF-FINDINGS.md. The wallet re-quotes and retries for free, and we'd like the alt-mempool rules to treat price-invalidation differently from spam.

**Who pays when a sandwiched swap is cancelled?** Nobody. The tx never enters a block. The bot paid for its own front-run and is left holding the position (−217 kUSD marked in our live run).

**Why Uniswap?** The price check reads the v4 PoolManager directly with `extsload` (StateLibrary), swaps settle through v4's flash accounting, quotes come from the v4 Quoter, and fillers route through v4. FEEDBACK.md has what we hit.

**Gas?** The whole validation prefix must fit in 100k (sum of VERIFY limits + 2,800 per secp256k1 / 6,700 per P256 signature). verifyIntent does a full frame-shape check inside ~78k for a P256 owner.

**What's the ±0.5% based on?** It's the user's band (adjustable in the UI). The replay shows 77% of same-sender sandwich triples moved the price more than 0.5%.
