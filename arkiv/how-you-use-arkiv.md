# How Kabuto uses Arkiv

The relay verifies a signed Kabuto intent against the account on chain 1337, replies to the poster, and publishes an expiring `kabuto.intent.v1` entity on Rabdi in the background. It records the entity key in its event journal and exposes it in later SSE events and `GET /intents`. Outcome reports create `kabuto.fill.v1` entities; a landed report is published only after the devnet explorer confirms the fill is `OnChain`, and it also patches the listing to `filled`.

The browser's Intents tab reads Rabdi every four seconds and shows open listings and five recent fills with explorer links. A filler can use `--source arkiv` to poll the trusted writer every two seconds, reverify signatures on chain 1337, and use the existing fill path. `GET /arkiv` shows setup and publication errors.

Source: [`packages/filler/src/arkiv.ts`](../packages/filler/src/arkiv.ts), [`packages/filler/src/relay.ts`](../packages/filler/src/relay.ts), [`packages/filler/src/filler.ts`](../packages/filler/src/filler.ts), [`packages/app/src/lib/arkiv.ts`](../packages/app/src/lib/arkiv.ts). Run `pnpm --dir packages/filler exec vitest run test/arkiv.test.ts` for the byte round trip and live public read. The live write case runs when a funded `ARKIV_PRIVATE_KEY` is present.
