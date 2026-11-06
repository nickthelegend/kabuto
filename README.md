# Kabuto

**A DEX where a sandwiched swap stops existing.** A sandwich bot needs your swap to stay valid after it has moved the price. Kabuto puts the Uniswap v4 price check inside the transaction's own EIP-8141 VERIFY frame, so if a bot moves the price, your swap is no longer a valid transaction: it is never included and costs you nothing. Or skip routing: sign an intent (no gas), and any filler can complete it through Uniswap v4 and pay the gas, while your account refuses any fill that breaks the signed shape. Kabuto ships as a DEX, an SDK (`@kabuto/sdk`), an open filler network with its intent board on Arkiv, and KabutoGuard, a Uniswap v4 hook that only lets price-pinned frame transactions trade.

**Live app:** https://kabuto-self.vercel.app · **Chain:** Ethereum Foundation EIP-8141 / ERC-8421 alt-mempool devnet (chain 1337) · **Explorer:** https://explorer.altmempool.wtf · **Intent board:** Arkiv Rabdi testnet · **License:** MIT

![Kabuto landing](docs/img/landing-hero.png)

> **Scope, stated up front.** EIP-8141 (frame transactions) is not on Ethereum mainnet or Sepolia; it is proposed for the Hegotá upgrade. Kabuto runs on the EF's public frame-transaction devnet, where Uniswap v4's PoolManager, V4 Quoter and StateView are predeployed. The mainnet numbers below come from a read-only replay of real mainnet blocks, and the mainnet checker only reads; Kabuto sends no mainnet transactions.

---

## The 60-second version

### Three live proofs (open them)

