# Reach

The Arkiv board is live in the deployed app, https://kabuto-self.vercel.app (Intents tab), with no tGLM needed by users: the relay's writer pays for every entity.

- Writer: `0x8eD225Ae7f4b445Bfee6ad5dd9719C59426Af3aF` (funded on Rabdi; about 0.00036 tGLM spent for one intent, one fill and one status patch).
- First live round trip (Nov 6 2026): intent entity `0xd309c13a29b10ff87b4ecfd62721f168397ea25930a0a2e5dc8f0f910be420d0` → filled on the EIP-8141 devnet by a third-party filler (`0xd498630c236fa7132b41011414430d0765d86b7ab4db62fc360901fc04f5752b`) → fill entity `0xd9cc8020d93d9bdae3052f914a1770613cc2c4958edaf72cf0621cca76fd4e5f` → intent patched to `filled`.
- Everyone who posts an intent in the app, and every filler polling with `--source arkiv`, uses the board. Current numbers: `GET https://kabuto-relay.201-18-198-162.sslip.io/arkiv` (`published`).

These are hackathon-scale numbers, stated as measured; we don't claim users beyond them.
