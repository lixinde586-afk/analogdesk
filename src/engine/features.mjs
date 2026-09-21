/**
 * AnalogDesk feature engine - isomorphic (Node + browser), zero dependencies.
 * All features are computed from information available at the close of session i (no lookahead).
 */

export const GROUPS = [
  { g: "name",   w: 0.30, f: ["ret5","ret20","ret60","dist52","vol20","volRatio","dd60","relBench20","gap20","dv20z"] },
  { g: "market", w: 0.20, f: ["mktRet20","mktDist52","mktVol20","vix","vixChg5","growthRel20"] },
  { g: "macro",  w: 0.20, f: ["slope","dRate90","beiChg20","usdChg20","oilChg20","hyChg20"] },
  { g: "crypto", w: 0.10, f: ["btcRet5","btcRet20","fng"] },
  { g: "event",  w: 0.20, f: ["dte","eventLoad5","isFomcDay"] }
];
export const FEATURES = GROUPS.flatMap((x) => x.f);
export const NF = FEATURES.length;
export const FIDX = Object.fromEntries(FEATURES.map((f, i) => [f, i]));
export const FGROUP = FEATURES.map((f) => GROUPS.find((x) => x.f.includes(f)).g);
export const DEFAULT_WEIGHTS = Object.fromEntries(GROUPS.map((x) => [x.g, x.w]));

/** default per-feature weights inside a group (equal), multiplied by the group weight */
export function featureWeights(groupWeights = DEFAULT_WEIGHTS) {
  const w = new Float64Array(NF);
  for (const grp of GROUPS) {
    const gw = groupWeights[grp.g] ?? 0;
    for (const f of grp.f) w[FIDX[f]] = gw / grp.f.length;
  }
  return w;
}

/* ---------------- helpers ---------------- */
const stdev = (arr) => {
  let n = 0, s = 0, s2 = 0;
  for (const x of arr) { if (x == null || !Number.isFinite(x)) continue; n++; s += x; s2 += x * x; }
  if (n < 2) return NaN;
  const v = (s2 - (s * s) / n) / (n - 1);
  return v > 0 ? Math.sqrt(v) : 0;
};
/** map a sparse {d:[],v:[]} series onto the trading calendar with forward-fill */
export function ffill(series, dates) {
  const out = new Float64Array(dates.length).fill(NaN);
  if (!series || !series.d) return out;
  let p = 0, last = NaN;
  const sd = series.d, sv = series.v ?? series.p;
  for (let i = 0; i < dates.length; i++) {
    while (p < sd.length && sd[p] <= dates[i]) { last = sv[p]; p++; }
    out[i] = last;
  }
  return out;
}
const retK = (a, i, k) => (i - k >= 0 && a[i] != null && a[i - k] != null && a[i - k] !== 0 ? a[i] / a[i - k] - 1 : NaN);

/* ---------------- matrix build ---------------- */
/**
 * @returns {{syms:string[],dates:string[],nSym:number,nDates:number,F:Float32Array,valid:Uint8Array,
 *            priceA:Float64Array,priceO:Float64Array,priceH:Float64Array,priceL:Float64Array,
 *            symOf:Uint16Array,benchIdx:number}}
 * F is flat: F[(symIdx*nDates + i)*NF + f]
 */
