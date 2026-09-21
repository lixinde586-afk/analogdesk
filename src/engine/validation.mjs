/**
 * AnalogDesk - out-of-sample validation harness.
 * Isomorphic (Node + browser), zero dependencies.
 *
 * PROTOCOL (fixed before any test-era number was inspected)
 * ---------------------------------------------------------
 *   calibration era : 2019-01-01 .. 2022-12-31
 *   test era        : 2023-01-01 .. last session in the library
 *   horizon H       : forward return over H trading sessions on the ADJUSTED close
 *   query grid      : every Nth session x every symbol with a valid feature row, N fixed per era
 *
 * For a query (symbol, session q) the realised outcome is y = A[q+H]/A[q] - 1. Candidates are
 * embargoed to j + H <= q, so no analog return in any band was still in the future when the
 * "decision" was made.
 *
 * PREDICTORS - all five are fitted on the calibration era only, then frozen.
 *   analogConformal : median +/- scale * sd of the k analog H-session returns. `scale` is the
 *                     finite-sample-corrected conformal quantile of |y - median| / sd over the
 *                     calibration era. This is the product's headline interval.
 *   analogRaw       : [p10, p90] of the same analog sample, no conformal multiplier. Isolates what
 *                     the calibration step buys.
 *   uncondNamePIT   : central 80% interval of every H-session return the SAME symbol realised
 *                     strictly before q. No features, no retrieval - the naive incumbent.
 *   volHarness      : 0 +/- scale * sigma_H, sigma_H = trailing 60-session daily log-return vol
 *                     scaled by sqrt(H). The standard volatility-timing benchmark; it conditions on
 *                     the current regime but knows nothing about cross-asset or event state.
 *   pooledUncond    : central 80% interval of every H-session return realised by ANY symbol up to
 *                     the end of the calibration era. The floor - one number for the whole desk.
 *
 * REPORTING
 *   pre-registered : coverage and mean width with the frozen calibration-era fit (deployable).
 *   matched        : every predictor re-scaled by a single multiplier so its test-era coverage hits
 *                    the target, then widths compared. Ranking device only - it peeks at the test
 *                    era, so it is never presented as a deployable interval.
 *   uncertainty    : coverage standard errors are clustered by QUERY DATE, not by observation.
 *                    Adjacent symbols on one session share the same market shock, so iid standard
 *                    errors would understate the uncertainty by roughly sqrt(71).
 *   conditioning   : coverage and width by realised-vol tercile, by year and by sector, plus PIT
 *                    uniformity. An interval that averages 80% by being 95% in calm tape and 60%
 *                    in stressed tape is worse than useless for a stress-testing desk.
 */

import { summarize, conformalScale, band, contains, quantile, scoreIntervals, reliability, pct } from "./distribution.mjs";
import { FIDX, NF } from "./features.mjs";

export const ERAS = {
  calibration: { from: "2019-01-01", to: "2022-12-31" },
  test: { from: "2023-01-01", to: null }
};

export const PREDICTORS = ["analogConformal", "analogRaw", "uncondNamePIT", "volHarness", "pooledUncond"];

export const VALIDATION_DEFAULTS = {
  horizon: 5,
  k: 50,
  coverage: 0.8,
  strideCalib: 40,
  strideTest: 25,
  symbols: null,
  volLookback: 60,
  maxQueries: 0
};

/* ------------------------------- helpers -------------------------------- */

const finite = (x) => x != null && Number.isFinite(x);
const mean = (v) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN);
const pearson = (x, y) => {
  const n = Math.min(x.length, y.length);
  if (n < 3) return NaN;
  const mx2 = mean(x), my = mean(y);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { num += (x[i] - mx2) * (y[i] - my); dx += (x[i] - mx2) ** 2; dy += (y[i] - my) ** 2; }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : NaN;
};
const sd = (v) => {
  const n = v.length; if (n < 2) return NaN;
  const m = v.reduce((a, b) => a + b, 0) / n;
  const s = v.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1);
  return s > 0 ? Math.sqrt(s) : NaN;
};

