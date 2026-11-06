# Arkiv friction (feedback criterion)

What it was like to build Kabuto's intent board on Arkiv Rabdi with `@arkiv-network/sdk` 1.0.1, Nov 5–6 2026. Each point says what happened and what would have helped.

## What worked
- **The SDK is small and typed.** `defineSchema` + `select().from(Schema).where(...).ownedBy(writer)` gave typed rows in both Node (relay, filler) and the browser bundle (Vite, no Node-only import errors). The whole integration is [`packages/filler/src/arkiv.ts`](../packages/filler/src/arkiv.ts) (86 lines) and [`packages/app/src/lib/arkiv.ts`](../packages/app/src/lib/arkiv.ts).
- **Expiry did exactly what we wanted.** `ExpirationTime.atDate(deadline)` made the first intent entity disappear at its signed deadline; `getEntity` on it now reports "No live entity … has expired". No cleanup job.
- **Raw queries work on the public RPC without a key**, which made the judge query in the README possible.
- **Cost is negligible:** the writer's three transactions (one intent, one fill, one status patch) left it at 8.99958 tGLM.

## Friction
1. **Two human steps before the first write.** Funding a writer means a faucet claim behind Sign-In with Ethereum and a CAPTCHA, and an access key needs the same. For an agent-built or CI-built project, that blocked the live write until a person did it. A CLI faucet for testnet (rate-limited by GitHub login, for example) would remove the wait.
2. **`rabdi({ accessKey: "" })` is required even for the public endpoint.** Omitting the field throws; passing `""` works and prints a rate-limit warning. Making the field optional would match how most people start.
3. **The public RPC says "heavily rate limited" with no number.** We poll every 4 s from the browser and every 2 s from a filler, and we can't say how far that scales. Publishing the limit would let apps size their polling.
4. **`$createdAt` can be selected but not used as a sort key.** To show the five most recent fills, the browser fetches pages of 100 and sorts locally ([`packages/app/src/lib/arkiv.ts:50`](../packages/app/src/lib/arkiv.ts#L50)). A sortable creation time would make "latest N" a single query.
5. **Pages are capped at 100 rows**, so every reader needs a pagination loop (`offset`), which each of our readers repeats.
6. **An expired entity is gone everywhere, including its explorer page.** That is the point of expiry, but it means a README link to an expired intent stops working, and there is no history API to prove it existed. We keep the proof in the fill entity (it carries the intent key and lives 30 days). An optional "tombstone" (key, owner, expiry block) kept after expiry would help audit trails.
7. **Anyone can write an entity with your schema name.** Correct for a public DB, but easy to miss: every reader must filter by owner. The docs could put `ownedBy` in the first query example.
8. **Chain-id clash.** The SDK's `localhost` chain uses id 1337, the same id as the EIP-8141 devnet our swaps settle on. We only use Rabdi, but a wallet holding both would be confused.
9. **`str` values are capped at 128 bytes**, so the signed intent JSON goes in a `bytes` field and readers decode it themselves.
