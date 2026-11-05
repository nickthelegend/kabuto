# Kabuto open filler network

Run a relay and one or more independent fillers against the public EIP-8141 devnet (chain 1337). This is a **devnet-only** demonstration until EIP-8141 ships in Hegotá. Anyone can run a relay: it holds no funds, cannot change a signed intent, and verifies the account's owner, onchain digest, signature, and deadline before accepting it. Its public events are observations from filler clients; consumers should confirm chain inclusion independently.

```sh
pnpm --dir packages/filler relay
pnpm --dir packages/filler filler -- --name a
pnpm --dir packages/filler filler -- --name b --minProfitBps 5 --tipGwei 2
pnpm --dir packages/filler attack -- --mode extra-sender
```

The relay listens on port 8788 with CORS `*` and stores posted intents and outcome events in `data/intents.jsonl`. `POST /intents` accepts a SDK `SignedIntent` JSON object; `GET /intents` returns unexpired open intents; `GET /events` streams SSE events `intent_posted`, `fill_submitted`, `fill_landed`, `fill_refused`, and `fill_replaced`. Filler clients report outcomes through `POST /events`.

Each filler has its own ignored devnet key role (`filler-a` or `filler-b`) and deploys its own `KabutoFiller` with 0.1 ETH on first run. It quotes through the live v4 Quoter, checks `account.decayedMinOut`, and fills only when the quote clears `minProfitBps`. It pays the user the contract minimum plus `userShareBps` of the surplus (default 5000 for a, 7500 for b), and keeps the rest. Competing fillers use the same intent nonce, so one fill lands and the other is replaced or refused. Set `--relay URL` to use another relay.

Attack mode supports `extra-sender`, `over-max`, `no-atomic`, and `underpay`. The first three violate `verifyIntent` and are refused at admission; underpay triggers atomic rollback. Start it while a fresh intent remains open. These modes spend only devnet test funds.

MIT © 2026 Nivesh Gajengi.
