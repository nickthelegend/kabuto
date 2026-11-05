import { useEffect, useState } from "react";
import { D } from "./lib/config";
import { pub } from "./lib/chain";
import { priceFromSqrt, sqrtPrice } from "./lib/market";
import { PROOF, REFUSED, REPLAY } from "./lib/proof";

const short = (h: string, n = 8) => `${h.slice(0, n)}…${h.slice(-4)}`;
const tx = (h: string) => `${D.explorer}tx/${h}`;

const STEPS: { img: string; video?: string; n: string; t: string; d: string }[] = [
  {
    img: "/step-1-pin.jpg",
    n: "01",
    t: "Your swap carries its own price",
    d: "Kabuto signs your swap with a price band. The band lives inside the transaction's VERIFY frame, the part of an EIP-8141 transaction the network runs before anything else.",
  },
  {
    img: "/step-2-raider.jpg",
    n: "02",
    t: "A bot sees it and buys first",
    d: "The classic sandwich: a bot spots your swap in the mempool, jumps ahead of it, and moves the price against you before your trade lands.",
  },
  {
    img: "/step-3-vanish.jpg",
    video: "/step-3-vanish.mp4",
    n: "03",
    t: "Your swap stops existing",
    d: "When the price leaves your band, the VERIFY frame fails, and a transaction whose VERIFY fails is invalid. It is never included, nobody can fill it, and you pay nothing. The bot is left holding its trade.",
  },
  {
    img: "/step-4-lanterns.jpg",
    n: "04",
    t: "Or let anyone race to fill it",
    d: "Post an intent instead: you sign only “this much in, at least this much out”. Any filler can complete the transaction through Uniswap v4 and pay the gas. The mempool itself is the auction.",
  },
];

const FRAMES = [
  { m: "VERIFY", who: "your account", what: "verifyIntent(intent): your signature over the intent, and every frame below checked" },
  { m: "VERIFY", who: "the filler", what: "pay(): the filler co-signs the whole tx and pays the gas" },
  { m: "SENDER", who: "your account", what: "tokenIn.transfer(filler, ≤ maxIn)  · atomic" },
  { m: "DEFAULT", who: "the filler", what: "fill(): swaps through Uniswap v4 and pays you · atomic, cannot act as you" },
  { m: "SENDER", who: "your account", what: "settleIntent(): reverts the whole batch unless you received the Dutch-decayed minimum" },
];

const SDK = `import { createKabuto, p256Signer, devnet1337 } from "@kabuto/sdk";

const kabuto = createKabuto({ deployment: devnet1337 });
const me = p256Signer(localKey);

// 1. route it yourself: a sandwich makes this tx invalid, so it costs 0
await kabuto.protectedSwap({ account, signer: me, zeroForOne: false, amountIn: 300_000000n, bandBps: 50 });

// 2. or sign only an intent and let anyone race to fill it
const intent = await kabuto.signIntent({ account, signer: me, tokenIn: kUSD, maxIn: 300_000000n,
  tokenOut: WETH, startOut, endOut, deadline });
await fetch(RELAY + "/intents", { method: "POST", body: JSON.stringify(intent) });`;

const FAQ = [
  {
    q: "Why not just set slippage to 0?",
    a: "A failed swap still lands on chain and you still pay for it, and a bot can still sandwich up to your limit. With Kabuto the check runs before the transaction is valid: if the price moved, there is no transaction to pay for.",
  },
  {
    q: "Isn't signing only an intent dangerous?",
    a: "Yes, and EIP-8141's own security section says so: an approval that doesn't commit to the frames authorizes an open-ended list. Kabuto's VERIFY frame constrains every frame (one transfer up to your max, filler frames that can't act as you, an atomic batch, and a final settlement bound to your balance). Every tampered fill we tried was refused before entering a block.",
  },
  {
    q: "Who runs the auction?",
    a: "Nobody. Fillers submit the same intent with the same nonce; the mempool keeps the one paying the highest fee. The intent relay only passes signed intents around: it holds no funds and cannot change a single byte.",
  },
  {
    q: "Can I use it on mainnet today?",
    a: "Not yet. EIP-8141 frame transactions arrive with the Hegotá upgrade. Kabuto runs on the Ethereum Foundation's public frame-transaction devnet, with Uniswap v4's real contracts, so it is ready the day mainnet is.",
  },
];

