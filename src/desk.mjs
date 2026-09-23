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

/**
 * The retrieval grid this desk will actually run on, and the one setting whose numbers are published.
 *
 * Every out-of-sample figure in research/VALIDATION.md, the frozen conformal scale, and the demo run
 * record were produced at k=${VALIDATED_K}. A request for k=999 is not invalid - it just is not
 * the thing that was measured, so the desk clamps it into a defensible range and says so out loud
 * instead of quietly handing back a card whose validation panel describes a different experiment.
 */
export const VALIDATED_K = DEFAULT_K;
export const K_MIN = 10;
export const K_MAX = 200;

const clip = (v, n = 48) => { const s = String(v); return s.length > n ? s.slice(0, n) + "\u2026" : s; };

/**
 * Snap one request onto the grid the engine and its validation cover, and record every adjustment.
 *
 * Horizons are a closed set: forward returns are precomputed for C.horizons only, so an off-grid
 * horizon used to produce a card with a null distribution - the UI then rendered a row of en-dashes
 * and no explanation, which is worse than an error because it looks like a result. Off-grid values
 * are snapped to the nearest measured horizon and the snap is disclosed.
 */
function normalizeRequest({ horizon, k, horizons }) {
  const notes = [];

  const hRaw = Number(horizon);
  let H, horizonSnapped = false;
  if (!Number.isFinite(hRaw) || hRaw <= 0) {
    H = DEFAULT_HORIZON;
    notes.push(`No usable horizon in the request (${clip(horizon)}), so the ${DEFAULT_HORIZON}-session default was used.`);
  } else if (horizons.includes(hRaw)) {
    H = hRaw;
  } else {
    H = horizons.reduce((best, h) => (Math.abs(h - hRaw) < Math.abs(best - hRaw) ? h : best));
    horizonSnapped = true;
    notes.push(`Horizon ${hRaw} sessions is not one this engine measures; snapped to the nearest supported horizon, ${H} sessions. The forward returns, the conformal scale and the validation panel on this card all describe ${H}-session outcomes.`);
  }

  const kRaw = Number(k);
  let K, kClamped = false;
  if (!Number.isFinite(kRaw) || kRaw <= 0) {
    K = DEFAULT_K;
    notes.push(`No usable neighbour count in the request (${clip(k)}), so the validated k=${DEFAULT_K} was used.`);
  } else {
    K = Math.round(kRaw);
    if (K < K_MIN) {
      kClamped = true;
      notes.push(`k=${K} is below the ${K_MIN}-neighbour floor: a distribution summarised from fewer than ${K_MIN} episodes has no meaningful spread, and the conformal interval needs at least 10. Raised to k=${K_MIN}.`);
      K = K_MIN;
    } else if (K > K_MAX) {
      kClamped = true;
      notes.push(`k=${K} is above the ${K_MAX}-neighbour ceiling: past that point the retrieved states stop resembling the query and the card reads as a market average. Lowered to k=${K_MAX}.`);
      K = K_MAX;
    }
  }

  if (K !== VALIDATED_K) {
    notes.push(`This card was run at k=${K}, not the validated k=${VALIDATED_K}: the frozen conformal scale and every out-of-sample figure below were fitted and measured at k=${VALIDATED_K}, so they describe that configuration, not this one. The retrieval, the distribution and the stress suite on this card were computed at k=${K}.`);
  }

  return { H, K, notes, horizonSnapped, kClamped, horizonBeforeSnap: horizonSnapped ? hRaw : null, kBeforeClamp: kClamped ? Math.round(kRaw) : null };
}

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
            // the last TRADED close (raw basis). The dividend-adjusted close is not a price anyone
            // can transact at, so it is never presented as one; adjusted levels stay inside returns.
            lastClose: Number.isFinite(mx.priceC[b + last]) ? Number(mx.priceC[b + last].toFixed(4)) : null,
            lastCloseBasis: "raw session close (split-adjusted, not dividend-adjusted)",
          };
        }),
        sessions: mx.nDates, from: mx.dates[0], to: mx.dates[mx.nDates - 1],
        // The full session calendar, so a relative date ("10 个交易日前") resolves to a real session
        // instead of an approximate calendar day. 2513 short strings; the browser bundle already
        // carries the dataset this comes from.
        dates: mx.dates.slice(), horizons: engine.C.horizons,
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
    analyze({ symbol, date = "latest", horizon = DEFAULT_HORIZON, k = DEFAULT_K, scenarios = null, includeStress = true, riskTolerancePct = null } = {}) {
      const req = normalizeRequest({ horizon, k, horizons: engine.C.horizons });
      const { H, K } = req;
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

      // A card with no distribution is not a result: the UI would render a row of en-dashes and the
      // narrative would have nothing to say about outcomes. Fail with the reason and the way out.
      if (!card.distribution) {
        const n = base.analogs.length;
        throw new Error(n
          ? `no completed ${H}-session outcome to summarise: ${n} analogs were retrieved for ${base.query.sym} as of ${base.query.date}, but none of them has a realised ${H}-session forward return in the library. Try a shorter horizon or an earlier as-of date.`
          : `no analogs could be retrieved for ${base.query.sym} as of ${base.query.date} at a ${H}-session horizon with k=${K}. The state may sit outside anything the library has seen, or too close to its ${engine.mx.dates[0]} start. Try a later as-of date or a shorter horizon.`);
      }

      // Echo what the request asked for and what the desk actually ran. Numbers live here so the
      // numeric gate's payload allowlist covers them; the prose array is disclosure, not a claim.
      Object.assign(card.retrieval, {
        horizonBeforeSnap: req.horizonBeforeSnap,
        horizonSnapped: req.horizonSnapped,
        kBeforeClamp: req.kBeforeClamp,
        kClamped: req.kClamped,
        kBounds: { min: K_MIN, max: K_MAX },
        validatedK: VALIDATED_K,
        notes: req.notes
      });

      // Personalisation, and the only kind this desk accepts: a drawdown tolerance the person asking
      // STATED in their own words. Nothing is inferred about them, nothing is remembered between
      // requests, and the answer is computed from the same analog sample as everything else on the card
      // - each episode's maximum adverse excursion, i.e. the lowest raw intraday low inside the
      // horizon against the RAW close of the decision session (one price basis, never the adjusted
      // close, which sits below it by the cumulative dividend factor). The key is only added when a tolerance was
      // given, so a default card is byte-identical to the one the replay cache and the demo record were
      // built from.
      const tol = Number(riskTolerancePct);
      if (Number.isFinite(tol) && tol > 0) {
        const level = Math.min(50, Math.max(1, tol));
        const maes = base.analogs.map((a) => a.mae).filter((x) => x != null && Number.isFinite(x));
        const breached = maes.filter((x) => x <= -level / 100).length;
        const breachedSharePct = maes.length ? Number(((breached / maes.length) * 100).toFixed(1)) : null;
        card.personalization = {
          kind: "statedDrawdownTolerance",
          tolerancePct: level,
          horizonSessions: H,
          measuredOn: maes.length,
          breachedCount: breached,
          breachedSharePct,
          heldSharePct: breachedSharePct == null ? null : Number((100 - breachedSharePct).toFixed(1)),
          measure: "maximum adverse excursion: the lowest raw intraday low inside the horizon, against the raw close of the decision session",
          verdict: breachedSharePct == null
            ? "No analog in this sample has a usable path, so the stated tolerance cannot be checked."
            : breachedSharePct >= 50
              ? `In ${breachedSharePct}% of the ${maes.length} retrieved episodes the price traded at least ${level}% below the decision-session close inside ${H} sessions. A stop at that level would have been hit in the majority of analogs.`
              : `In ${breachedSharePct}% of the ${maes.length} retrieved episodes the price traded at least ${level}% below the decision-session close inside ${H} sessions; the rest never marked down that far.`,
          caveat: "A statement about the retrieved sample, not a prediction. It is measured on daily lows, so it cannot see an overnight or weekend gap straight through the level, and it says nothing about whether the position would have been worth holding afterwards."
        };
      }

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