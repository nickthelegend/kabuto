# @kabuto/sdk

TypeScript client for Kabuto protected swaps, sponsored swaps, and open intents on the public EIP-8141 devnet. Works in browsers and Node. **Devnet only until EIP-8141 ships (Hegotá).** Chain ID 1337; test tokens and ETH have no mainnet value.

```sh
npm install @kabuto/sdk
```

The package is ESM and includes TypeScript declarations. `createKabuto()` uses the addresses exported as `devnet1337`; pass `{ rpcUrl, deployment }` to use a compatible gateway and deployment. All amounts are raw token units (`bigint`). kUSD has 6 decimals and WETH has 18.

## Setup and signers

```ts
import { createKabuto, devnet1337, secp256k1Signer, p256Signer, explainRejection } from '@kabuto/sdk';
const kabuto = createKabuto({ deployment: devnet1337 });
const owner = secp256k1Signer(ownerPrivateKey);
const passkey = p256Signer(p256PrivateKey);
console.log(owner.address, passkey.address);
```

Both signers expose `address`, `scheme`, and `signHash(hash32)`. A P256 address is the final 20 bytes of `keccak256(qx || qy)`; its packed signature is `r || s || qx || qy`. The secp256k1 packed signature is `yParity || r || s`.

## Deploy and stake an account

```ts
const deployed = await kabuto.deployAccount({
  funderKey, owner: owner.address,
  value: 50_000_000_000_000_000n,
});
const account = deployed.address;
```

```ts
const stake = await kabuto.stakeAccount({
  account, signer: owner,
  value: 12_000_000_000_000_000n,
});
await stake.wait();
```

The funder sends a legacy deployment transaction. Stake must exceed 0.01 ETH. The account and funder must already hold enough devnet ETH; the SDK does not silently request faucet funds.

## Quote and inspect price

```ts
const { amountOut } = await kabuto.quote({
  zeroForOne: !devnet1337.wethIs0,
  amountIn: 10_000_000n,
});
console.log(amountOut);
```

```ts
const { sqrtPriceX96, tick } = await kabuto.poolPrice();
console.log(sqrtPriceX96);
console.log(tick);
// sqrtPriceX96 comes from StateView.getSlot0(poolId).
```

`quote` also accepts `side: 'buy' | 'sell' | 'zeroForOne' | 'oneForZero'` (buy means kUSD → WETH) and returns the Quoter gas estimate. A price band can be a basis point width or explicit `{ min, max }` sqrt price limits.

## Protected and sponsored swaps

```ts
const swap = await kabuto.protectedSwap({
  account, signer: owner, zeroForOne: false,
  amountIn: 10_000_000n, bandBps: 50,
  minOut: 0n,
});
```

```ts
const sponsored = await kabuto.sponsoredSwap({
  account, signer: owner, zeroForOne: false,
  amountIn: 10_000_000n, bandBps: 50,
  minOut: 0n,
});
```

Use `await swap.wait()` or `for await (const event of swap.events())`. Protected swaps pin the pool price in VERIFY, then atomically approve and swap. Sponsored swaps add the payment VERIFY frame and transfer the deployment's configured fee in the output token; the account does not pay ETH for gas.

## Sign an open intent

```ts
const block = await kabuto.publicClient.getBlock();
const signedIntent = await kabuto.signIntent({
  account, signer: owner, tokenIn: devnet1337.kusd,
  maxIn: 10_000_000n, tokenOut: devnet1337.predeploys.weth,
  startOut, endOut, startTime: block.timestamp, deadline: block.timestamp + 600n,
});
```

`signIntent` reads `account.intentDigest(intent)` and signs only that explicit digest. It performs no transaction, so the owner pays no gas. `nonce` defaults to the account's current transaction nonce. The result contains `{ intent, digest, signature, account, owner, scheme }` and can be posted to any relay or sent directly to a filler.

## Build and submit a fill

```ts
const tx = await kabuto.buildFill({
  signedIntent, filler, operatorKey,
  amountIn: signedIntent.intent.maxIn,
  payOut: signedIntent.intent.startOut, tip: 100_000_000n,
});
```

```ts
const tracker = await kabuto.submitFill(tx);
for await (const event of tracker.events()) {
  console.log(event.status, event.hash);
}
console.log(tracker.hash);
```

The filler pays gas using its own `KabutoFiller` contract. The final settle frame checks the amount actually received by the account against the Dutch decayed minimum. `buildFill` accepts `attack` only for devnet security demonstrations.

## Track and explain

```ts
const tracker = kabuto.track(hash, event => {
  console.log(event.status, event.block, event.frames);
});
// Or: for await (const event of kabuto.track(hash)) { ... }
console.log(tracker.hash);
```

```ts
try {
  await kabuto.submitFill(tx);
} catch (error) {
  console.error(explainRejection(error));
}
// Also covers price, verify gas, and stake errors.
```

Lifecycle statuses are `admitted`, `pending`, `onchain`, `cancelled`, and `reverted`. The tracker reads `skandha_explorer_getTransaction`, with `skandha_frameTransactionStatus` as fallback. `explainRejection` maps `PriceOutOfBand`, `BadIntentShape(code)`, `BadIntentSignature`, `MAX_VERIFY_GAS`, and unstaked account errors.

## Security model

EIP-8141 warns: **“Execution Approval Authorizes All Subsequent Sender Frames.”** An approval based on an explicit 32-byte message could otherwise be reused with arbitrary later sender frames. [EIP-8141 security considerations](https://eips.ethereum.org/EIPS/eip-8141#execution-approval-authorizes-all-subsequent-sender-frames) require validation to constrain every subsequent `SENDER` frame. `KabutoAccount.verifyIntent` enforces the signed nonce, the payment VERIFY, an atomic `tokenIn.transfer` capped at `maxIn`, only atomic DEFAULT filler frames after it, and an exact final `settleIntent` call with the current output balance. Extra sender frames, over-max pulls, missing atomic flags, and altered settlement are rejected before admission. An underpayment makes settlement revert and rolls back the atomic batch.

The relay is untrusted: anyone can host one because the intent includes a digest and signature verified against the account owner. Fillers may compete on tip and on how much surplus they return to the user.

MIT © 2026 Nivesh Gajengi.
