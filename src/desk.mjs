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

/**
 * The 7x24 wrapper layer, as COMMITTED MEASUREMENT rather than a live call.
 *
 * research/LIMITATIONS.md §9 was explicit that the desk's headline claim - a market that never
 * closes - was the one thing it had never measured: every number came from a library of US daily
 * sessions, so "7x24" was narrative. scripts/measure-wrapper.mjs closes that gap against a venue
 * that is actually reachable, and writes data-cache/wrapper-probe.json. This function projects that
 * file onto one research card.
 *
 * Three deliberate choices:
 *  - It is read from disk at startup and baked into the static bundle, NOT fetched per request. A
 *    card must hash identically on the server and in a reviewer's browser tab or the replay cache
 *    misses, and a live order book changes every second. The snapshot is timestamped and the UI says so.
 *  - It never touches retrieval, the conformal scale or validation. Adding a venue must not be able
 *    to move a published figure. The wrapper block answers a different question: what the instrument
 *    you would actually trade at 03:00 on a Saturday adds on top of the underlying's distribution.
 *  - When a symbol has no verified wrapper, or the venue was unreachable, the card says so and still
 *    carries the calendar-derived closed-market share, which needs no venue at all. Nothing is
 *    estimated to fill the hole.
 *
 * Key naming is not cosmetic: verify-numbers.mjs whitelists integers found inside card fields whose
 * name matches /label|name|note|caveat|why|interpretation/i, because those are sentences the prose is
 * allowed to quote. Every human-readable string below therefore lives under one of those keys, so a
 * figure inside an explanatory sentence can never trip the numeric gate.
 */
export function createWrapperView(probe) {
  const ref = probe?.referenceMarket || null;
  const venueName = probe?.venue?.name || "tokenised-equity venue (not measured on this build)";
  const measuredAt = probe?.generatedAt || null;
  const summary = probe?.summary || null;
  const degraded = probe?.degradation || null;

  const referenceMarket = ref ? {
    closedSharePct: ref.closedSharePct,
    closedHoursPerWeek: ref.closedHoursPerWeek,
    cashOpenHoursPerWeek: ref.cashOpenHoursPerWeek,
    weekHours: ref.weekHours,
    sessionsPerWeek: ref.sessionsPerWeek,
    sessions: ref.sessions,
    from: ref.from,
    to: ref.to,
    note: ref.note
  } : null;

  const head = { status: null, symbol: null, venueName, measuredAt, referenceMarket };

  const forSymbol = (symbol) => {
    if (degraded) {
      return {
        ...head, status: "not-measured", symbol,
        degradation: { kind: degraded.kind, detail: degraded.detail, venueName: degraded.venue, disclosure: degraded.disclosure, probedAt: degraded.probedAt },
        caveatNote: degraded.disclosure
      };
    }
    const a = probe?.bySymbol?.[symbol];
    if (!a) {
      return {
        ...head, status: "no-verified-wrapper", symbol,
        reason: `No ${venueName} listing passed both verification tests against ${symbol}, so no wrapper figure is reported for it and none is estimated.`,
        candidatesTested: (probe?.rejected || []).filter((x) => x.sym === symbol).length,
        caveatNote: `The 7x24 measurement on this card is the reference-market calendar share only. ${symbol} has no verified tokenised wrapper on the measured venue, which is itself the finding: a desk that assumes every instrument is tradeable around the clock is assuming something false about this one.`
      };
    }
    const ch = a.closedHours || null;
    const ms = a.microstructure || null;
    return {
      ...head, status: "measured", symbol,
      instrument: a.pair, issuerSuffix: a.issuerSuffix,
      tracking: {
        returnCorrelation: a.returnCorrelation, trackingErrorBpPerDay: a.trackingErrorBpPerDay,
        tier: a.tier, tierLabel: a.tierLabel,
        overlapSessions: a.overlapSessions, from: a.from, to: a.to,
        note: `Daily returns of ${a.pair} against ${symbol} raw session closes over ${a.overlapSessions} overlapping sessions (${a.from} to ${a.to}). Tracking error is the standard deviation of the daily return difference, in basis points per day.`
      },
      premium: {
        medianPct: a.premiumMedianPct, p10Pct: a.premiumP10Pct, p90Pct: a.premiumP90Pct,
        priceDeviationPct: a.priceDeviationPct, wrapperLast: a.wrapperLast, lastRawClose: a.lastRawClose, lastRawCloseDate: a.lastRawCloseDate,
        note: `Premium of the wrapper over the underlying's RAW session close - the traded price against a traded price, never against the dividend-adjusted close, which sits below it by the cumulative dividend factor.`
      },
      liquidity: ms ? {
        spreadBps: ms.spreadBps, bestBid: ms.bestBid, bestAsk: ms.bestAsk, topOfBookUsdt: ms.topOfBookUsdt,
        depthWithin50BpsUsdt: ms.depthWithin50BpsUsdt, depthWithin200BpsUsdt: ms.depthWithin200BpsUsdt, levels: ms.levels,
        quoteVolume24hUsdt: a.quoteVolume24hUsdt, medianDailyQuoteVolumeUsdt: a.medianDailyQuoteVolumeUsdt,
        note: `Order-book snapshot at measuredAt. Resting depth is notional USDT within 50 bp and within 200 bp of the touch, both sides combined. It changes every second; this is the state at that timestamp, not a standing figure.`
      } : { spreadBps: null, depthWithin50BpsUsdt: null, quoteVolume24hUsdt: a.quoteVolume24hUsdt, medianDailyQuoteVolumeUsdt: a.medianDailyQuoteVolumeUsdt,
        note: a.microstructureError ? `The order book could not be read on this run (${a.microstructureError}); volume figures are from the ticker.` : "No order-book snapshot on this run." },
      sevenByTwentyFour: {
        referenceClosedSharePct: ref?.closedSharePct ?? null,
        referenceClosedHoursPerWeek: ref?.closedHoursPerWeek ?? null,
        closedMoveSharePct: ch?.referenceClosedMoveSharePct ?? null,
        closedHoursSharePct: ch?.referenceClosedHoursPct ?? null,
        tradedOutsideSessionPct: ch?.tradedOutsideSessionPct ?? null,
        hoursObserved: ch?.hoursObserved ?? null,
        conventionNote: ch?.convention ? `${ch.convention}. The reference-market closed share is derived from the library's own session calendar and needs no venue.` : null,
        note: ch
          ? `The measured core of the 7x24 claim. The reference cash market is shut for ${ref?.closedSharePct}% of the week, and ${ch.referenceClosedMoveSharePct}% of this wrapper's own realised hourly price movement over ${ch.hoursObserved} observed hours landed in those shut hours. It traded in ${ch.tradedOutsideSessionPct}% of them.`
          : "Hourly candles were unavailable for this pair on this run, so only the calendar-derived closed share is reported."
      },
      interpretation: `${a.pair} is a ${a.tierLabel} for ${symbol}: daily returns correlate at ${a.returnCorrelation} with a tracking error of ${a.trackingErrorBpPerDay} bp/day, and it prices within ${a.priceDeviationPct}% of the underlying's last raw close. It is the instrument a trader would actually hold outside cash hours - and outside those hours is where ${ch?.referenceClosedMoveSharePct ?? "most"}% of its own movement happens.`,
      caveat: `Measured on ${venueName}, not on a Bitget market-data feed: the Bitget official MCP is unreachable from this network and contributes nothing. A ${a.tier} tracker is not the underlying - at ${a.trackingErrorBpPerDay} bp/day of tracking error the wrapper carries its own idiosyncratic risk, and a premium band of ${a.premiumP10Pct}% to ${a.premiumP90Pct}% means the price you exit at can differ from the reference close the analog distribution is built on. Nothing here feeds the retrieval engine, the conformal scale or any validation figure.`
    };
  };

  return { probe: probe || null, available: Boolean(summary && !degraded), degraded: Boolean(degraded), referenceMarket, summary, forSymbol };
}

