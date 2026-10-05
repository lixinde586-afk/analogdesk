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
import { buildSignalsView } from "./data/signals.mjs";

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
 * What the parser understood that the engine cannot act on, said out loud on the card.
 *
 * normalizeRequest() discloses the adjustments the ENGINE makes (a snapped horizon, a clamped k).
 * This discloses the narrowing the LANGUAGE layer makes, which is the more dangerous kind: nothing
 * failed, the card is internally consistent, and every number on it is real - it is just not the
 * number the sentence asked for. A short question answered with long-side statistics, a sector word
 * answered with one ETF, a two-name comparison answered for one name: each produces a confident,
 * well-formed, wrong-scope card. So each one prints what was asked, what was run, and why those two
 * are not the same thing.
 *
 * Every field defaults to null and the function returns [] when nothing is set, so a card built
 * without this layer - every record in the replay cache, the committed demo run - is byte-identical
 * to the one it was warmed from. scripts/check-replay.mjs asserts that.
 *
 * Bilingual because the disclosure is only a disclosure if the person who asked can read it.
 */
function discloseIntent({ positionDirection = null, droppedInstruments = null, sectorProxy = null, ambiguousAlias = null, unheld = null, symbol = null } = {}, language = "en") {
  const zh = String(language) === "zh";
  const notes = [];
  const dropped = Array.isArray(droppedInstruments) ? droppedInstruments.filter((d) => d && d.symbol && d.symbol !== symbol) : [];

  if (dropped.length) {
    const syms = dropped.map((d) => d.symbol);
    // Grammatically enumerated rather than comma-joined: "You named 2 instruments (AMD)" reads as a
    // bug, and a disclosure that reads as a bug does not get read as a disclosure.
    const listed = zh ? syms.join("、")
      : syms.length === 1 ? syms[0] : syms.slice(0, -1).join(", ") + " and " + syms[syms.length - 1];
    const named = zh ? symbol + "、" + syms.join("、")
      : syms.length === 1 ? symbol + " and " + syms[0] : symbol + ", " + listed;
    notes.push(zh
      ? "你在一句话里提到了 " + (syms.length + 1) + " 个标的（" + named + "）。本桌面一次只分析一个标的，没有对比模式，所以这张卡片只关于 " + symbol + "。" + listed + " 没有与它做比较、对冲、相关性或基准对照，下面没有任何相对结论。请分别提问，再把两张卡片并排读。"
      : "You named " + (syms.length + 1) + " instruments in one sentence: " + named + ". This desk analyses one at a time and has no comparison mode, so this card is about " + symbol + " only. " + listed + (syms.length === 1 ? " was" : " were") + " not compared, netted, correlated or benchmarked against it, and nothing below is a relative view. Ask for each name separately and read the two cards side by side.");
  }

  if (positionDirection === "short") {
    notes.push(zh
      ? "你问的是做空，这张卡片没有按做空重算。下面所有数字——类比分布、分位数、保形区间和压力情景——都基于检索到的历史片段的做多方向远期收益，因此描述的是标的本身怎么走，不是做空能赚多少。请把尾部反着读：这里列为最差的情景对做空伤害最小，上行尾部才是最伤的。同理，回撤承受面板（如果有）也是做多口径的统计。"
      : "You asked about a SHORT position and this card was not recomputed for one. Every figure below - the analog distribution, the percentiles, the conformal interval and the stress suite - is built from the LONG-side forward return of the retrieved episodes, so it describes what the instrument did, not what a short would have earned. Read the tails in reverse: the scenarios named here as the worst outcomes are the ones that hurt a short least, and the upside tail is the one that hurts it most. The stated-drawdown panel, when present, is a long-side statistic for the same reason.");
  }

  if (sectorProxy) {
    notes.push(zh
      ? "「" + sectorProxy.word + "」指的是一个板块或篮子，不是单一标的。本库没有与之完全对应的标的，这张卡片分析的是 " + sectorProxy.have + "。" + (sectorProxy.whyZh || sectorProxy.why)
      : '"' + sectorProxy.word + '" names a sector or a basket, not one instrument. You asked for ' + sectorProxy.want + '; this card analyses ' + sectorProxy.have + ". " + sectorProxy.why);
  }

  if (ambiguousAlias) {
    notes.push(String(zh ? (ambiguousAlias.whyZh || ambiguousAlias.why) : ambiguousAlias.why));
  }

  // Reached only when a held instrument was analysed BESIDE an unheld one ("bitcoin and NVDA").
  // The unheld-only case never gets this far: the UI and the API both refuse it before a card exists,
  // because a card about the dropdown would be an answer to a question nobody asked.
  if (unheld && unheld.name) {
    notes.push(zh
      ? "你还提到了「" + unheld.word + "」（" + unheld.name + "，" + unheld.ticker + "），本库没有这个标的，所以它没有被分析，也没有参与下面任何数字。" + (unheld.whyZh || unheld.why)
      : "You also named \"" + unheld.word + "\" (" + unheld.name + ", " + unheld.ticker + "), which this library does not hold, so it was not analysed and contributes nothing to any figure below. " + unheld.why);
  }

  return notes;
}

