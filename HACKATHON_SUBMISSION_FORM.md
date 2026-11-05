# ETHGlobal Mumbai submission: Kabuto

## Project name
Kabuto

## Short description (≤ 100 chars)
A DEX where a sandwiched swap stops existing: EIP-8141 frame transactions + Uniswap v4.

## Description
A sandwich attack needs your swap to land after the bot's. Today it always can: your transaction is valid whatever the price does, so the bot buys first, you fill worse, and if your slippage limit trips you still pay for the failed swap. In a read-only replay of 27 hours of real Ethereum mainnet data we found 497 Uniswap v4 swaps sandwiched by the same sender; 388 of 501 evaluated moved the price more than 0.5%.

Kabuto is a DEX, an SDK and an open filler network built on EIP-8141 frame transactions and Uniswap v4, live on the Ethereum Foundation's frame-transaction devnet (chain 1337, ERC-8421 alternative mempool).

**Protection toggle.** With protection off, the DEX sends an ordinary swap. Our live sandwich bot, watching both mempools, front-runs it, lets it fill, and back-runs it in the same block: on camera it filled 1.80% worse than its quote (27.04 kUSD on 1,500 kUSD). With protection on, the same swap is a frame transaction whose VERIFY frame reads the Uniswap v4 pool price (`extsload`) and checks it against a band you signed. The same bot front-runs it, the price leaves the band, the VERIFY frame fails, and the transaction is never included: explorer status `Cancelled`, no receipt, 0 gas. The app shows "You saved 27.04 kUSD" against the identical unprotected swap.

**Open intents (SIGHASH_ANYONECANPAY for Ethereum).** Instead of routing, sign a note: up to X in, at least a Dutch-decaying minimum out. No transaction, no gas. Any filler completes it through Uniswap v4 and pays the gas. EIP-8141's security section warns that explicit-message approvals "authorize an open-ended list" of frames; Kabuto's VERIFY frame binds the approval to every frame (one transfer ≤ max, filler frames that cannot act as the account, an atomic batch, a settlement checked against the balance read during validation). No settlement contract, no Permit2, no auction server. Every tampered fill we tried was refused before reaching a block.

**The swap can pay its own gas.** A staked paymaster inspects the frames and sponsors a price-pinned swap that repays it from the output in the same atomic batch: the account's ETH moved by exactly 0.

**Works on mainnet today: "Were you sandwiched?"** Paste any Ethereum mainnet Uniswap v4 swap on the landing page; Kabuto reads that block from public RPCs, detects a sandwich with the same rules as our replay, and shows how far the bot moved the price and whether a ±0.5% Kabuto pin would have made the swap invalid.

**Intent board on Arkiv.** The relay mirrors each verified intent to Arkiv (Rabdi) as an entity that expires at the intent's deadline, and records fill outcomes (a landed fill only after the devnet confirms it); the app's Intents tab reads the board from Arkiv, and fillers can too. Live on Rabdi with a real intent and fill. Settlement stays on chain 1337.

Every claim in the README is tied to the contract line that enforces it, the test that covers it and the devnet transaction that proves it.

## How it's made
- **Contracts (Solidity 0.8.28, Foundry):** `KabutoAccount` (verifyPrice, verifyPriceExecution, verifyIntent, settleIntent), `KabutoPaymaster` (frame-inspecting sponsor), `KabutoFiller` (pays gas when its operator co-signs; swaps through v4), `KabutoRouter` (minimal v4 unlock-callback router). Frame opcodes (APPROVE, TXPARAM, FRAMEPARAM, FRAMEDATACOPY, SIGPARAM) via `@forshtat/hegota-support`; Uniswap v4-core `StateLibrary` / `extsload`.
- **Chain:** EF EIP-8141 / ERC-8421 devnet (ethrex `eip8141-tracer` + the ERC-8421 sidecar) with Uniswap v4 PoolManager, Quoter and StateView predeployed from mainnet bytecode. Accounts and the paymaster stake in the ERC-8421 registry so the alternative mempool admits their storage reads.
- **Signatures:** owner keys on the native P256 scheme (EIP-8141 scheme 2, a passkey-style key generated in the browser); intents use the explicit-`msg` path; the filler co-signs the canonical hash as a second signature entry.
- **SDK (`@kabuto/sdk`, TypeScript + viem):** protectedSwap, sponsoredSwap, signIntent, buildFill, submitFill, track, explainRejection. Scheme-aware validation-gas budget (100k cap, 2,800 per secp256k1 / 6,700 per P256 signature).
- **Live adversary:** a real sandwich bot (front-run at a higher fee, back-run behind the victim) that records the realized loss vs the no-sandwich quote for every attempt, plus `pnpm --dir packages/bot watch`, a terminal view of it.
- **Filler network:** an untrusted relay (intents are self-authenticating) mirrored to Arkiv (`@arkiv-network/sdk`), and a reference filler that quotes on the v4 Quoter and races other fillers by same-nonce replacement; attacker modes demonstrate refused tampering.
- **DEX (Vite + React):** keys, deploy, stake and signing all in the browser; GSAP ScrollTrigger landing, Motion UI. Hosted on Vercel; relay, filler, bot and a fallback faucet run in Docker on a VPS.
- **Battle-testing:** Foundry unit + fuzz tests with mocked frame opcodes, a live devnet e2e suite, live app runs against the hosted bot, and the mainnet replay.
- **Hacky bit:** finding that the devnet's FRAMEDATACOPY/FRAMEPARAM (marked unexercised in the helper library) work, and fitting two VERIFY frames, two signatures and a full frame-shape check under the 100k validation-gas cap.
- **AI usage:** Claude (Anthropic) and Codex helped write and review code, tests, docs and the demo film; ChatGPT and Gemini generated the artwork. Every on-chain claim was checked against the devnet explorer.

## Partner prizes (max 3)
1. Ethereum Foundation: Best use of the Frame Transaction Alternative Mempool
2. Uniswap Foundation: Build with Uniswap (FEEDBACK.md included)
3. Arkiv: Build on Arkiv (from scratch). Live: writer `0x8eD225Ae7f4b445Bfee6ad5dd9719C59426Af3aF`, intent entity `0xd309c13a…20d0` and its fill entity `0xd9cc8020…4e5f` (README "Arkiv intent board").

## Links
- Repo: https://github.com/nickthelegend/kabuto
- Live app: https://kabuto-self.vercel.app
- Demo video: `film/renders/kabuto-demo-v3.mp4` (upload, then paste the link here)
