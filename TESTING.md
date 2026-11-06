# Kabuto testing

## Fresh verification (Nov 6 2026, 04:05-04:35 UTC, branch `verify-audit` from `b969221`)

Every suite that does not spend devnet ETH, rerun from a clean worktree. Claim-by-claim evidence is in [docs/AUDIT.md](docs/AUDIT.md).

| Suite | Command | Passed | Failed | Skipped / not run |
| --- | --- | ---: | ---: | --- |
| Foundry | `forge test --root packages/contracts` | 19 (10 `KabutoTest` + 9 `KabutoGuardTest`) | 0 | 0; 2 fuzz tests × 256 runs |
| Replay detector | `pnpm --dir packages/replay test` | 2 (captured fixture + live public mainnet RPC) | 0 | 0. Before `987a838` the mainnet case failed on a clean checkout (`ENOENT`, git-ignored `cache/`) |
| SDK reads | `pnpm --dir packages/sdk exec vitest run test/read.test.ts` | 2 (live v4 quote + StateView read; secp256k1/P256 signature packing) | 0 | 0 |
| SDK deployment (new) | `pnpm --dir packages/sdk exec vitest run test/deployment.test.ts` | 6 (both PoolIds recomputed, hook flag bits, predeploys, 100k gas budget) | 0 | 0; offline |
| Arkiv | `pnpm --dir packages/filler exec vitest run test/arkiv.test.ts` | 2 (byte round trip, live Rabdi query) | 0 | 1 skipped (live write; needs `ARKIV_PRIVATE_KEY`) |
| Bot (read-only cases) | `pnpm --dir packages/bot exec vitest run -t "decodes\|reconstructs\|sizes"` | 2 (captured frame decode, live eth_call sizing) | 1 | `reconstructs hashes from the real read-only bundler dump` failed because `debug_bundler_dumpMempool` returned an empty mempool; 1 not run (EOA sandwich case spends ETH and binds :8787) |
| **Total offline / read-only** | | **33** | **1** | **2** |

Not run, by decision: `packages/e2e` (live suite and soak), `packages/sdk/test/live.test.ts`, `packages/filler/test/live.test.ts` and the bot's EOA sandwich case. The test deployer holds 0.0498 devnet ETH, enough for a run, but the devnet has produced no block since **block 408,262 (2026-11-05 22:58:46 UTC)**. `eth_blockNumber` on both the ethrex RPC and the alt-mempool gateway still returned `0x63ac6` five hours later, and the hosted bot's `/status` reports `lastError: "ethrex: terminated"`. No transaction can be included, so a run would only time out.

## Earlier results (Nov 5 2026)

| Suite | Command | Passed | Failed | Other |
| --- | --- | ---: | ---: | --- |
| Foundry | `forge test --root packages/contracts` | 19 tests (10 core + 9 KabutoGuard) | 0 | 2 fuzz tests ran 256 cases each (512 fuzz executions) |
| Public devnet | `pnpm --dir packages/e2e test` | 6 cases | 4 cases | One full run; targeted reruns confirmed 3 attack refusals and reproduced the inclusion timeouts |
| Soak smoke run | `pnpm --dir packages/e2e soak 1` | 0 rounds | 0 rounds | Own account deployed and staked tx admitted, but it stayed `New` without a receipt |

The funded full run is recorded in [`packages/e2e/out/run-2026-11-05T18-04-13-140Z.json`](packages/e2e/out/run-2026-11-05T18-04-13-140Z.json). The `out/` directory is git-ignored; each new run creates timestamped JSON with every submitted hash, outcome, gas, and errors. Initial attempts stopped because the public faucet was empty. After the test deployer received funds, the suite funded the permitted bot role from it and proceeded.