function sessionsIn(mx, from, to) {
  const out = [];
  for (let i = 0; i < mx.nDates; i++) {
    const d = mx.dates[i];
    if (from && d < from) continue;
    if (to && d > to) continue;
    out.push(i);
  }
  return out;
}

export function queryGrid(engine, { era, stride, symbols, maxQueries = 0 }) {
  const { mx } = engine;
  const w = ERAS[era];
  if (!w) throw new Error(`unknown era: ${era}`);
  const H = engine.C.horizon;
  const days = sessionsIn(mx, w.from, w.to).filter((i, n) => n % stride === 0 && i + H < mx.nDates && i >= engine.C.minHistory);
  const list = symbols?.length ? symbols.map((s) => mx.syms.indexOf(s)).filter((i) => i >= 0) : mx.syms.map((_, i) => i);
  const grid = [];
  for (const q of days) for (const sq of list) {
    if (maxQueries && grid.length >= maxQueries) return grid;
    if (mx.valid[sq * mx.nDates + q]) grid.push({ sq, q });
  }
  return grid;
}

/** Trailing daily log-return volatility over `look` sessions ending at q, inclusive. */
export function trailingVol(mx, sq, q, look = 60) {
  const b = sq * mx.nDates, r = [];
  for (let j = Math.max(1, q - look + 1); j <= q; j++) {
    const a = mx.priceA[b + j - 1], c = mx.priceA[b + j];
    if (a > 0 && finite(c)) r.push(Math.log(c / a));
  }
  return r.length >= 20 ? sd(r) : NaN;
}

/** Same-name point-in-time central-`target` interval from every H-session return realised before q. */
export function uncondNamePIT(mx, sq, q, H, target = 0.8) {
  const b = sq * mx.nDates, v = [];
  for (let j = 0; j + H <= q; j++) {
    const a = mx.priceA[b + j], c = mx.priceA[b + j + H];
    if (a > 0 && finite(c) && c > 0) v.push(c / a - 1);
  }
  if (v.length < 30) return null;
  v.sort((x, y) => x - y);
  const t = (1 - target) / 2;
  const lo = quantile(v, t), hi = quantile(v, 1 - t);
  return { lo, hi, width: hi - lo, centre: quantile(v, 0.5), half: (hi - lo) / 2, n: v.length };
}

/** One central-`target` interval pooled over every symbol, using data up to `qCut` only. */
export function pooledUncondBand(mx, H, qCut, target = 0.8, maxIdx = 400000) {
  const v = [];
  const step = Math.max(1, Math.ceil((mx.nSym * qCut) / maxIdx));
  let c = 0;
  for (let si = 0; si < mx.nSym && v.length < maxIdx; si++) {
    const b = si * mx.nDates;
    for (let j = 0; j + H <= qCut; j += step) {
      const a = mx.priceA[b + j], x = mx.priceA[b + j + H];
      if (a > 0 && finite(x) && x > 0) { v.push(x / a - 1); if (++c % 4 === 0 && v.length >= maxIdx) break; }
    }
  }
  if (v.length < 100) return null;
  v.sort((p, q) => p - q);
  const t = (1 - target) / 2;
  const lo = quantile(v, t), hi = quantile(v, 1 - t);
  return { lo, hi, width: hi - lo, centre: quantile(v, 0.5), half: (hi - lo) / 2, n: v.length };
}

/**
 * Evaluate one query. Returns each predictor's centre and UNSCALED half-width, plus the diagnostics
 * (PIT, realised vol, sector) the breakdowns need. Returns null when the query cannot be scored.
 */