/**
 * What the SENTENCE asked for that the card does not answer, printed beside it rather than inside it.
 *
 * Kept separate from discloseIntent() on purpose, and the separation is load-bearing. discloseIntent()
 * covers narrowings that change what the numbers MEAN - a short-side question answered with long-side
 * tails, a k the validation never measured - so those notes are part of the card's identity and part
 * of its replay digest. Nothing below changes a single number: "you asked for a price target and this
 * is a distribution", "the shock you named is this row of the stress suite", "the date you named is
 * outside the library". Two sentences that resolve to the same research question therefore get the
 * same card, the same numbers and the same cached prose, exactly as they already do when the digest
 * ignores question text - the framing travels beside the card instead of inside its key. Adding these
 * to notes instead would have silently cost the tariff-shock and vol-spike example chips their
 * model-written narratives, because a changed digest is a cache miss.
 *
 * Bilingual for the reason discloseIntent() is: a disclosure the asker cannot read is not one.
 *
 * @returns {{gaps: string[], namedScenario: object|null}}
 */
function discloseRequest({ answerGaps = null, namedScenario = null, dateOutOfRange = null, dateSnapped = null, scenarios = null } = {}, language = "en") {
  const zh = String(language) === "zh";
  const gaps = [];
  const list = Array.isArray(scenarios) ? scenarios : [];
  const row = (id) => (id ? list.find((x) => x && x.id === id) || null : null);

  if (dateOutOfRange && dateOutOfRange.asked) {
    const d = dateOutOfRange;
    gaps.push(zh
      ? "你要求的截至日 " + d.asked + " 不在本库范围内（" + d.from + " .. " + d.to + "），这张卡片改在 " + d.used + " 运行。库里没有你说的那一天的状态，所以下面没有任何一行数字是在描述它：分布、路径风险和压力情景全部是 " + d.used + " 这个状态的。"
      : "The as-of date you asked for, " + d.asked + ", is outside this library (" + d.from + " .. " + d.to + "), so this card ran at " + d.used + " instead. The library holds no state for the date you named, so no figure below describes it: the distribution, the path risk and the stress suite all describe the state at " + d.used + ".");
  } else if (dateSnapped) {
    // Not out of range, just not a session - a weekend, a holiday, or a date typed straight into the
    // API. The engine has always resolved it to the nearest session on or before; until now it did so
    // without saying, and the card header was the only place the substitution was visible.
    gaps.push(zh
      ? "你指定的 " + dateSnapped.asked + " 不是本库的交易日，卡片改在它之前最近的一个交易日 " + dateSnapped.used + " 运行。"
      : "The as-of date you gave, " + dateSnapped.asked + ", is not a session in this library, so the card ran at the nearest session on or before it: " + dateSnapped.used + ".");
  }

  let scenarioText = null;
  if (namedScenario && namedScenario.word) {
    const hit = row(namedScenario.scenarioId);
    const near = row(namedScenario.nearest);
    const reason = namedScenario.why ? String(zh ? (namedScenario.whyZh || namedScenario.why) : namedScenario.why) : null;
    const kindOf = (r) => (r.kind === "window"
      ? (zh ? "把类比库钉在 " + r.from + " .. " + r.to + " 这个具名窗口" : "the analog library pinned to " + r.from + " .. " + r.to)
      : r.kind === "venue"
        ? (zh ? "按 7x24 交易场所的日历重算持有期" : "the holding period recomputed on the 7x24 venue's own calendar")
        : (zh ? "对查询状态施加冲击叠加后重新检索" : "the query state shocked in z-space, then re-retrieved"));
    if (hit) scenarioText = zh
      ? "你点名的「" + namedScenario.word + "」由压力测试里的这一行回答：" + hit.label + "（" + kindOf(hit) + "），下面已高亮。它与基准用完全相同的设置运行，因此可以直接比较；它是被测量过的历史片段，不是对你这句话的模拟。"
      : "The \"" + namedScenario.word + "\" you named is answered by this row of the stress suite: " + hit.label + " (" + kindOf(hit) + "). It is highlighted below, it runs with this card's own settings so it is directly comparable to the baseline, and it is a measured episode rather than a simulation of your sentence.";
    else if (near) scenarioText = (zh
      ? "本库没有「" + namedScenario.word + "」这个情景，所以没有任何一行直接回答它。最接近的是 " + near.label + "（" + kindOf(near) + "），下面已高亮。"
      : "The suite has no \"" + namedScenario.word + "\" scenario, so no row answers it directly. The closest is " + near.label + " (" + kindOf(near) + "), highlighted below.")
      + (reason ? " " + reason : "");
    else scenarioText = (zh
      ? "本库没有与「" + namedScenario.word + "」对应的压力情景，下面没有任何一行回答它。"
      : "The suite has no scenario matching \"" + namedScenario.word + "\", so no row below answers it.")
      + (reason ? " " + reason : "");
  }

  for (const g of (Array.isArray(answerGaps) ? answerGaps : [])) {
    if (!g) continue;
    let text = String(zh ? (g.whyZh || g.why || "") : (g.why || ""));
    // A hypothetical question and the row that answers it are one thought, so they are printed as one.
    if (g.kind === "conditional" && scenarioText) { text += " " + scenarioText; scenarioText = null; }
    if (text) gaps.push(text);
  }
  if (scenarioText) gaps.push(scenarioText);

  const hit = row(namedScenario && namedScenario.scenarioId);
  const near = row(namedScenario && namedScenario.nearest);
  return {
    gaps,
    // The id the UI highlights. Resolved against the suite the desk actually runs, so a stale mapping
    // in the language layer degrades into no highlight instead of a wrong one.
    namedScenario: namedScenario && namedScenario.word ? {
      asked: namedScenario.word,
      scenarioId: hit ? hit.id : null, label: hit ? hit.label : null,
      nearestId: !hit && near ? near.id : null, nearestLabel: !hit && near ? near.label : null,
      available: Boolean(hit)
    } : null
  };
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
      /**
       * The RETURN layer of the 7x24 claim. sevenByTwentyFour above is a share of absolute movement,
       * and a share cannot be sized: nobody can ask "what did it do" of a percentage of |returns|.
       * This block reports what the wrapper actually returned while the reference cash market was shut,
       * as a distribution with a left tail and an intra-block path - the same two objects every other
       * part of this card reports. Per-pair figures first, then the pooled figure across every verified
       * wrapper, with the distinct weekend count next to the pooled n because blocks across wrappers in
       * the same weekend are not independent draws.
       */
      closedSessionReturns: (() => {
        const cr = a.closedReturns || null;
        const pooled = probe?.closedSessionReturns || null;
        if (!cr && !pooled) return null;
        const wd = cr?.weekendReturnDistribution || null;
        return {
          weekendBlocks: cr?.blocks?.weekend ?? null,
          overnightBlocks: cr?.blocks?.overnight ?? null,
          weekendReturnDistribution: wd,
          weekendMaeDistribution: cr?.weekendMaeDistribution || null,
          weekendShareBreached5PctDrawdownPct: cr?.weekendShareBreached5PctDrawdownPct ?? null,
          // Carried as a value, not only inside a field name, so a sentence can quote the threshold
          // it is describing and the numeric gate can trace that numeral to the payload.
          weekendDrawdownThresholdPct: cr?.weekendShareBreached5PctDrawdownPct != null ? -5 : null,
          hourlyStdRatioOutsideOverInside: cr?.hourlyStdRatioOutsideOverInside ?? null,
          hourlyInsideSession: cr?.hourlyInsideSession || null,
          hourlyOutsideSession: cr?.hourlyOutsideSession || null,
          pooledWeekendReturnDistribution: pooled?.pooled?.weekendReturnDistribution || null,
          pooledWeekendMaeDistribution: pooled?.pooled?.weekendMaeDistribution || null,
          pooledWeekendShareBreached5PctDrawdownPct: pooled?.pooled?.weekendShareBreached5PctDrawdownPct ?? null,
          pooledWeekendShareBreached10PctDrawdownPct: pooled?.pooled?.weekendShareBreached10PctDrawdownPct ?? null,
          pooledPairs: pooled?.pairsWithReturnLayer ?? null,
          pooledDistinctWeekendStarts: pooled?.distinctWeekendStarts ?? null,
          conventionNote: cr?.convention || null,
          note: wd
            ? `The return layer, measured rather than asserted. Across ${cr.weekendBlocks?.length ?? 0} weekend block(s) in the observed ${cr.hourlyInsideSession?.n != null ? (cr.hourlyInsideSession.n + cr.hourlyOutsideSession.n) : "720"}-hour window, ${a.pair} went from the pre-weekend close to the reopen with a median return of ${wd.medianPct}% (p10 ${wd.p10Pct}%, p90 ${wd.p90Pct}%, sd ${wd.stdPct}%), and its median intra-weekend adverse excursion was ${cr.weekendMaeDistribution?.medianPct ?? "n/a"}%. Hour for hour, closed-session price formation was ${cr.hourlyStdRatioOutsideOverInside ?? "n/a"}x as volatile as open-session formation.`
            : "No closed-session block in the observed window was long enough to measure for this pair, so only the calendar share and the movement share are reported.",
          caveatNote: pooled?.caveat || null
        };
      })(),
      interpretation: `${a.pair} is a ${a.tierLabel} for ${symbol}: daily returns correlate at ${a.returnCorrelation} with a tracking error of ${a.trackingErrorBpPerDay} bp/day, and it prices within ${a.priceDeviationPct}% of the underlying's last raw close. It is the instrument a trader would actually hold outside cash hours - and outside those hours is where ${ch?.referenceClosedMoveSharePct ?? "most"}% of its own movement happens.`,
      caveat: `Measured on ${venueName}, which is where these tokenised-equity wrappers are listed and tradeable; the official Bitget MCP is probed and cross-checked separately in the provenance panel, on both a direct and a proxied route, and neither route is the source of the figures in this block. A ${a.tier} tracker is not the underlying - at ${a.trackingErrorBpPerDay} bp/day of tracking error the wrapper carries its own idiosyncratic risk, and a premium band of ${a.premiumP10Pct}% to ${a.premiumP90Pct}% means the price you exit at can differ from the reference close the analog distribution is built on. Nothing here feeds the retrieval engine, the conformal scale or any validation figure; the one consumer is the 7x24 venue stress overlay, which composes the retrieved paths with these measured closed-market blocks and prints the instrument, the block count and the distinct-weekend count beside the result it produces.`
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
/**
 * The BITGET venue view of the same 7x24 layer, and the primary one.
 *
 * Why Bitget is primary and Gate.io is the second venue rather than the other way round:
 *  - it is the host's own data on the host's own exchange (the exchange parameter is pinned to
 *    "bitget" and the echoed exchange is asserted on every fetch), not a third-party aggregator's;
 *  - it covers more of the library: 39 verified instruments over 39 of 71 underlyings against the
 *    Gate.io spot wrappers' 34;
 *  - it serves a deeper hourly window (~1000 bars, ~41 days), so the same claim rests on more distinct
 *    weekends rather than fewer.
 *
 * And why it is labelled rather than quietly substituted: a Bitget RWA PERPETUAL is not a redeemable
 * spot token. It carries funding and a basis, so its closed-session return is the return of a 7x24
 * synthetic position. The instrument class is printed with every figure, and the Gate.io spot wrapper
 * stays on the card as an independent second venue - agreement between two different instruments on
 * one underlying is stronger evidence than the same instrument measured twice.
 *
 * The route is part of the label too: Bitget hosts reset at the TCP layer on a direct connection from
 * the build machine, so this block exists because a local proxy answered. On a machine with no proxy
 * the measurement degrades, says so, and the Gate.io block stands alone.
 */
export function createBitget7x24View(probe) {
  const degraded = probe?.degradation || null;
  const venue = probe?.venue || null;
  const venueName = venue?.name || "Bitget official MCP (not reachable on this build)";
  const measuredAt = probe?.generatedAt || null;
  const route = venue?.route || null;
  const summary = probe?.summary || null;
  const bySymbol = new Map((probe?.instruments || []).map((a) => [a.sym, a]));
  const crossRows = new Map((probe?.crossVenue?.available ? probe.crossVenue.perSymbol || [] : []).map((x) => [x.sym, x]));
  const crossWindow = probe?.crossVenue?.windowHours || null;
  const crossNote = probe?.crossVenue?.note || null;

  const head = {
    status: null, symbol: null, venueName, route, measuredAt, primary: true,
    instrumentClass: venue?.instrumentClass || null, productType: venue?.productType || null,
    exchangePinned: venue?.exchange || null, keyRequired: venue?.keyRequired ?? null
  };

  const forSymbol = (symbol) => {
    if (!probe) return { ...head, status: "not-measured", symbol, caveatNote: "No Bitget 7x24 measurement is on record for this build, so no Bitget figure is reported and none is estimated." };
    if (degraded) {
      return {
        ...head, status: "not-measured", symbol,
        degradation: { kind: degraded.kind, detail: degraded.detail },
        caveatNote: `The Bitget venue could not be reached on this run (${degraded.kind}), so no Bitget figure is reported and none is estimated: ${degraded.detail}`
      };
    }
    const a = bySymbol.get(symbol);
    if (!a) {
      const refs = (probe.rejected || []).filter((x) => x.sym === symbol);
      return {
        ...head, status: "no-verified-instrument", symbol,
        reason: `No Bitget listing passed both verification tests against ${symbol}, so no Bitget figure is reported for it and none is estimated.`,
        refusals: refs.map((x) => ({ pair: x.pair, stage: x.stage, reason: x.reason })),
        caveatNote: refs.length
          ? `Bitget was asked about ${symbol} and the answer is on the record rather than absent: ${refs.map((x) => `${x.pair} refused at the ${x.stage} stage (${x.reason})`).join("; ")}.`
          : `Bitget lists no tokenised instrument for ${symbol} in the measured universe, which is itself the finding.`
      };
    }
    const ch = a.closedHours || null;
    const ms = a.microstructure || null;
    const cr = a.closedReturns || null;
    const pooled = probe.closedSessionReturns || null;
    const wd = cr?.weekendReturnDistribution || null;
    return {
      ...head, status: "measured", symbol,
      instrument: a.pair, exchange: a.exchange, tier: a.tier, tierLabel: a.tierLabel,
      intervalEchoed: a.intervalEchoed, exchangeEchoed: a.exchangeEchoed, hourlyCandles: a.hourlyCandles,
      hourlyFrom: a.hourlyFrom || null, hourlyTo: a.hourlyTo || null,
      flaggedRwaInCatalog: a.flaggedRwaInCatalog ?? null,
      tracking: {
        returnCorrelation: a.returnCorrelation, trackingErrorBpPerDay: a.trackingErrorBpPerDay,
        tier: a.tier, tierLabel: a.tierLabel,
        overlapSessions: a.overlapSessions, from: a.from, to: a.to,
        note: `Daily returns of the Bitget ${a.pair} perpetual against ${symbol} raw session closes over ${a.overlapSessions} overlapping sessions (${a.from} to ${a.to}). Tracking error is the standard deviation of the daily return difference, in basis points per day.`
      },
      premium: {
        medianPct: a.premiumMedianPct, p10Pct: a.premiumP10Pct, p90Pct: a.premiumP90Pct,
        priceDeviationPct: a.priceDeviationPct, perpLast: a.perpLast, lastRawClose: a.lastRawClose, lastRawCloseDate: a.lastRawCloseDate,
        note: "Basis of the perpetual against the underlying's RAW session close - a traded price against a traded price. On a perpetual this is a basis that funding pulls back toward the mark, not a redeemable premium, so it is labelled basis rather than premium."
      },
      liquidity: ms ? {
        spreadBps: ms.spreadBps, bestBid: ms.bestBid, bestAsk: ms.bestAsk, mid: ms.mid,
        depthWithin50BpsUsdt: ms.depthWithin50BpsUsdt, levels: ms.levels,
        quoteVolume24hUsdt: a.quoteVolume24hUsdt, medianDailyVolumeBase: a.medianDailyVolumeBase,
        note: `Bitget order-book snapshot at ${ms.snapshotAt}. Resting depth is notional USDT within 50 bp of the touch, both sides combined. It changes every second; this is the state at that timestamp, not a standing figure.`
      } : {
        spreadBps: null, depthWithin50BpsUsdt: null, quoteVolume24hUsdt: a.quoteVolume24hUsdt,
        note: a.microstructureError ? `The Bitget order book could not be read on this run (${a.microstructureError}).` : "No Bitget order-book snapshot on this run."
      },
      sevenByTwentyFour: {
        closedMoveSharePct: ch?.referenceClosedMoveSharePct ?? null,
        closedHoursSharePct: ch?.referenceClosedHoursPct ?? null,
        tradedOutsideSessionPct: ch?.tradedOutsideSessionPct ?? null,
        hoursObserved: ch?.hoursObserved ?? null,
        conventionNote: ch?.convention || null,
        note: ch
          ? `The measured core of the 7x24 claim, on Bitget's own candles: ${ch.referenceClosedMoveSharePct}% of this perpetual's realised hourly price movement over ${ch.hoursObserved} observed hours landed outside the US cash session, and it traded in ${ch.tradedOutsideSessionPct}% of those hours.`
          : (a.hourlyError ? `Hourly candles were unavailable for this instrument on this run (${a.hourlyError}), so no movement share is reported and none is estimated.` : "Hourly candles were unavailable for this instrument on this run.")
      },
      closedSessionReturns: (cr || pooled) ? {
        weekendBlocks: cr?.blocks?.weekend ?? null,
        overnightBlocks: cr?.blocks?.overnight ?? null,
        weekendReturnDistribution: wd,
        weekendMaeDistribution: cr?.weekendMaeDistribution || null,
        weekendShareBreached5PctDrawdownPct: cr?.weekendShareBreached5PctDrawdownPct ?? null,
        weekendDrawdownThresholdPct: cr?.weekendShareBreached5PctDrawdownPct != null ? -5 : null,
        hourlyStdRatioOutsideOverInside: cr?.hourlyStdRatioOutsideOverInside ?? null,
        hourlyInsideSession: cr?.hourlyInsideSession || null,
        hourlyOutsideSession: cr?.hourlyOutsideSession || null,
        pooledWeekendReturnDistribution: pooled?.pooled?.weekendReturnDistribution || null,
        pooledWeekendMaeDistribution: pooled?.pooled?.weekendMaeDistribution || null,
        pooledWeekendShareBreached5PctDrawdownPct: pooled?.pooled?.weekendShareBreached5PctDrawdownPct ?? null,
        pooledWeekendShareBreached10PctDrawdownPct: pooled?.pooled?.weekendShareBreached10PctDrawdownPct ?? null,
        pooledInstruments: pooled?.instrumentsWithReturnLayer ?? null,
        pooledDistinctWeekendStarts: pooled?.distinctWeekendStarts ?? null,
        conventionNote: cr?.convention || null,
        note: wd
          ? `The return layer, measured on Bitget data. Across ${cr.blocks?.weekend ?? 0} weekend block(s) in the observed ${ch?.hoursObserved ?? a.hourlyCandles}-hour window, ${a.pair} went from the pre-weekend close to the reopen with a median return of ${wd.medianPct}% (p10 ${wd.p10Pct}%, p90 ${wd.p90Pct}%, sd ${wd.stdPct}%), and its median intra-weekend adverse excursion was ${cr.weekendMaeDistribution?.medianPct ?? "n/a"}%. Hour for hour, closed-session price formation was ${cr.hourlyStdRatioOutsideOverInside ?? "n/a"}x as volatile as open-session formation.`
          : "No closed-session block in the observed window was long enough to measure for this instrument.",
        caveatNote: pooled?.caveat || null
      } : null,
      interpretation: `${a.pair} is a ${a.tierLabel} for ${symbol} on Bitget's own venue: daily returns correlate at ${a.returnCorrelation} with a tracking error of ${a.trackingErrorBpPerDay} bp/day, and it prices within ${a.priceDeviationPct}% of the underlying's last raw close. It is a 24/7 perpetual, so it is the instrument a trader would actually hold outside cash hours - and outside those hours is where ${ch?.referenceClosedMoveSharePct ?? "most"}% of its own movement happens.`,
      caveat: `Measured on ${venueName} through the official Bitget MCP on the ${route} route, with the exchange pinned to "${a.exchange}" and the echoed interval (${a.intervalEchoed}) and exchange (${a.exchangeEchoed}) asserted on every fetch - the upstream accepts a granularity parameter and silently ignores it, returning daily bars, so the echo is checked rather than trusted. A ${a.tier} perpetual is not the underlying and not a redeemable spot token: at ${a.trackingErrorBpPerDay} bp/day of tracking error it carries its own idiosyncratic risk, funding applies, and a basis band of ${a.premiumP10Pct}% to ${a.premiumP90Pct}% means the price you exit at can differ from the reference close the analog distribution is built on. Nothing here feeds the retrieval engine, the conformal scale or any validation figure; the one consumer is the 7x24 venue stress overlay, which composes the retrieved paths with these measured closed-market blocks and prints the instrument, the block count and the distinct-weekend count beside the result it produces.`
    };
  };

  const crossVenueFor = (symbol) => {
    const row = crossRows.get(symbol);
    if (!row) return null;
    return { ...row, windowHours: crossWindow, note: crossNote };
  };

  return {
    probe: probe || null,
    available: Boolean(summary && !degraded),
    degraded: Boolean(degraded),
    summary, venueName, route, measuredAt,
    forSymbol, crossVenueFor,
    crossVenueSummary: probe?.crossVenue?.available ? {
      comparedSymbols: probe.crossVenue.comparedSymbols,
      medianDifferenceBitgetMinusGateio: probe.crossVenue.medianDifferenceBitgetMinusGateio,
      windowHours: crossWindow, note: crossNote,
      bitgetVenue: probe.crossVenue.bitgetVenue, gateVenue: probe.crossVenue.gateVenue
    } : null
  };
}

function annotateWrapperScenarios(card) {
  const w = card.wrapper;
  if (!w) return;
  // Whichever venue is primary on this build is the one the scenario caveat quotes, and it names the
  // instrument class so a perpetual is never described as a spot wrapper.
  const bg = w.bitget;
  const src = bg?.status === "measured" ? bg : (w.status === "measured" ? w : null);
  if (!src) return;
  const s = (card.stress || []).find((x) => x.id === "liquidity-air-pocket");
  const closed = src.sevenByTwentyFour?.closedMoveSharePct;
  const refClosed = src.sevenByTwentyFour?.referenceClosedSharePct ?? w.sevenByTwentyFour?.referenceClosedSharePct
    // The share is venue-independent (it comes from the library calendar), so referenceMarket always
    // has it. Without this the caveat printed "closed for undefined% of the week": the Bitget view
    // never carried the field, and card.wrapper only has one when Gate.io verified this symbol.
    ?? w.referenceMarket?.closedSharePct;
  if (!s || !Number.isFinite(closed)) return;
  const kind = src === bg ? "Bitget RWA perpetual" : "tokenised-equity wrapper";
  s.caveat = `${s.caveat} Measured on the instrument itself (${src.instrument}, a ${kind} on ${src.venueName}): ${Number.isFinite(refClosed) ? "the reference market is closed for " + refClosed + "% of the week and " : ""}${closed}% of its realised hourly movement happened in those closed hours, so the gap risk this scenario describes is not hypothetical for the instrument a trader would hold.`;
}
export function createDesk({ dataset, validationResults = null, provenance = {}, config = {}, wrapper = null, bitget7x24 = null, signals = null }) {
  const wrapperView = createWrapperView(wrapper);
  const bitgetView = createBitget7x24View(bitget7x24);

  // The venue stress scenario composes analog paths with the measured closed-market weekend blocks of
  // the verified instrument for this symbol: primary venue first (Bitget RWA perpetuals), then the
  // Gate.io spot wrapper. A symbol with neither gets a skipped scenario carrying the reason, never an
  // invented block.
  // The effective sample of the composition is the number of DISTINCT weekend starts among the blocks
  // this instrument actually contributes, not the venue-wide count: one instrument can be missing a
  // weekend to an hourly-data gap, and quoting the venue-wide figure would then overstate its own
  // sample. Both are carried, so a reader can see the gap when there is one.
  const distinctStarts = (blocks) => new Set(blocks.map((b) => b.startIso).filter(Boolean)).size || null;
  const venueForStress = (symbol) => {
    const bgInst = bitget7x24 && !bitget7x24.degradation
      ? (bitget7x24.instruments || []).find((x) => x.sym === symbol) : null;
    const bgBlocks = Array.isArray(bgInst?.closedReturns?.weekendBlocks) ? bgInst.closedReturns.weekendBlocks : null;
    if (bgBlocks && bgBlocks.length) {
      return {
        venue: "bitget", venueName: bitget7x24.venue?.name || "Bitget official MCP", instrument: bgInst.pair,
        instrumentClass: bgInst.instrumentClass, blocks: bgBlocks,
        distinctWeekendStarts: distinctStarts(bgBlocks),
        venueDistinctWeekendStarts: bitget7x24.closedSessionReturns?.distinctWeekendStarts ?? null,
        pooledWeekendN: bitget7x24.closedSessionReturns?.pooled?.weekendReturnDistribution?.n ?? null,
        route: bitget7x24.venue?.route ?? null
      };
    }
    const wInst = wrapper && !wrapper.degradation ? (wrapper.bySymbol || {})[symbol] : null;
    const wBlocks = Array.isArray(wInst?.closedReturns?.weekendBlocks) ? wInst.closedReturns.weekendBlocks : null;
    if (wBlocks && wBlocks.length) {
      return {
        venue: "gateio", venueName: wrapper.venue?.name || "Gate.io spot v4", instrument: wInst.pair,
        instrumentClass: "redeemable spot tokenised-equity wrapper", blocks: wBlocks,
        distinctWeekendStarts: distinctStarts(wBlocks),
        venueDistinctWeekendStarts: wrapper.closedSessionReturns?.distinctWeekendStarts ?? null,
        pooledWeekendN: wrapper.closedSessionReturns?.pooled?.weekendReturnDistribution?.n ?? null,
        route: null
      };
    }
    return { blocks: [], reason: `no verified 7x24 instrument with a measured weekend return layer for ${symbol} on either venue` };
  };
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
        // The reported-earnings calendar, symbol to ISO dates. An earnings question never moves the
        // as-of date on its own (see EARNINGS_RE in src/llm/lui.mjs) - it is disclosed, and the report
        // date is offered as a one-click chip so the trader chooses it. Offering it needs the dates.
        earnings: dataset.events?.earnings || null,
        benchSym: mx.benchSym, features: FEATURES, groups: GROUPS, nFeatures: NF,
        excludedFromDistance: DISTANCE_EXCLUDE
      };
    },

    wrapper() { return { available: wrapperView.available, degraded: wrapperView.degraded, measuredAt: wrapperView.probe?.generatedAt || null, venueName: wrapperView.probe?.venue?.name || null, summary: wrapperView.summary, referenceMarket: wrapperView.referenceMarket, verified: Object.keys(wrapperView.probe?.bySymbol || {}).length, closedSessionReturns: wrapperView.probe?.closedSessionReturns || null,
      // The primary venue for this layer, reported beside the second one rather than instead of it.
      bitget: {
        available: bitgetView.available, degraded: bitgetView.degraded, measuredAt: bitgetView.measuredAt,
        venueName: bitgetView.venueName, route: bitgetView.route, summary: bitgetView.summary,
        verified: (bitgetView.probe?.instruments || []).length,
        closedSessionReturns: bitgetView.probe?.closedSessionReturns || null,
        crossVenue: bitgetView.crossVenueSummary
      } }; },
    validation(H = DEFAULT_HORIZON) { return validationByHorizon[H] || null; },
    allValidation() { return validationByHorizon; },
    conformal(H = DEFAULT_HORIZON) { return conformalByHorizon[H] || null; },

    /**
     * Full analysis for one trade idea.
     * @returns {{card:object, detail:object}}
     */
    analyze({ symbol, date = "latest", horizon = DEFAULT_HORIZON, k = DEFAULT_K, scenarios = null, includeStress = true, riskTolerancePct = null,
      // Everything below is the LANGUAGE layer's disclosure and is null unless a caller parsed a
      // sentence. Null means "no narrowing to report", which is what keeps a default card identical
      // to the one the replay cache and the committed demo record were built from.
      positionDirection = null, droppedInstruments = null, sectorProxy = null, ambiguousAlias = null,
      unheld = null,
      // How the SENTENCE was read rather than how the request was narrowed: the gap between what was
      // asked and what a card can answer, a scenario the sentence named, and a date the library does
      // not reach. All three are disclosed beside the card and none of them enters its digest.
      answerGaps = null, namedScenario = null, dateOutOfRange = null, language = "en" } = {}) {
      const req = normalizeRequest({ horizon, k, horizons: engine.C.horizons });
      const intentNotes = discloseIntent({ positionDirection, droppedInstruments, sectorProxy, ambiguousAlias, unheld, symbol }, language);
      const { H, K } = req;
      const t0 = Date.now();
      const base = engine.query({ sym: symbol, date, horizon: H, k: K });
      // The engine resolves an as-of date to the last session on or before it. When the caller named a
      // day that is not a session at all, the card describes a different day than the one asked for.
      const dateSnapped = (date && date !== "latest" && base.query.date && base.query.date !== date)
        ? { asked: String(date), used: base.query.date } : null;
      const stress = includeStress ? stressReport(engine, { sym: symbol, date, horizon: H, k: K, scenarios: scenarios || SCENARIOS, venue: venueForStress(symbol) }) : null;

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
      const gateBlock = wrapperView.forSymbol(base.query.sym);
  const bitgetBlock = bitgetView.forSymbol(base.query.sym);
  // Bitget is the PRIMARY venue for this layer; Gate.io is an independent second venue on a different
  // instrument class, and the only venue on a machine with no route to Bitget. Which venue a figure
  // came from is never left for the reader to infer.
  const primaryVenue = bitgetBlock?.status === "measured" ? "bitget" : (gateBlock?.status === "measured" ? "gateio" : null);
  card.wrapper = {
    ...gateBlock,
    primaryVenue,
    primaryStatus: primaryVenue === "bitget" ? bitgetBlock.status : (primaryVenue === "gateio" ? gateBlock.status : null),
    venueNote: primaryVenue === "bitget"
      ? "The 7x24 figures headed on this card are measured on Bitget's own data - Bitget RWA perpetuals fetched through the official Bitget MCP with the exchange pinned to bitget. The Gate.io spot-wrapper measurement is kept beside it as an independent second venue on a different instrument class, not as a duplicate."
      : (primaryVenue === "gateio"
        ? "Bitget's own venue was not measurable for this instrument on this run, so the 7x24 figures headed on this card come from the Gate.io spot-wrapper measurement. The reason is recorded in wrapper.bitget rather than omitted."
        : "Neither venue produced a verified instrument for this symbol on this run, so the card reports the reference-market calendar share only and no venue figure is estimated."),
    bitget: bitgetBlock,
    crossVenue: bitgetView.crossVenueFor(base.query.sym)
  };
      annotateWrapperScenarios(card);

      // The market signals layer (news / sentiment / macro) is attached AFTER buildCard, like the
      // wrapper block: it is the "why is the market like this now" backdrop, and no retrieval,
      // conformal or validation figure is computed from it. It is market-wide (the same snapshot for
      // every card) with macro falling back to this card's own measured features. Null when no
      // snapshot was supplied, so a card built without it is unchanged and the cache still reaches it.
      card.signals = buildSignalsView(signals, card);

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
        // Engine adjustments first, then what the sentence asked for that the engine could not act on.
        notes: req.notes.concat(intentNotes)
      });

      /*
       * Request-framing disclosure, attached only when there is something to frame. Both keys are
       * listed in DIGEST_VOLATILE_KEYS (src/llm/replay.mjs) and both are omitted entirely on a plain
       * request, so a canonical card stays byte-identical to the one its cached narrative was written
       * for and scripts/check-replay.mjs still finds it.
       */
      const framing = discloseRequest({ answerGaps, namedScenario, dateOutOfRange, dateSnapped, scenarios: SCENARIOS }, language);
      if (framing.gaps.length) card.retrieval.requestGaps = framing.gaps;
      if (framing.namedScenario) card.retrieval.namedScenario = framing.namedScenario;

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