import deployment from "../../../../deployments/1337.json";
import { defineChain, type Address, type Hex } from "viem";

export const D = deployment as unknown as {
  chainId: number; gateway: string; ethrex: string; explorer: string;
  predeploys: Record<"poolManager" | "stateView" | "weth" | "usdc" | "permit2" | "stakingRegistry", Address>;
  kusd: Address; router: Address; wethIs0: boolean; poolId: Hex;
  poolKey: { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };
};

export const QUOTER: Address = "0xeEa49CC6419125E2f706bf7f95Cf34ac7e93087D"; // v4 Quoter predeploy
export const BOT_URL = (import.meta.env.VITE_BOT_URL as string | undefined) ?? "http://localhost:8787";
export const RELAY_URL = (import.meta.env.VITE_RELAY_URL as string | undefined) ?? "http://localhost:8788";
export const LEGACY_GAS_PRICE = 2_000_000n;
export const FRAME_MAX_FEE = 2_000_000_000n;
export const STAKE = 12_000_000_000_000_000n; // 0.012 ETH, strictly above the devnet minStake (0.01)

export const devnet = defineChain({
  id: 1337, name: "EIP-8141 alt-mempool devnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [D.gateway] } },
});
