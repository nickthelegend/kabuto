import { decodeEventLog, formatUnits, parseUnits, type Hex } from "viem";
import { account, deployment, ensureAssets, pub, routerAbi, swapData, wallet } from "./common.js";

export async function sendVictim(amount = parseUnits(process.env.VICTIM_KUSD ?? "30", 6)) {
  if (await pub.getChainId() !== 1337) throw new Error("Refusing to send outside devnet 1337");
  const direction = !deployment.wethIs0;
  const victim = account("victim").address;
  await ensureAssets("victim", amount, 0n);
  const quoteBlock = await pub.getBlockNumber();
  const quoted = await pub.simulateContract({ address: deployment.router, abi: routerAbi, functionName: "swapExactIn", args: [deployment.poolKey, direction, amount, 0n, victim], account: victim, blockNumber: quoteBlock });
  const quote = quoted.result as bigint;
  const min = quote * 99n / 100n;
  const hash = await wallet("victim").sendTransaction({ to: deployment.router, data: swapData(direction, amount, min, victim), gas: 500_000n, gasPrice: BigInt(process.env.VICTIM_GAS_WEI ?? "2000000"), type: "legacy" });
  console.log(`Victim sent ${hash}, no-sandwich quote ${formatUnits(quote, 18)} WETH, 1% slippage`);
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  let output: bigint | null = null;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== deployment.router.toLowerCase()) continue;
    try {
      const event = decodeEventLog({ abi: routerAbi, data: log.data, topics: log.topics });
      if (event.eventName === "Swapped") output = (event.args as unknown as { amountOut: bigint }).amountOut;
    } catch { /* unrelated event */ }
  }
  if (receipt.status !== "success" || output === null) throw new Error(`Victim swap failed: ${hash} (${receipt.status})`);
  console.log(`Victim included block ${receipt.blockNumber} index ${receipt.transactionIndex}; output ${formatUnits(output, 18)} WETH; loss vs quote ${formatUnits(quote - output, 18)} WETH`);
  return { hash: hash as Hex, receipt, quote, output };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) sendVictim().catch(e => { console.error(e); process.exitCode = 1; });
