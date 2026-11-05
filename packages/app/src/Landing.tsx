import { useEffect, useRef, useState } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useGSAP } from "@gsap/react";
import { D } from "./lib/config";
import { pub } from "./lib/chain";
import { priceFromSqrt, sqrtPrice } from "./lib/market";
import { PROOF, REPLAY } from "./lib/proof";
import "./landing.css";

gsap.registerPlugin(ScrollTrigger, useGSAP);

const short = (h: string, n = 8) => `${h.slice(0, n)}…${h.slice(-4)}`;
const tx = (h: string) => `${D.explorer}tx/${h}`;
const stoppedPct = Math.round((REPLAY.stopped / REPLAY.evaluated) * 100);

const STEPS = [
  { img: "/step-1-pin.jpg", n: "01", t: "Your swap carries its own price." },
  { img: "/step-2-raider.jpg", n: "02", t: "A bot buys in front of you." },
  { img: "/step-3-vanish.jpg", video: "/step-3-vanish.mp4", n: "03", t: "Your swap stops existing. 0 gas." },
  { img: "/step-4-lanterns.jpg", n: "04", t: "Or post an intent. Fillers race and pay the gas." },
];

const SDK_LINES: [string, string][] = [
  ["k", `import { createKabuto, p256Signer, devnet1337 } from "@kabuto/sdk";`],
  ["", ``],
  ["", `const kabuto = createKabuto({ deployment: devnet1337 });`],
  ["c", `// sandwiched = never included, costs 0`],
  ["", `await kabuto.protectedSwap({ account, signer, zeroForOne, amountIn, bandBps: 50 });`],
  ["c", `// or sign only an intent and let anyone fill it`],
  ["", `const intent = await kabuto.signIntent({ account, signer, tokenIn, maxIn, tokenOut, startOut, endOut, deadline });`],
];

