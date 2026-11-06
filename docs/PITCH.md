# Kabuto: 2-minute pitch and judge Q&A

Every number below is in the README, TESTING.md or a linked transaction. If a judge asks for a number that isn't here, say you don't have it.

## The 2-minute script (about 260 spoken words)

| Time | Show | Say |
|---|---|---|
| 0:00–0:20 | Landing hero | "When you swap on a DEX, a bot can see your swap, buy first, and sell back to you at a worse price. That's a sandwich. It works because your swap is still a valid transaction after the bot moved the price. On Uniswap v4 mainnet, in 27 hours, we counted 497 victim swaps." |
| 0:20–0:45 | DEX, protection **off**, 1,500 kUSD; then the bot terminal | "Here's an ordinary swap with 2% slippage. Our real sandwich bot front-runs it and back-runs it in the same block: positions 0, 1 and 2. I got 1.8% less than my quote: 27 kUSD gone." |
| 0:45–1:10 | Protection **on**; the result card shows "Sandwich blocked · Not included · 0 gas" and "You saved"; on the explorer, the event history shows `dropped: Cancelled` | "Same swap, protection on. Kabuto puts the price check inside the transaction's own EIP-8141 VERIFY frame. The bot front-runs again, the mempool re-checks my transaction, the price is out of my band, and my swap simply stops existing. Not reverted: never included. I pay zero gas, and the bot is left holding its own trade." |
| 1:10–1:35 | Intents tab: sign, filler fills, Arkiv board row | "Or don't route at all. I sign one intent, no gas: at most this much in, at least this much out. Anyone can fill it through Uniswap v4 and pay the gas. My account checks every frame of the fill, so the tampered fills we tried were refused before reaching a block. The board of open intents lives on Arkiv and expires with each intent." |
| 1:35–1:50 | Landing proof list: KabutoGuard rows | "And for Uniswap: KabutoGuard, a v4 hook that reads the transaction it runs in. In this pool, only price-pinned frame transactions can swap. A bot's plain transaction reverts." |
| 1:50–2:00 | Logo, repo URL | "Live on the EF frame-transaction devnet with Uniswap v4. Every claim is a transaction you can open. Kabuto: swaps that only happen at your price." |

The EF devnet has been halted since block 408,262 (Nov 5, 22:58:46 UTC). Check `eth_blockNumber` before going on stage. If it is still halted, say so in one sentence ("the EF devnet stopped producing blocks overnight, so this is the recorded run"), play the film or open the three proof transactions from the README, and never present a recorded run as live.

## Numbers you can quote (and their source)

| Number | Source |
|---|---|
| 497 victim transactions, 503 same-sender triples, 27 hours, blocks 26,299,825–26,307,824 | README "How big the problem is"; `packages/replay` |
| 388 of 501 evaluated (77%) moved the price more than 0.5% | same |
| 1.80% worse, 27.04 kUSD lost on 1,500 kUSD; indices 0, 1, 2 of block 407,046 | tx `0xbf074d56…de29` |
| Protected swap dropped as `Cancelled` at block 407,052, 0 gas (entry now reads `replaced`: nonce reused later) | tx `0x2e8b5b7c…2e92` event history |
| Intent filled by a third party: 0.00886 WETH, signed minimum 0.00885 | tx `0xdfd70b01…c065` |
| 19 Foundry tests (10 core + 9 KabutoGuard), 2 fuzz tests × 256 runs | TESTING.md |
| Validation-gas cap 100k; 78,500 left for `verifyIntent` with a P256 owner (the P256 fill `0xdfd70b01` sums to exactly 100,000) | `packages/sdk/src/index.ts:45-51` |

Don't quote a dollar figure for mainnet: USD pricing covered about 1% of candidates.

## Q&A

**Why not slippage 0 / minOut?** A failed swap still lands and you pay its gas, and the bot still takes everything up to your limit. Kabuto's check runs before the transaction is valid, so a moved price leaves nothing to pay for.

**Why not Flashbots Protect / MEV Blocker / CoW?** Those depend on a trusted relay or solver network. Kabuto's check is part of the transaction's own validity, so it doesn't depend on which mempool or builder sees it.

**EIP-8141 isn't on mainnet.** Correct, it's proposed for Hegotá. We built on the EF's public devnet against the Uniswap v4 contracts predeployed there. The only mainnet piece is read-only: the replay and the "Were you sandwiched?" checker.

**What stops a filler from stealing?** `verifyIntent` binds the signature to every frame, as EIP-8141's security section asks: one tokenIn transfer of at most maxIn (exactly 68 bytes of calldata), filler frames in DEFAULT mode (the caller is the entry point, so they can't act as the account), one atomic batch with no value, and a final settle against the balance read during VERIFY. An extra SENDER frame, an over-max pull and a dropped atomic flag were all refused at admission. An underpaying fill lands, fails settlement and rolls back; only the filler pays.

**Doesn't a cancelled swap hurt the account's reputation?** ERC-8421 counts admitted-but-not-included transactions against staked senders. That's the honest open question, written up in EF-FINDINGS.md: we'd like price invalidation scored differently from spam.

**Who pays when a sandwiched swap is cancelled?** Not the user: the transaction never enters a block. The bot paid for its own front-run and is left holding that position.

**Why is this a Uniswap project?** The price check reads the v4 PoolManager with `StateLibrary.getSlot0` (`extsload`), swaps settle through v4 flash accounting in our router and filler, quotes come from the V4 Quoter, and KabutoGuard is a v4 hook. The README has a line-by-line pointer table; FEEDBACK.md has what we hit.

**Why Arkiv and not your relay's database?** Fillers shouldn't have to trust our relay. On Arkiv, open intents are queryable by status, chain and deadline, filtered by a known writer, and expire at the intent's own deadline. Settlement never leaves chain 1337.

**What's the ±0.5% based on?** It's the user's band, adjustable in the UI. In the replay, 77% of the evaluated same-sender sandwiches moved the price more than 0.5%.

**Did your tests pass?** Foundry 19/19. Fresh Nov 6 rerun of everything that spends no devnet ETH: 33 passed, 1 failed (a bot test that needs a non-empty alt-mempool dump), 2 skipped. The last full live e2e run (Nov 5): 6 passed, 4 failed waiting for inclusion during a devnet stall; two of those were mined later, two were mined later but reverted at the filler's frame. Every hash is in TESTING.md.
