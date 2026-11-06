# Reach (reach criterion)

Measured Nov 6 2026; hackathon-scale numbers, stated as measured.

## Who reads and writes the board
- **Every DEX user who opens the Intents tab** at https://kabuto-self.vercel.app reads the board straight from Rabdi (every 4 s). Users need no tGLM and no Arkiv wallet: the relay's writer pays for every entity.
- **Every filler** can read open intents from Arkiv instead of trusting our relay: `pnpm --dir packages/filler filler -- --source arkiv` with `ARKIV_WRITER` and its own funded operator key set (polls every 2 s, re-verifies each signature on chain 1337). Any team can run one; nothing in the protocol needs our servers.
- **Anyone with the query** in the README can audit the fill log without our code.

## Numbers
| | Value | How to check |
|---|---|---|
| Writer | `0x8eD225Ae7f4b445Bfee6ad5dd9719C59426Af3aF` | [explorer](https://rabdi.explorer.arkiv.network/address/0x8eD225Ae7f4b445Bfee6ad5dd9719C59426Af3aF) |
| Writer transactions | 3 (intent create, fill create, status patch) | `eth_getTransactionCount` on Rabdi returned `0x3` |
| Writer balance | 8.99958 tGLM | `GET https://kabuto-relay.201-18-198-162.sslip.io/arkiv` (`balanceTglm`) |
| Live fill entity | [`0xd9cc8020…4e5f`](https://rabdi.explorer.arkiv.network/entity/0xd9cc8020d93d9bdae3052f914a1770613cc2c4958edaf72cf0621cca76fd4e5f), outcome `landed`, devnet tx [`0xd498630c…752b`](https://explorer.altmempool.wtf/tx/0xd498630c236fa7132b41011414430d0765d86b7ab4db62fc360901fc04f5752b) (mined in block 407,731) | README query 1 |
| Intent entity | `0xd309c13a…20d0`, published about 4 s after posting, patched `open` → `filled`, then expired at its deadline as designed | `getEntity` now reports it expired |
| Relay publications since its last restart | `published` in `GET /arkiv` | live counter |

## What would grow it
Kabuto's intents are self-authenticating, so any wallet or DEX using `@kabuto/sdk` can post to any relay that mirrors to the same schema, and any filler can read the board. More fillers reading Arkiv, not more of our own writes, is the reach that matters.