export function buildMatrix(ds, { minHistory = 60 } = {}) {
  const dates = ds.dates;
  const nDates = dates.length;
  const syms = ds.meta.universe.map((u) => u.s).filter((s) => ds.prices[s]);
  const nSym = syms.length;
  const F = new Float32Array(nSym * nDates * NF).fill(NaN);
  const valid = new Uint8Array(nSym * nDates);
  const priceA = new Float64Array(nSym * nDates).fill(NaN);
  const priceO = new Float64Array(nSym * nDates).fill(NaN);
  const priceH = new Float64Array(nSym * nDates).fill(NaN);
  const priceL = new Float64Array(nSym * nDates).fill(NaN);
  const symOf = new Uint16Array(nSym * nDates);

  // shared (date-level) series
  const M = ds.macro || {};
  const vix = ffill(M.VIXCLS, dates), slope = ffill(M.T10Y2Y, dates), fed = ffill(M.DFEDTARU, dates);
  const bei = ffill(M.T10YIE, dates), usd = ffill(M.DTWEXBGS, dates), oil = ffill(M.DCOILWTICO, dates);
  const hy = ffill(M.BAMLH0A0HYM2, dates);
  const C = ds.crypto || {};
  const btc = ffill(C.BTC ? { d: C.BTC.d, v: C.BTC.p } : null, dates);
  const fng = ffill(C.FNG ? { d: C.FNG.d, v: C.FNG.p } : null, dates);
  const dateIdx = new Map(dates.map((d, i) => [d, i]));
  const fomcSet = new Set((ds.events?.fomc || []).map((d) => d));
  const fomcIdx = [...fomcSet].map((d) => dateIdx.get(d)).filter((i) => i != null).sort((a, b) => a - b);
  const earnIdx = {};
  for (const [s, arr] of Object.entries(ds.events?.earnings || {})) {
    earnIdx[s] = (arr || []).map((d) => {
      let i = dateIdx.get(d);
      if (i != null) return i;
      const nd = dates.findIndex((x) => x >= d); // release after a holiday/weekend -> next session
      return nd >= 0 ? nd : null;
    }).filter((i) => i != null).sort((a, b) => a - b);
  }

  // benchmark (SPY) series used by market + relative features
  const benchSym = ds.prices.SPY ? "SPY" : (ds.prices.QQQ ? "QQQ" : syms[0]);
  const benchIdx = syms.indexOf(benchSym);
  const growthSym = ds.prices.QQQ ? "QQQ" : benchSym;
  const growthIdx = syms.indexOf(growthSym);
  const bA = ds.prices[benchSym].a, gA = ds.prices[growthSym].a;
  const benchRet20 = new Float64Array(nDates).fill(NaN);
  const benchVol20 = new Float64Array(nDates).fill(NaN);
  const benchDist52 = new Float64Array(nDates).fill(NaN);
  const growthRel20 = new Float64Array(nDates).fill(NaN);
  const bLog = new Float64Array(nDates).fill(NaN);
  for (let i = 0; i < nDates; i++) {
    if (i > 0 && bA[i] != null && bA[i - 1] != null && bA[i - 1] > 0) bLog[i] = Math.log(bA[i] / bA[i - 1]);
    benchRet20[i] = retK(bA, i, 20);
    if (i >= 20) benchVol20[i] = stdev(Array.from(bLog.subarray(i - 19, i + 1))) * Math.SQRT2 * Math.sqrt(126);
    let hh = -Infinity;
    for (let j = Math.max(0, i - 251); j <= i; j++) if (ds.prices[benchSym].h[j] != null) hh = Math.max(hh, ds.prices[benchSym].h[j]);
    benchDist52[i] = hh > 0 && bA[i] != null ? bA[i] / hh - 1 : NaN;
    growthRel20[i] = (retK(gA, i, 20) || NaN) - (benchRet20[i] || NaN);
    if (!Number.isFinite(growthRel20[i])) growthRel20[i] = NaN;
  }
  const vixChg5 = new Float64Array(nDates).fill(NaN);
  for (let i = 5; i < nDates; i++) if (vix[i] > 0 && vix[i - 5] > 0) vixChg5[i] = vix[i] / vix[i - 5] - 1;

  for (let si = 0; si < nSym; si++) {
    const sym = syms[si];
    const P = ds.prices[sym];
    const a = P.a, o = P.o, h = P.h, l = P.l, v = P.v;
    const base = si * nDates;
    const log = new Float64Array(nDates).fill(NaN);
    for (let i = 0; i < nDates; i++) {
      priceA[base + i] = a[i] ?? NaN; priceO[base + i] = o[i] ?? NaN;
      priceH[base + i] = h[i] ?? NaN; priceL[base + i] = l[i] ?? NaN;
      symOf[base + i] = si;
      if (i > 0 && a[i] != null && a[i - 1] != null && a[i - 1] > 0) log[i] = Math.log(a[i] / a[i - 1]);
    }
    const earn = earnIdx[sym] || [];
    let ep = 0;
    // Liquidity regime (dv20z): 20-session mean dollar volume, z-scored against the trailing
    // 250 sessions ending 20 sessions back. Prefix sums + a two-pointer window make this
    // O(nDates) per symbol instead of O(nDates^2); numerically identical to the naive form.
    const dvCS = new Float64Array(nDates + 1); // cumulative dollar volume
    const dvCN = new Float64Array(nDates + 1); // cumulative count of usable sessions
    for (let i = 0; i < nDates; i++) {
      const x = (v[i] != null && a[i] != null) ? v[i] * a[i] : NaN;
      dvCS[i + 1] = dvCS[i] + (Number.isFinite(x) ? x : 0);
      dvCN[i + 1] = dvCN[i] + (Number.isFinite(x) ? 1 : 0);
    }
    const dv20 = new Float64Array(nDates).fill(NaN);
    for (let i = 19; i < nDates; i++) {
      const n = dvCN[i + 1] - dvCN[i - 19];
      if (n > 0) dv20[i] = (dvCS[i + 1] - dvCS[i - 19]) / n;
    }
    const dvObs = [];
    for (let i = 0; i < nDates; i++) if (Number.isFinite(dv20[i])) dvObs.push(i);
    const dvMu = new Float64Array(nDates).fill(NaN);
    const dvSd = new Float64Array(nDates).fill(NaN);
    for (let i = 20, lo = 0, hi = 0, s = 0, s2 = 0; i < nDates; i++) {
      const wLo = Math.max(20, i - 249), wHi = i - 20;
      while (hi < dvObs.length && dvObs[hi] <= wHi) { const x = dv20[dvObs[hi++]]; s += x; s2 += x * x; }
      while (lo < hi && dvObs[lo] < wLo) { const x = dv20[dvObs[lo++]]; s -= x; s2 -= x * x; }
      const n = hi - lo;
      if (n >= 2) { dvMu[i] = s / n; const vr = (s2 - (s * s) / n) / (n - 1); dvSd[i] = vr > 0 ? Math.sqrt(vr) : 0; }
    }
    for (let i = 0; i < nDates; i++) {
      if (a[i] == null) continue;
      const row = (base + i) * NF;
      let ok = i >= minHistory;
      // ---- name group ----
      F[row + FIDX.ret5] = retK(a, i, 5);
      F[row + FIDX.ret20] = retK(a, i, 20);
      F[row + FIDX.ret60] = retK(a, i, 60);
      let hh = -Infinity;
      for (let j = Math.max(0, i - 251); j <= i; j++) if (h[j] != null) hh = Math.max(hh, h[j]);
      F[row + FIDX.dist52] = hh > 0 ? a[i] / hh - 1 : NaN;
      if (i >= 20) F[row + FIDX.vol20] = stdev(Array.from(log.subarray(i - 19, i + 1))) * Math.sqrt(252);
      const v5 = i >= 5 ? stdev(Array.from(log.subarray(i - 4, i + 1))) * Math.sqrt(252) : NaN;
      const v20 = F[row + FIDX.vol20];
      F[row + FIDX.volRatio] = v20 > 0 ? v5 / v20 : NaN;
      let pk = -Infinity;
      for (let j = Math.max(0, i - 59); j <= i; j++) if (a[j] != null) pk = Math.max(pk, a[j]);
      F[row + FIDX.dd60] = pk > 0 ? a[i] / pk - 1 : NaN;
      F[row + FIDX.relBench20] = Number.isFinite(F[row + FIDX.ret20]) && Number.isFinite(benchRet20[i]) ? F[row + FIDX.ret20] - benchRet20[i] : NaN;
      // overnight/weekend gap behaviour: proxy for 7x24 wrapper gap risk
      let gs = 0, gn = 0;
      for (let j = Math.max(1, i - 19); j <= i; j++) if (o[j] != null && a[j - 1] != null && a[j - 1] > 0) { gs += Math.abs(o[j] / a[j - 1] - 1); gn++; }
      F[row + FIDX.gap20] = gn ? gs / gn : NaN;
      F[row + FIDX.dv20z] = dvSd[i] > 0 ? (dv20[i] - dvMu[i]) / dvSd[i] : NaN;
      // ---- market group ----
      F[row + FIDX.mktRet20] = benchRet20[i];
      F[row + FIDX.mktDist52] = benchDist52[i];
      F[row + FIDX.mktVol20] = benchVol20[i];
      F[row + FIDX.vix] = vix[i];
      F[row + FIDX.vixChg5] = vixChg5[i];
      F[row + FIDX.growthRel20] = growthRel20[i];
      // ---- macro group ----
      F[row + FIDX.slope] = slope[i];
      F[row + FIDX.dRate90] = i >= 63 && Number.isFinite(fed[i]) && Number.isFinite(fed[i - 63]) ? fed[i] - fed[i - 63] : NaN;
      F[row + FIDX.beiChg20] = i >= 20 && Number.isFinite(bei[i]) && Number.isFinite(bei[i - 20]) ? bei[i] - bei[i - 20] : NaN;
      F[row + FIDX.usdChg20] = i >= 20 && usd[i - 20] > 0 ? usd[i] / usd[i - 20] - 1 : NaN;
      F[row + FIDX.oilChg20] = i >= 20 && oil[i - 20] > 0 ? oil[i] / oil[i - 20] - 1 : NaN;
      F[row + FIDX.hyChg20] = i >= 20 && Number.isFinite(hy[i]) && Number.isFinite(hy[i - 20]) ? (hy[i] - hy[i - 20]) * 100 : NaN;
      // ---- crypto / cross-asset group ----
      F[row + FIDX.btcRet5] = i >= 5 && btc[i - 5] > 0 ? btc[i] / btc[i - 5] - 1 : NaN;
      F[row + FIDX.btcRet20] = i >= 20 && btc[i - 20] > 0 ? btc[i] / btc[i - 20] - 1 : NaN;
      F[row + FIDX.fng] = Number.isFinite(fng[i]) ? fng[i] / 100 : NaN;
      // ---- event group ----
      while (ep < earn.length && earn[ep] < i) ep++;
      const nextEarn = ep < earn.length ? earn[ep] : null;
      const dteCal = nextEarn == null ? 45 : Math.min(45, Math.round((new Date(dates[nextEarn]) - new Date(dates[i])) / 86400000));
      F[row + FIDX.dte] = dteCal;
      let fomcIn5 = 0;
      for (const fi of fomcIdx) { if (fi > i && fi <= i + 5) fomcIn5++; else if (fi > i + 5) break; }
      F[row + FIDX.eventLoad5] = fomcIn5 + (dteCal <= 7 ? 1 : 0);
      F[row + FIDX.isFomcDay] = fomcSet.has(dates[i]) ? 1 : 0;
      // validity: price present + minimum history + the two core name features finite
      if (ok && Number.isFinite(F[row + FIDX.ret20]) && Number.isFinite(F[row + FIDX.vol20])) valid[base + i] = 1;
    }
  }
  return { syms, dates, nSym, nDates, NF, F, valid, priceA, priceO, priceH, priceL, symOf, benchIdx, growthIdx, benchSym };
}

