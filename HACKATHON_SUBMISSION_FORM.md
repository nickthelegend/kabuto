# ETHGlobal Mumbai submission: Kabuto

Paste-ready answers, one section per ETHGlobal form field. Every number here is in the README, TESTING.md or a linked transaction.

Before pasting (Nick):
- [ ] Submit the Uniswap Developer Feedback Form, pasting https://github.com/nickthelegend/kabuto/blob/main/FEEDBACK.md (paste-ready answers at the end of FEEDBACK.md). The Uniswap answer below says it was submitted.
- [ ] Upload the demo video and paste its link under Links.
- [ ] Pick exactly these three partner prizes: EF Frame Transaction Alternative Mempool, Uniswap Build with Uniswap, Arkiv Build on Arkiv (from scratch).

## Project name
Kabuto

## Short description (max 100 characters)
A DEX where a sandwiched swap stops existing: EIP-8141 frame transactions + Uniswap v4.

(87 characters)

## Description
A sandwich bot needs your swap to stay valid after it has moved the price. Today it always does: an ordinary swap is valid at any price above its slippage floor, so the bot buys first, you fill worse, and if your limit trips you still pay gas for the failed swap. In a read-only replay of 27 hours of Ethereum mainnet (blocks 26,299,825–26,307,824) we found 503 Uniswap v4 sandwich triples whose front and back legs share a sender, hitting 497 victim transactions; in 388 of the 501 we could evaluate, the front-run moved the price more than 0.5%.

Kabuto is a DEX, an SDK and an open filler network on EIP-8141 frame transactions and Uniswap v4, live on the Ethereum Foundation's frame-transaction devnet (chain 1337, ERC-8421 alternative mempool).

Protection toggle. With protection off, the DEX sends an ordinary swap, and our live sandwich bot front-runs it and back-runs it in the same block (indices 0, 1, 2): it filled 1.80% worse than its quote, 27.04 kUSD on 1,500 kUSD. With protection on, the same swap is a frame transaction whose VERIFY frame reads the v4 pool price with `extsload` and checks it against a band you signed. The bot front-runs again, the alt-mempool re-runs VERIFY, it reverts with `PriceOutOfBand`, and the swap is dropped: status `Cancelled`, no receipt, 0 gas.

Open intents. Instead of routing, sign a note: at most X in, at least a Dutch-decaying minimum out. No transaction, no gas. Any filler completes it through Uniswap v4 and pays the gas. EIP-8141's security section warns that explicit-message approvals cover every later SENDER frame; Kabuto's `verifyIntent` binds the approval to every frame (one transfer of at most maxIn, filler frames that cannot act as the account, one atomic batch, settlement against the balance read during validation). There is no settlement contract and no auction server. Three tampered fills (extra SENDER frame, over-max pull, missing atomic flag) were refused at admission; an underpaying fill lands, fails settlement and rolls back.

KabutoGuard. A Uniswap v4 `beforeSwap` hook that reads the frame transaction it runs in and only admits swaps whose price was pinned in an earlier, successful VERIFY frame by the sender. Live: a pinned swap landed, and a plain transaction (what a sandwich bot sends) through the same router reverted with `NotFrameTx()`.

The swap can also pay its own gas: a staked paymaster inspects the frames and sponsors a price-pinned swap that repays it from the output; the account's ETH moved by 0 wei.

On mainnet today, read-only: paste an Ethereum mainnet Uniswap v4 swap on the landing page and Kabuto tells you whether it was sandwiched and whether a ±0.5% pin would have made it invalid.

The intent board lives on Arkiv (Rabdi): each verified intent becomes an entity that expires at the intent's deadline, fill outcomes become a 30-day fill log, and the DEX's Intents tab reads the board from Arkiv. Settlement stays on chain 1337.

