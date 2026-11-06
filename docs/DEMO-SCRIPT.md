# Kabuto demo film (≤ 4 min)

Rules: plain-language problem first; everything shown live on the devnet in the product UI (no CLI, no replays presented as live); real tx hashes on screen; captions where something is non-obvious; never edit real output.

| Time | Picture | Voice / caption |
|---|---|---|
| 0:00–0:20 | Gemini hero loop (kabuto under the moon) → title "Kabuto" | "Every time you swap on a DEX, a bot can see it, buy first, and sell to you at a worse price. It's called a sandwich." |
| 0:20–0:35 | Replay stat card: real mainnet v4 sandwiches from `packages/replay/out/summary.json` | "In 27 hours of Uniswap v4 mainnet: 497 sandwiched swaps. With a ±0.5% pin, 77% of the ones we could evaluate would have been invalid." (same-sender count from `out/sandwiches.jsonl`; no dollar figure: USD coverage was ~1%) |
| 0:35–1:20 | DEX, protected swap: sign → In alt-mempool; sandwich bot panel goes live; bot front-runs; the result card shows "Sandwich blocked · Not included · 0 gas"; open the Cancelled tx on the explorer | "Kabuto puts the price check inside the transaction's VERIFY frame. The bot moved the price, so our swap stopped existing. We paid nothing. The bot is holding its trade." |
| 1:20–1:45 | Same swap from the normal wallet: filled worse | "Same swap, normal wallet: filled 1.8% worse." (from the take's own numbers) |
| 1:45–2:45 | Post an intent: "Sign intent · no gas" → relay shows it → filler A and filler B quote and race → attacker filler tries an extra SENDER frame → refused `BadIntentShape(9)` → fill lands; account ETH unchanged | "Or don't route it at all. Sign one sentence: this much in, at least this much out. Anyone can fill it and pay the gas. EIP-8141 warns that signing only a message is dangerous; Kabuto checks every frame. The attacker's fill never reaches a block." |
| 2:45–3:15 | Gemini lantern race b-roll → architecture diagram | "No settlement contract, no auction server. The mempool is the auction." |
| 3:15–3:45 | SDK snippet + proof table on the landing | "Any DEX or wallet can add both with @kabuto/sdk. Every claim is a transaction you can open." |
| 3:45–4:00 | Logo, repo URL | "Kabuto. Swaps that only happen at your price." |

Capture: Playwright `recordVideo` of the DEX at 1440×900 on the live devnet (real txs), plus the relay/filler/bot processes running. Edit in HyperFrames; b-roll from `assets/generated/*.mp4`.
