/**
 * AnalogDesk - desk orchestration.
 *
 * Isomorphic: server.mjs runs it in Node, scripts/compile-bundle.mjs ships the same module to the
 * browser so the static deployment executes the FULL engine client-side rather than replaying
 * canned answers. One code path means the two deployments cannot disagree about a number.
 *
 * A desk holds one engine (built once, ~0.6s) and answers three things:
 *   analyze()  -> the research card plus the full analog detail the UI renders
 *   narrate()  -> the card plus prose, in LIVE / REPLAY / TEMPLATE mode, through the numeric gate
 *   validate() -> the frozen out-of-sample summary, per horizon
 */

import { createEngine, DISTANCE_EXCLUDE } from "./engine/analog.mjs";
import { FEATURES, GROUPS, NF } from "./engine/features.mjs";
import { stressReport, SCENARIOS } from "./engine/stress.mjs";
import { summarize, histogram, pct } from "./engine/distribution.mjs";
import { buildCard, validationSummary, horizonLabel } from "./llm/card.mjs";

export const DEFAULT_HORIZON = 5;
export const DEFAULT_K = 50;

export function createDesk({ dataset, validationResults = null, provenance = {}, config = {} }) {
  const t0 = Date.now();
  const engine = createEngine(dataset, { k: DEFAULT_K, horizon: DEFAULT_HORIZON });

  // Per-horizon conformal parameters, taken from the frozen validation run. Nothing here is fitted
  // at request time: a live request may not re-calibrate on data the trader is asking about.
  const conformalByHorizon = {};
  for (const [hStr, run] of Object.entries(validationResults?.runs || {})) {
    const H = Number(hStr);
    if (!Number.isFinite(H) || !run?.fit?.analogConformal) continue;
    conformalByHorizon[H] = {
      scale: Number(run.fit.analogConformal.scale.toFixed(4)),
      // protocol.coverage is a FRACTION (0.8). pct() multiplies by 100, so passing coverage*100 here
      // produced 8000 and every "80% target" in the UI and the prose read as "8000%".
      targetPct: Number((run.protocol.coverage * 100).toFixed(0)),
      oosCoveragePct: run.results.analogConformal.testEra.coveragePct,
      oosSEPp: run.results.analogConformal.testEra.coverageSEPct,
      oosWidthPct: run.results.analogConformal.testEra.widthPct,
      fittedOn: `${run.protocol.eras.calibration.from}..${run.protocol.eras.calibration.to}`,
      testEra: `${run.protocol.eras.test.from}..${run.library.to}`,
      testQueries: run.headline.testN
    };
  }
  const validationByHorizon = {};
  for (const [hStr, run] of Object.entries(validationResults?.runs || {})) {
    const H = Number(hStr);
    if (Number.isFinite(H)) validationByHorizon[H] = validationSummary(run);
  }

  const desk = {
    engine,
    dataset,
    config,
    scenarios: SCENARIOS.map((s) => ({ id: s.id, label: s.label, kind: s.kind, tags: s.tags, why: s.why, caveat: s.caveat })),
    horizons: engine.C.horizons,
    defaultHorizon: DEFAULT_HORIZON,
    initMs: Date.now() - t0,

    library() {
      const { mx } = engine;
      return {
        symbols: mx.syms.map((s) => {
          const u = (dataset.meta?.universe || []).find((x) => x.s === s);
          const b = mx.syms.indexOf(s) * mx.nDates;
          let last = mx.nDates - 1;
          while (last > 0 && !mx.valid[b + last]) last--;
          let first = 0;
          while (first < mx.nDates && !mx.valid[b + first]) first++;
          return {
            symbol: s, name: u?.n || s, sector: u?.sec || null, etf: Boolean(u?.etf),
            firstSession: mx.dates[first], lastSession: mx.dates[last],
            sessions: mx.valid.slice(b, b + mx.nDates).reduce((a, x) => a + x, 0),
            lastClose: Number.isFinite(mx.priceA[b + last]) ? Number(mx.priceA[b + last].toFixed(4)) : null
          };
        }),
        sessions: mx.nDates, from: mx.dates[0], to: mx.dates[mx.nDates - 1],
        benchSym: mx.benchSym, features: FEATURES, groups: GROUPS, nFeatures: NF,
        excludedFromDistance: DISTANCE_EXCLUDE
      };
    },

    validation(H = DEFAULT_HORIZON) { return validationByHorizon[H] || null; },
    allValidation() { return validationByHorizon; },
    conformal(H = DEFAULT_HORIZON) { return conformalByHorizon[H] || null; },

    /**
     * Full analysis for one trade idea.
     * @returns {{card:object, detail:object}}
     */
    analyze({ symbol, date = "latest", horizon = DEFAULT_HORIZON, k = DEFAULT_K, scenarios = null, includeStress = true } = {}) {
      const H = Number(horizon) || DEFAULT_HORIZON;
      const K = Number(k) || DEFAULT_K;
      const t0 = Date.now();
      const base = engine.query({ sym: symbol, date, horizon: H, k: K });
      const stress = includeStress ? stressReport(engine, { sym: symbol, date, horizon: H, k: K, scenarios: scenarios || SCENARIOS }) : null;

      const prov = {
        ...provenance,
        sessions: engine.mx.nDates, symbols: engine.mx.nSym,
        // Retrieval settings, echoed into the card so the provenance panel and the numeric gate both
        // read them from the payload rather than from a constant duplicated in the UI.
        nFeatures: base.config.nFeatures,
        metricFeatures: base.config.metricFeatures?.length ?? null,
        metricFeatureNames: base.config.metricFeatures ?? null,
        excludedFromDistance: base.config.exclude || DISTANCE_EXCLUDE,
        zClip: base.config.zClip, maxPerCalendarDate: base.config.maxPerCalendarDate,
        minSameSymbolGap: base.config.minSameSymbolGap, minWeightCoverage: base.config.minWeightCoverage,
        from: engine.mx.dates[0], to: engine.mx.dates[engine.mx.nDates - 1],
        datasetBuiltAt: dataset.meta?.builtAt || null,
        priceSource: dataset.meta?.sources?.prices || null,
        earningsSource: dataset.meta?.sources?.earningsDates || null,
        horizonLabel: horizonLabel(H)
      };

      const card = buildCard({
        result: base, stress, provenance: prov,
        validation: validationByHorizon[H] || null,
        conformal: conformalFor(base, conformalByHorizon[H], H)
      });

      const rets = base.analogs.map((a) => a.fwd?.[H]).filter((x) => x != null && Number.isFinite(x));
      const detail = {
        query: base.query, config: base.config, library: base.library, scan: base.scan,
        analogs: base.analogs,
        distribution: summarize(rets, { mae: base.analogs.map((a) => a.mae), mfe: base.analogs.map((a) => a.mfe) }),
        histogram: histogram(rets, 30),
        baselineFan: stress?.baseline?.fan || null,
        baselineTail: stress?.baseline?.tail || null,
        stress: stress ? stress.scenarios.map((s) => ({ ...s, result: undefined })) : [],
        stressFan: stress ? stress.baseline.fan : null,
        timing: { analyzeMs: Date.now() - t0, retrievalMs: base.timing.queryMs, engineInitMs: engine.initMs }
      };
      return { card, detail };
    }
  };
  return desk;
}

/** Build the conformal interval for THIS query from the frozen scale, and expose its parameters. */
function conformalFor(result, fit, H) {
  if (!fit || !Number.isFinite(fit.scale)) return null;
  const rets = result.analogs.map((a) => a.fwd?.[H]).filter((x) => x != null && Number.isFinite(x));
  if (rets.length < 10) return null;
  const s = summarize(rets, {});
  if (!Number.isFinite(s.sd) || !(s.sd > 0)) return null;
  const half = fit.scale * s.sd;
  return {
    ...fit,
    loPct: pct(s.median - half), hiPct: pct(s.median + half), widthPct: pct(2 * half),
    medianPct: pct(s.median), analogSdPct: pct(s.sd),
    horizonSessions: H
  };
}

export { SCENARIOS, horizonLabel };