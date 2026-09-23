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
    const want = String(sym || "").trim().toUpperCase();
    const sq = mx.syms.indexOf(want);
    // Name the fix, not just the failure: this message reaches the UI toast and the API error body,
    // and a reviewer who typos a ticker should not have to go and read the source to recover.
    if (sq < 0) {
      throw new Error(want
        ? `symbol not in analog library: ${sym}. The library covers ${mx.syms.length} instruments - pick one from the Symbol dropdown.`
        : `no symbol given. Pick one of the ${mx.syms.length} instruments in the Symbol dropdown.`);
    }
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

  /**
   * Forward returns and path risk are measured on two different price bases, deliberately, and
   * never against each other:
   *   fwd[h]  A[j+h] / A[j] - 1 on the ADJUSTED close (split + dividend). That is the research
   *           definition of the outcome being predicted - the total return of holding the name.
   *   mae/mfe raw L and raw H over (j, j+H] divided by the RAW close at j. An intraday low is a
   *           traded price, so the only entry price it may be compared with is the traded close of
   *           the decision session. Using the adjusted close as that denominator puts a raw low over
   *           an adjusted close: for a dividend payer the ratio carries the cumulative dividend
   *           factor (0.47x on RTX), which inflates every excursion and reports a large favourable
   *           excursion - and even a positive median adverse excursion - on names that actually fell.
   *   path    adjusted closes over the adjusted entry, so the last path point equals fwd[H] exactly
   *           and the fan drawn from it is the return path, not a second price basis.
   */
  function forward(b, j, H) {
    const p0 = mx.priceA[b + j];
    if (!(p0 > 0)) return { fwd: {}, mae: null, mfe: null, path: [] };
    const p0Raw = mx.priceC[b + j];
    const rawEntry = Number.isFinite(p0Raw) && p0Raw > 0 ? p0Raw : null;
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
      if (rawEntry != null) {
        if (Number.isFinite(L)) lo = Math.min(lo, L / rawEntry - 1);
        if (Number.isFinite(Hi)) hi = Math.max(hi, Hi / rawEntry - 1);
      }
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
    if (q < 0) throw new Error(`no session found for ${mx.syms[sq]} on or before ${opts.date}: the library starts ${mx.dates[0]}`);
    const qb = sq * nDates + q;
    if (!mx.valid[qb]) {
      // resolveIndex walks backwards to the last valid row, so reaching here means there is none at
      // or before the requested date. Walk forwards to say which session does work.
      let first = 0;
      while (first < nDates && !mx.valid[sq * nDates + first]) first++;
      throw new Error(`${mx.syms[sq]} has no feature row on or before ${mx.dates[q]}`
        + (first < nDates
          ? ` - its first usable session is ${mx.dates[first]}, because the expanding z-scores need ${C.minHistory} sessions of history behind them`
          : ` - it has no usable feature row anywhere in the library`));
    }
    if (q < H + C.minHistory) {
      const earliest = Math.min(nDates - 1, H + C.minHistory);
      throw new Error(`${mx.dates[q]} is too early for ${mx.syms[sq]}: a ${H}-session horizon needs ${C.minHistory} sessions of feature history behind it, so the earliest queryable session is ${mx.dates[earliest]}`);
    }

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
        // price is the ADJUSTED close (the basis every forward return uses); priceRaw is the RAW
        // session close (the basis every MAE/MFE is measured from). Both are carried so a reader can
        // audit either number against the price series it belongs to.
        date: mx.dates[q], idx: q, price: mx.priceA[qb], priceRaw: mx.priceC[qb], features: qFeatures, z: qRawZ, zUsed: qUsedZ,
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