export function probe(engine, sq, q, C) {
  const { mx } = engine;
  const H = C.horizon;
  const nDates = mx.nDates;
  const b = sq * nDates;
  const p0 = mx.priceA[b + q], p1 = mx.priceA[b + q + H];
  if (!(p0 > 0) || !finite(p1) || !(p1 > 0)) return null;
  const y = p1 / p0 - 1;

  let res;
  const t0 = Date.now();
  try { res = engine.query({ sq, q, horizon: H, k: C.k }); } catch { return null; }
  const ms = Date.now() - t0;

  const rets = res.analogs.map((a) => a.fwd?.[H]).filter((x) => finite(x));
  if (rets.length < 10) return null;
  const s = summarize(rets, {});
  const sorted = [...rets].sort((a, c) => a - c);
  const pit = sorted.filter((x) => x <= y).length / sorted.length;

  const dv = trailingVol(mx, sq, q, C.volLookback);
  const un = uncondNamePIT(mx, sq, q, H, C.coverage);
  const row = FIDX.vol20;
  return {
    sq, q, date: mx.dates[q], sym: mx.syms[sq],
    sector: (engine.sectorOf?.[mx.syms[sq]]) || null,
    y, ms, n: rets.length, pit,
    vol20: Number.isFinite(mx.F[(b + q) * NF + row]) ? mx.F[(b + q) * NF + row] : NaN,
    sigmaH: finite(dv) ? dv * Math.sqrt(H) : NaN,
    uncond: un,
    analogConformal: { centre: s.median, hw: s.sd, p10: s.p10, p90: s.p90, sd: s.sd, n: rets.length },
    analogRaw: { centre: (s.p10 + s.p90) / 2, hw: (s.p90 - s.p10) / 2 },
    uncondNamePIT: un ? { centre: un.centre, hw: un.half } : null,
    volHarness: finite(dv) ? { centre: 0, hw: dv * Math.sqrt(H) } : null
  };
}

/** Cluster-robust coverage + width for one predictor at one multiplier. */
function scorePredictor(rows, centreKey, lam, target) {
  const used = [];
  for (const r of rows) {
    const p = r[centreKey];
    if (!p || !finite(p.centre) || !finite(p.hw) || !(p.hw > 0) || !finite(r.y)) continue;
    const hw = p.hw * lam;
    used.push({ date: r.date, y: r.y, centre: p.centre, hw, hit: Math.abs(r.y - p.centre) <= hw });
  }
  const n = used.length;
  if (!n) return { n: 0 };
  const hit = used.filter((x) => x.hit).length;
  const width = used.reduce((a, x) => a + 2 * x.hw, 0) / n;
  const se = clusteredCoverageSE(used.map((x) => ({ ...x, hitBool: true })));
  return {
    n, lambda: lam, coverage: hit / n, coveragePct: pct(hit / n, 1),
    coverageSE: se.se, coverageSEPct: se.se != null && finite(se.se) ? Number((se.se * 100).toFixed(2)) : null,
    clusters: se.clusters,
    width, widthPct: pct(width),
    above: used.filter((x) => x.y > x.centre + x.hw).length / n,
    below: used.filter((x) => x.y < x.centre - x.hw).length / n,
    signedBias: used.reduce((a, x) => a + (x.y - x.centre), 0) / n,
    rows: used
  };
}

