/**
 * AnalogDesk - historical analog retrieval.
 *
 * Isomorphic (Node + browser), zero dependencies.
 *
 * Method
 * ------
 * Every (symbol, session) pair in the library is a candidate analog. Each candidate is described
 * by the 28 features in features.mjs, standardised with an EXPANDING-window mu/sd that only ever
 * uses rows dated on or before that session, so a z-score means the same thing in 2017 and 2025
 * and nothing in the pipeline can see the future.
 *
 * Similarity is a group-weighted Euclidean distance in z-space:
 *   - z is winsorised at +/-3 sigma;
 *   - {dv20z, fng, hyChg20} are carried in the payload for display but EXCLUDED from the metric
 *     (dv20z is a slow liquidity level that dominates distance, fng only exists from 2018-02 and
 *     is crypto-specific, hyChg20 has a coverage break in 2023);
 *   - each GROUPS entry keeps its full weight, redistributed over the group's usable features;
 *   - features missing on either side are dropped and the distance renormalised, so a candidate
 *     is never rewarded for having holes. Candidates covering <60% of the metric weight are
 *     rejected outright.
 *
 * Selection is greedy over ascending distance under two anti-clustering constraints: at most
 * `maxPerCalendarDate` analogs may share a calendar date, and two analogs of the same symbol must
 * be at least `minSameSymbolGap` trading days apart. Without these, the top-50 collapses onto one
 * week of one crash and the "distribution" is really a single event.
 *
 * Leakage control: a candidate at session j is only eligible when j + horizon <= q, so every
 * forward return we report was fully realised in the past relative to the query date.
 */

import { buildMatrix, GROUPS, FEATURES, NF, FIDX, DEFAULT_WEIGHTS } from "./features.mjs";

/** Carried in the payload for display, deliberately kept out of the distance metric. */
export const DISTANCE_EXCLUDE = ["dv20z", "fng", "hyChg20"];

export const DEFAULT_CONFIG = {
  k: 50,
  zClip: 3,
  horizon: 20,
  horizons: [1, 5, 10, 20, 40, 60],
  maxPerCalendarDate: 2,
  minSameSymbolGap: 10,
  exclude: DISTANCE_EXCLUDE,
  groupWeights: DEFAULT_WEIGHTS,
  minWeightCoverage: 0.6,
  minHistory: 60,
  poolMultiple: 80
};

export function resolveConfig(cfg = {}) {
  const C = { ...DEFAULT_CONFIG, ...cfg };
  C.horizons = [...new Set([...(C.horizons || []), C.horizon])].sort((a, b) => a - b);
  return C;
}

/** Per-feature metric weights: group weight preserved, spread over the group's usable features. */
export function distanceWeights(C = DEFAULT_CONFIG) {
  const ex = new Set(C.exclude || []);
  const gw = C.groupWeights || DEFAULT_WEIGHTS;
  const w = new Float64Array(NF);
  let total = 0;
  for (const grp of GROUPS) {
    const usable = grp.f.filter((f) => !ex.has(f));
    if (!usable.length) continue;
    const share = (gw[grp.g] ?? 0) / usable.length;
    for (const f of usable) { w[FIDX[f]] = share; total += share; }
  }
  if (total > 0) for (let f = 0; f < NF; f++) w[f] /= total;
  return w;
}

/* --------------------------- expanding statistics -------------------------- */

/**
 * Point-in-time mu/sd/count per feature. Index i holds the statistics of every valid row dated
 * on or before session i, so statsAt(st, i) is exactly what a desk could have known at that close.
 */
export function buildExpandingStats(mx) {
  const { F, valid, nSym, nDates } = mx;
  const S = new Float64Array(nDates * NF), Q = new Float64Array(nDates * NF), C = new Float32Array(nDates * NF);
  const rs = new Float64Array(NF), rq = new Float64Array(NF), rc = new Float64Array(NF);
  for (let i = 0; i < nDates; i++) {
    for (let si = 0; si < nSym; si++) {
      const b = si * nDates + i;
      if (!valid[b]) continue;
      const row = b * NF;
      for (let f = 0; f < NF; f++) {
        const x = F[row + f];
        if (!Number.isFinite(x)) continue;
        rs[f] += x; rq[f] += x * x; rc[f]++;
      }
    }
    const o = i * NF;
    for (let f = 0; f < NF; f++) { S[o + f] = rs[f]; Q[o + f] = rq[f]; C[o + f] = rc[f]; }
  }
  return { S, Q, C, nDates };
}

