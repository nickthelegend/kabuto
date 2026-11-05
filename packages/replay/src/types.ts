export type Hex = `0x${string}`;
export interface RawLog {
  address: Hex; topics: Hex[]; data: Hex; blockNumber: Hex; transactionHash: Hex;
  transactionIndex: Hex; logIndex: Hex; removed?: boolean;
}
export interface Tx { hash: Hex; from: Hex; to: Hex | null; blockNumber: Hex; transactionIndex: Hex }
export interface Block { number: Hex; timestamp: Hex; hash: Hex }
export interface Swap {
  poolId: Hex; sender: Hex; amount0: bigint; amount1: bigint; sqrtPriceX96: bigint;
  liquidity: bigint; tick: number; fee: number; blockNumber: number; transactionIndex: number;
  logIndex: number; transactionHash: Hex; prePriceX96: bigint | null;
}
export interface Pool { id: Hex; currency0: Hex; currency1: Hex; fee: number; hooks: Hex; tickSpacing: number; initializeBlock: number }
export interface Candidate { front: Swap; victim: Swap; back: Swap; frontTx: Tx; victimTx: Tx; backTx: Tx; attackerMatch: 'from' | 'to' }