export function runValidation(engine, opts = {}) {
  const C = { ...VALIDATION_DEFAULTS, ...opts };
  engine.C.horizon = C.horizon;
  const { mx } = engine;
  const H = C.horizon;
  const t0 = Date.now();
  const sectorOf = {};
  for (const u of (engine.ds?.meta?.universe || [])) sectorOf[u.s] = u.sec || null;
  engine.sectorOf = sectorOf;

  const out = {
    protocol: { ...C, eras: ERAS, predictors: PREDICTORS },
    library: { nSym: mx.nSym, nDates: mx.nDates, from: mx.dates[0], to: mx.dates[mx.nDates - 1], benchSym: mx.benchSym },
    engineConfig: { ...engine.C, initMs: engine.initMs }
  };

  const collect = (grid) => {
    const rows = [];
    for (const { sq, q } of grid) {
      for (const r of [probe(engine, sq, q, C)]) if (r) { r.sector = sectorOf[r.sym]; rows.push(r); }
    }
    return rows;
  };

  const calibGrid = queryGrid(engine, { era: "calibration", stride: C.strideCalib, symbols: C.symbols, maxQueries: C.maxQueries });
  const testGrid = queryGrid(engine, { era: "test", stride: C.strideTest, symbols: C.symbols, maxQueries: C.maxQueries });
  out.grid = { calibration: calibGrid.length, test: testGrid.length };

  const calib = collect(calibGrid);
  const test = collect(testGrid);
  if (!calib.length || !test.length) throw new Error("empty era grid - widen the symbol list or reduce the stride");

  // Pooled floor: fixed once, from data available at the end of the calibration era.
  const calibEnd = sessionsIn(mx, null, ERAS.calibration.to).at(-1);
  const pooled = pooledUncondBand(mx, H, calibEnd - H, C.coverage);
  for (const r of [...calib, ...test]) r.pooledUncond = pooled ? { centre: pooled.centre, hw: pooled.half } : null;

  // Freeze the calibration-era multipliers.
  const fitA = conformalScale(calib.map((r) => (r.analogConformal.sd > 0 ? Math.abs(r.y - r.analogConformal.centre) / r.analogConformal.sd : NaN)), C.coverage);
  const fitV = conformalScale(calib.map((r) => (r.volHarness?.hw > 0 ? Math.abs(r.y - r.volHarness.centre) / r.volHarness.hw : NaN)), C.coverage);
  const fitP = conformalScale(calib.filter((r) => r.pooledUncond).map((r) => Math.abs(r.y - r.pooledUncond.centre) / r.pooledUncond.hw), C.coverage);
  out.fit = {
    analogConformal: { scale: fitA.scale, scoresUsed: fitA.n, quantileLevel: fitA.level },
    volHarness: { scale: fitV.scale, scoresUsed: fitV.n, quantileLevel: fitV.level },
    pooledUncond: { scale: fitP.scale, scoresUsed: fitP.n, quantileLevel: fitP.level, pooledN: pooled?.n, pooledCut: mx.dates[Math.max(0, calibEnd - H)] },
    analogRaw: { scale: 1, note: "empirical percentiles, self-calibrating" },
    uncondNamePIT: { scale: 1, note: "empirical percentiles, self-calibrating" }
  };
  const lam = { analogConformal: fitA.scale, analogRaw: 1, uncondNamePIT: 1, volHarness: fitV.scale, pooledUncond: fitP.scale };

  const results = {};
  for (const key of PREDICTORS) {
    const pre = scorePredictor(test, key, lam[key], C.coverage);
    const cal = scorePredictor(calib, key, lam[key], C.coverage);
    const matched = matchCoverage(test.map((r) => ({ centre: r[key]?.centre, hw: r[key]?.hw, y: r.y })), C.coverage);
    results[key] = {
      lambdaFrozen: lam[key],
      calibrationEra: { coveragePct: cal.coveragePct, widthPct: cal.widthPct, n: cal.n },
      testEra: strip(pre),
      matched: { lambda: matched.lambda, coverage: matched.cov, coveragePct: pct(matched.cov, 1), width: matched.width, widthPct: pct(matched.width), n: matched.n },
      tailBalance: { above: pre.above, below: pre.below, signedBias: pre.signedBias }
    };
  }
  out.results = results;

  const aW = results.analogConformal.testEra.widthPct, bW = results.uncondNamePIT.testEra.widthPct;
  out.headline = {
    horizon: H, targetCoveragePct: pct(C.coverage, 1),
    analogCoveragePct: results.analogConformal.testEra.coveragePct,
    analogWidthPct: aW,
    baselineWidthPct: bW,
    preRegisteredSharpnessGainPct: bW != null && aW != null ? Number((100 * (bW - aW) / bW).toFixed(1)) : null,
    matchedCoverageWidth: Object.fromEntries(PREDICTORS.map((k) => [k, results[k].matched.widthPct])),
    matchedCoverageSharpnessGainPct: results.uncondNamePIT.matched.widthPct
      ? Number((100 * (1 - results.analogConformal.matched.widthPct / results.uncondNamePIT.matched.widthPct)).toFixed(1)) : null,
    analogScale: fitA.scale,
    meanQueryMs: test.reduce((s, r) => s + r.ms, 0) / test.length,
    meanAnalogs: test.reduce((s, r) => s + r.n, 0) / test.length,
    testN: test.length, calibN: calib.length
  };

  // Conditioning: does the interval track the regime, or only average out to 80%?
  const vols = test.map((r) => r.vol20).filter(Number.isFinite).sort((x, y) => x - y);
  const terc = (p) => (vols.length ? vols[Math.floor(p * (vols.length - 1))] : NaN);
  const t1 = terc(1 / 3), t2 = terc(2 / 3);
  const bucketOf = (r) => (!finite(r.vol20) ? null : r.vol20 <= t1 ? "low" : r.vol20 <= t2 ? "mid" : "high");
  const years = [...new Set(test.map((r) => r.date.slice(0, 4)))].sort();
  const sectors = [...new Set(test.map((r) => r.sector).filter(Boolean))].sort();

  const slice = (rows) => Object.fromEntries(PREDICTORS.map((k) => {
    const s = scorePredictor(rows, k, lam[k], C.coverage);
    return [k, { n: s.n, coveragePct: s.coveragePct, widthPct: s.widthPct, coverageSEPct: s.coverageSEPct }];
  }));

  out.breakdown = {
    volTerciles: { t1Pct: pct(t1, 1), t2Pct: pct(t2, 1) },
    byVolRegime: ["low", "mid", "high"].map((regime) => ({ regime, ...slice(test.filter((r) => bucketOf(r) === regime)) })),
    byYear: years.map((year) => ({ year, ...slice(test.filter((r) => r.date.startsWith(year))) })),
    bySector: sectors.map((sector) => ({ sector, ...slice(test.filter((r) => r.sector === sector)) }))
  };

  // PIT uniformity of the raw analog sample (before conformal scaling).
  const bins = new Array(10).fill(0);
  for (const r of test) { let i = Math.floor(r.pit * 10); if (i > 9) i = 9; if (i < 0) i = 0; bins[i]++; }
  const exp = test.length / 10;
  out.pit = {
    bins: bins.map((c, i) => ({ bin: `${i * 10}-${i * 10 + 10}%`, count: c, expected: exp, deviationPct: pct((c - exp) / exp, 1) })),
    chiSquare: bins.reduce((a, c) => a + ((c - exp) ** 2) / exp, 0), df: 9,
    chiSquareCritical5pct: 16.92,
    median: quantile(test.map((r) => r.pit).sort((a, b) => a - b), 0.5)
  };
  out.reliability = reliability(test.filter((r) => finite(r.analogConformal.sd)).map((r) => ({
    band: band(r.analogConformal.centre, r.analogConformal.sd, fitA.scale), y: r.y
  })));
  /* ------------------------------------------------------------------------
   * Per-symbol conditional quality.
   *
   * Aggregate mean width rewards a predictor that ignores WHICH name is being traded: one fixed
   * interval tuned to the cross-sectional mixture can look sharp on average while covering MU at 42%
   * and XLV at 100%. A pre-trade desk is used one name at a time, so the decisive question is
   * whether each predictor lands near target for each name. Reported in full, including where the
   * analog engine loses.
   * ---------------------------------------------------------------------- */
  const symStats = {};
  for (const r of test) {
    for (const k of PREDICTORS) {
      const p = r[k];
      if (!p || !finite(p.centre) || !(p.hw > 0) || !finite(r.y)) continue;
      const hw = p.hw * lam[k];
      const o = ((symStats[r.sym] ||= {})[k] ||= { hit: 0, n: 0, width: 0, vol: [] });
      o.hit += Math.abs(r.y - p.centre) <= hw ? 1 : 0;
      o.n++; o.width += 2 * hw;
      if (finite(r.vol20)) o.vol.push(r.vol20);
    }
  }
  const symbols = Object.keys(symStats).filter((s) => (symStats[s].analogConformal?.n || 0) >= 10);
  const lo = C.coverage * 100 - 10, hi = C.coverage * 100 + 10;
  out.bySymbol = {
    tolerancePp: [lo, hi],
    symbols: symbols.map((sym) => {
      const row = { sym, sector: sectorOf[sym] || null };
      for (const k of PREDICTORS) {
        const o = symStats[sym][k];
        row[k] = o ? { n: o.n, coveragePct: pct(o.hit / o.n, 1), widthPct: pct(o.width / o.n) } : null;
      }
      return row;
    }),
    dispersion: Object.fromEntries(PREDICTORS.map((k) => {
      const covs = symbols.map((s) => (symStats[s][k] ? (symStats[s][k].hit / symStats[s][k].n) * 100 : NaN)).filter(finite);
      const widths = symbols.map((s) => (symStats[s][k] ? symStats[s][k].width / symStats[s][k].n : NaN)).filter(finite);
      const vols = symbols.map((s) => (symStats[s][k] ? mean(symStats[s][k].vol) : NaN)).filter(finite);
      if (!covs.length) return [k, null];
      const sorted = [...covs].sort((a, b) => a - b);
      return [k, {
        symbols: covs.length,
        coverageSdPp: sd(covs),
        coverageIqrPp: quantile(sorted, 0.75) - quantile(sorted, 0.25),
        minCoveragePct: sorted[0], maxCoveragePct: sorted[sorted.length - 1],
        withinTolerance: covs.filter((c) => c >= lo && c <= hi).length,
        corrWidthOwnVol: pearson(widths, vols)
      }];
    }))
  };

  // Which predictor the calibration era alone would have selected, and what it then did on test.
  const calibRanking = PREDICTORS
    .map((k) => ({ k, width: matchCoverage(calib.map((r) => ({ centre: r[k]?.centre, hw: r[k]?.hw, y: r.y })), C.coverage).width }))
    .filter((x) => finite(x.width)).sort((a, b) => a.width - b.width);
  out.selection = {
    rule: "sharpest predictor at matched coverage on the CALIBRATION era only; test era not consulted",
    ranking: calibRanking.map((x) => ({ predictor: x.k, calibWidthPct: pct(x.width) })),
    selected: calibRanking[0]?.k || null,
    selectedTestWidthPct: calibRanking[0] ? results[calibRanking[0].k].matched.widthPct : null,
    analogTestWidthPct: results.analogConformal.matched.widthPct
  };

  out.directional = {
    hitRate: pct(test.filter((r) => Math.sign(r.y) === Math.sign(r.analogConformal.centre)).length / test.length, 1),
    n: test.length
  };
  out.timing = { totalMs: Date.now() - t0, meanQueryMs: out.headline.meanQueryMs, engineInitMs: engine.initMs };
  out.rows = { calibration: calib, test };
  return out;
}

