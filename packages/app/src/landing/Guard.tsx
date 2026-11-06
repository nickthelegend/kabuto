import { D } from "../lib/config";
import { EVIDENCE, GUARD } from "./evidence";

const tx = (h: string) => `${D.explorer}tx/${h}`;
const short = (h: string, a = 8, b = 4) => `${h.slice(0, a)}…${h.slice(-b)}`;

/** KabutoGuard: the Uniswap v4 hook that only admits price-pinned frame transactions. Every line links to its proof. */
export function Guard() {
  return (
    <section className="ln-guard ln-wrap" id="guard" aria-labelledby="ln-guard-h">
      <span className="ln-tag ln-head">Uniswap v4 hook · live on chain 1337</span>
      <h2 className="ln-h2 ln-head" id="ln-guard-h">KabutoGuard.<br /><em>A pool bots can't trade.</em></h2>
      <div className="ln-guard-top">
        <div>
          <p className="ln-guard-p">Its <code>beforeSwap</code> reads the transaction it runs in. No frame transaction with this pool's price pinned in an earlier VERIFY frame: no swap. A sandwich bot's plain transaction reverts.</p>
        </div>
        <div className="ln-gate" role="list" aria-label="Two real swaps against the guarded pool">
          <a role="listitem" className="ln-gate-row no" href={tx(GUARD.plainSwap)} target="_blank" rel="noreferrer">
            <span className="k">Plain transaction<small>what a sandwich bot sends</small></span>
            <span className="arrow" aria-hidden />
            <span className="v"><b>Reverted</b><small className="mono">NotFrameTx() · {short(GUARD.plainSwap)} ↗</small></span>
          </a>
          <a role="listitem" className="ln-gate-row yes" href={tx(GUARD.pinnedSwap)} target="_blank" rel="noreferrer">
            <span className="k">Frame transaction<small>VERIFY pins the price, then swaps</small></span>
            <span className="arrow" aria-hidden />
            <span className="v"><b>Traded</b><small className="mono">OnChain · {short(GUARD.pinnedSwap)} ↗</small></span>
          </a>
        </div>
      </div>
      <div className="ln-guard-grid">
        <a href={EVIDENCE.guardFrameCheck} target="_blank" rel="noreferrer"><span className="ln-tag">01 · type 6 only</span><b>Plain transactions revert</b><p>Legacy and 1559 transactions can't swap here at all: <code>NotFrameTx()</code>.</p><small>KabutoGuardHook.sol ↗</small></a>
        <a href={EVIDENCE.guardSource} target="_blank" rel="noreferrer"><span className="ln-tag">02 · the pin is checked</span><b>This pool, this sender, earlier</b><p>The VERIFY frame must have succeeded, before the swap, for this pool: else <code>NoPricePin()</code>.</p><small>beforeSwap ↗</small></a>
        <a href={EVIDENCE.guardBand} target="_blank" rel="noreferrer"><span className="ln-tag">03 · band ≤ {GUARD.maxBandPct}%</span><b>No loose pins</b><p>A pin wider than {GUARD.maxBandPct}% is refused with <code>BandTooWide()</code>, so every swap is tightly pinned.</p><small>band check ↗</small></a>
      </div>
      <div className="ln-guard-facts">
        <a href={`${D.explorer}address/${GUARD.hook}`} target="_blank" rel="noreferrer"><small>Hook</small><span className="mono">{short(GUARD.hook, 10, 6)} ↗</span></a>
        <a href={EVIDENCE.guardTests} target="_blank" rel="noreferrer"><small>Foundry</small><span>{GUARD.tests} tests ↗</span></a>
        <a href={EVIDENCE.guardReadme} target="_blank" rel="noreferrer"><small>How it works</small><span>README ↗</span></a>
      </div>
    </section>
  );
}