| # | What you'll see | Transaction |
|---|---|---|
| 1 | **The problem, live.** An ordinary 1,500 kUSD swap with 2% slippage is sandwiched by our bot: front-run, victim, back-run at indices 0, 1, 2 of block 407,046. The victim got 0.04543 WETH against a 0.04626 quote (1.80% worse, 27.04 kUSD). | victim [`0xbf074d56…de29`](https://explorer.altmempool.wtf/tx/0xbf074d561e3ed81a19eb3c4eea24efa7e6d8ec48511543fd318682d72afbde29) |
| 2 | **The fix, live.** The same swap with protection on (±0.5% pin). The same bot front-ran it in block 407,052; the alt-mempool re-ran the VERIFY frame, it reverted with `PriceOutOfBand` (`0x8ad5a9c0`), and the swap was dropped: status `Cancelled`, no receipt, 0 gas. | [`0x2e8b5b7c…2e92`](https://explorer.altmempool.wtf/tx/0x2e8b5b7ca0801c1ba0931593d33f099a19a0189ed057d775b74b9d88cf7b2e92) |
| 3 | **A pool that can't be sandwiched.** In the KabutoGuard v4 pool, a price-pinned frame transaction swaps; a plain legacy transaction (what a sandwich bot sends) through the same router reverts with `NotFrameTx()` (`0x2e55cc19`). | pinned [`0xd1962486…f861`](https://explorer.altmempool.wtf/tx/0xd1962486165f1c4afdf3aec80ad6f2c6f882063403ad81e8469165e68472f861) · plain [`0x8fd351e2…1829`](https://explorer.altmempool.wtf/tx/0x8fd351e2cffefc53e3680916bdb4007f24cbbc9b601ae37b13a80287e3291829) |

Also live: an intent filled by a third-party filler that paid the gas ([`0xdfd70b01…c065`](https://explorer.altmempool.wtf/tx/0xdfd70b014486b1d92669271318502d159570de709be0dbb2a99682da49b8c065)), its Arkiv fill record ([`0xd9cc8020…4e5f`](https://rabdi.explorer.arkiv.network/entity/0xd9cc8020d93d9bdae3052f914a1770613cc2c4958edaf72cf0621cca76fd4e5f)), and a "Were you sandwiched?" checker on the landing page that reads real Ethereum mainnet.

### How it fits together

```mermaid
flowchart LR
  U["Kabuto DEX / @kabuto/sdk<br/>(P256 key in the browser)"]
  R["Intent relay<br/>(untrusted)"]
  AK[("Arkiv Rabdi<br/>intent board + fill log")]
  F["Fillers<br/>(anyone)"]
  M["ERC-8421 alt-mempool<br/>chain 1337"]
  A["KabutoAccount<br/>VERIFY: verifyPrice / verifyIntent"]
  G["KabutoGuard hook<br/>beforeSwap reads the frame tx"]
  V4["Uniswap v4 PoolManager"]
  B["Sandwich bot<br/>(real, hosted)"]
  U -- "protected swap (frame tx)" --> M
  U -- "signed intent, no gas" --> R
  R -- "mirror, expires at deadline" --> AK
  AK -- "open intents" --> F
  AK -- "Intents tab" --> U
  F -- "fill tx, filler pays gas" --> M
  M --> A
  A -- "extsload slot0 in VERIFY" --> V4
  A -- "swap in SENDER frames" --> V4
  V4 -- "beforeSwap" --> G
  B -- "front-runs, back-runs" --> V4
```

### Run it

```sh
pnpm install
forge test --root packages/contracts        # 19 tests (10 core + 9 KabutoGuard)
pnpm --dir packages/app dev                 # the DEX on :5180, against the public devnet
pnpm --dir packages/bot watch               # read-only view of the hosted sandwich bot
```

Full backend (relay, filler, bot, faucet): `docker compose up -d --build`, or see [Run it](#run-it-1) below.

### Limits (full list in [Known limits](#known-limits-honest-list))

- Devnet only: EIP-8141 is not on any public network yet. kUSD is a devnet test token; the WETH/kUSD pool is thin and its price has drifted away from real ETH.
- Of the live e2e suite's last full run, 6 cases passed and 4 timed out waiting for inclusion while the public devnet stalled ([TESTING.md](TESTING.md)).
- How ERC-8421 reputation should score swaps that are cancelled by price movement is an open question ([EF-FINDINGS.md](EF-FINDINGS.md)).

---

## For judges: prize requirements → evidence

| Prize | Stated requirement | Where it is |
|---|---|---|
| **EF: Best Use of the Frame Transaction Alternative Mempool** | Real alt-mempool usage (an admitted devnet tx, or code that submits one) | Admitted and mined: [`0x45345cfa…`](https://explorer.altmempool.wtf/tx/0x45345cfa137774ca97c8a1b8e3d58f51b19940a4db3ef765ea9680f135a1e08a), [`0xdfd70b01…`](https://explorer.altmempool.wtf/tx/0xdfd70b014486b1d92669271318502d159570de709be0dbb2a99682da49b8c065), [`0xd1962486…`](https://explorer.altmempool.wtf/tx/0xd1962486165f1c4afdf3aec80ad6f2c6f882063403ad81e8469165e68472f861); admitted then cancelled: [`0x2e8b5b7c…`](https://explorer.altmempool.wtf/tx/0x2e8b5b7ca0801c1ba0931593d33f099a19a0189ed057d775b74b9d88cf7b2e92). Submitting code: [`packages/sdk/src/index.ts`](packages/sdk/src/index.ts) (`protectedSwap`, `submitFill`) |
| | Explain the design, code and trade-offs | [Architecture](#architecture), [Design trade-offs](#design-trade-offs), [EF-FINDINGS.md](EF-FINDINGS.md) (what we verified on the devnet and what broke) |
| **Uniswap: Build with Uniswap** | Public repo, open source | this repo, MIT |
| | FEEDBACK.md + the Uniswap Developer Feedback Form linked to it | [FEEDBACK.md](FEEDBACK.md) (form answers at the end of that file) |
| | README points to the relevant contracts and code lines | [Uniswap v4 code pointers](#uniswap-v4-code-pointers) |
| **Arkiv: Build on Arkiv (from scratch)** | Built at the event | first commit 2026-11-05 21:44 IST, after hacking opened at 21:00 IST |
| | Writes to Arkiv testnet; a user-facing feature reads it | relay writer [`packages/filler/src/arkiv.ts`](packages/filler/src/arkiv.ts); the DEX's Intents tab reads Rabdi every 4 s ([`packages/app/src/lib/arkiv.ts`](packages/app/src/lib/arkiv.ts)) |
| | README: writer wallet + a query judges can run | [Arkiv intent board](#arkiv-intent-board-rabdi-testnet) |
| | `arkiv/schema.md`, friction feedback, one file per criterion | [schema](arkiv/schema.md), [friction](arkiv/friction.md), [reach](arkiv/reach.md), [why Arkiv](arkiv/why-arkiv.md), [how we use Arkiv](arkiv/how-you-use-arkiv.md) |
| | Open-source license, AI disclosure | [LICENSE](LICENSE) (MIT); [AI usage](#ai-usage) |

---

## The same 1,500 kUSD swap, three ways (live, Nov 6 2026)

![Unprotected: sandwiched 1.80% worse. Protected: blocked, 0 gas, saved 27.04 kUSD. Intent: filled by a third party, 0 gas.](docs/img/dex-three-outcomes.png)

| Mode | What happened on chain | Tx |
|---|---|---|
| **Protection off** (ordinary wallet, 2% slippage) | Bot front-run, victim and back-run at **indices 0, 1, 2 of block 407,046**. The victim received 0.04543 WETH against a 0.04626 WETH quote: **1.80% worse, 27.04 kUSD lost.** | victim [`0xbf074d56…de29`](https://explorer.altmempool.wtf/tx/0xbf074d561e3ed81a19eb3c4eea24efa7e6d8ec48511543fd318682d72afbde29), front [`0xa33875b5…4e18`](https://explorer.altmempool.wtf/tx/0xa33875b5dcd12802e25c92150f8b87284b766f945e49a5ca589a6a6975784e18), back [`0xba51ab55…b3d2`](https://explorer.altmempool.wtf/tx/0xba51ab5570bcd69b298bd7efad26002dc3b23c591bcdfdf3bc0b616699b8b3d2) |
| **Protection on** (Kabuto account, ±0.5% pin) | The same bot front-ran it (block 407,052, index 0). The front-run pushed the price out of the pinned band, so the alt-mempool's revalidation of the VERIFY frame failed (`PriceOutOfBand`): **dropped with status `Cancelled`, no receipt, 0 gas.** The bot was left holding its front-run. | victim [`0x2e8b5b7c…2e92`](https://explorer.altmempool.wtf/tx/0x2e8b5b7ca0801c1ba0931593d33f099a19a0189ed057d775b74b9d88cf7b2e92), front [`0xd368dd0c…bc3c`](https://explorer.altmempool.wtf/tx/0xd368dd0c3dae6f660d415967e1d6d19004a85400c32f4c3d52f034c62dbfbc3c) |
| **Intent** (300 kUSD → WETH) | Signed off-chain (0 gas), posted to the open relay. A third-party filler built the frame transaction, routed it through Uniswap v4 and paid the gas. The account received 0.00886 WETH (signed minimum 0.00885). | [`0xdfd70b01…c065`](https://explorer.altmempool.wtf/tx/0xdfd70b014486b1d92669271318502d159570de709be0dbb2a99682da49b8c065) |

The "You saved" figure is computed from the swaps themselves (`kUSD paid × shortfall vs quote`), and only shown when the protected swap has the same size and direction as the sandwiched one.

### Watch the attack from the bot's side

```sh
pnpm --dir packages/bot watch -- --history 2      # read-only view of the hosted bot's /events and /attempts
```

![The sandwich bot's terminal view](docs/img/bot-terminal.png)

---

## Architecture

### System

```mermaid
flowchart LR
  subgraph Browser["Browser (Vercel: kabuto-self.vercel.app)"]
    UI["Kabuto DEX<br/>React + viem"]
    KEY["P256 owner key<br/>(devnet only, localStorage)"]
    EOA["Ordinary EOA<br/>(for the unprotected comparison)"]
  end
  subgraph Devnet["EF EIP-8141 devnet · chain 1337"]
    AMP["ERC-8421 alt-mempool sidecar<br/>altmempool.forshtat.com/rpc"]
    PUB["Public mempool (ethrex)"]
    subgraph Contracts
      ACC["KabutoAccount<br/>verifyPrice · verifyIntent · settleIntent"]
      PM["KabutoPaymaster<br/>sponsor()"]
      FIL["KabutoFiller<br/>pay() · fill()"]
      RT["KabutoRouter"]
      V4["Uniswap v4 PoolManager<br/>WETH/kUSD 0.3%"]
      REG["ERC-8421 staking registry"]
    end
  end
  subgraph VPS["Hackathon VPS (Docker behind Traefik)"]
    REL["Intent relay :8788<br/>kabuto-relay…sslip.io"]
    FA["Filler A"]
    BOT["Sandwich bot :8787<br/>kabuto-bot…sslip.io"]
    FAU["Fallback ETH faucet :8789"]
  end
  UI -- "frame tx (type 0x06)" --> AMP
  EOA -- "legacy swap" --> PUB
  UI -- "signed intent (no tx)" --> REL
  REL -- "SSE intents" --> FA
  FA -- "frame tx, pays gas" --> AMP
  BOT -- "watches both mempools,<br/>front-runs / back-runs" --> PUB
  AMP --> ACC
  ACC -- "extsload slot0" --> V4
  RT --> V4
  FIL --> V4
  ACC -. staked .-> REG
  PM -. staked .-> REG
```

### Why a sandwiched Kabuto swap can't be included

```mermaid
sequenceDiagram
  participant U as Your Kabuto account
  participant M as Alt-mempool (ERC-8421)
  participant B as Sandwich bot
  participant P as Uniswap v4 pool
  U->>M: frame tx: VERIFY verifyPrice(pool, min, max) · SENDER approve · SENDER swap
  M->>M: admission: run VERIFY, price inside band → admitted
  B->>P: front-run at a higher fee (moves the price)
  Note over M,P: block building re-runs VERIFY against the new pool state
  M->>U: VERIFY reverts (PriceOutOfBand) → tx invalid
  Note over U: status Cancelled · no receipt · 0 gas · tokens untouched
  Note over B: holds its front-run, nothing to sell into
```

An ordinary swap with a 2% `minAmountOut` is valid at any price above its floor, so the bot can buy first and sell after, inside your slippage. A failed slippage check still lands and still costs gas. Kabuto's check runs before the transaction is valid at all.

### Protected swap frames (`KabutoAccount.verifyPrice`)

```
0  VERIFY  account   verifyPrice(poolId, minSqrtPriceX96, maxSqrtPriceX96)   reads PoolManager slot0 via extsload, APPROVE(EXECUTION_AND_PAYMENT)
1  SENDER  tokenIn   approve(router, amountIn)                               atomic
2  SENDER  router    swapExactIn(key, zeroForOne, amountIn, minOut, account)
```

Reading another contract's storage in VERIFY breaks the canonical mempool's storage rule, so the account stakes in the ERC-8421 staking registry and uses the alternative mempool, which is exactly what that mempool is for.

### Open intent frames (`KabutoAccount.verifyIntent` / `settleIntent`)

New to intents? [docs/INTENTS.md](docs/INTENTS.md) explains them from zero.

The owner signs `intentDigest(intent)` as an **explicit 32-byte signature `msg`**, not the transaction's signature hash. EIP-8141's security considerations warn that such an approval "authorizes an open-ended list" of frames and that validation "must therefore bind its approval to the entire set of frames it is willing to authorize". `verifyIntent` does that:

```
0  VERIFY   account   verifyIntent(intent)        owner signature over the intent + checks every frame below
1  VERIFY   filler    pay()                       filler co-signs the whole tx (signature entry 1) and pays the gas
2  SENDER   tokenIn   transfer(filler, ≤ maxIn)   exactly 68 bytes of calldata; atomic; no value
3… DEFAULT  filler    fill(...)                   swaps through Uniswap v4 and pays the account; caller is ENTRY_POINT,
                                                  so it cannot act as the account; atomic; no value
n  SENDER   account   settleIntent(tokenOut, balanceBefore, startOut, endOut, startTime, deadline)
```

`balanceBefore` is read during VERIFY and must equal the settle frame's calldata byte for byte, so settlement measures exactly what this fill delivered. The minimum decays linearly from `startOut` to `endOut` (a Dutch auction enforced by the account). Fillers compete with the same nonce; the alt-mempool keeps the highest fee.

```mermaid
sequenceDiagram
  participant O as Owner (P256 key)
  participant R as Relay (untrusted)
  participant F as Filler
  participant M as Alt-mempool
  participant A as KabutoAccount
  O->>R: signed intent (no transaction, no gas)
  R-->>F: SSE intent_posted
  F->>F: quote on the v4 Quoter, build 5 frames
  F->>M: frame tx (filler pays)
  M->>A: VERIFY verifyIntent: signature, nonce, every frame's mode/target/flags/data
  A->>A: SENDER transfer ≤ maxIn → DEFAULT fill via v4 → SENDER settleIntent
  Note over A: settle reverts if received < decayed minimum → whole atomic batch rolls back
```

### KabutoGuard: a Uniswap v4 pool that cannot be sandwiched (`KabutoGuardHook`)

A v4 hook whose `beforeSwap` reads **the transaction it is running in**. Inside an EIP-8141 transaction, a contract called from a SENDER frame (here a hook, called by the PoolManager during `unlock`) can read `TXPARAM`, `FRAMEPARAM` and `FRAMEDATACOPY`. The hook requires an **earlier, successful VERIFY frame by the sender that pinned this pool's price**, with a band no wider than 2%. Otherwise it reverts:

- a plain (legacy / 1559) transaction, which is what a sandwich bot sends → `NotFrameTx()`
- no pin, a pin for another pool, a later or failed VERIFY frame, or a pin on another account → `NoPricePin()`
- a band wider than `MAX_BAND_BPS` → `BandTooWide()`

So in this pool every swap is price-pinned: a front-run makes the honest swap invalid, and a bot's plain transaction can't trade at all. The hook does not need to trust the sender's account code: an account whose `verifyPrice` doesn't really check only fails to protect itself (see the contract's comment). Only possible with frame transactions.

| Live (Nov 6 2026) | |
|---|---|
| Hook (BEFORE_SWAP flag, CREATE2-mined) | `0x9A485379e6307A12cF380D9F783296Aa1E570080` |
| Guarded WETH/kUSD pool | `0x4869421e2f2f11bcdecdf1168a5b6183eb00c123cc1d5181b8712af074b91725` |
| Price-pinned frame-tx swap | [`0xd1962486…f861`](https://explorer.altmempool.wtf/tx/0xd1962486165f1c4afdf3aec80ad6f2c6f882063403ad81e8469165e68472f861): `OnChain`, all frames successful |
| Plain legacy swap through the same router | [`0x8fd351e2…1829`](https://explorer.altmempool.wtf/tx/0x8fd351e2cffefc53e3680916bdb4007f24cbbc9b601ae37b13a80287e3291829): mined, **reverted**; revert data is v4's wrapped hook error carrying `NotFrameTx()` (`0x2e55cc19`) |

### The swap can pay its own gas (`KabutoPaymaster.sponsor`)

The paymaster's VERIFY frame inspects the transaction with `TXPARAM`, `FRAMEPARAM` and `FRAMEDATACOPY`. It approves payment only for a price-pinned approve/swap/fee batch on its own pool (checked against the full v4 PoolKey hash) that repays it in the output token. It also checks the price band and the sender's balance, so a moved price makes the transaction invalid instead of costing the sponsor gas.

---

## Design trade-offs

| Choice | Why | What it costs |
|---|---|---|
| Price check in a VERIFY frame instead of a `minAmountOut` | A moved price makes the transaction invalid, so a sandwich has nothing to sell into and the user pays no gas | VERIFY reads PoolManager storage, which the canonical mempool forbids, so the account must stake in the ERC-8421 registry and use the alternative mempool |
| Cancel instead of revert | A cancelled transaction is free for the user and gives the bot nothing | ERC-8421 counts admitted-but-not-included transactions against a staked sender. A user who is attacked often could lose reputation; this is open (see [EF-FINDINGS.md](EF-FINDINGS.md)) |
| Intents signed as an explicit 32-byte `msg` | The owner signs once, without knowing who fills or what the filler's frames look like | EIP-8141 warns that this approval covers every later SENDER frame, so `verifyIntent` must check every frame's mode, target, flags, value and calldata, which costs validation gas |
| Everything inside the 100k validation-gas cap | Fits the devnet's `MAX_VERIFY_GAS`, so no special mempool budget is needed | The cap covers the whole validation prefix plus 2,800 gas per secp256k1 and 6,700 per P256 signature. For a P256 owner plus a filler co-signature and `pay()`, `verifyIntent` gets 78,500 gas ([`intentVerifyBudget`](packages/sdk/src/index.ts#L49)) |
| Dutch decay enforced by the account, competition by same-nonce replacement | No settlement contract, no auction server: the alt-mempool keeps the highest fee | Fillers compete on fee, not on a sealed price; a filler sees the intent in public |
| An untrusted relay mirrored to Arkiv | Intents carry their own signature, so anyone can host a relay or read the board | Readers must filter by the writer as owner and re-verify each signature on chain 1337 |
| KabutoGuard trusts the sender's own VERIFY pin | The hook doesn't need to know the account's code | An account whose `verifyPrice` doesn't really check only fails to protect itself; it cannot weaken the pool for others |

## Uniswap v4 code pointers

| What | Code |
|---|---|
| Read the v4 pool price inside VERIFY (`StateLibrary.getSlot0` → `extsload`) | [`KabutoAccount.sol:178-180`](packages/contracts/src/KabutoAccount.sol#L178), called from `verifyPrice` at [:71](packages/contracts/src/KabutoAccount.sol#L71) |
| The paymaster's price check against its own pool | [`KabutoPaymaster.sol:125`](packages/contracts/src/KabutoPaymaster.sol#L125), inside `sponsor` at [:80](packages/contracts/src/KabutoPaymaster.sol#L80) |
| Router: `unlock` → `swap` → `sync`/`settle`/`take` | [`KabutoRouter.sol:48`](packages/contracts/src/KabutoRouter.sol#L48) `swapExactIn`, [:76](packages/contracts/src/KabutoRouter.sol#L76) `swap`, [:92](packages/contracts/src/KabutoRouter.sol#L92) `take`, [:109-113](packages/contracts/src/KabutoRouter.sol#L109) `_settle` |
| Filler swaps tokens it received earlier in the same transaction | [`KabutoFiller.sol:52`](packages/contracts/src/KabutoFiller.sol#L52) `unlock`, [:62](packages/contracts/src/KabutoFiller.sol#L62) `swap`, [:74-77](packages/contracts/src/KabutoFiller.sol#L74) `sync`/`settle`/`take` |
| KabutoGuard `beforeSwap`: finds an earlier successful VERIFY price pin by the sender | [`KabutoGuardHook.sol:59`](packages/contracts/src/KabutoGuardHook.sol#L59), frame scan [:79-84](packages/contracts/src/KabutoGuardHook.sol#L79), band limit [:97](packages/contracts/src/KabutoGuardHook.sol#L97) |
| V4 Quoter (`quoteExactInputSingle`) and StateView (`getSlot0`) from the SDK | [`packages/sdk/src/index.ts:169`](packages/sdk/src/index.ts#L169), [:174](packages/sdk/src/index.ts#L174) |
| Hook deployment (CREATE2-mined BEFORE_SWAP address, 200 bps max band) | [`packages/devnet/src/guard.ts:77`](packages/devnet/src/guard.ts#L77) |
| Tests against a real v4 PoolManager (compiled from `v4-core`, stored in `test/PoolManager.creation.json`) | [`packages/contracts/test/Kabuto.t.sol`](packages/contracts/test/Kabuto.t.sol) (router and filler swaps), [`KabutoGuard.t.sol`](packages/contracts/test/KabutoGuard.t.sol) (9 hook tests) |

## Every claim, where it is enforced, and where it is proven

| Claim | Enforced in | Tested in | On chain |
|---|---|---|---|
| A protected swap is only valid inside its signed price band | `KabutoAccount.verifyPrice` ([KabutoAccount.sol:71](packages/contracts/src/KabutoAccount.sol#L71)), slot0 read at [:179](packages/contracts/src/KabutoAccount.sol#L179) | `packages/contracts/test/Kabuto.t.sol` (price bounds) | [`0x45345cfa…e08a`](https://explorer.altmempool.wtf/tx/0x45345cfa137774ca97c8a1b8e3d58f51b19940a4db3ef765ea9680f135a1e08a) mined in band |
| A front-run makes it invalid: never included, 0 gas | the VERIFY revert above + EIP-8141 validity rules | live: `packages/e2e` bot-first race | [`0xbc0334ea…ea80`](https://explorer.altmempool.wtf/tx/0xbc0334ead2575f8a6c6c54d06292da3c71dd5bfb6a20c5097fcfd29c0fe2ea80), [`0x2e8b5b7c…2e92`](https://explorer.altmempool.wtf/tx/0x2e8b5b7ca0801c1ba0931593d33f099a19a0189ed057d775b74b9d88cf7b2e92) `Cancelled` |
| The same bot really sandwiches an ordinary swap | — (that's the problem) | `packages/bot` measures quote vs realized output | [`0xbf074d56…de29`](https://explorer.altmempool.wtf/tx/0xbf074d561e3ed81a19eb3c4eea24efa7e6d8ec48511543fd318682d72afbde29) indices 0/1/2, −1.80% |
| An intent fill can't take more than `maxIn` | [KabutoAccount.sol:118-120](packages/contracts/src/KabutoAccount.sol#L118) `BadIntentShape(6)` | Foundry + live attack `over-max` | refused at admission (no hash, no gas) |
| Filler frames can't act as the account | [:126](packages/contracts/src/KabutoAccount.sol#L126) `BadIntentShape(9)` | Foundry + live attack `extra-sender` | refused at admission |
| The batch is atomic | [:124](packages/contracts/src/KabutoAccount.sol#L124) `BadIntentShape(7)` | Foundry + live attack `no-atomic` | refused at admission |
| An underpaying fill rolls back | `settleIntent` ([:146](packages/contracts/src/KabutoAccount.sol#L146)), Dutch decay ([:157](packages/contracts/src/KabutoAccount.sol#L157)) | Foundry + live `underpay` (balance identical at blocks N−1 and N) | [`0xb0a236cc…5e64`](https://explorer.altmempool.wtf/tx/0xb0a236ccb9451dcefe266fb3f1db4d12a72b86d1b21fa832fa0c4fac11685e64) |
| A third-party filler pays the gas | `KabutoFiller.pay` ([KabutoFiller.sol:43](packages/contracts/src/KabutoFiller.sol#L43)) | live e2e intent case | [`0xefebea6a…cce3`](https://explorer.altmempool.wtf/tx/0xefebea6a0a5c7b3e75229c5a9980ee823cd1273945e036a897d12f00fb38cce3) |
| A swap can pay its own gas | `KabutoPaymaster.sponsor` ([KabutoPaymaster.sol:80](packages/contracts/src/KabutoPaymaster.sol#L80)) | Foundry paymaster codes 1–13 | [`0x7559cff5…7cde`](https://explorer.altmempool.wtf/tx/0x7559cff5fa0398cc452800c66261f03c90bf9925164f5e4c51628c4eef707cde) account ETH moved 0 wei |
| A v4 pool where plain transactions cannot swap and every swap is price-pinned | `KabutoGuardHook.beforeSwap` ([KabutoGuardHook.sol](packages/contracts/src/KabutoGuardHook.sol)) | `packages/contracts/test/KabutoGuard.t.sol` (9 tests) | pinned swap [`0xd1962486…`](https://explorer.altmempool.wtf/tx/0xd1962486165f1c4afdf3aec80ad6f2c6f882063403ad81e8469165e68472f861) OnChain; legacy swap [`0x8fd351e2…`](https://explorer.altmempool.wtf/tx/0x8fd351e2cffefc53e3680916bdb4007f24cbbc9b601ae37b13a80287e3291829) reverted `NotFrameTx()` |
| Owner keys use the native P256 scheme | `sigparam(0, RESOLVED_SIGNER) == owner` | live P256 case | [`0xfe705666…b7d3`](https://explorer.altmempool.wtf/tx/0xfe70566620a7e2798002ea376b598d7a6614fee279c861b2cc6146978178b7d3) |
| All of this fits the 100k validation-gas cap | `MAX_VERIFY_GAS` + per-signature cost (secp256k1 2,800, P256 6,700) in [packages/sdk/src/index.ts:45](packages/sdk/src/index.ts#L45) | the live P256 intent fill | [`0xefebea6a…cce3`](https://explorer.altmempool.wtf/tx/0xefebea6a0a5c7b3e75229c5a9980ee823cd1273945e036a897d12f00fb38cce3) |

More rows (bot-first race, paymaster, P256, every hash from the e2e suite) are in [TESTING.md](TESTING.md). What we learned about the devnet is in [EF-FINDINGS.md](EF-FINDINGS.md); what we hit with Uniswap v4 is in [FEEDBACK.md](FEEDBACK.md).

---

## Were you sandwiched? Check any mainnet swap (live today)

The landing page has a checker that runs on **real Ethereum mainnet**, in your browser: paste a Uniswap v4 swap's transaction hash and Kabuto reads that block's PoolManager `Swap` logs from public RPCs, applies the same front/victim/back rules as the replay below, and says whether you were sandwiched, by whom, how far the bot moved the price first, and whether a ±0.5% Kabuto pin would have made your swap invalid. Source: [packages/app/src/lib/mainnet.ts](packages/app/src/lib/mainnet.ts). It reproduces the replay's results exactly (same front-run, back-run and price move for the example victims).

![The mainnet checker on a real sandwiched swap](docs/img/mainnet-checker.png)

## How big the problem is: a mainnet replay

`packages/replay` scans Uniswap v4 PoolManager `Swap` logs on **Ethereum mainnet** (read-only), blocks 26,299,825–26,307,824 (27 hours), for front/victim/back triples whose front and back legs share a sender.

- **503** triples whose front and back legs share `tx.from`, covering **497** unique victim transactions.
- **388 of 501** evaluated (77%) moved the price more than 0.5% before the victim, so a ±0.5% Kabuto pin would have made those victim swaps invalid.
- How these are counted: `packages/replay/out/sandwiches.jsonl` (regenerated by `pnpm --dir packages/replay scan`, git-ignored), filtered to `attackerMatch == "from"`. The committed [`out/summary.json`](packages/replay/out/summary.json) uses the looser rule (front and back share `tx.from` or `tx.to`): 540 candidates, 419 of 538 evaluated (77.9%).
- No dollar figure: USD pricing covered about 1% of candidates. Heuristic, false-positive and false-negative risks: [METHOD.md](packages/replay/METHOD.md).

## SDK

```ts
import { createKabuto, p256Signer, devnet1337 } from "@kabuto/sdk";

const kabuto = createKabuto({ deployment: devnet1337 });
const me = p256Signer(localKey);

// route it yourself: a sandwich makes this tx invalid, so it costs 0
await kabuto.protectedSwap({ account, signer: me, zeroForOne: false, amountIn: 300_000000n, bandBps: 50 });

// or sign only an intent and let anyone race to fill it
const intent = await kabuto.signIntent({ account, signer: me, tokenIn, maxIn, tokenOut, startOut, endOut, startTime, deadline });
```

Full API: [packages/sdk/README.md](packages/sdk/README.md).

## Battle-tested

| Suite | Result |
|---|---|
| Foundry (`forge test --root packages/contracts`) | 19 tests, 0 failed (10 core + 9 KabutoGuard), 2 fuzz tests × 256 runs. Frame opcodes mocked at the `HegotaSupport` helper addresses; swaps against the real v4 PoolManager bytecode. Found two shape-check gaps, both fixed with regression tests and the paymaster redeployed. |
| Live devnet e2e (`pnpm --dir packages/e2e test`) | Protected swap, bot-first race, out-of-band and three tampered fills refused, run against the public devnet. Some cases were admitted but timed out waiting for inclusion while the public devnet stalled (every hash and outcome in TESTING.md). |
| Live app runs (this README's top table) | Ordinary swap sandwiched; protected swap cancelled at 0 gas; intent filled by a VPS filler. |
| Arkiv (`pnpm --dir packages/filler exec vitest run test/arkiv.test.ts`) | 2 passed (byte round trip, live public Rabdi read), 1 skipped (live write; needs a funded writer key in the environment) |
| Live sandwich bot (`packages/bot`) | Watches the public mempool and the alt-mempool, front-runs and back-runs real swaps, and records the realized loss vs the no-sandwich quote for every attempt. |

## Arkiv intent board (Rabdi testnet)

Open intents need a public place where any filler can find them. Kabuto's relay mirrors every verified, signed chain 1337 intent to **Arkiv** as an entity that **expires at the intent's own deadline**, and records each fill outcome as a separate entity. The app's Intents tab reads the board straight from Arkiv, and fillers can poll Arkiv instead of the relay (`--source arkiv`). Swaps still settle only on the EIP-8141 devnet; Arkiv is the data layer.

**Live, Nov 6 2026 (from the deployed app):**

| | |
|---|---|
| Writer address (owns every Kabuto entity) | [`0x8eD225Ae7f4b445Bfee6ad5dd9719C59426Af3aF`](https://rabdi.explorer.arkiv.network/address/0x8eD225Ae7f4b445Bfee6ad5dd9719C59426Af3aF) |
| Intent entity (300 kUSD → WETH, `kabuto.intent.v1`) | [`0xd309c13a…20d0`](https://rabdi.explorer.arkiv.network/entity/0xd309c13a29b10ff87b4ecfd62721f168397ea25930a0a2e5dc8f0f910be420d0), published ~4 s after posting, status patched `open` → `filled` |
| Fill entity (`kabuto.fill.v1`, outcome `landed`) | [`0xd9cc8020…4e5f`](https://rabdi.explorer.arkiv.network/entity/0xd9cc8020d93d9bdae3052f914a1770613cc2c4958edaf72cf0621cca76fd4e5f), linking the intent key to devnet fill [`0xd498630c…752b`](https://explorer.altmempool.wtf/tx/0xd498630c236fa7132b41011414430d0765d86b7ab4db62fc360901fc04f5752b) |

A landed fill is written only after the devnet explorer confirms the transaction on chain (fill reports arrive on an open endpoint). `GET https://kabuto-relay.201-18-198-162.sslip.io/arkiv` shows the writer, its tGLM balance, the publication count and the last error.

**Queries judges can run** on Rabdi (`https://rpc.rabdi.db-chain.testnet.arkiv.network`, chain 7794095):

```text
arkiv.schema = str('kabuto.fill.v1') AND $owner = addr(0x8eD225Ae7f4b445Bfee6ad5dd9719C59426Af3aF)
```

This is the fill log; fill entities live for 30 days, so it returns the landed fill above (checked Nov 6 2026: 1 row, expiring at Rabdi block 1,561,290). Open intents:

```text
arkiv.schema = str('kabuto.intent.v1') AND status = str('open') AND chainId = u64(1337) AND $owner = addr(0x8eD225Ae7f4b445Bfee6ad5dd9719C59426Af3aF)
```

Intent entities **expire at the intent's own deadline**, so this returns rows only while an intent is open; the first intent entity above has already expired, as designed (`getEntity` now reports "No live entity"). Post an intent in the app's Intents tab and it appears within seconds. Always filter by the writer as owner; anyone can write an entity with the same schema name.

From Node with the SDK:

```ts
import { createPublicClient } from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { http } from "viem";
const c = createPublicClient({ chain: rabdi({ accessKey: "" }), transport: http() });
console.log(await c.query("arkiv.schema = str('kabuto.fill.v1') AND $owner = addr(0x8eD225Ae7f4b445Bfee6ad5dd9719C59426Af3aF)",
  { select: { $key: true, $attributes: true }, limit: 100 }));
```

Schema and judging notes: [`arkiv/schema.md`](arkiv/schema.md), [`arkiv/how-you-use-arkiv.md`](arkiv/how-you-use-arkiv.md), [`arkiv/why-arkiv.md`](arkiv/why-arkiv.md), [`arkiv/reach.md`](arkiv/reach.md), [`arkiv/friction.md`](arkiv/friction.md).

## Where it runs

| Piece | Host |
|---|---|
| DEX + landing | Vercel: https://kabuto-self.vercel.app |
| Intent relay | VPS, `https://kabuto-relay.201-18-198-162.sslip.io` (`GET /intents`, `POST /intents`, SSE `/events`) |
| Filler A | VPS (Docker), races intents from the relay |
| Sandwich bot | VPS, `https://kabuto-bot.201-18-198-162.sslip.io` (`/status`, `/attempts`, SSE `/events`) |
| Fallback ETH faucet | VPS, `https://kabuto-faucet.201-18-198-162.sslip.io` (the devnet's public faucet is empty) |
| Contracts | EF devnet 1337, addresses in [`deployments/1337.json`](deployments/1337.json) |

Uniswap v4 PoolManager `0x6bF9Aa9c04fd001385742d61f6818C3236429848`, Quoter `0xeEa49CC6419125E2f706bf7f95Cf34ac7e93087D` and StateView `0xd89a052862AaA34f0B6cc7f3B6a9D080584a43FB` are the devnet's predeployed real v4 contracts. Kabuto's own pool is WETH/kUSD, fee 3000, tick spacing 60.

## Known limits (honest list)

- Devnet only, because EIP-8141 is not on any public network yet. kUSD is a devnet test token; USDC on the devnet is not mintable by us.
- The WETH/kUSD pool is thin and our demo runs keep buying WETH, so its price has drifted well above real ETH. The sandwich arithmetic is unaffected.
- The bot can miss: if a victim lands in the very next block, before the bot sees it in the mempool, it front-runs too late. Its viewer prints "did not form a sandwich" in that case, rather than a loss.
- One protected swap (`0x912537da…4818`) was recorded by the alt-mempool as `replaced` (a same-nonce replacement), not `Cancelled`. It also never executed and paid 0 gas, but the app's "Sandwich blocked" label is broader than the exact reason in that case.
- ERC-8421 counts admitted-but-not-included transactions against a staked sender's reputation. How price-invalidated swaps should be scored is an open question, documented in [EF-FINDINGS.md](EF-FINDINGS.md).
- Browser keys are devnet-only and live in localStorage.

## Repository

| Package | What |
|---|---|
| `packages/contracts` | `KabutoAccount`, `KabutoPaymaster`, `KabutoFiller`, `KabutoRouter`, `KabutoGuardHook`, `DevnetToken` (Foundry; `@forshtat/hegota-support` for frame opcodes; Uniswap v4-core) |
| `packages/sdk` | `@kabuto/sdk`: `protectedSwap`, `sponsoredSwap`, `signIntent`, `buildFill`, `submitFill`, `track`, `explainRejection` |
| `packages/app` | Kabuto DEX (Vite + React, GSAP ScrollTrigger landing, Motion UI): swap with the protection toggle, intents, wallet |
| `packages/filler` | intent relay (untrusted; intents are self-authenticating) + reference filler + attacker modes |
| `packages/bot` | a real sandwich bot that watches both mempools, plus `watch`, its terminal viewer |
| `packages/faucet` | fallback devnet ETH faucet |
| `packages/replay` | the mainnet sandwich replay |
| `packages/devnet` | the scripts that produced the proof transactions |
| `packages/e2e` | live devnet test suite and soak |
| `film/` | the demo video (HyperFrames) |

## Run it

```sh
pnpm install
forge build --root packages/contracts
pnpm --dir packages/filler relay        # intent relay on :8788
pnpm --dir packages/filler filler       # a filler
pnpm --dir packages/bot start           # the sandwich bot on :8787
pnpm --dir packages/bot watch           # its terminal viewer
pnpm --dir packages/app dev             # Kabuto DEX on :5180
```

Or run the backend the way it is hosted: `docker compose up -d --build` (relay, filler, bot, faucet).

The DEX's Connect wallet creates a devnet-only P256 key in your browser, funds an ordinary EOA from the devnet faucet (or the Kabuto fallback faucet), deploys and stakes your Kabuto account, and mints test kUSD.

## AI usage

- **Claude (Anthropic, via Claude Code)** and **OpenAI Codex** helped write and review the contracts, SDK, relay, filler, bot, app, tests and these docs, including the Arkiv integration.
- **ChatGPT image generation** made the still artwork in `assets/generated/` and **Gemini** animated two of the stills into the landing videos (see those commits).
- The live app runs were recorded with Playwright scripts (`packages/demo`) against the deployed app. Every on-chain claim was checked against the devnet explorer and Rabdi; the team is responsible for all code and claims.

## License

MIT © 2026 Nivesh Gajengi
