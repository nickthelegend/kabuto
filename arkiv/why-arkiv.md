# Why Arkiv (why-Arkiv criterion)

An open intent is a **temporary public offer**: "at most X in, at least Y out, until this deadline, from this account". Fillers need to find the live ones, filter them, and trust they came from a known publisher. When the deadline passes, the offer should vanish.

| Need | Arkiv feature we use | What we'd do without it |
|---|---|---|
| Fillers find live offers by status, chain and deadline | indexed attributes (`status`, `chainId`, `deadline`, `tokenIn`, `tokenOut`, `account`) with SQL-like filters | run and trust a database behind our relay (`GET /intents`), which is a single operator |
| Stale offers disappear by themselves | `ExpirationTime.atDate(deadline)`: the entity expires at the intent's own signed deadline | a cleanup cron, or on-chain storage that costs gas to write and never goes away |
| Readers can tell our listings from spam | entity owner: readers filter `ownedBy(writer)` | sign every row and make readers verify a second signature scheme |
| A public, auditable outcome log | `kabuto.fill.v1` entities with the devnet tx hash, kept 30 days | events on chain 1337, but a refused fill never reaches chain 1337, so it would leave no record at all |
| Users pay nothing | the writer pays tGLM; users never touch Rabdi | users would need gas on a second chain |

What Arkiv is **not** used for: authorization, prices or settlement. Those stay on chain 1337, enforced by `KabutoAccount.verifyIntent`. A filler re-verifies every intent's signature on chain 1337 before filling, so a wrong or forged board entry can waste a filler's time but cannot move a user's funds. That split keeps Kabuto to one settlement chain, with Arkiv as its data layer.

The user-facing reader is the DEX's Intents tab ([`packages/app/src/lib/arkiv.ts`](../packages/app/src/lib/arkiv.ts)); the judge queries are in the README and [`schema.md`](schema.md).