function strip(o) {
  const { rows, ...rest } = o;
  void rows;
  return rest;
}

/* --------------------------- cluster-robust errors ------------------------ */

/**
 * Coverage standard error clustered by query date. Sessions are the correlation unit: all symbols
 * queried on one session share the same market shock, so only between-session variation counts.
 */
export function clusteredCoverageSE(rows) {
  const byDate = new Map();
  for (const r of rows) {
    if (!r.hitBool) continue;
    const arr = byDate.get(r.date) || { hit: 0, n: 0 };
    arr.hit += r.hit ? 1 : 0; arr.n++;
    byDate.set(r.date, arr);
  }
  const per = [...byDate.values()].filter((x) => x.n > 0).map((x) => x.hit / x.n);
  const m = per.length;
  if (m < 2) return { se: NaN, clusters: m };
  const mean = per.reduce((a, x) => a + x, 0) / m;
  return { se: sd(per.map((x) => x)) / Math.sqrt(m), clusters: m, meanOfClusters: mean };
}

/** Bisect a single multiplier so test-era coverage lands on `target`. */
export function matchCoverage(rows, target, kind = "scaled") {
  const evalAt = (lam) => {
    let hit = 0, n = 0, w = 0;
    for (const r of rows) {
      if (!finite(r.centre) || !finite(r.hw) || !(r.hw > 0) || !finite(r.y)) continue;
      const hw = r.hw * lam;
      n++; if (Math.abs(r.y - r.centre) <= hw) hit++; w += 2 * hw;
    }
    return { cov: n ? hit / n : NaN, width: n ? w / n : NaN, n };
  };
  let lo = 0.05, hi = 20;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const c = evalAt(mid).cov;
    if (!finite(c)) break;
    if (c < target) lo = mid; else hi = mid;
  }
  const lam = (lo + hi) / 2;
  return { lambda: lam, ...evalAt(lam) };
}