function useLive() {
  const [block, setBlock] = useState<bigint | null>(null);
  const [price, setPrice] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const [b, p] = await Promise.all([pub.getBlockNumber(), sqrtPrice()]);
        if (alive) { setBlock(b); setPrice(priceFromSqrt(p)); }
      } catch { /* devnet unreachable: cards show their empty state */ }
    };
    tick();
    const t = setInterval(tick, 4000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  return { block, price };
}

export function Landing() {
  const live = useLive();
  const [faq, setFaq] = useState<number | null>(0);
  const [heroVideo, setHeroVideo] = useState(true);
  return (
    <>
      <section className="l-hero frame" aria-label="Kabuto">
        {heroVideo ? (
          <video className="l-hero-media" src="/hero.mp4" poster="/hero.jpg" autoPlay muted loop playsInline onError={() => setHeroVideo(false)} />
        ) : (
          <img className="l-hero-media" src="/hero.jpg" alt="" />
        )}
        <div className="l-hero-shade" aria-hidden />
        <div className="l-hero-copy">
          <span className="eyebrow"><i className="pulse" aria-hidden />Live on the EIP-8141 devnet · Uniswap v4</span>
          <h1>Swaps that only happen <span className="moon">at your price.</span></h1>
          <p className="lede">
            Route a swap yourself and a sandwich makes it vanish, for free. Or post an intent and let anyone race to fill it,
            with no settlement contract and no auction server: the mempool is the auction.
          </p>
          <div className="cta">
            <a className="btn-moon" href="#/app">Open Kabuto DEX</a>
            <a className="btn-line" href="#how">How it works</a>
          </div>
        </div>
        <div className="l-float" aria-live="polite">
          <div className="fcard"><small>Devnet block</small><b className="mono">{live.block !== null ? `#${live.block}` : "connecting…"}</b></div>
          <div className="fcard"><small>WETH / kUSD on Uniswap v4</small><b className="mono">{live.price !== null ? live.price.toLocaleString("en-US", { maximumFractionDigits: 2 }) : "…"}</b></div>
          <div className="fcard shu"><small>Sandwiched swap</small><b>Cancelled · 0 gas</b><a className="mono" href={tx(PROOF[2].hash)} target="_blank" rel="noreferrer">{short(PROOF[2].hash)}</a></div>
        </div>
      </section>

      <section className="l-stats" aria-label="Mainnet sandwiches">
        <div><b>{REPLAY.uniqueVictims}</b><span>Uniswap v4 swaps on mainnet sandwiched by the same sender in {REPLAY.hours} hours</span></div>
        <div><b className="moon">{Math.round((REPLAY.stopped / REPLAY.evaluated) * 100)}%</b><span>would have been impossible with a ±{REPLAY.bandPct}% Kabuto pin</span></div>
        <div><b>0</b><span>gas a Kabuto swap pays when the price moves against it</span></div>
        <p className="fine">Blocks {REPLAY.fromBlock.toLocaleString()}–{REPLAY.toBlock.toLocaleString()} ({REPLAY.fromIso} → {REPLAY.toIso}). Heuristic, read-only scan of PoolManager Swap logs; method and caveats in packages/replay/METHOD.md.</p>
      </section>

      <section className="l-sec" id="how">
        <div className="l-head">
          <span className="eyebrow">How it works</span>
          <h2>A sandwich needs your swap to land after the bot's. Kabuto makes sure it can't.</h2>
        </div>
        <div className="l-steps">
          {STEPS.map((s) => (
            <article className="l-step" key={s.n}>
              {s.video ? <video src={s.video} poster={s.img} autoPlay muted loop playsInline aria-hidden /> : <img src={s.img} alt="" loading="lazy" />}
              <div>
                <span className="mono num">{s.n}</span>
                <h3>{s.t}</h3>
                <p>{s.d}</p>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="l-sec l-two">
        <div className="l-head">
          <span className="eyebrow">Two ways to swap, one rule</span>
          <h2>A Kabuto swap is only valid if you get your price.</h2>
        </div>
        <div className="l-modes">
          <article className="frame mode">
            <span className="tag">Protected swap</span>
            <h3>You route it.</h3>
            <p>Your account's VERIFY frame reads the Uniswap v4 pool price. Outside your band, the transaction is invalid: never included, never charged. Add the Kabuto paymaster and the swap even pays its own gas from what you receive.</p>
            <ul className="mono"><li>VERIFY · verifyPrice(pool, band)</li><li>SENDER · approve · atomic</li><li>SENDER · swap on v4</li></ul>
          </article>
          <article className="frame mode">
            <span className="tag gold">Open intent</span>
            <h3>Anyone routes it.</h3>
            <p>You sign one digest: up to this much in, at least this much out, decaying over a few minutes. Fillers compete to complete it through Uniswap v4 and pay the gas. The first one it pays wins; same-nonce replacement settles any tie.</p>
            <ul className="mono"><li>sign(intentDigest) · no tx, no gas</li><li>filler builds + pays</li><li>settle: ≥ decayed minimum, or nothing</li></ul>
          </article>
        </div>
      </section>

      <section className="l-sec" id="security">
        <div className="l-head">
          <span className="eyebrow">The EIP warned about this</span>
          <h2>We built the path the spec calls dangerous, and made it safe.</h2>
        </div>
        <div className="l-warn frame">
          <blockquote>
            “Validation code must therefore bind its approval to the entire set of frames it is willing to authorize.”
            <cite>EIP-8141, Security Considerations</cite>
          </blockquote>
          <ol className="l-frames">
            {FRAMES.map((f, i) => (
              <li key={i}><span className={`m m-${f.m.toLowerCase()}`}>{f.m}</span><span className="who">{f.who}</span><span className="what mono">{f.what}</span></li>
            ))}
          </ol>
          <div className="l-attacks">
            <h3>Tampered fills, refused before a block</h3>
            <ul>
              {REFUSED.map((r) => <li key={r.code}><span>{r.attack}</span><code>{r.code}</code></li>)}
            </ul>
          </div>
        </div>
      </section>

      <section className="l-sec" id="proof">
        <div className="l-head">
          <span className="eyebrow">Proof on chain</span>
          <h2>Every claim on this page is a transaction you can open.</h2>
        </div>
        <div className="frame l-proof">
          {PROOF.map((p) => (
            <a key={p.hash} className="l-proof-row" href={tx(p.hash)} target="_blank" rel="noreferrer">
              <span className="what">{p.what}</span>
              <span className={`res ${p.tone}`}>{p.result}</span>
              <span className="mono h">{short(p.hash, 10)}</span>
            </a>
          ))}
        </div>
      </section>

      <section className="l-sec" id="sdk">
        <div className="l-head">
          <span className="eyebrow">@kabuto/sdk</span>
          <h2>Any DEX or wallet can offer both, in a few lines.</h2>
        </div>
        <pre className="frame l-code"><code>{SDK}</code></pre>
      </section>

      <section className="l-sec l-faq">
        <div className="l-head"><span className="eyebrow">Questions</span><h2>Straight answers.</h2></div>
        <div>
          {FAQ.map((f, i) => (
            <div className={`qa ${faq === i ? "open" : ""}`} key={f.q}>
              <button aria-expanded={faq === i} onClick={() => setFaq(faq === i ? null : i)}>{f.q}<span aria-hidden>{faq === i ? "−" : "+"}</span></button>
              {faq === i && <p>{f.a}</p>}
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