export function statsAt(st, i, out) {
  const mu = out?.mu || new Float64Array(NF), sd = out?.sd || new Float64Array(NF);
  const o = Math.max(0, Math.min(i, st.nDates - 1)) * NF;
  for (let f = 0; f < NF; f++) {
    const c = st.C[o + f];
    if (c > 2) {
      const s = st.S[o + f];
      mu[f] = s / c;
      const v = (st.Q[o + f] - (s * s) / c) / (c - 1);
      sd[f] = v > 0 ? Math.sqrt(v) : 1;
    } else { mu[f] = 0; sd[f] = 1; }
  }
  return { mu, sd };
}

/** Winsorised z-score matrix, standardised with the expanding stats of each row's own session. */
export function buildZ(mx, st, zClip = 3) {
  const { F, valid, nSym, nDates } = mx;
  const Z = new Float32Array(nSym * nDates * NF).fill(NaN);
  const scratch = { mu: new Float64Array(NF), sd: new Float64Array(NF) };
  for (let i = 0; i < nDates; i++) {
    const { mu, sd } = statsAt(st, i, scratch);
    for (let si = 0; si < nSym; si++) {
      const b = si * nDates + i;
      if (!valid[b]) continue;
      const row = b * NF;
      for (let f = 0; f < NF; f++) {
        const x = F[row + f];
        if (!Number.isFinite(x)) continue;
        let z = (x - mu[f]) / sd[f];
        if (z > zClip) z = zClip; else if (z < -zClip) z = -zClip;
        Z[row + f] = z;
      }
    }
  }
  return Z;
}

/* --------------------------------- heap ----------------------------------- */

/** Fixed-capacity max-heap of the best (lowest distance) candidates seen so far. */
class TopK {
  constructor(cap) { this.cap = cap; this.d = []; this.i = []; }
  get max() { return this.d.length ? this.d[0] : Infinity; }
  push(dist, idx) {
    const { d, i, cap } = this;
    if (d.length < cap) { d.push(dist); i.push(idx); this._up(d.length - 1); }
    else if (dist < d[0]) { d[0] = dist; i[0] = idx; this._down(0); }
  }
  _up(p) {
    const { d, i } = this;
    while (p > 0) {
      const par = (p - 1) >> 1;
      if (d[par] >= d[p]) break;
      [d[par], d[p]] = [d[p], d[par]]; [i[par], i[p]] = [i[p], i[par]]; p = par;
    }
  }
  _down(p) {
    const { d, i } = this, n = d.length;
    for (;;) {
      const l = 2 * p + 1, r = l + 1; let m = p;
      if (l < n && d[l] > d[m]) m = l;
      if (r < n && d[r] > d[m]) m = r;
      if (m === p) break;
      [d[m], d[p]] = [d[p], d[m]]; [i[m], i[p]] = [i[p], i[m]]; p = m;
    }
  }
  drain() {
    const out = this.d.map((dist, n) => ({ dist, idx: this.i[n] }));
    return out.sort((a, b) => a.dist - b.dist);
  }
}

/* --------------------------------- engine --------------------------------- */

