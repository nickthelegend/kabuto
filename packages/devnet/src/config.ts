import { defineChain, type Address } from "viem";

/** The public EIP-8141 / ERC-8421 alt-mempool devnet (forshtat/mempool-workshop-sidecar, devnet-readme section 8). */
export const GATEWAY = "https://altmempoolgateway.forshtat.com/rpc";
export const EXPLORER = "https://explorer.altmempool.wtf/";

export const devnet = defineChain({
  id: 1337,
  name: "EIP-8141 alt-mempool devnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [GATEWAY] } },
});

export const PREDEPLOYS = {
  poolManager: "0x6bF9Aa9c04fd001385742d61f6818C3236429848",
  stateView: "0xd89a052862AaA34f0B6cc7f3B6a9D080584a43FB",
  weth: "0x1b7d32025F7cA633943BbCC9Ec61a98ef66187b6",
  usdc: "0xEFe0D421fD473564c9C9b0cDCeB194cF476D6AF5",
  permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
  stakingRegistry: "0xd51c04d7a0b01124e84de152f4e56d9eecb22d2f",
} as const satisfies Record<string, Address>;

/** Legacy txs (deploys, EOA swaps): the devnet base fee is a few wei. */
export const LEGACY_GAS_PRICE = 2_000_000n; // 0.002 gwei
export const FRAME_MAX_FEE = 2_000_000_000n; // 2 gwei, as in the workshop
export const MIN_STAKE = 10_000_000_000_000_000n; // 0.01 ETH; the BALANCE carve-out needs strictly more
