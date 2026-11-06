# Kabuto claims audit

Audited on **Nov 6 2026, 04:05-04:35 UTC**, against `main` at `b969221`, from a clean worktree (branch `verify-audit`). Every claim in [README.md](../README.md) and [HACKATHON_SUBMISSION_FORM.md](../HACKATHON_SUBMISSION_FORM.md) is marked:

- **verified**: rechecked today, with the evidence named
- **stale**: was true or partly true, but the text no longer matches the code, the chain or the live service
- **unverifiable**: cannot be rechecked today (the reason is given)

Evidence sources: devnet ethrex RPC `https://altmempool.forshtat.com` (`eth_getTransactionReceipt`, `eth_getTransactionByHash`, `eth_getBalance`), the alt-mempool gateway's read-only `skandha_explorer_getTransaction` (admission record and event history), the hosted services' public GET endpoints, Arkiv Rabdi (`getEntity`, `query`), Ethereum mainnet public RPCs (read-only), and the test runs in [TESTING.md](../TESTING.md). No mainnet transaction was sent, and no `debug_bundler_clear*` or `set*` call was made.

## State of the environment at audit time

| Check | Result |
| --- | --- |
| Devnet head | **Halted.** `eth_blockNumber` = `0x63ac6` (408,262), block timestamp 2026-11-05 22:58:46 UTC, unchanged on both the RPC and the gateway through 04:10 UTC on Nov 6 |
| Historical state | Pruned. `eth_call` at blocks 405,072 and 408,092 returns `state root missing`; `debug_traceTransaction` returns `Exceeded max amount of blocks to re-execute` |
| Live app `https://kabuto-self.vercel.app` | 200, `<title>Kabuto DEX</title>`. The JS bundle has the relay, faucet, gateway, KabutoGuard hook and redeployed paymaster `0x2b594f59…afdf9` addresses, the mainnet RPCs (publicnode, dRPC) and the "Were you sandwiched?" section |
| Relay `GET /intents` | 200, `[]` |
| Relay `GET /arkiv` | 200, `configured: true`, writer `0x8eD225Ae…f3aF`, 8.9996 tGLM, `published: 1`, `lastError: null` |
| Relay SSE `/events` | 200, `: connected` |
| Bot `GET /status` | 200, `watching: true`, `detected: 4`, `lastError: "ethrex: terminated"` |
| Bot `GET /attempts` | 200, 13 attempts (Nov 5 20:47-21:21 UTC) |
| Bot SSE `/events` | 200, `: connected` |
| Faucet `GET /status` | 200, 0.425 ETH, 1 drip, max 60, 0.06 ETH per drip. `GET /` is 404, which is expected (only `/status` and `POST /drip` exist, `packages/faucet/faucet.ts:38-41`) |
| Repo `https://github.com/nickthelegend/kabuto` | 200 (public) |
| Test deployer balance | 0.0498 devnet ETH: enough for a run, but the halted chain makes a live e2e run impossible, so none was made |

## README.md

### Header and scope

| # | Claim | Status | Evidence |
| --- | --- | --- | --- |
| R1 | Live app at kabuto-self.vercel.app | verified (loads) | HTTP 200, bundle contents above. Transactions from the app cannot be included while the devnet is halted |
| R2 | Chain 1337, explorer.altmempool.wtf | verified | `eth_chainId` = `0x539`; explorer HTML 200 |
| R3 | Uniswap v4 PoolManager, Quoter, StateView predeployed | verified | `sdk/test/read.test.ts` quotes the pool and reads StateView live (2/2 pass); addresses match `deployments/1337.json` (`sdk/test/deployment.test.ts`) |
| R4 | License MIT | verified | `LICENSE`: "Copyright (c) 2026 Nivesh Gajengi" |

### "The same 1,500 kUSD swap, three ways"