export function createEngine(ds, cfg = {}) {
  const C = resolveConfig(cfg);
  const t0 = Date.now();
  const mx = buildMatrix(ds, { minHistory: C.minHistory });
  const st = buildExpandingStats(mx);
  const Z = buildZ(mx, st, C.zClip);
  const w = distanceWeights(C);
  const active = [];
  for (let f = 0; f < NF; f++) if (w[f] > 0) active.push(f);
  const ACT = Int32Array.from(active);
  const nSym = mx.nSym, nDates = mx.nDates;
  const meta = Object.fromEntries((ds.meta?.universe || []).map((u) => [u.s, u]));
  const benchSym = mx.benchSym;
  const initMs = Date.now() - t0;

  const maxH = Math.max(...C.horizons);
  const scratch = { mu: new Float64Array(NF), sd: new Float64Array(NF) };

  function resolveIndex(sym, date) {
    const sq = mx.syms.indexOf(String(sym || "").toUpperCase());
    if (sq < 0) throw new Error(`symbol not in analog library: ${sym}`);
    const dates = mx.dates;
    let q;
    if (date == null || date === "latest") {
      q = nDates - 1;
      while (q > 0 && !mx.valid[sq * nDates + q]) q--;
    } else {
      q = dates.indexOf(date);
      if (q < 0) { let lo = 0, hi = dates.length - 1, best = -1;
        while (lo <= hi) { const mid = (lo + hi) >> 1; if (dates[mid] <= date) { best = mid; lo = mid + 1; } else hi = mid - 1; }
        q = best; }
      while (q > 0 && !mx.valid[sq * nDates + q]) q--;
    }
    return { sq, q };
  }

  function forward(b, j, H) {
    const p0 = mx.priceA[b + j];
    if (!(p0 > 0)) return { fwd: {}, mae: null, mfe: null, path: [] };
    const fwd = {};
    for (const h of C.horizons) {
      const t = j + h;
      const p = t < nDates ? mx.priceA[b + t] : NaN;
      fwd[h] = (Number.isFinite(p) && p > 0) ? p / p0 - 1 : null;
    }
    let lo = Infinity, hi = -Infinity;
    const path = [];
    for (let t = j + 1; t <= j + H && t < nDates; t++) {
      const L = mx.priceL[b + t], Hi = mx.priceH[b + t], cl = mx.priceA[b + t];
      if (Number.isFinite(L)) lo = Math.min(lo, L / p0 - 1);
      if (Number.isFinite(Hi)) hi = Math.max(hi, Hi / p0 - 1);
      if (Number.isFinite(cl)) path.push(cl / p0 - 1);
    }
    return { fwd, mae: Number.isFinite(lo) ? lo : null, mfe: Number.isFinite(hi) ? hi : null, path };
  }

  /**
   * @param {{sym?:string, sq?:number, date?:string, q?:number, horizon?:number, k?:number,
   *          shock?:Object, restrict?:{from?:string,to?:string}|null, poolMultiple?:number}} opts
   */
  function query(opts = {}) {
    const t0 = Date.now();
    const H = opts.horizon ?? C.horizon;
    const k = opts.k ?? C.k;
    const { sq, q } = opts.sq != null && opts.q != null ? opts : resolveIndex(opts.sym, opts.date);
    if (q < 0) throw new Error(`no session found for ${opts.sym} ${opts.date ?? ""}`);
    const qb = sq * nDates + q;
    if (!mx.valid[qb]) throw new Error(`no feature row for ${mx.syms[sq]} on ${mx.dates[q]}`);
    if (q < H + C.minHistory) throw new Error(`not enough history before ${mx.dates[q]} for a ${H}-session horizon`);

    const restrict = opts.restrict || null;
    let jLo = C.minHistory, jHi = q - H;
    if (restrict) {
      if (restrict.from) { let i = mx.dates.findIndex((d) => d >= restrict.from); if (i >= 0) jLo = Math.max(jLo, i); }
      if (restrict.to) { let i = -1; for (let t = mx.dates.length - 1; t >= 0; t--) if (mx.dates[t] <= restrict.to) { i = t; break; }
        if (i >= 0) jHi = Math.min(jHi, i); }
    }
    if (jHi < jLo) throw new Error("restriction window leaves no eligible analogs before the embargo date");

    // Query z-vector. A stress shock is applied here, in z-space, so the library is re-searched
    // against the counterfactual state rather than the observed one.
    const qrow = qb * NF;
    const qz = new Float64Array(NF);
    for (let f = 0; f < NF; f++) qz[f] = Z[qrow + f];
    const { mu, sd } = statsAt(st, q, scratch);
    if (opts.shock) {
      for (const [fname, raw] of Object.entries(opts.shock.raw || {})) {
        const f = FIDX[fname]; if (f == null) continue;
        let z = (raw - mu[f]) / sd[f]; z = Math.max(-C.zClip, Math.min(C.zClip, z)); qz[f] = z;
      }
      for (const [fname, dz] of Object.entries(opts.shock.z || {})) {
        const f = FIDX[fname]; if (f == null) continue;
        const base = Number.isFinite(qz[f]) ? qz[f] : 0;
        qz[f] = Math.max(-C.zClip, Math.min(C.zClip, base + dz));
      }
    }

    const heap = new TopK(Math.max(k * (opts.poolMultiple ?? C.poolMultiple), 2000));
    const NA = ACT.length;
    const minCov = C.minWeightCoverage;
    let scanned = 0, eligible = 0;
    for (let si = 0; si < nSym; si++) {
      const base = si * nDates;
      for (let j = jLo; j <= jHi; j++) {
        const b = base + j;
        if (!mx.valid[b]) continue;
        scanned++;
        const row = b * NF;
        let s = 0, wsum = 0;
        for (let t = 0; t < NA; t++) {
          const f = ACT[t];
          const a = qz[f], c = Z[row + f];
          if (!Number.isFinite(a) || !Number.isFinite(c)) continue;
          const d = a - c, ww = w[f];
          s += ww * d * d; wsum += ww;
        }
        if (wsum < minCov) continue;
        eligible++;
        heap.push(Math.sqrt(s / wsum), b);
      }
    }

    // Greedy constrained selection.
    const perDate = new Map(), bySym = new Map(), chosen = [];
    for (const cand of heap.drain()) {
      if (chosen.length >= k) break;
      const si = (cand.idx / nDates) | 0, j = cand.idx % nDates;
      const dkey = mx.dates[j];
      if ((perDate.get(dkey) || 0) >= C.maxPerCalendarDate) continue;
      const prev = bySym.get(si);
      if (prev) { let clash = false; for (const pj of prev) if (Math.abs(j - pj) < C.minSameSymbolGap) { clash = true; break; } if (clash) continue; }
      perDate.set(dkey, (perDate.get(dkey) || 0) + 1);
      if (prev) prev.push(j); else bySym.set(si, [j]);
      chosen.push({ si, j, dist: cand.dist });
    }

    const analogs = chosen.map(({ si, j, dist }) => {
      const b = si * nDates;
      const { fwd, mae, mfe } = forward(b, j, H);
      const row = (b + j) * NF;
      return {
        sym: mx.syms[si], name: meta[mx.syms[si]]?.n || mx.syms[si], sector: meta[mx.syms[si]]?.sec || null,
        date: mx.dates[j], idx: j, dist,
        sameName: mx.syms[si] === mx.syms[sq],
        fwd, mae, mfe,
        features: Object.fromEntries(FEATURES.map((f) => [f, Number.isFinite(mx.F[row + FIDX[f]]) ? mx.F[row + FIDX[f]] : null])),
        z: Object.fromEntries(FEATURES.map((f) => [f, Number.isFinite(Z[row + FIDX[f]]) ? Z[row + FIDX[f]] : null]))
      };
    });

    const qFeatures = Object.fromEntries(FEATURES.map((f) => [f, Number.isFinite(mx.F[qrow + FIDX[f]]) ? mx.F[qrow + FIDX[f]] : null]));
    const qRawZ = Object.fromEntries(FEATURES.map((f) => [f, Number.isFinite(Z[qrow + FIDX[f]]) ? Z[qrow + FIDX[f]] : null]));
    const qUsedZ = Object.fromEntries(FEATURES.map((f) => [f, Number.isFinite(qz[FIDX[f]]) ? qz[FIDX[f]] : null]));

    return {
      query: {
        sym: mx.syms[sq], name: meta[mx.syms[sq]]?.n || mx.syms[sq], sector: meta[mx.syms[sq]]?.sec || null,
        date: mx.dates[q], idx: q, price: mx.priceA[qb], features: qFeatures, z: qRawZ, zUsed: qUsedZ,
        stats: Object.fromEntries(FEATURES.map((f) => [f, { mu: mu[FIDX[f]], sd: sd[FIDX[f]] }]))
      },
      config: { ...C, horizon: H, k, nFeatures: NF, nMetricFeatures: NA, metricFeatures: active.map((f) => FEATURES[f]),
        exclude: [...(C.exclude || [])], restrict, shock: opts.shock || null },
      analogs,
      scan: { scanned, eligible, chosen: analogs.length, jLo, jHi, from: mx.dates[jLo], to: mx.dates[jHi] },
      timing: { initMs, queryMs: Date.now() - t0 },
      library: { nSym, nDates, from: mx.dates[0], to: mx.dates[nDates - 1], benchSym }
    };
  }

  return { C, ds, mx, st, Z, w, active, query, resolveIndex, maxH, initMs, benchSym };
}

export { FEATURES, NF, FIDX, GROUPS, buildMatrix };