/**
 * Carry the measured closed-hours figure into the one scenario that has always claimed it. The
 * liquidity-air-pocket caveat used to read "gap20 is measured on the underlying exchange session, not
 * on a 7x24 venue" - an accurate admission of a gap. When the gap has been measured, the caveat says
 * so and quotes the measurement instead of only confessing to it.
 */
function annotateWrapperScenarios(card) {
  const w = card.wrapper;
  if (!w || w.status !== "measured") return;
  const s = (card.stress || []).find((x) => x.id === "liquidity-air-pocket");
  const closed = w.sevenByTwentyFour?.closedMoveSharePct;
  const refClosed = w.sevenByTwentyFour?.referenceClosedSharePct;
  if (!s || !Number.isFinite(closed)) return;
  s.caveat = `${s.caveat} Measured on the wrapper itself (${w.instrument}, ${w.venueName}): the reference market is closed for ${refClosed}% of the week and ${closed}% of the wrapper's realised hourly movement happened in those closed hours, so the gap risk this scenario describes is not hypothetical for the instrument a trader would hold.`;
}
export function createDesk({ dataset, validationResults = null, provenance = {}, config = {}, wrapper = null }) {
  const wrapperView = createWrapperView(wrapper);
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

    wrapper() { return { available: wrapperView.available, degraded: wrapperView.degraded, measuredAt: wrapperView.probe?.generatedAt || null, venueName: wrapperView.probe?.venue?.name || null, summary: wrapperView.summary, referenceMarket: wrapperView.referenceMarket, verified: Object.keys(wrapperView.probe?.bySymbol || {}).length }; },
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

      // The wrapper layer is attached AFTER buildCard rather than passed into it: buildCard describes
      // the analog analysis, and this block describes the instrument that analysis would be traded
      // through. Keeping them separate is what makes it obvious that no retrieval figure depends on it.
      card.wrapper = wrapperView.forSymbol(base.query.sym);
      annotateWrapperScenarios(card);

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