| # | Claim | Status | Evidence |
| --- | --- | --- | --- |
| R5 | Unprotected: front, victim, back at indices 0, 1, 2 of block 407,046 | verified | receipts: `0xa33875b5` idx 0, `0xbf074d56` idx 1, `0xba51ab55` idx 2, all block 407,046, status 1. Front and back sender are both the bot `0x64fe5968…48F4`; the victim is `0x46280a6d…834f` |
| R6 | Victim got 0.04543 WETH vs 0.04626 quote, 1.80% worse, 27.04 kUSD lost | verified | victim receipt: 1,500 kUSD out, 0.045426538 WETH in. Bot `/attempts`: `noSandwichQuote` 0.046260482 (StateView at block 407,045). Shortfall 1.8027%; 1,500 × 1.8027% = 27.04 |
| R7 | Protected: the same bot front-ran it (block 407,052, index 0) | verified | `0xd368dd0c` receipt: bot sender, block 407,052, idx 0, status 1 |
| R8 | Protected: "explorer status `Cancelled`, no receipt, 0 gas" | verified, wording stale | no receipt. Explorer event history: `dropped: Cancelled`, "revalidation failed as of block 407052: validation frame 0: reverted with data `0x8ad5a9c0…`" (`PriceOutOfBand(uint160,uint160,uint160)`). The entry's current outcome is `replaced` (nonce reused by `0x4f164a1e…` at 21:03 UTC), so a judge opening the link sees "replaced", not "Cancelled" |
| R9 | Intent: 300 kUSD in, 0.00886 WETH received (min 0.00885), third-party filler paid the gas | verified | `0xdfd70b01` receipt: block 407,027, status 1, 300 kUSD from the account, 0.008864980 WETH to the account, `payer` = filler `0x088b044e…4196`. Signature 0 is scheme 2 (P256) with an explicit `msg`; signature 1 is the filler's secp256k1 |
| R10 | "You saved" is computed from the swaps and shown only for the same size and direction | unverifiable today | needs the browser UI; not exercised in this audit |
| R11 | `pnpm --dir packages/bot watch -- --history 2` reads `/events` and `/attempts` | verified (endpoints) | both endpoints answer; `watch` script exists in `packages/bot/package.json` |

### Architecture and frames

| # | Claim | Status | Evidence |
| --- | --- | --- | --- |
| R12 | Protected swap = VERIFY `verifyPrice` + SENDER approve + SENDER `swapExactIn` | verified | `0x45345cfa` frames: mode 1 `0x2c8cfee1`, mode 2 `0x095ea7b3`, mode 2 `0x440aeb19`, all status 1 |
| R13 | `verifyPrice` reads slot0 via extsload | verified | `KabutoAccount.sol:71`, `:179` |
| R14 | Intent frames: VERIFY verifyIntent, VERIFY filler `pay()`, SENDER transfer, DEFAULT fill, SENDER settle | verified | `0xdfd70b01` frames: modes 1, 1, 2, 0, 2; frame 1 targets the filler with `0x1b9265b8`; frame 2 is a 68-byte `transfer`; all 5 frame receipts status 1 |
| R15 | Front-run makes the swap invalid, re-run of VERIFY at block building | verified | R8 event history (two separate runs: `0xbc0334ea` at block 404,231 and `0x2e8b5b7c` at block 407,052, both `PriceOutOfBand`) |
| R16 | Account and paymaster stake in the ERC-8421 registry | verified indirectly | the gateway's admission record for `0xdfd70b01` / `0x2e8b5b7c` passes the `storage` rule for the sender's and payer's VERIFY frames, which an unstaked entity reading PoolManager storage would fail. The registry itself was not queried |

### KabutoGuard

