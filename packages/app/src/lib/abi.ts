import KabutoAccount from "../abi/KabutoAccount.json";
import KabutoRouter from "../abi/KabutoRouter.json";
import DevnetToken from "../abi/DevnetToken.json";
import type { Abi, Hex } from "viem";

export const accountArtifact = KabutoAccount as { abi: Abi; bytecode: Hex };
export const routerAbi = KabutoRouter.abi as Abi;
export const tokenAbi = DevnetToken.abi as Abi;

export const POOL_KEY_T = {
  type: "tuple", name: "poolKey",
  components: [
    { name: "currency0", type: "address" }, { name: "currency1", type: "address" },
    { name: "fee", type: "uint24" }, { name: "tickSpacing", type: "int24" }, { name: "hooks", type: "address" },
  ],
} as const;

export const stateViewAbi = [
  { type: "function", name: "getSlot0", stateMutability: "view", inputs: [{ name: "poolId", type: "bytes32" }], outputs: [{ type: "uint160" }, { type: "int24" }, { type: "uint24" }, { type: "uint24" }] },
  { type: "function", name: "getLiquidity", stateMutability: "view", inputs: [{ name: "poolId", type: "bytes32" }], outputs: [{ type: "uint128" }] },
] as const;

export const quoterAbi = [{
  type: "function", name: "quoteExactInputSingle", stateMutability: "nonpayable",
  inputs: [{ type: "tuple", name: "params", components: [POOL_KEY_T, { name: "zeroForOne", type: "bool" }, { name: "exactAmount", type: "uint128" }, { name: "hookData", type: "bytes" }] }],
  outputs: [{ name: "amountOut", type: "uint256" }, { name: "gasEstimate", type: "uint256" }],
}] as const;

export const registryAbi = [
  { type: "function", name: "addStake", stateMutability: "payable", inputs: [{ type: "uint32" }], outputs: [] },
  { type: "function", name: "getDepositInfo", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }, { type: "uint32" }, { type: "uint64" }] },
] as const;
