# ETHGlobal Mumbai submission: Kabuto

## Project name
Kabuto

## Short description (≤ 100 chars)
Swaps only valid at your price: sandwiched = free and invalid, or let anyone race to fill your intent.

## Description
A sandwich attack needs your swap to land after the bot's. Today it always can: your transaction is valid no matter what the price does, so the bot buys first, you fill worse, and if your slippage limit trips you still pay for the failed swap.

Kabuto is a DEX, an SDK and an open filler network built on EIP-8141 frame transactions and Uniswap v4, live on the Ethereum Foundation's frame-transaction devnet.

**Protected swap.** Your Kabuto account's VERIFY frame (the part of a frame transaction that runs before anything else) reads the Uniswap v4 pool price with `extsload` and checks it against a band you signed. If a bot moves the price, your transaction becomes invalid: builders cannot include it, and nobody pays for it. We proved it live: a bot front-ran a protected swap that was already in the alt-mempool; the bot's trade landed and our swap was never included (Cancelled, 0 gas).

**Open intents: SIGHASH_ANYONECANPAY for Ethereum.** You sign only an intent (up to X in, at least a Dutch-decaying minimum out) as an explicit 32-byte signature message. Any filler completes the transaction through Uniswap v4 and pays the gas. EIP-8141's own security section warns that such approvals "authorize an open-ended list" of frames; Kabuto's VERIFY frame binds the approval to every frame: one transfer up to your max, filler frames that cannot act as you, an atomic batch, and a final settlement checked against the balance read during validation. There is no settlement contract, no Permit2 and no auction server: fillers replace each other in the mempool by fee. Every tampered fill we tried was refused before it reached a block.

**The swap pays its own gas.** A staked paymaster inspects the transaction's frames and sponsors a price-pinned swap that repays it from the swap's output in the same atomic batch: the user's ETH balance moves by exactly 0.

Every claim links to a devnet transaction in the README.

## How it's made
- **Contracts (Solidity, Foundry):** `KabutoAccount` (verifyPrice, verifyPriceExecution, verifyIntent, settleIntent), `KabutoPaymaster` (frame-inspecting sponsor), `KabutoFiller` (pays gas when its operator co-signs; swaps through v4), `KabutoRouter` (minimal v4 unlock-callback router). Frame opcodes (APPROVE, TXPARAM, FRAMEPARAM, FRAMEDATACOPY, SIGPARAM) via `@forshtat/hegota-support`; Uniswap v4-core `StateLibrary`/`extsload`.
- **Chain:** EF EIP-8141 / ERC-8421 alternative-mempool devnet (chain 1337, ethrex `eip8141-tracer` + the ERC-8421 mempool sidecar), with Uniswap v4 PoolManager, Quoter and StateView predeployed from mainnet bytecode. Accounts and the paymaster stake in the ERC-8421 staking registry so the alternative mempool admits their storage reads.
- **Signatures:** owner keys on the native P256 scheme (EIP-8141 signature scheme 2); intents use the explicit-`msg` signature path; the filler co-signs the canonical hash as a second signature entry.
- **SDK (`@kabuto/sdk`, TypeScript + viem):** protectedSwap, sponsoredSwap, signIntent, buildFill, track (lifecycle from the sidecar explorer API), explainRejection.
- **Filler network:** an untrusted intent relay (intents are self-authenticating) and a reference filler that quotes with the v4 Quoter and races other fillers via same-nonce replacement; attacker modes demonstrate refused tampering.
- **DEX (Vite + React):** runs fully in the browser (keys, deploy, stake, sign), Oboro-style UI; art generated with ChatGPT and animated with Gemini.
- **Battle-testing:** Foundry unit + fuzz tests with mocked frame opcodes, a live devnet e2e suite, a soak run, a real sandwich bot, and a replay of real Uniswap v4 sandwiches on Ethereum mainnet.
- **Hacky bit:** discovering that the devnet's FRAMEDATACOPY/FRAMEPARAM (marked unexercised in the helper library) work, and squeezing two VERIFY frames, two signatures and a full frame-shape check under the 100k validation-gas cap.

## Prizes
- Ethereum Foundation: Best use of the Frame Transaction Alternative Mempool
- Uniswap Foundation: Build with Uniswap (FEEDBACK.md included)

## Links
- Repo: https://github.com/nickthelegend/kabuto
- Demo video: TBD
- Live app: TBD
