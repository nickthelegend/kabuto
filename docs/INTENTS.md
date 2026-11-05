# Intents, from zero

## The one-sentence version
A normal swap is **you doing the trade**. An intent is **you signing what you want, and letting someone else do the trade for you**, with your account refusing any result worse than what you signed.

## A normal swap
You want 300 kUSD → WETH. You:
1. choose the route (which pool, which router),
2. build and send the transaction,
3. pay the gas, so you must already hold ETH,
4. hope no bot sandwiches you on the way.

## An intent
You sign a note. Nothing is sent to the chain and no gas is paid:

> Take **up to 300 kUSD** from my account.
> Give me **at least 0.00595 WETH**, falling to **0.00585 WETH** over the next **2 minutes**.
> This note is valid once (nonce 7).

Then:
1. The note goes on a public board: Kabuto's relay, mirrored to Arkiv.
2. **Fillers**, independent bots run by anyone, read the board. A filler thinks: *"I can swap that on Uniswap v4, give the user their WETH, and keep whatever is left over."*
3. The fastest or best-paying filler builds the transaction, **pays the gas**, and sends it.
4. Your Kabuto account checks the filler's work inside the same transaction. If you'd receive less than the minimum, or the filler tried anything else with your tokens, the transaction is invalid or rolls back. Your 300 kUSD never leaves.

Everyday analogy: it's ordering food in an app. You say what you want and the most you'll pay; a delivery partner does the running; if the order arrives wrong, you don't accept it.

## Why users want it
- **No ETH needed.** A new user who only holds a stablecoin can trade; the filler pays the gas.
- **Competition sets the price.** Fillers race each other; the one that gives you the most wins.
- **No routing knowledge.** Wallets and AI agents say *what*, not *how*.
- **A hard floor.** You can never get less than your signed minimum.

## Why this is new: what EIP-8141 makes possible
Intents already exist: UniswapX, CoW Swap, 1inch Fusion. But each needs:
- its own **settlement contract** that holds your token approval, and
- an **off-chain auction server** that picks the winner.

Kabuto needs neither, because an EIP-8141 frame transaction can be built by one party and approved by another:

```
0  VERIFY   your account   checks your signature on the note AND the shape of every frame below
1  VERIFY   the filler     signs the whole transaction and agrees to pay the gas
2  SENDER   your account   sends at most 300 kUSD to the filler           (atomic)
3  DEFAULT  the filler     swaps on Uniswap v4 and pays you               (atomic; cannot act as you)
4  SENDER   your account   settleIntent: received ≥ minimum, or revert the whole batch
```

You sign only the note (an *explicit signature message*), not the transaction. EIP-8141's own security section warns that this kind of approval is dangerous unless the account checks every frame. Kabuto's `verifyIntent` does exactly that, and we tried to break it live:
- an extra frame that sends your tokens to the attacker → refused before reaching a block
- taking more than 300 kUSD → refused
- removing the all-or-nothing flag → refused
- paying you less than the minimum → the whole batch rolled back; your balance was identical before and after

The auction is the mempool itself: fillers send the same note at the same nonce, and the alt-mempool keeps the highest fee.

## Where you see it in the app
Intents tab → type an amount → **Sign intent**. The card shows:
**Signed** (0 gas) → **Posted** (on the board, and on Arkiv) → **Fillers racing** (bids) → **Filled** ("filler paid gas", amount received). The Arkiv board below lists open intents and recent fills, with explorer links.

## The protection toggle vs intents
| | Protection toggle | Intent |
|---|---|---|
| Who sends the transaction | you | a filler |
| Who pays gas | you (or the paymaster) | the filler |
| What protects your price | VERIFY pins the pool price: a sandwiched swap is invalid | VERIFY + settle: anything below your minimum is invalid or rolls back |
| Best for | "I want to swap now, at this price" | "I want this outcome, someone else do it" |
