/**
 * AnalogDesk - outcome distribution + conformal calibration.
 * Isomorphic (Node + browser), zero dependencies.
 *
 * The analog engine returns a SAMPLE of historical forward returns. A sample is not a forecast, so
 * we do two things with it:
 *
 *  1. describe it (quantiles, tail probabilities, max adverse excursion) - this is what the desk
 *     shows a trader;
 *  2. calibrate it. Raw analog percentiles are systematically over-confident, because 50 neighbors
 *     drawn from a similar regime under-represent the regimes that broke it. We therefore fit ONE
 *     global multiplier on the analog standard deviation with split conformal prediction on a
 *     calibration era, and never touch it again on the test era.
 *
 * Conformal score for a realised outcome y given analog median m and analog sd s:
 *     score = |y - m| / s
 * The scale is the finite-sample-corrected empirical quantile of the calibration scores at the
 * target coverage. The resulting interval m +/- scale * s has the target marginal coverage under
 * exchangeability, WITHOUT any distributional assumption. Coverage is then measured on a strictly
 * later era, and compared against a same-name unconditional percentile band at the same coverage.
 */

/**
 * Linear-interpolation empirical quantile. `sorted` must already be ascending.
 * Lives here (not in analog.mjs) so the dependency graph stays analog -> nothing, distribution ->
 * nothing, stress/validation -> distribution: no cycles, and the browser bundle can tree-shake.
 */
export function quantile(sorted, p) {
  const n = sorted.length;
  if (!n) return NaN;
  if (n === 1) return sorted[0];
  const h = (n - 1) * p, lo = Math.floor(h), hi = Math.ceil(h);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (h - lo);
}

export const DEFAULT_COVERAGE = 0.8;

/**
 * Standard normal CDF via the Abramowitz-Stegun 7.1.26 erf approximation (|error| < 1.5e-7).
 * The path-risk benchmark needs Phi(-x) and this repo ships no dependencies, so the twelve lines
 * live here rather than arriving in a package. It is also deterministic to the last bit, which
 * matters because research/validation-results.json is regenerated and diffed.
 */
export function normalCdf(x) {
  const z = Number(x);
  if (!Number.isFinite(z)) return NaN;
  const t = 1 / (1 + 0.3275911 * (Math.abs(z) / Math.SQRT2));
  const poly = ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  const erfMag = 1 - poly * Math.exp(-(z * z) / 2);   // erf(|z|/sqrt 2); the 1 - IS the identity
  return 0.5 * (1 + (z >= 0 ? erfMag : -erfMag));
}

const clean = (arr) => (arr || []).filter((x) => x != null && Number.isFinite(x)).map(Number);
export const pct = (x, dp = 2) => (x == null || !Number.isFinite(x) ? null : Number((x * 100).toFixed(dp)));

export function moments(values) {
  const v = clean(values), n = v.length;
  if (!n) return { n: 0, mean: NaN, sd: NaN, skew: NaN, kurt: NaN };
  let s = 0; for (const x of v) s += x;
  const mean = s / n;
  let m2 = 0, m3 = 0, m4 = 0;
  for (const x of v) { const d = x - mean; m2 += d * d; m3 += d * d * d; m4 += d * d * d * d; }
  const varr = n > 1 ? m2 / (n - 1) : NaN;
  const sd = varr > 0 ? Math.sqrt(varr) : NaN;
  const pop2 = m2 / n;
  return {
    n, mean, sd,
    skew: sd > 0 && n > 2 ? (m3 / n) / Math.pow(pop2 || 1, 1.5) : NaN,
    kurt: pop2 > 0 && n > 3 ? (m4 / n) / (pop2 * pop2) - 3 : NaN
  };
}

/**
 * Full description of one analog outcome sample. Returns are fractions; the `*Pct` fields are the
 * same numbers in percentage points so the UI never has to guess a unit.
 */
export function summarize(values, { thresholds = [-0.20, -0.10, -0.05, 0, 0.05, 0.10], mae = null, mfe = null } = {}) {
  const v = clean(values).sort((a, b) => a - b);
  const n = v.length;
  if (!n) return { n: 0 };
  const mo = moments(v);
  const q = (p) => quantile(v, p);
  const out = {
    n,
    mean: mo.mean, median: q(0.5), sd: mo.sd, skew: mo.skew, kurt: mo.kurt,
    min: v[0], max: v[n - 1],
    p05: q(0.05), p10: q(0.10), p25: q(0.25), p50: q(0.50), p75: q(0.75), p90: q(0.90), p95: q(0.95),
    iqr: q(0.75) - q(0.25),
    prob: Object.fromEntries(thresholds.map((t) => [String(t), v.filter((x) => (t === 0 ? x > 0 : x < t)).length / n]))
  };
  out.width80Empirical = q(0.90) - q(0.10);
  out.var90 = -q(0.10);
  const tail = v.filter((x) => x <= q(0.10));
  out.cvar90 = tail.length ? -tail.reduce((a, b) => a + b, 0) / tail.length : NaN;
  if (mae) {
    const a = clean(mae).sort((x, y) => x - y);
    out.mae = { n: a.length, median: quantile(a, 0.5), p10: quantile(a, 0.10), p25: quantile(a, 0.25),
      breach: Object.fromEntries([0.05, 0.10, 0.15, 0.20].map((t) => [String(t), a.filter((x) => x < -t).length / (a.length || 1)])) };
  }
  if (mfe) {
    const f = clean(mfe).sort((x, y) => x - y);
    out.mfe = { n: f.length, median: quantile(f, 0.5), p75: quantile(f, 0.75), p90: quantile(f, 0.90) };
  }
  return out;
}