## How it's made
- Contracts (Solidity 0.8.28, Foundry): `KabutoAccount` (verifyPrice, verifyPriceExecution, verifyIntent, settleIntent), `KabutoPaymaster` (frame-inspecting sponsor), `KabutoFiller` (pays gas when its operator co-signs; swaps through v4), `KabutoRouter` (minimal v4 unlock-callback router), `KabutoGuardHook` (frame-aware v4 hook). Frame opcodes (APPROVE, TXPARAM, FRAMEPARAM, FRAMEDATACOPY, SIGPARAM) come from `@forshtat/hegota-support`; pool reads use v4-core `StateLibrary` / `extsload`.
- Chain: the EF EIP-8141 / ERC-8421 devnet (ethrex `eip8141-tracer` plus the ERC-8421 sidecar), where the Uniswap v4 PoolManager, V4 Quoter and StateView are predeployed. The account and paymaster stake in the ERC-8421 registry so the alternative mempool admits their reads of PoolManager storage during VERIFY.
- Signatures: owner keys use the native P256 scheme (a passkey-style key generated in the browser). Intents use the explicit 32-byte `msg` path; the filler co-signs the canonical hash as a second signature entry.
- SDK (`@kabuto/sdk`, TypeScript + viem): protectedSwap, sponsoredSwap, signIntent, buildFill, submitFill, track, explainRejection, with a validation-gas budget per signature scheme (100k cap, 2,800 per secp256k1 and 6,700 per P256 signature).
- A real adversary: a hosted sandwich bot that watches both mempools, front-runs at a higher fee, back-runs behind the victim, and records the realized loss against the no-sandwich quote for every attempt.
- Filler network: an untrusted relay (intents carry their own signatures) mirrored to Arkiv with `@arkiv-network/sdk`, and a reference filler that quotes on the V4 Quoter and competes by same-nonce replacement; attacker modes demonstrate the refused tampering.
- DEX (Vite + React): key creation, account deploy, stake and signing all happen in the browser; GSAP ScrollTrigger landing, Motion UI. Hosted on Vercel; relay, filler, bot and a fallback faucet run in Docker on a VPS.
- Testing: 19 Foundry tests (10 core + 9 KabutoGuard; 2 fuzz tests × 256 runs) with mocked frame opcodes and a real v4 PoolManager; a live devnet e2e suite (last full run: 6 passed, 4 timed out waiting for inclusion during a devnet stall); live app runs against the hosted bot; and the mainnet replay.
- Hacky bit: the helper library marks FRAMEPARAM and FRAMEDATACOPY as not yet exercised on this devnet. We found they work, including from a v4 hook called by the PoolManager inside a SENDER frame, which is what makes KabutoGuard possible. We also fit two VERIFY frames, two signatures and a full frame-shape check under the 100k validation-gas cap (78,500 gas left for `verifyIntent` with a P256 owner).

## Partner prizes (max 3)

### Ethereum Foundation: Best Use of the Frame Transaction Alternative Mempool
Kabuto needs the alt mempool's core capability: a staked account's VERIFY frame reads another contract's storage (the Uniswap v4 PoolManager's `slot0`), which the canonical mempool forbids. The headline behaviour, a swap admitted and then dropped as `Cancelled` when a front-run moves the price, is the alt mempool's revalidation at work. We also use explicit-`msg` signatures with every frame constrained, as the EIP's security section asks, a frame-inspecting paymaster, P256 keys and same-nonce replacement. Proofs: admitted and mined `0x45345cfa…e08a`, cancelled after a front-run `0x2e8b5b7c…2e92`, intent fill `0xdfd70b01…c065`. Devnet findings, including a gateway that lost its gossip peer and an explorer field that disagrees with its own event log: EF-FINDINGS.md.

### Uniswap Foundation: Build with Uniswap
Kabuto reads the v4 PoolManager's price with `StateLibrary.getSlot0` / `extsload` during transaction validation, settles swaps through v4 flash accounting (`unlock`, `swap`, `sync`/`settle`/`take`) in its own router and filler, quotes on the V4 Quoter, and adds KabutoGuard, a `beforeSwap` hook that only lets price-pinned frame transactions trade. The README's "Uniswap v4 code pointers" table links each of these to its line. FEEDBACK.md is in the repo root and is linked from our Uniswap Developer Feedback Form submission.

### Arkiv: Build on Arkiv (from scratch)
Open intents need a public board that any filler can query and that cleans itself up. Each verified intent is a `kabuto.intent.v1` entity with indexed status, tokens, chain and deadline, expiring at the intent's own deadline; each fill outcome is a `kabuto.fill.v1` entity kept for 30 days. The DEX's Intents tab reads the board from Rabdi, and fillers can poll Arkiv instead of the relay. Writer: `0x8eD225Ae7f4b445Bfee6ad5dd9719C59426Af3aF`. Judge query and the required files (schema, friction, reach, why-arkiv, how-you-use-arkiv) are in the README's "Arkiv intent board" section and `arkiv/`.

## AI usage
Claude (Anthropic, via Claude Code) and OpenAI Codex helped write and review the contracts, SDK, relay, filler, bot, app, tests and docs. ChatGPT image generation made the still artwork, and Gemini animated two stills into the landing videos. The live app runs were recorded with Playwright scripts (`packages/demo`) against the deployed app, and every on-chain claim was checked against the devnet explorer and Rabdi. The team is responsible for all code and claims.

## Links
- Repo: https://github.com/nickthelegend/kabuto
- Live app: https://kabuto-self.vercel.app
- Demo video: upload the final render from `film/`, then paste the link here
