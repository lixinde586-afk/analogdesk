/**
 * AnalogDesk - the research card.
 *
 * This is the ONLY object the language model is allowed to see, and therefore the only source a
 * number in the generated narrative can legitimately come from. It is built from engine output,
 * pre-rounded into display units, and self-describing: every field the prose may cite is present,
 * and nothing else is. Keeping the payload closed is what makes src/llm/verify-numbers.mjs a real
 * gate rather than a formality - if a figure is not in the card, the model cannot cite it and the
 * gate will reject the draft if it tries.
 */

import { FEATURES, GROUPS } from "../engine/features.mjs";
import { summarize, histogram, pct } from "../engine/distribution.mjs";

export const FEATURE_LABELS = {
  ret5: "5-session return", ret20: "20-session return", ret60: "60-session return",
  dist52: "distance from 52-week high", vol20: "20-session realised volatility (annualised)",
  volRatio: "5d/20d volatility ratio", dd60: "drawdown from 60-session peak",
  relBench20: "20-session return vs benchmark", gap20: "mean absolute overnight/weekend gap, 20 sessions",
  dv20z: "20-session dollar-volume regime z-score",
  mktRet20: "benchmark 20-session return", mktDist52: "benchmark distance from 52-week high",
  mktVol20: "benchmark 20-session volatility", vix: "VIX level", vixChg5: "5-session VIX change",
  growthRel20: "growth-vs-broad 20-session relative return",
  slope: "10y-2y Treasury slope", dRate90: "Fed funds target change, 90 days",
  beiChg20: "10y breakeven inflation change, 20 days", usdChg20: "trade-weighted USD change, 20 days",
  oilChg20: "WTI crude change, 20 days", hyChg20: "high-yield OAS change, 20 days (bp)",
  btcRet5: "BTC 5-day return", btcRet20: "BTC 20-day return", fng: "crypto fear & greed (0-1)",
  dte: "calendar days to next earnings release (capped at 45)",
  eventLoad5: "scheduled event load, next 5 sessions", isFomcDay: "is an FOMC decision day"
};

export const FEATURE_UNITS = {
  ret5: "pct", ret20: "pct", ret60: "pct", dist52: "pct", vol20: "pct", volRatio: "ratio",
  dd60: "pct", relBench20: "pct", gap20: "pct", dv20z: "z",
  mktRet20: "pct", mktDist52: "pct", mktVol20: "pct", vix: "level", vixChg5: "pct", growthRel20: "pct",
  slope: "level", dRate90: "bp", beiChg20: "bp", usdChg20: "pct", oilChg20: "pct", hyChg20: "bp",
  btcRet5: "pct", btcRet20: "pct", fng: "level", dte: "days", eventLoad5: "count", isFomcDay: "flag"
};

const PCT_FEATURES = new Set(Object.entries(FEATURE_UNITS).filter(([, u]) => u === "pct").map(([k]) => k));

export function displayFeature(name, value) {
  if (value == null || !Number.isFinite(value)) return null;
  if (PCT_FEATURES.has(name)) return Number((value * 100).toFixed(2));
  if (FEATURE_UNITS[name] === "bp") return Number(value.toFixed(2));
  return Number(value.toFixed(3));
}

export const horizonLabel = (H) => (H === 1 ? "1 session (next close)"
  : H === 5 ? "5 sessions (one trading week)"
  : H === 10 ? "10 sessions (two trading weeks)"
  : H === 20 ? "20 sessions (one trading month)"
  : H === 40 ? "40 sessions (two trading months)"
  : `${H} sessions`);

/** Rank the state description by |z| so the prose leads with what is actually distinctive. */
export function notableFeatures(query, { top = 8, exclude = [] } = {}) {
  const ex = new Set(exclude);
  return FEATURES
    .filter((f) => !ex.has(f))
    .map((f) => ({ feature: f, label: FEATURE_LABELS[f] || f, unit: FEATURE_UNITS[f] || "level",
      value: displayFeature(f, query.features[f]), z: query.z[f], zUsed: query.zUsed[f] }))
    .filter((x) => x.z != null && Number.isFinite(x.z))
    .sort((a, b) => Math.abs(b.z) - Math.abs(a.z))
    .slice(0, top);
}