/* ---------------- standardisation ---------------- */
/** robust mu/sd per feature over rows with date index < cutoffIdx (walk-forward safe) */
export function computeStats(mx, { cutoffIdx = Infinity } = {}) {
  const { F, valid, nSym, nDates } = mx;
  const mu = new Float64Array(NF), sd = new Float64Array(NF);
  const sums = new Float64Array(NF), sq = new Float64Array(NF), cnt = new Int32Array(NF);
  const q = [];
  for (let si = 0; si < nSym; si++) {
    const base = si * nDates;
    for (let i = 0; i < nDates && i < cutoffIdx; i++) {
      if (!valid[base + i]) continue;
      const row = (base + i) * NF;
      for (let f = 0; f < NF; f++) {
        const x = F[row + f];
        if (!Number.isFinite(x)) continue;
        sums[f] += x; sq[f] += x * x; cnt[f]++;
        if (f === 0 && q.length < 200000) q.push(x); // unused, kept cheap
      }
    }
  }
  for (let f = 0; f < NF; f++) {
    if (cnt[f] > 2) { mu[f] = sums[f] / cnt[f]; const varr = (sq[f] - sums[f] * sums[f] / cnt[f]) / (cnt[f] - 1); sd[f] = varr > 0 ? Math.sqrt(varr) : 1; }
    else { mu[f] = 0; sd[f] = 1; }
  }
  return { mu, sd, cnt };
}
