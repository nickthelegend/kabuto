# Kabuto

**Swaps that are only valid if you get your price, whether you route them yourself or let anyone compete to fill them.**

Kabuto is a DEX, an SDK and an open filler network built on **EIP-8141 frame transactions** and **Uniswap v4**, running live on the Ethereum Foundation's public frame-transaction devnet (chain 1337, ERC-8421 alternative mempool).

- **Protected swap.** You route the swap. Your account's VERIFY frame reads the Uniswap v4 pool price. If a bot moves it before inclusion, the transaction is invalid: it is never included, and you pay nothing.
- **Open intent ("SIGHASH_ANYONECANPAY for Ethereum").** You sign only an intent: up to X in, at least a Dutch-decaying minimum out. Any filler completes the transaction through Uniswap v4 and pays the gas. There is no settlement contract, no Permit2 and no auction server: fillers replace each other in the mempool by fee.
- **The swap pays its own gas.** A staked paymaster sponsors a protected swap and is repaid from the swap's output inside the same atomic batch.

> EIP-8141 is not on mainnet yet (it is considered for the Hegotá upgrade). Kabuto runs on the EF devnet today, against Uniswap v4's real contracts, so it is ready the day frame transactions ship.

## Proof on chain

Every claim below is a transaction on the devnet explorer (https://explorer.altmempool.wtf).

| What | Result | Tx |
|---|---|---|
| Protected swap inside its price band | mined, price check + approve + swap as one batch | [`0x45345cfa…e08a`](https://explorer.altmempool.wtf/tx/0x45345cfa137774ca97c8a1b8e3d58f51b19940a4db3ef765ea9680f135a1e08a) |
| A bot front-runs a protected swap that is already in the mempool | bot mined first | [`0x3ac90a6e…8149`](https://explorer.altmempool.wtf/tx/0x3ac90a6ef90e45519256f33fb90efe3e4e2af6aab50b2337ad0eb3c4ce888149) |
| …the protected swap it targeted | **never included (Cancelled), 0 gas** | [`0xbc0334ea…ea80`](https://explorer.altmempool.wtf/tx/0xbc0334ead2575f8a6c6c54d06292da3c71dd5bfb6a20c5097fcfd29c0fe2ea80) |
| Swap pays its own gas (Kabuto paymaster) | 5/5 frames, account ETH moved 0 wei | [`0x7559cff5…7cde`](https://explorer.altmempool.wtf/tx/0x7559cff5fa0398cc452800c66261f03c90bf9925164f5e4c51628c4eef707cde) |
| Open intent filled by a third-party filler | 5/5 frames, filler paid gas, account got its minimum | [`0xefebea6a…cce3`](https://explorer.altmempool.wtf/tx/0xefebea6a0a5c7b3e75229c5a9980ee823cd1273945e036a897d12f00fb38cce3) |
| A filler underpays an intent | settle frame failed, batch rolled back, user's tokens unchanged | [`0xb0a236cc…5e64`](https://explorer.altmempool.wtf/tx/0xb0a236ccb9451dcefe266fb3f1db4d12a72b86d1b21fa832fa0c4fac11685e64) |
| Owner key on the native P256 signature scheme | mined | [`0xfe705666…b7d3`](https://explorer.altmempool.wtf/tx/0xfe70566620a7e2798002ea376b598d7a6614fee279c861b2cc6146978178b7d3) |

Refused at admission (never in a block, no hash, no gas): an extra SENDER frame that pays the attacker (`BadIntentShape(9)`), pulling more than `maxIn` (`BadIntentShape(6)`), dropping the atomic flag (`BadIntentShape(7)`), and a protected swap after the price left its band (`PriceOutOfBand`).

## How it works

### Protected swap (`KabutoAccount.verifyPrice`)

```
VERIFY  account   verifyPrice(poolId, minSqrtPriceX96, maxSqrtPriceX96)   reads PoolManager slot0 via extsload
SENDER  tokenIn   approve(router, amountIn)                               atomic
SENDER  router    swapExactIn(key, zeroForOne, amountIn, minOut, account)
```

A sandwich needs the victim's swap to land after the front-run. A Kabuto swap that would land after a price-moving front-run fails its own VERIFY frame, and a frame transaction whose VERIFY frame fails is invalid: builders cannot include it and nobody is charged. Reading the PoolManager's storage breaks the canonical mempool's storage rule, so the account stakes in the ERC-8421 staking registry and uses the standard alternative mempool.

### Open intent (`KabutoAccount.verifyIntent` / `settleIntent`)

The owner signs `intentDigest(intent)` as an **explicit 32-byte signature `msg`**, not the transaction's signature hash. EIP-8141's security considerations warn that such an approval "authorizes an open-ended list" and that "validation code must therefore bind its approval to the entire set of frames it is willing to authorize". `verifyIntent` does exactly that:

```
0  VERIFY   account   verifyIntent(intent)        owner signature over the intent; checks every frame below
1  VERIFY   filler    pay()                       filler co-signs the full tx (sig entry 1) and pays the gas
2  SENDER   tokenIn   transfer(filler, ≤ maxIn)   atomic, no value
3… DEFAULT  filler    fill(...)                   swaps through Uniswap v4, pays the account; caller is ENTRY_POINT,
                                                  so it cannot act as the account; atomic, no value
n  SENDER   account   settleIntent(tokenOut, balanceBefore, startOut, endOut, startTime, deadline)
```

`balanceBefore` is read inside VERIFY and must match the settle frame's calldata byte for byte, so the settlement measures exactly what the fill delivered. The minimum decays linearly from `startOut` to `endOut` (a Dutch auction enforced by the account itself). Fillers compete by sending the same intent at the same nonce; the alternative mempool's same-nonce replacement keeps the highest fee.

### The swap pays its own gas (`KabutoPaymaster.sponsor`)

The paymaster's VERIFY frame inspects the transaction with `TXPARAM`, `FRAMEPARAM` and `FRAMEDATACOPY`, and approves payment only for a price-pinned approve/swap/fee batch on its pool that repays it in the swap's output token. It also checks the price band and the sender's input balance, so a moved price makes the tx invalid instead of costing the sponsor gas.

## Repository

| Package | What |
|---|---|
| `packages/contracts` | `KabutoAccount`, `KabutoPaymaster`, `KabutoFiller`, `KabutoRouter`, `DevnetToken` (Foundry, `@forshtat/hegota-support` for the frame opcodes, Uniswap v4-core) |
| `packages/sdk` | `@kabuto/sdk`: `protectedSwap`, `sponsoredSwap`, `signIntent`, `buildFill`, `track`, `explainRejection` |
| `packages/filler` | intent relay (untrusted, self-authenticating intents) + reference filler bot + attacker modes |
| `packages/app` | Kabuto DEX (Vite + React): landing, protected swaps, open intents, live lane |
| `packages/bot` | a real sandwich bot that watches both mempools |
| `packages/replay` | real Uniswap v4 sandwiches on Ethereum mainnet, and the share a ±0.5% band would have stopped |
| `packages/devnet` | the scripts that produced the proof transactions above |
| `packages/e2e` | live devnet test suite |
| `deployments/1337.json` | deployed addresses |

## Run it

```sh
pnpm install
pnpm --dir packages/contracts exec forge build
pnpm --dir packages/filler relay        # intent relay on :8788
pnpm --dir packages/filler filler       # a filler
pnpm --dir packages/app dev             # Kabuto DEX on :5180
```

The DEX creates a devnet-only P256 key in your browser, takes 1 ETH from the devnet faucet, deploys and stakes your account, and mints test kUSD (a devnet token; nobody outside the devnet operators can mint USDC there).

## Deployments (chain 1337)

See [`deployments/1337.json`](deployments/1337.json). Uniswap v4 PoolManager `0x6bF9Aa9c04fd001385742d61f6818C3236429848`, Quoter `0xeEa49CC6419125E2f706bf7f95Cf34ac7e93087D` and StateView `0xd89a052862AaA34f0B6cc7f3B6a9D080584a43FB` are the devnet's predeployed real v4 contracts.

## License

MIT © 2026 Nivesh Gajengi