export function buildCard({ result, stress = null, validation = null, provenance = {}, conformal = null }) {
  const q = result.query;
  const H = result.config.horizon;
  const A = result.analogs;
  const rets = A.map((a) => a.fwd?.[H]).filter((x) => x != null && Number.isFinite(x));
  const s = summarize(rets, { mae: A.map((a) => a.mae), mfe: A.map((a) => a.mfe) });
  const hist = histogram(rets, 24);

  const bySector = {}, byYear = {};
  for (const a of A) {
    if (a.sector) bySector[a.sector] = (bySector[a.sector] || 0) + 1;
    const y = a.date.slice(0, 4); byYear[y] = (byYear[y] || 0) + 1;
  }

  const card = {
    schema: "analogdesk.research-card/1",
    generatedAt: new Date().toISOString(),
    idea: {
      symbol: q.sym, name: q.name, sector: q.sector, asOfSession: q.date,
      // two bases, both traceable: referenceClose drives every forward return on the card,
      // referenceCloseRaw is the traded close the MAE/MFE excursions are measured from.
      referenceClose: q.price == null || !Number.isFinite(q.price) ? null : Number(q.price.toFixed(4)),
      referenceCloseRaw: q.priceRaw == null || !Number.isFinite(q.priceRaw) ? null : Number(q.priceRaw.toFixed(4)),
      returnBasis: "adjusted close, A[q+H]/A[q] - 1",
      pathRiskBasis: "raw session OHLC, raw low/high over the raw close of the decision session",
      horizonSessions: H, horizonLabel: horizonLabel(H)
    },
    currentState: {
      notable: notableFeatures(q, { top: 8, exclude: [] }),
      allFeatures: FEATURES.map((f) => ({ feature: f, label: FEATURE_LABELS[f] || f, unit: FEATURE_UNITS[f] || "level",
        value: displayFeature(f, q.features[f]), z: q.z[f] == null || !Number.isFinite(q.z[f]) ? null : Number(q.z[f].toFixed(3)) })),
      groups: GROUPS.map((g) => ({ group: g.g, weightPct: Number((g.w * 100).toFixed(0)), features: g.f }))
    },
    retrieval: {
      kRequested: result.config.k, kReturned: A.length,
      distinctSessions: new Set(A.map((a) => a.date)).size,
      distinctSymbols: new Set(A.map((a) => a.sym)).size,
      sameSymbolCount: A.filter((a) => a.sameName).length,
      closestDistance: A.length ? Number(A[0].dist.toFixed(4)) : null,
      medianDistance: A.length ? Number(A[A.length >> 1].dist.toFixed(4)) : null,
      analogDateFrom: A.length ? A.map((a) => a.date).sort()[0] : null,
      analogDateTo: A.length ? A.map((a) => a.date).sort().at(-1) : null,
      embargoSessions: H,
      bySector, byYear,
      top: A.slice(0, 12).map((a) => ({
        symbol: a.sym, name: a.name, sector: a.sector, session: a.date,
        distance: Number(a.dist.toFixed(4)),
        forwardReturnPct: a.fwd?.[H] == null ? null : Number((a.fwd[H] * 100).toFixed(2)),
        maxAdverseExcursionPct: a.mae == null ? null : Number((a.mae * 100).toFixed(2)),
        maxFavourableExcursionPct: a.mfe == null ? null : Number((a.mfe * 100).toFixed(2))
      }))
    },
    distribution: s.n ? {
      horizonSessions: H, n: s.n,
      meanPct: pct(s.mean), medianPct: pct(s.median), sdPct: pct(s.sd),
      p10Pct: pct(s.p10), p25Pct: pct(s.p25), p75Pct: pct(s.p75), p90Pct: pct(s.p90),
      minPct: pct(s.min), maxPct: pct(s.max),
      skew: Number.isFinite(s.skew) ? Number(s.skew.toFixed(3)) : null,
      probabilityBelow: { minus5Pct: pct(s.prob?.["-0.05"], 1), minus10Pct: pct(s.prob?.["-0.1"], 1), minus20Pct: pct(s.prob?.["-0.2"], 1) },
      probabilityAboveZeroPct: pct(s.prob?.["0"], 1),
      probabilityBelowZeroPct: pct(1 - (s.prob?.["0"] ?? 0), 1),
      valueAtRisk90Pct: pct(s.var90), conditionalVar90Pct: pct(s.cvar90),
      histogram: hist.bins.map((b) => ({ midpointPct: Number((b.mid * 100).toFixed(2)), sharePct: Number((b.p * 100).toFixed(1)) }))
    } : null,
    excursion: s.n && s.mae ? {
      horizonSessions: H,
      maxAdverseMedianPct: pct(s.mae.median), maxAdverseP10Pct: pct(s.mae.p10), maxAdverseP25Pct: pct(s.mae.p25),
      maxFavourableMedianPct: pct(s.mfe?.median), maxFavourableP75Pct: pct(s.mfe?.p75), maxFavourableP90Pct: pct(s.mfe?.p90),
      probabilityOfBreaching: Object.fromEntries(Object.entries(s.mae.breach || {}).map(([k, v]) => [`${Math.round(Number(k) * 100)}PctDrawdown`, pct(v, 1)])),
      rewardRiskRatio: s.mfe?.median != null && s.mae?.median ? Number(Math.abs(s.mfe.median / s.mae.median).toFixed(2)) : null
    } : null,
    conformal: conformal ? {
      coverageTargetPct: conformal.targetPct, scale: Number(Number(conformal.scale).toFixed(3)),
      lowerPct: conformal.loPct, upperPct: conformal.hiPct, widthPct: conformal.widthPct,
      fittedOn: conformal.fittedOn,
      outOfSampleCoveragePct: conformal.oosCoveragePct, outOfSampleSEPp: conformal.oosSEPp,
      testEra: conformal.testEra, testQueries: conformal.testQueries,
      interpretation: "Interval is median +/- scale x sd of the analog sample. The scale is fitted on 2019-2022 only and frozen; the coverage figure is measured on 2023 onward."
    } : null,
    stress: stress ? stress.scenarios.map((sc) => ({
      id: sc.id, label: sc.label, kind: sc.kind, tags: sc.tags,
      why: sc.why, caveat: sc.caveat, skipped: sc.skipped, analogsUsed: sc.n,
      medianForwardPct: sc.medianPct, p10ForwardPct: sc.p10Pct, p90ForwardPct: sc.p90Pct,
      probabilityBelowMinus10Pct: sc.probLoss10 == null ? null : Number((sc.probLoss10 * 100).toFixed(1)),
      maxAdverseMedianPct: sc.maeMedianPct,
      probabilityOfBreaching10PctDrawdown: sc.breach10Pct == null ? null : Number((sc.breach10Pct * 100).toFixed(1)),
      heldWithin10PctDrawdownPct: sc.holdableWithin10pct == null ? null : Number((sc.holdableWithin10pct * 100).toFixed(1)),
      deltaMedianVsBaselinePct: sc.deltaMedianPct == null ? null : Number(sc.deltaMedianPct.toFixed(2)),
      fan: (sc.fan || []).filter((_, i) => i % Math.max(1, Math.ceil((sc.fan || []).length / 12)) === 0).map((p) => ({
        session: p.t, p10Pct: p.p10 == null ? null : Number((p.p10 * 100).toFixed(2)),
        p50Pct: p.p50 == null ? null : Number((p.p50 * 100).toFixed(2)),
        p90Pct: p.p90 == null ? null : Number((p.p90 * 100).toFixed(2))
      }))
    })) : null,
    validation: validation || null,
    provenance
  };
  return card;
}