| # | Claim | Status | Evidence |
| --- | --- | --- | --- |
| R17 | Hook `0x9A485379…0080`, BEFORE_SWAP flag, CREATE2-mined | verified | 3,815 bytes of code at the address; its low 14 bits are exactly `1 << 7` (BEFORE_SWAP), checked in `sdk/test/deployment.test.ts` |
| R18 | Guarded pool id `0x4869421e…1725` | verified | recomputed from `guardPoolKey` (`sdk/test/deployment.test.ts`) |
| R19 | Pinned frame-tx swap `0xd1962486` `OnChain`, all frames successful | verified | receipt status 1, block 408,092, type 6; explorer `OnChain` |
| R20 | Plain legacy swap `0x8fd351e2` mined and reverted with `NotFrameTx()` (`0x2e55cc19`) | partly verified | receipt: type 0, block 408,093, status 0, to the router. `cast sig "NotFrameTx()"` = `0x2e55cc19`. The revert data can no longer be replayed (state pruned, trace refused) |
| R21 | Reverts: plain tx `NotFrameTx`, no/other-pool/later/failed/other-account pin `NoPricePin`, wide band `BandTooWide` | verified | `KabutoGuard.t.sol`: `testNonFrameReverts`, `testNoVerifyPinReverts`, `testDifferentPoolPinReverts`, `testFuturePinReverts`, `testPriorVerifyFailureReverts`, `testPinOnAnotherAccountReverts`, `testWideBandReverts` (9/9 pass) |
| R22 | "a band no wider than 2%" | verified with a caveat | `MAX_BAND_BPS` is an immutable constructor argument (`KabutoGuardHook.sol:32,47`), not a constant. 2% holds only for the deployed instance's argument, which this audit could not read back from pruned state |

### "Every claim, where it is enforced, and where it is proven"

| # | Claim | Status | Evidence |
| --- | --- | --- | --- |
| R23 | Price band: `KabutoAccount.sol:71`, slot0 `:179`, tx `0x45345cfa` mined in band | verified | lines match; receipt status 1, block 404,216 |
| R24 | Front-run → invalid; `0xbc0334ea`, `0x2e8b5b7c` `Cancelled` | verified, wording stale | both: no receipt, event `dropped: Cancelled` (`PriceOutOfBand`), current outcome `replaced` (see R8) |
| R25 | The bot really sandwiches; `0xbf074d56` indices 0/1/2, −1.80% | verified | R5, R6 |
| R26 | `maxIn` at `:118-120` `BadIntentShape(6)` | verified | lines 118 and 120 |
| R27 | Filler frames can't act as the account, `:126` `BadIntentShape(9)` | verified | line 126 |
| R28 | Atomic batch, `:124` `BadIntentShape(7)` | verified | line 124 |
| R29 | Underpay rolls back; `settleIntent` `:146`, decay `:157`; tx `0xb0a236cc` | verified | lines match (`:157` is `decayedMinOut`). Receipt: block 405,073, status 0, frame statuses 1,1,1,1,**0** (settle reverted), **0 logs**, so no transfer persisted. The README's "balance identical at blocks N−1 and N" can no longer be re-read (state pruned) |
| R30 | Filler pays gas; `KabutoFiller.sol:43`; tx `0xefebea6a` | verified | line 43 is `pay()`; receipt `payer` `0xc3832afe…cc37` ≠ sender `0x550de711…8471` |
| R31 | Swap pays its own gas; `KabutoPaymaster.sol:80`; tx `0x7559cff5`, account ETH moved 0 wei | verified | line 80 is `sponsor`; `payer` `0xfa10b562…3fa0` (the pre-`b292fcd` paymaster); sender balance at blocks 404,402 and 404,403 both 27,829,455,998,845,504 wei |
| R32 | KabutoGuard row (9 tests, two txs) | verified | R19-R21 |
| R33 | P256 owner keys: `sigparam(0, RESOLVED_SIGNER) == owner`; tx `0xfe705666` | verified | `KabutoAccount.sol:174`; tx signature scheme `0x2`, status 1 |
| R34 | 100k validation-gas cap, `sdk/src/index.ts:45`, proven by "the live P256 intent fill `0xefebea6a`" | **stale** | line 45 is `MAX_VERIFY_GAS`. But `0xefebea6a` has two **secp256k1** signatures (schemes 1, 1), not P256. The P256 intent fill is `0xdfd70b01`: VERIFY limits 78,500 + 12,000 plus 6,700 (P256) + 2,800 (secp256k1) = exactly 100,000 |

### Mainnet checker and replay

