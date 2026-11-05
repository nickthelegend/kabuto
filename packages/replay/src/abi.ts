import { parseAbiItem, toEventSelector } from 'viem';

export const MANAGER = '0x000000000004444c5dc75cB358380D2e3dE08A90';
export const SWAP = parseAbiItem('event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)');
export const INITIALIZE = parseAbiItem('event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)');
export const SWAP_TOPIC = toEventSelector(SWAP);
export const INITIALIZE_TOPIC = toEventSelector(INITIALIZE);
export const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
export const USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7';
export const DAI = '0x6b175474e89094c44da98b954eedeac495271d0f';
export const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
export const ETH = '0x0000000000000000000000000000000000000000';
export const DECIMALS: Record<string, number> = { [USDC]: 6, [USDT]: 6, [DAI]: 18, [WETH]: 18, [ETH]: 18 };
export const STABLES = new Set([USDC, USDT, DAI]);
