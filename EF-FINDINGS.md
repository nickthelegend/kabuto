# EIP-8141 / ERC-8421 devnet findings (Kabuto, ETHGlobal Mumbai 2026)

What we verified on the public alt-mempool devnet (chain 1337, gateway `altmempoolgateway.forshtat.com`, ethrex `eip8141-tracer`), with transactions you can open.

## Verified working

| Feature | How we used it | Evidence |
|---|---|---|
| Staked entity reading foreign storage in VERIFY | `KabutoAccount.verifyPrice` reads the Uniswap v4 PoolManager's `slot0` via `extsload`; refused by the canonical mempool, admitted once staked | protected swap `0x45345cfa…e08a` |
| A VERIFY frame that fails at inclusion time | a protected swap was admitted, a higher-fee front-run moved the price, and the swap was never included: explorer status `Cancelled`, 0 gas | `0xbc0334ea…ea80` (bot: `0x3ac90a6e…8149`) |
| `ATOMIC_BATCH_FLAG` | approve + swap; and the intent batch rolled back when its settle frame failed (account balance identical at block N-1 and N) | `0xb0a236cc…5e64` |
| `TXPARAM`, `FRAMEPARAM`, `FRAMEDATACOPY` | marked "from the EIP text, not yet exercised" in `@forshtat/hegota-support` for this devnet; they work: our paymaster and `verifyIntent` read FRAME_COUNT, NONCE, SENDER, MODE, FLAGS, RESOLVED_TARGET, VALUE, DATA_LENGTH and frame calldata | sponsored swap `0x7559cff5…7cde`, intent fill `0xefebea6a…cce3` |
| P256 signature scheme | owner key is raw P256, signer = `keccak256(qx‖qy)[12:]` | `0xfe705666…b7d3` |
| Explicit 32-byte `msg` signatures + a second signature entry | the owner signs only an intent digest (entry 0, explicit msg); the filler co-signs the canonical hash (entry 1) and pays | `0xefebea6a…cce3` |
| Same-nonce replacement | fillers competing for one intent replace each other by fee | `packages/filler` |

## Friction and suggestions

1. **`MAX_VERIFY_GAS` is the sum over the whole validation prefix, plus 2,800 per signature.** Two VERIFY frames and two signatures leave about 94k for real logic. The error message is clear (`validation prefix execution gas sum … exceeds MAX_VERIFY_GAS`); the README of the workshop could state the per-signature cost up front.
2. **`skandha_frameTransactionStatus` lags the explorer record.** We saw `New` from `skandha_frameTransactionStatus` while `skandha_explorer_getTransaction` already said `OnChain`. We poll the explorer record first.
3. **Contract creation costs state gas.** `eth_estimateGas` then ×2 worked every time; a fixed 6M limit sometimes did not (3 KB contract out of gas at 6,000,000).
4. **The explicit-`msg` path is powerful and under-documented.** The security considerations warn about it correctly; an example validator that constrains every SENDER frame (like `KabutoAccount.verifyIntent`) would show builders the safe way to use it.
5. **Reputation with many `Cancelled` txs is untested by us at scale.** A protected swap that is cancelled after admission is exactly what ERC-8421 reputation counts against a staked sender. Guidance on how invalidations by price movement should be scored would help applications like ours.