| # | Claim | Status | Evidence |
| --- | --- | --- | --- |
| R35 | The checker reads public RPCs in the browser and reproduces the replay | verified for the three built-in examples | `checkMainnetTx` run under Node against mainnet: all three `EXAMPLES` return `sandwiched` with the same front and back hashes as `sandwiches.jsonl`, and the same price moves (37.88%, 4.79%, −5.12%) |
| R36 | "paste a Uniswap v4 swap's transaction hash" (any) | **stale / at risk** | publicnode returns `null` receipts for older blocks (block 26,299,987 is null; 26,301,932 is still served; mainnet head 26,353,341). `rpc()` in `packages/app/src/lib/mainnet.ts:17-28` only falls back to dRPC on an *error*, so a `null` receipt becomes `not-found` (`:58`). The replay fixture victim `0x2c3d2f3f…0485` already returns `not-found`, although dRPC serves it. The three built-in examples (blocks 26,301,932-26,302,872) are about 2,000 blocks (≈7 h) from the same cutoff, so they will likely return `not-found` by judging time |
| R37 | Replay: blocks 26,299,825-26,307,824, 27 hours | verified | `packages/replay/out/summary.json` `window`; 96,348 s = 26.8 h |
| R38 | 497 unique victims (503 same-sender triples); 388 of 501 evaluated (77%) moved > 0.5% | verified, but inconsistent with the committed output | recomputed from the local, untracked `packages/replay/out/sandwiches.jsonl` (`attackerMatch == "from"`): 503 triples, 497 unique victims, 388/501 stopped (77.45%). The committed `out/summary.json` and `packages/replay/README.md` report the full set (same sender **or** same contract): 540 candidates, 419 of 538 (77.88%). A judge cannot reproduce 497/388 from tracked files |
| R39 | USD pricing covered about 1% of pools | verified | `summary.json` `usdCoverage` 0.0111 (6 of 540 candidates) |

### SDK, battle-testing, Arkiv, hosting

| # | Claim | Status | Evidence |
| --- | --- | --- | --- |
| R40 | SDK exports `protectedSwap`, `sponsoredSwap`, `signIntent`, `buildFill`, `submitFill`, `track`, `explainRejection` | verified | `packages/sdk/src/index.ts` (`explainRejection` at :73) |
| R41 | Foundry: 19 tests, 0 failed (10 + 9), 2 fuzz × 256 | verified | rerun today, TESTING.md |
| R42 | Two shape-check gaps fixed with regressions, paymaster redeployed | verified | commit `b292fcd` updates `deployments/1337.json`; `testPaymasterShapeCodesAndPrice` covers a wrong PoolKey (`BadShape(7)`); every `BadIntentShape` 1-14 and `BadShape` 1-13 in source has an expected revert in `Kabuto.t.sol` |
| R43 | Live e2e: some cases "admitted but timed out waiting for inclusion" | stale | several were included later: the P256 retry `0x84746cac` and the soak stake `0x12907ca8` landed (blocks 407,700 and 407,703); the intent-fill retry `0x877b80cd` and the underpay retry `0x13f15852` mined **reverted** at block 407,708 at the filler's `fill` frame (frame 3), with the filler paying gas. TESTING.md now records this |
| R44 | Live app runs table | verified | R5-R9; bot `/attempts` also confirms the film takes `0x94d3996f` (block 407,289, indices 0/1/2) and `0x02d38de2` (front-run block 407,292 idx 0; `Cancelled` by `PriceOutOfBand` at 407,293, later `replaced`), and the miss `0x76d52215` (victim block 406,976, front-run 406,977) |
| R45 | Bot records realized loss vs no-sandwich quote for every attempt | verified | `/attempts` rows carry `victimRealizedOutput`, `noSandwichQuote`, `victimLoss`, `quoteMethod` |
| R46 | Arkiv writer `0x8eD225Ae…f3aF` owns every Kabuto entity | verified | `GET /arkiv`; fill entity `$owner` and `$creator` |
| R47 | Intent entity `0xd309c13a…20d0`, patched `open` → `filled` | stale (expired by design) | `getEntity` → "No live entity … has expired". The intent entity expires at the intent's deadline, as the README says. It still exists as the fill entity's `intentKey` |
| R48 | Fill entity `0xd9cc8020…4e5f`, `kabuto.fill.v1`, `landed`, links devnet fill `0xd498630c` | verified | `getEntity`: `outcome = landed`, `txHash = 0xd498630c…752b`, `intentKey = 0xd309c13a…`, `filler = 0x088B044e…4196`, expires at Rabdi block 1,561,290. `0xd498630c` receipt status 1, block 407,731, explorer `OnChain` |
| R49 | The judge query returns open intents | verified (query works), currently empty | `arkiv.schema = str('kabuto.intent.v1') AND status = str('open') AND chainId = u64(1337)` → 0 entities; `kabuto.fill.v1` → 1 entity owned by the writer |
| R50 | Fillers can use `--source arkiv` | verified (code) | `packages/filler/src/filler.ts:22-25` |
| R51 | Hosting table (relay, bot, faucet on the VPS; contracts in `deployments/1337.json`) | verified | endpoints above; `docker-compose.yml` defines `relay`, `filler`, `bot`, `faucet` |
| R52 | "the devnet's public faucet is empty" | unverifiable today | the public faucet was not probed; claim rests on Nov 5 notes in TESTING.md |
| R53 | Known limit: `0x912537da…4818` "recorded as `replaced`, not `Cancelled`" | **stale** | explorer history shows `dropped: Cancelled` first ("revalidation failed as of block 407022", `PriceOutOfBand`), then `replaced` by the intent `0xdfd70b01` (same nonce 13). No receipt. It was cancelled like the others |
| R54 | `docs/img/*`, `docs/INTENTS.md`, `EF-FINDINGS.md`, `FEEDBACK.md`, `arkiv/*.md`, `METHOD.md`, `packages/sdk/README.md` | verified | all files exist |

