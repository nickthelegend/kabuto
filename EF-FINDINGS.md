# EIP-8141 / ERC-8421 devnet findings (Kabuto, ETHGlobal Mumbai 2026)

What we verified on the public alt-mempool devnet (chain 1337, gateway `altmempoolgateway.forshtat.com`, ethrex `eip8141-tracer`), with transactions you can open.

## Verified working

| Feature | How we used it | Evidence |
|---|---|---|
| Staked entity reading foreign storage in VERIFY | `KabutoAccount.verifyPrice` reads the Uniswap v4 PoolManager's `slot0` via `extsload`; refused by the canonical mempool, admitted once staked | protected swap `0x45345cfa…e08a` |
| A VERIFY frame that fails at inclusion time | a protected swap was admitted, a higher-fee front-run moved the price, and the swap was never included: the explorer's event log reads `admitted` (`New`), then `dropped` (`Cancelled`) with reason "revalidation failed as of block N: validation frame 0: reverted with data 0x8ad5a9c0…" (`PriceOutOfBand`); no receipt, 0 gas | `0xbc0334ea…ea80` (bot: `0x3ac90a6e…8149`), [`0x2e8b5b7c…2e92`](https://explorer.altmempool.wtf/tx/0x2e8b5b7ca0801c1ba0931593d33f099a19a0189ed057d775b74b9d88cf7b2e92) (dropped at block 407,052) |
| `ATOMIC_BATCH_FLAG` | approve + swap; and the intent batch rolled back when its settle frame failed (account balance identical at block N-1 and N) | `0xb0a236cc…5e64` |
| `TXPARAM`, `FRAMEPARAM`, `FRAMEDATACOPY` | marked "from the EIP text, not yet exercised" in `@forshtat/hegota-support` for this devnet; they work: our paymaster and `verifyIntent` read FRAME_COUNT, NONCE, SENDER, MODE, FLAGS, RESOLVED_TARGET, VALUE, DATA_LENGTH and frame calldata | sponsored swap `0x7559cff5…7cde`, intent fill `0xefebea6a…cce3` |
| P256 signature scheme | owner key is raw P256, signer = `keccak256(qx‖qy)[12:]` | `0xfe705666…b7d3` |
| Explicit 32-byte `msg` signatures + a second signature entry | the owner signs only an intent digest (entry 0, explicit msg); the filler co-signs the canonical hash (entry 1) and pays | `0xefebea6a…cce3` |
| Same-nonce replacement | fillers competing for one intent replace each other by fee | `packages/filler` |
| Frame opcodes from nested calls | `TXPARAM`/`FRAMEPARAM`/`FRAMEDATACOPY` work from **any** contract called inside a SENDER frame, including a Uniswap v4 hook called by the PoolManager during `unlock`. In a legacy transaction the same calls fail (our hook catches it and reverts `NotFrameTx`). This lets an application contract enforce "only frame transactions with property X may call me": KabutoGuard requires a successful earlier VERIFY price pin | probe `0x25d65d67…947a`, guarded swap [`0xd1962486…`](https://explorer.altmempool.wtf/tx/0xd1962486165f1c4afdf3aec80ad6f2c6f882063403ad81e8469165e68472f861), legacy swap [`0x8fd351e2…`](https://explorer.altmempool.wtf/tx/0x8fd351e2cffefc53e3680916bdb4007f24cbbc9b601ae37b13a80287e3291829) |

## Friction and suggestions

0. **Nov 6, ~00:00 IST: the gateway lost its gossip peer.** `skandha_connectedPeers` on `altmempoolgateway.forshtat.com/rpc` returned `[]` while its pool grew to 28 entries stuck at `New` (ours and other teams'). The miner's own sidecar (`altmempool.forshtat.com/rpc`) had its own, nearly empty pool. Submitting directly to the miner's sidecar included our intent fill within seconds. Kabuto now uses the miner endpoint; a health line in the explorer for "gateway peers: 0" would have saved an hour.

1. **`MAX_VERIFY_GAS` is the sum over the whole validation prefix, plus a per-signature cost** (2,800 for secp256k1, 6,700 for P256 in our measurements; [`packages/sdk/src/index.ts:46`](packages/sdk/src/index.ts#L46)). For an intent fill with a P256 owner, a secp256k1 filler co-signature and a 12k `pay()` frame, `verifyIntent` has 78,500 gas left. The error message is clear (`validation prefix execution gas sum … exceeds MAX_VERIFY_GAS`); the README of the workshop could state the per-signature cost up front.
2. **`skandha_frameTransactionStatus` lags the explorer record.** We saw `New` from `skandha_frameTransactionStatus` while `skandha_explorer_getTransaction` already said `OnChain`. We poll the explorer record first.
3. **Contract creation costs state gas.** `eth_estimateGas` then ×2 worked every time; a fixed 6M limit sometimes did not (3 KB contract out of gas at 6,000,000).
4. **The explicit-`msg` path is powerful and under-documented.** The security considerations warn about it correctly; an example validator that constrains every SENDER frame (like `KabutoAccount.verifyIntent`) would show builders the safe way to use it.
5. **`skandha_explorer_getTransaction` gives three different views of a cancelled transaction.** For `0x2e8b5b7c…2e92` and `0xbc0334ea…ea80` (checked Nov 6), `entry` is `null`, `admission.outcome` is `replaced`, and the `events` array ends in `dropped` / `Cancelled` with the revalidation reason. A client that reads `entry.status` or `admission.outcome` gets no status or the wrong reason; only the last event says what happened. A top-level `status` (and `outcome` set from the final event) would make cancellations easy to report.
6. **Reputation with many `Cancelled` txs is untested by us at scale.** A protected swap that is cancelled after admission is exactly what ERC-8421 reputation counts against a staked sender. Guidance on how invalidations by price movement should be scored would help applications like ours.
