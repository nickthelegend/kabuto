import { DAI, ETH, STABLES, USDC, USDT, WETH } from './abi.js';
import type { Candidate, Hex, Pool } from './types.js';

export type NullableMetric = { value: number | null; reason: string | null };
const ok = (value: number): NullableMetric => Number.isFinite(value) ? { value, reason: null } : { value: null, reason: 'nonfinite calculation' };
const unknown = (reason: string): NullableMetric => ({ value: null, reason });
const human = (raw: bigint, decimals: number) => Number(raw) / 10 ** decimals;
export const price1Per0 = (sqrt: bigint, d0: number, d1: number) => (Number(sqrt) / 2 ** 96) ** 2 * 10 ** (d0 - d1);

export function measure(candidate: Candidate, pool: Pool | null, decimals: Record<string, number>, band: number, wethUsd: number | null) {
  const { front, victim, back } = candidate;
  const d0 = pool ? decimals[pool.currency0] : undefined;
  const d1 = pool ? decimals[pool.currency1] : undefined;
  const pre = front.prePriceX96;
  const post = front.sqrtPriceX96;
  const hasUnits = d0 !== undefined && d1 !== undefined;
  const preSpot = pre && hasUnits ? price1Per0(pre, d0!, d1!) : null;
  const postSpot = hasUnits ? price1Per0(post, d0!, d1!) : null;
  const realized = hasUnits && victim.amount0 !== 0n && victim.amount1 !== 0n ? human(victim.amount1 < 0n ? -victim.amount1 : victim.amount1, d1!) / human(victim.amount0 < 0n ? -victim.amount0 : victim.amount0, d0!) : null;
  const input0 = front.amount0 < 0n;
  const inputCurrency = pool ? (input0 ? pool.currency0 : pool.currency1) : null;
  const inputDecimals = input0 ? d0 : d1;
  const victimInput = hasUnits ? human(input0 ? -victim.amount0 : -victim.amount1, inputDecimals!) : null;
  const victimOutput = hasUnits ? human(input0 ? victim.amount1 : victim.amount0, input0 ? d1! : d0!) : null;
  const loss = preSpot && victimInput !== null && victimOutput !== null ? victimInput - (input0 ? victimOutput / preSpot : victimOutput * preSpot) : null;
  const net0 = hasUnits ? human(front.amount0 + back.amount0, d0!) : null;
  const net1 = hasUnits ? human(front.amount1 + back.amount1, d1!) : null;
  const profit = preSpot && net0 !== null && net1 !== null ? (input0 ? net0 + net1 / preSpot : net1 + net0 * preSpot) : null;
  const priceMove = pre ? (Number(post) / Number(pre)) ** 2 - 1 : null;
  const stopped = priceMove === null ? null : Math.abs(priceMove) > band;
  let inputUsd: number | null = null;
  if (pool && preSpot && inputCurrency) {
    if (STABLES.has(inputCurrency)) inputUsd = 1;
    else {
      const other = input0 ? pool.currency1 : pool.currency0;
      if (STABLES.has(other)) inputUsd = input0 ? preSpot : 1 / preSpot;
      else if (inputCurrency === WETH || inputCurrency === ETH) inputUsd = wethUsd;
    }
  }
  const usdReason = !pool ? 'pool Initialize event not found in metadata lookback' : !hasUnits ? 'token decimals unavailable' : !pre ? 'pre-front pool price unavailable' : inputUsd === null ? 'no same-block WETH/USDC v4 price or stablecoin quote' : null;
  return {
    poolId: front.poolId, blockNumber: front.blockNumber,
    frontTx: front.transactionHash, victimTx: victim.transactionHash, backTx: back.transactionHash,
    etherscan: { front: `https://etherscan.io/tx/${front.transactionHash}`, victim: `https://etherscan.io/tx/${victim.transactionHash}`, back: `https://etherscan.io/tx/${back.transactionHash}` },
    attackerMatch: candidate.attackerMatch, attackerFrom: candidate.frontTx.from, victimFrom: candidate.victimTx.from,
    pool, inputCurrency, preSpotToken1PerToken0: preSpot === null ? unknown(!pre ? 'no earlier Swap observed' : 'token decimals unavailable') : ok(preSpot),
    postFrontSpotToken1PerToken0: postSpot === null ? unknown('token decimals unavailable') : ok(postSpot),
    victimRealizedToken1PerToken0: realized === null ? unknown('token decimals unavailable or zero swap amount') : ok(realized),
    victimLossInputToken: loss === null ? unknown(!pre ? 'no earlier Swap observed' : 'pool metadata or token decimals unavailable') : ok(loss),
    attackerNetToken0: net0 === null ? unknown('pool metadata or token decimals unavailable') : ok(net0),
    attackerNetToken1: net1 === null ? unknown('pool metadata or token decimals unavailable') : ok(net1),
    attackerGrossProfitInputToken: profit === null ? unknown(!pre ? 'no earlier Swap observed' : 'pool metadata or token decimals unavailable') : ok(profit),
    victimLossUsd: loss === null || inputUsd === null ? unknown(usdReason ?? 'input-token loss unavailable') : ok(loss * inputUsd),
    attackerGrossProfitUsd: profit === null || inputUsd === null ? unknown(usdReason ?? 'input-token profit unavailable') : ok(profit * inputUsd),
    priceMove, stopped, stoppedReason: stopped === null ? 'pre-front pool price unavailable' : null,
    band, fee: victim.fee, poolUsdPricing: inputUsd === null ? null : { inputTokenUsd: inputUsd, basis: STABLES.has(inputCurrency!) ? 'stablecoin peg assumption' : 'pre-front v4 pool spot / same-block WETH-USDC v4 spot' }
  };
}