## HACKATHON_SUBMISSION_FORM.md

| # | Claim | Status | Evidence |
| --- | --- | --- | --- |
| F1 | 497 swaps sandwiched by the same sender in 27 h; 388 of 501 moved > 0.5% | verified, inconsistent with committed output | R38 |
| F2 | Live on chain 1337, ERC-8421 alternative mempool | verified, but halted now | R2; head stopped at 408,262 |
| F3 | On camera: 1.80% worse, 27.04 kUSD on 1,500 kUSD | verified | R6, film take `0x94d3996f` (R44) |
| F4 | Protected: front-run, VERIFY fails, `Cancelled`, no receipt, 0 gas | verified | R8, R24 |
| F5 | Intent: no tx, no gas for the signer; any filler completes it and pays gas | verified | R9, R30 |
| F6 | VERIFY binds the approval to every frame | verified | R26-R29; `testIntentShapeCodes`, `testFuzzIntentRandomFrameMutations` |
| F7 | "Every tampered fill we tried was refused before reaching a block" | **stale** | the three shape attacks were refused at admission, but the underpay fill reached a block and reverted (`0xb0a236cc`, status 0, the filler paid gas). It rolled back; it was not refused |
| F8 | KabutoGuard: pinned swap landed; plain tx reverted with `NotFrameTx()` | verified / partly verified | R19, R20 |
| F9 | Paymaster: account ETH moved by exactly 0 | verified | R31 |
| F10 | Mainnet checker: paste any mainnet v4 swap | **stale / at risk** | R36 |
| F11 | Arkiv: real intent and fill on Rabdi; landed fill written only after the devnet confirms | verified (fill), intent expired | R47, R48 |
| F12 | Contract list incl. `verifyPriceExecution` | verified | `KabutoAccount.sol:78` |
| F13 | Native P256 owner keys (scheme 2); filler co-signs as entry 1 | verified | R9, R33; `KabutoFiller.sol:44` reads `sigparam(1, RESOLVED_SIGNER)` |
| F14 | Validation-gas budget 100k, 2,800 / 6,700 | verified | `sdk/test/deployment.test.ts`; `0xdfd70b01` sums to exactly 100,000 |
| F15 | Battle-testing list | verified | TESTING.md |
| F16 | Partner prize 3 Arkiv: intent `0xd309c13a…20d0` and fill `0xd9cc8020…4e5f` | partly stale | R47, R48 |
| F17 | Repo and live app links | verified | both 200 |
| F18 | Demo video `film/renders/kabuto-demo-v3.mp4` | unverifiable from the repo | `film/renders/` is not tracked; the file exists only in the local main checkout. The link must be pasted after upload |

## Not covered

- UI behaviour (toggle, "You saved", Connect wallet flow): no browser session was used in this audit.
- No fresh live e2e run: the devnet was halted (see the top of this file).