/** Equal-width histogram for the UI, plus the empirical CDF breakpoints. */
export function histogram(values, bins = 28) {
  const v = clean(values);
  if (!v.length) return { bins: [], lo: 0, hi: 0, step: 0 };
  let lo = Math.min(...v), hi = Math.max(...v);
  if (hi === lo) { hi = lo + 1e-6; }
  const step = (hi - lo) / bins;
  const counts = new Array(bins).fill(0);
  for (const x of v) { let b = Math.floor((x - lo) / step); if (b >= bins) b = bins - 1; if (b < 0) b = 0; counts[b]++; }
  return {
    lo, hi, step, bins: counts.map((c, i) => ({ x0: lo + i * step, x1: lo + (i + 1) * step, mid: lo + (i + 0.5) * step, c, p: c / v.length }))
  };
}

/**
 * Split-conformal scale. `scores` are |y - median| / sd over the CALIBRATION era only.
 * Finite-sample correction: use the ceil((n+1)*target)/n empirical quantile, clipped to [0,1].
 */
export function conformalScale(scores, target = DEFAULT_COVERAGE) {
  const s = clean(scores).sort((a, b) => a - b);
  const n = s.length;
  if (!n) return { scale: NaN, n: 0, target };
  const level = Math.min(1, Math.ceil((n + 1) * target) / n);
  return { scale: quantile(s, level), n, target, level };
}

export function band(median, sd, scale) {
  if (!Number.isFinite(median) || !Number.isFinite(sd) || !Number.isFinite(scale)) return null;
  const half = scale * sd;
  return { lo: median - half, hi: median + half, width: 2 * half, half };
}

export function contains(b, y) {
  return !!b && Number.isFinite(y) && y >= b.lo && y <= b.hi;
}

/**
 * Same-name unconditional benchmark: the central `target` interval of every H-session forward
 * return the symbol realised strictly before the query session. Point-in-time by construction.
 */
export function unconditionalBand(priceA, q, H, nDates, target = DEFAULT_COVERAGE) {
  const v = [];
  for (let j = 0; j + H <= q; j++) {
    const a = priceA[j], b = priceA[j + H];
    if (Number.isFinite(a) && a > 0 && Number.isFinite(b) && b > 0) v.push(b / a - 1);
  }
  if (v.length < 30) return null;
  v.sort((a, b) => a - b);
  const tail = (1 - target) / 2;
  const lo = quantile(v, tail), hi = quantile(v, 1 - tail);
  return { lo, hi, width: hi - lo, n: v.length, median: quantile(v, 0.5), sd: moments(v).sd, target };
}

/** Median-centred unconditional band: the fair like-for-like comparator for the conformal band. */
export function unconditionalBandCentred(priceA, q, H, nDates, target = DEFAULT_COVERAGE) {
  const b = unconditionalBand(priceA, q, H, nDates, target);
  if (!b) return null;
  const med = b.median;
  return { ...b, lo: med - b.width / 2, hi: med + b.width / 2, centred: true };
}

/** Coverage + average width of a set of scored intervals. */
export function scoreIntervals(rows) {
  const ok = rows.filter((r) => r.band && Number.isFinite(r.y));
  const n = ok.length;
  if (!n) return { n: 0 };
  let hit = 0, width = 0, signed = 0;
  for (const r of ok) {
    if (contains(r.band, r.y)) hit++;
    width += r.band.width;
    signed += r.y - (r.band.lo + r.band.hi) / 2;
  }
  return {
    n, coverage: hit / n, width: width / n,
    widthPct: pct(width / n), bias: signed / n,
    above: ok.filter((r) => r.y > r.band.hi).length / n,
    below: ok.filter((r) => r.y < r.band.lo).length / n
  };
}

/**
 * Reliability table: bucket queries by where the realised outcome landed in the predictive
 * distribution, and compare the empirical frequency against the nominal one.
 */
export function reliability(rows, levels = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]) {
  const ok = rows.filter((r) => r.band && Number.isFinite(r.y) && r.band.width > 0);
  const n = ok.length;
  if (!n) return [];
  return levels.map((lv) => {
    let hit = 0;
    for (const r of ok) {
      const c = (r.band.lo + r.band.hi) / 2, hw = (r.band.hi - r.band.lo) / 2;
      if (hw > 0 && Math.abs(r.y - c) <= hw * lv) hit++;
    }
    return { level: lv, nominal: lv, empirical: hit / n, n };
  });
}