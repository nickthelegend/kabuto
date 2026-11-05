# Uniswap v4 mainnet replay

Read-only analysis of sandwich-shaped `Swap` sequences on Ethereum mainnet. Uses public RPC endpoints and no keys.

```sh
pnpm --dir packages/replay install
pnpm --dir packages/replay scan --blocks 50000
pnpm --dir packages/replay test
```

`REPLAY_RPC` overrides the default public RPC fallback order. `--band 0.005` sets the fractional hypothetical price band. `--init-lookback` controls how many blocks before the swap window to search for pool `Initialize` events (default 5,000). Raw responses are cached in `cache/`; results are `out/summary.json` and `out/sandwiches.jsonl`. Both directories are ignored by Git. `METHOD.md` defines the heuristic and limitations.
`--to-block <height>` pins the inclusive end of a window so a rerun uses the same cached range.

## Included mainnet run

The completed contiguous window, extended from the interrupted run's cache, is **blocks 26,299,825–26,307,824 inclusive** (8,000 blocks), from **2026-10-29 17:14:23 UTC** to **2026-10-30 20:00:11 UTC**. It was scanned with:

```sh
REPLAY_RPC=https://eth.drpc.org pnpm --dir packages/replay scan --blocks 8000 --to-block 26307824 --init-lookback 5000
```

The public RPCs' log range and archive limits made the 50,000-block default impractical within 25 minutes. The 8,000-block extension pass took **256.224 seconds** with earlier 5,000-block responses cached; a final cached regeneration of the same window took **2.54 seconds**. There were **172,802 Swap logs** and **540 sandwich-shaped candidates**. For **538** candidates with a known pre-front price, **419 (77.88%)** moved outside a hypothetical **±0.5%** signing band; two were unevaluable. This is a measured band-rejection share, not proof that every candidate was a malicious or profitable sandwich.

The bounded `Initialize` search covered blocks **26,294,825–26,307,824** and found metadata for **11 of 66** candidate pools. Only **6 of 540** candidates could be valued in USD under the method: their signed spot-price shortfall estimates sum to **$1,143.64**, while the outer legs' gross token-delta estimates sum to **−$4.90**. These are sparse, partial estimates, so this run does **not** support a market-wide dollar extraction claim. See `out/summary.json` for exact values, transaction hashes and per-pool counts.

To refresh a test fixture from actual mainnet RPC responses: `pnpm --filter @kabuto/replay fixture <fromBlock> [toBlock]`. The script selects the busiest same-block pool in that range and saves its raw logs and transactions in `test/fixtures/`.