/** Compact validation block for the card - headline figures only, no per-symbol tables. */
export function validationSummary(V) {
  if (!V) return null;
  const H = V.headline.horizon;
  const r = V.results;
  return {
    primaryHorizonSessions: H,
    protocol: `calibration ${V.protocol.eras.calibration.from}..${V.protocol.eras.calibration.to}, test ${V.protocol.eras.test.from}..${V.library.to}, ${V.headline.testN} out-of-sample queries over ${V.library.nSym} instruments`,
    targetCoveragePct: Number((V.protocol.coverage * 100).toFixed(0)),
    analog: { coveragePct: r.analogConformal.testEra.coveragePct, coverageSEPp: r.analogConformal.testEra.coverageSEPct, widthPct: r.analogConformal.testEra.widthPct, fittedScale: Number(V.fit.analogConformal.scale.toFixed(3)), matchedCoverageWidthPct: r.analogConformal.matched.widthPct },
    benchmarks: Object.fromEntries(["analogRaw", "uncondNamePIT", "volHarness", "pooledUncond"].map((k) => [k, {
      coveragePct: r[k].testEra.coveragePct, widthPct: r[k].testEra.widthPct, matchedCoverageWidthPct: r[k].matched.widthPct }])),
    matchedCoverageSharpnessVsSameNamePct: V.headline.matchedCoverageSharpnessGainPct,
    perSymbolCoverageSdPp: { analogConformal: Number(V.bySymbol.dispersion.analogConformal.coverageSdPp.toFixed(1)), uncondNamePIT: Number(V.bySymbol.dispersion.uncondNamePIT.coverageSdPp.toFixed(1)), pooledUncond: Number(V.bySymbol.dispersion.pooledUncond.coverageSdPp.toFixed(1)) },
    pitChiSquare: Number(V.pit.chiSquare.toFixed(1)), pitChiSquareCritical5Pct: V.pit.chiSquareCritical5pct,
    directionalHitRatePct: V.directional.hitRate,
    meanRetrievalMs: Number(V.timing.meanQueryMs.toFixed(1)),
    honestVerdict: "Analog retrieval hits its coverage target out of sample and its width tracks each instrument's own volatility, but it is NOT sharper than a same-name unconditional band at matched coverage, and its raw PIT distribution fails a uniformity test. It is a stress-testing and provenance instrument, not an alpha source. See research/VALIDATION.md and research/LIMITATIONS.md."
  };
}