/**
 * AnalogDesk - equity-market sentiment, computed entirely from the COMMITTED dataset.
 *
 * The alternative.me Fear & Greed index is a CRYPTO market reading; using it as the mood of a US
 * equity (e.g. NVDA) is an asset-class mismatch. This module builds a genuinely equity sentiment
 * score from things the dataset already contains, so it is keyless and reproducible:
 *
 *   - internal breadth: the share of the equity universe (single names + equity ETFs) closing above
 *     its own 50- and 200-day moving averages;
 *   - the index trend: SPY's distance to its 50/200-DMA and its 20-session return;
 *   - volatility positioning: the percentile of the latest VIX over the trailing five years, inverted
 *     (a low VIX percentile is complacent/greedy; a high percentile is fearful).
 *
 * Each component maps to 0..100 and is combined with fixed, stated weights; nothing is a black box.
 * Pure (dataset in, object out) so it is unit-testable; scripts/collect-signals.mjs loads the dataset
 * and passes it in, and the result is baked into the static snapshot.
 */

/** Instruments that are not equities and would distort a stock-breadth count. */
export const NON_EQUITY_SYMBOLS = new Set(["GLD", "TLT", "UUP", "VIXY"]);

export function equityBand(v100) {
  if (v100 == null || !Number.isFinite(v100)) return "unknown";
  if (v100 <= 25) return "Extreme Fear";
  if (v100 <= 45) return "Fear";
  if (v100 <= 55) return "Neutral";
  if (v100 <= 75) return "Greed";
  return "Extreme Greed";
}

function sma(arr, endIdx, win) {
  let s = 0, n = 0;
  for (let i = endIdx - win + 1; i <= endIdx; i++) {
    const x = arr[i];
    if (Number.isFinite(x)) { s += x; n++; }
  }
  return n ? s / n : null;
}
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

export function computeEquitySentiment(dataset) {
  const dates = dataset.dates, prices = dataset.prices;
  const last = dates.length - 1;
  const syms = Object.keys(prices).filter((s) => !NON_EQUITY_SYMBOLS.has(s));

  // 1. Internal breadth.
  let a50 = 0, a200 = 0, n50 = 0, n200 = 0;
  for (const s of syms) {
    const c = prices[s].c, px = c[last];
    const s50 = sma(c, last, 50), s200 = sma(c, last, 200);
    if (s50 != null) { n50++; if (px > s50) a50++; }
    if (s200 != null) { n200++; if (px > s200) a200++; }
  }
  const breadth50 = 100 * a50 / (n50 || 1);
  const breadth200 = 100 * a200 / (n200 || 1);

  // 2. SPY trend.
  const spy = prices.SPY.c, px = spy[last];
  const spyS50 = sma(spy, last, 50), spyS200 = sma(spy, last, 200);
  const ret = (w) => (last - w >= 0 && spy[last - w]) ? 100 * (px / spy[last - w] - 1) : null;
  const ret20 = ret(20), ret125 = ret(125), ret250 = ret(250);
  const dist50 = 100 * (px / spyS50 - 1), dist200 = 100 * (px / spyS200 - 1);

  // 3. VIX percentile, aligned to the latest library date.
  const vixM = dataset.macro.VIXCLS;
  let vixLast = null, vixIdx = -1;
  for (let i = vixM.d.length - 1; i >= 0; i--) {
    if (vixM.d[i] <= dates[last]) { vixLast = vixM.v[i]; vixIdx = i; break; }
  }
  const winV = vixM.v.slice(Math.max(0, vixIdx - 1249), vixIdx + 1).filter(Number.isFinite);
  const sorted = [...winV].sort((a, b) => a - b);
  const rAt = sorted.findIndex((x) => x >= vixLast);
  const pct = rAt < 0 ? 100 : 100 * rAt / (sorted.length - 1 || 1);
  let vs = 0, vn = 0;
  for (let i = vixIdx - 49; i <= vixIdx; i++) { const x = vixM.v[i]; if (Number.isFinite(x)) { vs += x; vn++; } }
  const vixMean50 = vn ? vs / vn : null;

  // Component scores (0..100).
  const vixScore = 100 - pct;
  const ret20Score = clamp(50 + (ret20 || 0) * 8, 0, 100);
  const trendScore = (clamp(50 + dist50 * 5, 0, 100) + clamp(50 + dist200 * 3, 0, 100)) / 2;

  // Fixed weights: breadth50 25, breadth200 20, VIX 20, SPY-return 15, SPY-trend 20.
  const score = breadth50 * 0.25 + breadth200 * 0.20 + vixScore * 0.20 + ret20Score * 0.15 + trendScore * 0.20;

  const components = [
    { key: "breadth50", label: "Breadth: % above 50-DMA", value: Number(breadth50.toFixed(1)), score: Number(breadth50.toFixed(1)), weight: 25 },
    { key: "breadth200", label: "Breadth: % above 200-DMA", value: Number(breadth200.toFixed(1)), score: Number(breadth200.toFixed(1)), weight: 20 },
    { key: "vix", label: "VIX inverted 5y percentile", value: Number(vixLast?.toFixed(2)), score: Number(vixScore.toFixed(1)), weight: 20,
      extra: `VIX ${vixLast?.toFixed(2)}, ${pct.toFixed(0)}th pct; 50d mean ${vixMean50?.toFixed(2)}` },
    { key: "spyRet20", label: "SPY 20-session return", value: Number(ret20?.toFixed(2)), score: Number(ret20Score.toFixed(1)), weight: 15, suffix: "%" },
    { key: "spyTrend", label: "SPY vs 50/200-DMA trend", value: Number(dist200.toFixed(2)), score: Number(trendScore.toFixed(1)), weight: 20,
      extra: `vs50 ${dist50.toFixed(2)}%, vs200 ${dist200.toFixed(2)}%; 6m ${ret125?.toFixed(1)}%, 12m ${ret250?.toFixed(1)}%` }
  ];

  return {
    kind: "equity",
    source: "engine-computed from the committed dataset (keyless, reproducible)",
    asOf: dates[last],
    score: Number(score.toFixed(1)),
    band: equityBand(score),
    components
  };
}