| Live observation | Transaction | Result |
| --- | --- | --- |
| Protected swap | [0xb48830dd…af1fe](https://explorer.altmempool.wtf/tx/0xb48830dd240ff2248e4bdf542f204330f376db4ced3547e2661cff3b222af1fe) | Mined, success |
| Price-moving bot swap | [0xd39c2107…d3af3](https://explorer.altmempool.wtf/tx/0xd39c2107fcac16bec63236edd2a3f81cc7ca52d01bd0d72055a1f87a6d6d3af3) | Mined; following pinned swap refused at admission, account ETH unchanged |
| Bot-first race | [0x4d2b299f…da8b5](https://explorer.altmempool.wtf/tx/0x4d2b299f4c0f0049005137aefb407988fe8f2ff61948431d10086440c45da8b5) | `Cancelled`, no receipt, account ETH unchanged. Nov 6 recheck: still no receipt; the explorer no longer returns the entry (`Frame transaction not found`) |
| Sponsored swap | [0xc8831ad1…c6872](https://explorer.altmempool.wtf/tx/0xc8831ad160bc1979381d2a7f160ef92070c0998237a565a7e6fecff5a21c6872) | Admitted with successful frame simulation; not mined within 120 s, later replaced by another same-nonce submission. Nov 6 recheck: no receipt; explorer answers `Frame transaction not found` |
| Sponsored retry | [0x5fd5af51…6c0a5](https://explorer.altmempool.wtf/tx/0x5fd5af51dea748a0b3b665c41b07a96a7e64b03ae006ed3768163cf5f206c0a5) | Admitted, remained `New` for 120 s, later `Cancelled`. Nov 6 recheck: no receipt; explorer answers `Frame transaction not found` |
| P256 retry with correct nonce | [0x84746cac…3c49f](https://explorer.altmempool.wtf/tx/0x84746cac988e39f8bff877e587a9de847405d4c02ca86586c899a5832863c49f) | Admitted, stayed `New` for 120 s. **Later mined:** `OnChain`, status 1, block 407,700 |
| Intent fill retry | [0x877b80cd…67a15](https://explorer.altmempool.wtf/tx/0x877b80cdafb630f107638819f862a570f5452b1c08a4d3cb4e088e05ed167a15) | Admitted, five simulated frames successful, stayed `New` for 120 s. **Later mined reverted:** block 407,708, status 0; frame 3 (filler `fill`) reverted, frame 4 (settle) skipped; the filler (payer `0x26a52908…2a53`) paid the gas |
| Underpay retry | [0x13f15852…87cde](https://explorer.altmempool.wtf/tx/0x13f158526206a10d702052b9244b558d4479c16f571912a91b8253f865087cde) | Admitted, settlement frame simulated as reverted, stayed `New` for 120 s; block-to-block balance assertion could not run. **Later mined reverted:** block 407,708, status 0, but frame 3 (`fill`) reverted, not the settle frame (skipped); filler paid the gas |
| Soak setup stake | [0x12907ca8…6660d](https://explorer.altmempool.wtf/tx/0x12907ca88e35a4e9a7205e027289d63d300f2d4d1d56c06e2af6f31104b6660d) | Admitted, stayed `New` for 120 s; no soak round ran. **Later mined:** `OnChain`, block 407,703 |

## Live app runs (Nov 6 2026, deployed app + hosted bot)

Recorded with `packages/demo/record2.mjs` against https://kabuto-self.vercel.app and the hosted sandwich bot; the bot's own `/attempts` record is the source for the block positions.

| Run | Transaction | Result |
| --- | --- | --- |
| Ordinary swap, 1,500 kUSD, 2% slippage | [0xbf074d56…de29](https://explorer.altmempool.wtf/tx/0xbf074d561e3ed81a19eb3c4eea24efa7e6d8ec48511543fd318682d72afbde29) | Sandwiched: bot front-run, victim, bot back-run at indices 0, 1, 2 of block 407,046; 0.04543 WETH vs 0.04626 quoted (−1.80%) |
| Same swap, protection on (±0.5%) | [0x2e8b5b7c…2e92](https://explorer.altmempool.wtf/tx/0x2e8b5b7ca0801c1ba0931593d33f099a19a0189ed057d775b74b9d88cf7b2e92) | Bot front-ran it (block 407,052, index 0); explorer status `Cancelled`, no receipt, 0 gas |
| Film take, ordinary swap | 0x94d3996f…ed2f | Sandwiched at indices 0, 1, 2 of block 407,289 (−1.80%) |
| Film take, protection on | 0x02d38de2…5a63 | Bot front-ran it (block 407,292, index 0); `Cancelled`, 0 gas |
| Intent, 300 kUSD → WETH | [0xdfd70b01…c065](https://explorer.altmempool.wtf/tx/0xdfd70b014486b1d92669271318502d159570de709be0dbb2a99682da49b8c065) | Filled by the hosted filler, which paid the gas; account received 0.00886 WETH (minimum 0.00885) |
| Miss, recorded honestly | 0x76d52215…3fd1 | Victim landed one block before the bot's front-run: no sandwich (the viewer prints TOO SLOW) |

KabutoGuard live (`pnpm --dir packages/devnet exec tsx src/guard.ts --fresh`): hook `0x9A485379e6307A12cF380D9F783296Aa1E570080`, pinned frame-tx swap [0xd1962486…](https://explorer.altmempool.wtf/tx/0xd1962486165f1c4afdf3aec80ad6f2c6f882063403ad81e8469165e68472f861) `OnChain`; plain legacy swap [0x8fd351e2…](https://explorer.altmempool.wtf/tx/0x8fd351e2cffefc53e3680916bdb4007f24cbbc9b601ae37b13a80287e3291829) reverted with `NotFrameTx()` (checked by replaying the call). Frame-opcode probe: `FrameProbe.sol` read SENDER, frame count, index, target and mode from inside a SENDER frame (`0x25d65d67…947a`); the same reads fail in a legacy transaction.

Arkiv: `pnpm --dir packages/filler exec vitest run test/arkiv.test.ts` → 2 passed (byte round trip, live public Rabdi read), 1 skipped (live write; needs a funded writer).

## Coverage

- **Foundry:** The 0.8.28 tests etch controllable helpers at the addresses created by `HegotaSupport`, following the workshop's opcode mock pattern. They exercise account signer and price bounds; every `BadIntentShape` code 1–14, signature checks, settlement and Dutch decay; both paymaster price and shape checks (codes 1–13), owner permissions; filler payment signature and access restrictions; and router liquidity, swap, slippage, and filler swaps against a real v4 PoolManager. The real PoolManager's 0.8.26 creation bytecode is stored in `packages/contracts/test/PoolManager.creation.json`, compiled from `lib/v4-core/src/PoolManager.sol` with `forge build --root packages/contracts/lib/v4-core`. Regressions verify the intent transfer's exact calldata length, the paymaster's entire v4 PoolKey, and the approval's router and amount.
- **Public devnet:** Ten cases assert protected swap inclusion; out-of-band admission refusal with zero account gas; bot-first race cancellation and zero account gas; sponsored fee payment with unchanged account ETH; P256 inclusion; open intent output; three malformed intent refusals; and underpayment rollback using `balanceOf` at the preceding and containing blocks. The suite uses the actual gateway, explorer, contracts and permitted test roles. It fails on setup or assertion errors.
- **Soak:** `pnpm --dir packages/e2e soak [N]` runs 20 rounds by default, alternating protected swaps, intent fills, and over-max attacks. It prints each round's outcome, gas, and hash, and records the hashes in the same JSON format.

## How to run

```sh
forge test --root packages/contracts
pnpm --dir packages/e2e install
pnpm --dir packages/e2e test
pnpm --dir packages/e2e soak 20
```

The devnet tests deploy only their own accounts and filler. They use the shared pool, router, token, and paymaster from `deployments/1337.json`. The token faucet supplies their accounts. They never reset the mempool or redeploy the shared stack.
The full test command creates fresh accounts on each run. Set `KABUTO_REUSE_FIXTURE=1` only for a targeted retry that should use the last test accounts; the soak command reuses the filler fixture but creates a fresh account for its rounds.

## Known limits

- Chain testing is on devnet 1337 only. The public faucet was empty at first; an external test-role top-up permitted the funded run.
- The devnet stopped producing blocks at block 408,262 (2026-11-05 22:58:46 UTC) and was still stopped at 04:35 UTC on Nov 6, so no fresh live run exists after that time.
- Old devnet state is pruned: `eth_call` at blocks such as 405,072 and 408,092 now fails with `state root missing`, so historical balance checks and revert-data replays can no longer be repeated against the public RPC.
- After the bot-first race, multiple independently signed transactions, including a fresh P256 account and a fresh soak account, passed admission and simulation but stayed `New` without receipts for at least 120 seconds. This prevented the sponsored, P256, intent-fill, underpay, and soak completion assertions. Raising the P256 fee to 10 gwei did not change that result. The gateway and chain still answered reads and produced blocks. Several of them were included later (blocks 407,700-407,708, see the table above): the P256 retry and the soak stake landed, and the intent-fill and underpay retries mined as reverted at the filler's `fill` frame. The suite had stopped waiting by then, so those assertions remain unrecorded.
- The paymaster in `deployments/1337.json` (`0x2b594f59…afdf9`) is the redeployment that includes the PoolKey and approval validation fix (commit `b292fcd`). The e2e run above predates it; the fix itself is covered by the Foundry regressions.
- Reputation effects for accounts with many `Cancelled` transactions remain untested at scale.
- The Foundry opcode helpers model frame metadata; only the live suite exercises actual frame transaction admission and settlement semantics.