function useLivePrice() {
  const [p, setP] = useState<{ block: bigint; price: number } | null>(null);
  useEffect(() => {
    let alive = true;
    const tick = async () => { try { const [b, s] = await Promise.all([pub.getBlockNumber(), sqrtPrice()]); if (alive) setP({ block: b, price: priceFromSqrt(s) }); } catch { /* offline */ } };
    tick(); const t = setInterval(tick, 3000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  return p;
}

export function Landing() {
  const root = useRef<HTMLDivElement>(null);
  const live = useLivePrice();

  useGSAP(() => {
    const mm = gsap.matchMedia();
    mm.add({ motion: "(prefers-reduced-motion: no-preference)", wide: "(min-width: 900px)" }, (ctx) => {
      const { motion, wide } = ctx.conditions as { motion: boolean; wide: boolean };
      if (!motion) return;

      /* hero: words rise, widgets land, then float */
      const intro = gsap.timeline({ defaults: { ease: "power4.out" } });
      intro
        .from(".ln-eyebrow", { y: 16, opacity: 0, duration: 0.7 })
        .from(".ln-h1 .w > span", { yPercent: 110, duration: 1.1, stagger: 0.06 }, "-=0.4")
        .from(".ln-ctas > *", { y: 20, opacity: 0, duration: 0.7, stagger: 0.08 }, "-=0.7")
        .from(".ln-swap", { y: 80, opacity: 0, scale: 0.94, duration: 1.2 }, "-=0.6")
        .from(".ln-chip.bad", { x: -60, opacity: 0, duration: 1 }, "-=0.9")
        .from(".ln-chip.good", { x: 60, opacity: 0, duration: 1 }, "<");
      gsap.to(".ln-chip.bad", { y: -10, duration: 2.6, ease: "sine.inOut", yoyo: true, repeat: -1, delay: 1.8 });
      gsap.to(".ln-chip.good", { y: 10, duration: 3, ease: "sine.inOut", yoyo: true, repeat: -1, delay: 1.8 });

      /* hero video: slow push-in while scrolling away, content drifts up */
      gsap.to(".ln-hero-media", { scale: 1.18, yPercent: 12, ease: "none", scrollTrigger: { trigger: ".ln-hero", start: "top top", end: "bottom top", scrub: true } });
      gsap.to(".ln-hero-copy", { yPercent: -30, opacity: 0.2, ease: "none", scrollTrigger: { trigger: ".ln-hero", start: "top top", end: "bottom top", scrub: true } });
      gsap.to(".ln-widgets", { yPercent: -12, ease: "none", scrollTrigger: { trigger: ".ln-hero", start: "center center", end: "bottom top", scrub: true } });

      /* numbers count up */
      gsap.utils.toArray<HTMLElement>(".ln-count").forEach((el) => {
        const to = Number(el.dataset.to);
        const o = { v: 0 };
        gsap.to(o, { v: to, duration: 1.6, ease: "power2.out", scrollTrigger: { trigger: el, start: "top 85%", once: true }, onUpdate: () => { el.textContent = Math.round(o.v).toLocaleString("en-US"); } });
      });
      gsap.from(".ln-stat", { y: 40, opacity: 0, stagger: 0.12, duration: 0.9, ease: "power3.out", scrollTrigger: { trigger: ".ln-stats", start: "top 80%" } });

      /* what the bot sees: pinned, scrubbed story */
      const story = gsap.timeline({ scrollTrigger: { trigger: ".ln-bot", start: wide ? "top top" : "top 20%", end: wide ? "+=1400" : "+=700", scrub: 0.6, pin: wide } });
      story
        .from(".ln-bot .ln-col", { y: 60, opacity: 0, stagger: 0.15, duration: 1 })
        .from(".ln-row.r0", { x: -30, opacity: 0, stagger: 0.1, duration: 0.6 })
        .from(".ln-row.r1", { x: -30, opacity: 0, stagger: 0.1, duration: 0.6 })
        .to(".ln-row.gone", { borderColor: "rgba(166,228,191,.55)", backgroundColor: "rgba(166,228,191,.06)", duration: 0.4 })
        .to(".ln-row.gone .lbl", { opacity: 0.35, duration: 0.5 }, "<")
        .from(".ln-row.gone .v", { opacity: 0, scale: 0.6, duration: 0.5 }, "<")
        .from(".ln-row.r2", { x: -30, opacity: 0, stagger: 0.1, duration: 0.6 })
        .from(".ln-res", { y: 30, opacity: 0, scale: 0.96, stagger: 0.15, duration: 0.8 });

      /* four steps: pinned horizontal track on desktop, stacked reveal on phones */
      if (wide) {
        const track = document.querySelector<HTMLElement>(".ln-track")!;
        const move = gsap.to(track, { x: () => -(track.scrollWidth - window.innerWidth + 80), ease: "none", scrollTrigger: { trigger: ".ln-steps", start: "top top", end: () => "+=" + (track.scrollWidth - window.innerWidth + 80), scrub: 0.8, pin: true, invalidateOnRefresh: true } });
        gsap.utils.toArray<HTMLElement>(".ln-step").forEach((s) => {
          gsap.fromTo(s.querySelector(".ln-step-media"), { scale: 1.25 }, { scale: 1, ease: "none", scrollTrigger: { trigger: s, containerAnimation: move, start: "left right", end: "right left", scrub: true } });
          gsap.from(s.querySelector(".ln-step-cap"), { y: 40, opacity: 0, duration: 0.8, ease: "power3.out", scrollTrigger: { trigger: s, containerAnimation: move, start: "left 75%", toggleActions: "play none none reverse" } });
        });
      } else {
        ScrollTrigger.batch(".ln-step", { start: "top 85%", onEnter: (els) => gsap.from(els, { y: 50, opacity: 0, stagger: 0.12, duration: 0.8, ease: "power3.out" }) });
      }

      /* proof rows + sdk lines */
      ScrollTrigger.batch(".ln-proof li", { start: "top 90%", onEnter: (els) => gsap.from(els, { y: 24, opacity: 0, stagger: 0.06, duration: 0.6, ease: "power3.out" }) });
      gsap.from(".ln-code .ln", { opacity: 0, x: -14, stagger: 0.12, duration: 0.5, ease: "power2.out", scrollTrigger: { trigger: ".ln-code", start: "top 75%" } });
      gsap.from(".ln-head", { y: 40, opacity: 0, duration: 1, ease: "power3.out", stagger: 0.1, scrollTrigger: { trigger: ".ln-head", start: "top 85%" } });
      gsap.fromTo(".ln-end-glow", { scale: 0.6, opacity: 0 }, { scale: 1, opacity: 1, ease: "none", scrollTrigger: { trigger: ".ln-end", start: "top bottom", end: "center center", scrub: true } });
    });
    const refresh = () => ScrollTrigger.refresh();
    window.addEventListener("load", refresh);
    document.fonts?.ready.then(refresh);
    return () => window.removeEventListener("load", refresh);
  }, { scope: root });

  const words = (s: string) => s.split(" ").map((w, i) => <span className="w" key={i}><span>{w}</span></span>);

  return (
    <div className="ln" ref={root}>
      <nav className="ln-nav">
        <a className="ln-wm" href="#/">Kabuto</a>
        <div className="ln-links"><a href="#how">How it works</a><a href="#sdk">SDK</a><a href="#proof">Proof</a></div>
        <a className="ln-cta" href="#/app">Launch app</a>
      </nav>

      <header className="ln-hero">
        <div className="ln-hero-media" aria-hidden>
          <video src="/hero.mp4" poster="/hero.jpg" autoPlay muted loop playsInline />
        </div>
        <div className="ln-hero-shade" aria-hidden />
        <div className="ln-hero-copy">
          <span className="ln-eyebrow"><i />Live on the EIP-8141 devnet · Uniswap v4{live ? ` · block ${live.block.toLocaleString("en-US")}` : ""}</span>
          <h1 className="ln-h1">{words("Swap at your price.")}<br /><em>{words("Or not at all.")}</em></h1>
          <div className="ln-ctas"><a className="ln-btn g" href="#/app">Launch app</a><a className="ln-btn l" href="#bot">See the sandwich</a></div>
        </div>
        <div className="ln-widgets">
          <div className="ln-chip bad"><small>Ordinary wallet</small><b>Sandwiched · −1.80%</b><span>front · you · back, one block</span></div>
          <div className="ln-swap" aria-hidden>
            <div className="ln-swap-h"><b>Swap</b><span>Uniswap v4</span></div>
            <div className="ln-bx"><small>You pay</small><div><b>1,500</b><span className="ln-tk"><i />kUSD</span></div></div>
            <div className="ln-bx"><small>You receive</small><div><b>{live ? (1500 / live.price).toFixed(4) : "…"}</b><span className="ln-tk w"><i />WETH</span></div></div>
            <div className="ln-pr"><i className="sh" />Sandwich protection<i className="t" /></div>
            <div className="ln-go">Swap</div>
          </div>
          <div className="ln-chip good"><small>Kabuto</small><b>Sandwich blocked</b><span>never included · 0 gas</span></div>
        </div>
      </header>

      <section className="ln-stats">
        <div className="ln-stat"><b><span className="ln-count" data-to={REPLAY.uniqueVictims}>{REPLAY.uniqueVictims}</span></b><span>swaps sandwiched on Uniswap v4 mainnet in {REPLAY.hours} hours</span></div>
        <div className="ln-stat"><b className="g"><span className="ln-count" data-to={stoppedPct}>{stoppedPct}</span>%</b><span>of them a ±{REPLAY.bandPct}% Kabuto pin would have stopped</span></div>
        <div className="ln-stat"><b><span className="ln-count" data-to={0}>0</span> gas</b><span>paid when a protected swap is blocked</span></div>
      </section>

      <section className="ln-bot" id="bot">
        <div className="ln-wrap">
          <span className="ln-tag ln-head">Same bot · real devnet runs</span>
          <h2 className="ln-h2 ln-head">What the bot sees.</h2>
          <div className="ln-cols">
            <div className="ln-col">
              <h3>Ordinary wallet <span>2% slippage</span></h3>
              <div className="ln-row bot r0"><span className="n">idx 0</span><span className="lbl">Bot buys first</span><span className="v">front-run</span></div>
              <div className="ln-row you r1"><span className="n">idx 1</span><span className="lbl">Your swap</span><span className="v">fills worse</span></div>
              <div className="ln-row bot r2"><span className="n">idx 2</span><span className="lbl">Bot sells into you</span><span className="v">back-run</span></div>
              <a className="ln-res bad" href={tx(PROOF[3].hash)} target="_blank" rel="noreferrer"><small>You lost</small><b>−1.80%</b></a>
            </div>
            <div className="ln-col">
              <h3>Kabuto <span>price pinned ±0.5%</span></h3>
              <div className="ln-row bot r0"><span className="n">idx 0</span><span className="lbl">Bot buys first</span><span className="v">front-run</span></div>
              <div className="ln-row gone r1"><span className="n">—</span><span className="lbl">Your swap</span><span className="v">never included</span></div>
              <div className="ln-row na r2"><span className="n">—</span><span className="lbl">Nothing to sell into</span><span className="v">bot holds −217 kUSD</span></div>
              <a className="ln-res good" href={tx(PROOF[4].hash)} target="_blank" rel="noreferrer"><small>You paid</small><b>0 gas</b></a>
            </div>
          </div>
        </div>
      </section>

      <section className="ln-steps" id="how">
        <div className="ln-steps-h"><span className="ln-tag">How it works</span><h2 className="ln-h2">Four frames.</h2></div>
        <div className="ln-track">
          {STEPS.map((s) => (
            <article className="ln-step" key={s.n}>
              <div className="ln-step-media">{s.video ? <video src={s.video} poster={s.img} autoPlay muted loop playsInline /> : <img src={s.img} alt="" />}</div>
              <div className="ln-step-cap"><span className="ln-tag">{s.n}</span><b>{s.t}</b></div>
            </article>
          ))}
        </div>
      </section>

      <section className="ln-sdk ln-wrap" id="sdk">
        <div><span className="ln-tag ln-head">@kabuto/sdk</span><h2 className="ln-h2 ln-head">Any wallet.<br />A few lines.</h2></div>
        <pre className="ln-code"><code>{SDK_LINES.map(([k, l], i) => <span className={`ln ${k}`} key={i}>{l || " "}</span>)}</code></pre>
      </section>

      <section className="ln-proof ln-wrap" id="proof">
        <span className="ln-tag ln-head">Proof on chain</span>
        <h2 className="ln-h2 ln-head">Every claim is a transaction.</h2>
        <ul>
          {PROOF.map((p) => (
            <li key={p.hash} data-tone={p.tone}>
              <span className="w">{p.what}</span><span className="r">{p.result}</span>
              <a href={tx(p.hash)} target="_blank" rel="noreferrer">{short(p.hash)} ↗</a>
            </li>
          ))}
        </ul>
      </section>

      <section className="ln-end ln-wrap">
        <div className="ln-end-glow" aria-hidden />
        <h2>Protect every swap.</h2>
        <a className="ln-btn g" href="#/app">Launch app</a>
      </section>

      <footer className="ln-foot ln-wrap">
        <span>Kabuto · EIP-8141 / ERC-8421 alt-mempool devnet (chain 1337) · Uniswap v4 · MIT</span>
        <span><a href={D.explorer} target="_blank" rel="noreferrer">Explorer</a></span>
      </footer>
    </div>
  );
}
