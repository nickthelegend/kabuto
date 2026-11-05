# Kabuto testing

## Results from this checkout

| Suite | Command | Passed | Failed | Other |
| --- | --- | ---: | ---: | --- |
| Foundry | `forge test --root packages/contracts` | 10 tests | 0 | 2 fuzz tests ran 256 cases each (512 fuzz executions) |
| Public devnet | `pnpm --dir packages/e2e test` | 6 cases | 4 cases | One full run; targeted reruns confirmed 3 attack refusals and reproduced the inclusion timeouts |
| Soak smoke run | `pnpm --dir packages/e2e soak 1` | 0 rounds | 0 rounds | Own account deployed and staked tx admitted, but it stayed `New` without a receipt |

The funded full run is recorded in [`packages/e2e/out/run-2026-11-05T18-04-13-140Z.json`](packages/e2e/out/run-2026-11-05T18-04-13-140Z.json). The `out/` directory is git-ignored; each new run creates timestamped JSON with every submitted hash, outcome, gas, and errors. Initial attempts stopped because the public faucet was empty. After the test deployer received funds, the suite funded the permitted bot role from it and proceeded.

| Live observation | Transaction | Result |
| --- | --- | --- |
| Protected swap | [0xb48830dd…af1fe](https://explorer.altmempool.wtf/tx/0xb48830dd240ff2248e4bdf542f204330f376db4ced3547e2661cff3b222af1fe) | Mined, success |
| Price-moving bot swap | [0xd39c2107…d3af3](https://explorer.altmempool.wtf/tx/0xd39c2107fcac16bec63236edd2a3f81cc7ca52d01bd0d72055a1f87a6d6d3af3) | Mined; following pinned swap refused at admission, account ETH unchanged |
| Bot-first race | [0x4d2b299f…da8b5](https://explorer.altmempool.wtf/tx/0x4d2b299f4c0f0049005137aefb407988fe8f2ff61948431d10086440c45da8b5) | `Cancelled`, no receipt, account ETH unchanged |
| Sponsored swap | [0xc8831ad1…c6872](https://explorer.altmempool.wtf/tx/0xc8831ad160bc1979381d2a7f160ef92070c0998237a565a7e6fecff5a21c6872) | Admitted with successful frame simulation; not mined within 120 s, later replaced by another same-nonce submission |
| Sponsored retry | [0x5fd5af51…6c0a5](https://explorer.altmempool.wtf/tx/0x5fd5af51dea748a0b3b665c41b07a96a7e64b03ae006ed3768163cf5f206c0a5) | Admitted, remained `New` for 120 s, later `Cancelled` |
| P256 retry with correct nonce | [0x84746cac…3c49f](https://explorer.altmempool.wtf/tx/0x84746cac988e39f8bff877e587a9de847405d4c02ca86586c899a5832863c49f) | Admitted, stayed `New` for 120 s |
| Intent fill retry | [0x877b80cd…67a15](https://explorer.altmempool.wtf/tx/0x877b80cdafb630f107638819f862a570f5452b1c08a4d3cb4e088e05ed167a15) | Admitted, five simulated frames successful, stayed `New` for 120 s |
| Underpay retry | [0x13f15852…87cde](https://explorer.altmempool.wtf/tx/0x13f158526206a10d702052b9244b558d4479c16f571912a91b8253f865087cde) | Admitted, settlement frame simulated as reverted, stayed `New` for 120 s; block-to-block balance assertion could not run |
| Soak setup stake | [0x12907ca8…6660d](https://explorer.altmempool.wtf/tx/0x12907ca88e35a4e9a7205e027289d63d300f2d4d1d56c06e2af6f31104b6660d) | Admitted, stayed `New` for 120 s; no soak round ran |

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
- After the bot-first race, multiple independently signed transactions, including a fresh P256 account and a fresh soak account, passed admission and simulation but stayed `New` without receipts for at least 120 seconds. This prevented the sponsored, P256, intent-fill, underpay, and soak completion assertions. Raising the P256 fee to 10 gwei did not change that result. The gateway and chain still answered reads and produced blocks.
- The shared paymaster in `deployments/1337.json` predates the PoolKey and approval validation fix. The live suite uses that shared deployment as instructed; the new checks are covered by Foundry until a new paymaster deployment is authorized.
- Reputation effects for accounts with many `Cancelled` transactions remain untested at scale.
- The Foundry opcode helpers model frame metadata; only the live suite exercises actual frame transaction admission and settlement semantics.
