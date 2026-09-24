/**
 * AnalogDesk - the reference-session convention and the closed-session return layer.
 *
 * WHY THIS IS ITS OWN MODULE
 * The 7x24 claim is now measured on two venues: Gate.io spot (xStocks tokenised equities, reachable on
 * a direct connection) and the Bitget official MCP (Bitget's own RWA perpetuals and tokenised-stock
 * spot pairs, reachable on the local-proxy route). A cross-venue comparison is only evidence if both
 * sides used the same definition of "the reference market was closed", the same minimum block length
 * and the same entry/exit convention. Duplicating those rules in two scripts would let them drift, and
 * a drift would silently turn a comparison into a coincidence. So the convention lives here, once, and
 * both measurement scripts import it.
 *
 * This module is pure: no network, no filesystem, no venue knowledge. Hourly rows arrive already
 * normalised to { t: epochSeconds, c, hi, lo, qv } by the venue adapter.
 *
 *  - The reference-session window is deliberately CONSERVATIVE. US cash hours are 13:30-20:00 UTC in
 *    daylight time and 14:30-21:00 UTC in standard time; this counts every Monday-Friday hourly bucket
 *    from 13:00 to 20:59 UTC as "open", which is 40h a week against the real 32.5h. Any bias in the
 *    closed-hours figures is therefore downward: they understate how much happens outside the cash
 *    session rather than overstating it.
 *  - Every number is rounded before it is returned, because the research card is the only thing the
 *    language model may quote and a payload carrying sixteen digits licenses sixteen digits of prose.
 */

import { quantile } from "./xstocks.mjs";

/** US cash regular trading hours, counted generously (see the header). Hour buckets 13..20 UTC, Mon-Fri. */
export const OPEN_HOURS_UTC = [13, 14, 15, 16, 17, 18, 19, 20];
export const OPEN_DAYS_UTC = [1, 2, 3, 4, 5];
export const CASH_HOURS_PER_WEEK = 6.5 * 5;   // the real figure, used for the calendar share
export const WEEK_HOURS = 168;

// The return layer. A closed run shorter than MIN_BLOCK_HOURS is a gap in the exchange feed, not a
// session break, and measuring a "weekend" across a feed gap would report the gap as risk.
export const MIN_BLOCK_HOURS = 12;
// Friday cash close to Monday cash open is ~64h of shut reference market. Anything at or above this
// is a genuine weekend; below it and above MIN_BLOCK_HOURS is an overnight break.
export const WEEKEND_BLOCK_HOURS = 48;

/**
 * The acceptance rules a candidate instrument must pass before it may be reported as a 7x24 proxy for
 * an underlying. One definition, shared by every venue, because two venues measured under different
 * rules cannot be compared and a comparison is the whole reason there are two venues.
 *
 *  - TOL_PCT: max |instrument last / underlying raw close - 1| in percent.
 *  - MIN_CORR: floor on the correlation of DAILY returns with the underlying. Price proximity alone is
 *    not evidence: LINK trades near LI Auto's share price, and a price-only test would have "verified"
 *    a crypto token as a tokenised Chinese EV maker.
 *  - MIN_OVERLAP: sessions of overlap required before a correlation means anything.
 */
export const ACCEPTANCE = { TOL_PCT: 7, MIN_CORR: 0.5, MIN_OVERLAP: 20, MAX_CANDIDATE_SUFFIX: 3 };

export const SESSION_CONVENTION = "Mon-Fri hourly buckets 13:00-20:59 UTC counted as reference-session OPEN (conservative: the real US cash session is 32.5h/week, this counts 40h)";

export const CLOSED_RETURN_CONVENTION = "hourly buckets; reference session = Mon-Fri 13:00-20:59 UTC (40h/week, deliberately wider than the real 32.5h cash session so closed-hours figures are understated rather than flattered); a block is a maximal run of consecutive closed candles of at least " + MIN_BLOCK_HOURS + "h, weekend if at least " + WEEKEND_BLOCK_HOURS + "h; MAE uses the intra-block candle low against the pre-block close";

export const stdev = (a) => {
  if (!a || a.length < 2) return NaN;
  const m = a.reduce((x, y) => x + y, 0) / a.length;
  return Math.sqrt(a.reduce((s2, x) => s2 + (x - m) ** 2, 0) / (a.length - 1));
};

export const r = (x, dp = 2) => (x == null || !Number.isFinite(x) ? null : Number(Number(x).toFixed(dp)));
export const r0 = (x) => r(x, 0);

export function isReferenceOpen(epochSeconds) {
  const d = new Date(epochSeconds * 1000);
  return OPEN_DAYS_UTC.includes(d.getUTCDay()) && OPEN_HOURS_UTC.includes(d.getUTCHours());
}

/**
 * The headline 7x24 measurement for one instrument: how much of its own realised hourly movement, and
 * how many of its traded hours, fall outside the reference cash session.
 */
export function closedHours(h) {
  let openAbs = 0, closedAbs = 0, openN = 0, closedN = 0, tradedOpen = 0, tradedClosed = 0;
  for (let i = 1; i < h.length; i++) {
    const prev = h[i - 1].c, cur = h[i].c;
    if (!(prev > 0) || !(cur > 0)) continue;
    const abs = Math.abs(cur / prev - 1);
    const open = isReferenceOpen(h[i].t);
    if (open) { openAbs += abs; openN++; if (h[i].qv > 0) tradedOpen++; }
    else { closedAbs += abs; closedN++; if (h[i].qv > 0) tradedClosed++; }
  }
  const moves = openN + closedN;
  const totalAbs = openAbs + closedAbs;
  const hours = openN + closedN + 1;
  return {
    hoursObserved: hours,
    referenceClosedHoursPct: moves ? r(100 * closedN / moves) : null,
    referenceClosedMoveSharePct: totalAbs > 0 ? r(100 * closedAbs / totalAbs) : null,
    tradedOutsideSessionPct: closedN ? r(100 * tradedClosed / closedN) : null,
    tradedInsideSessionPct: openN ? r(100 * tradedOpen / openN) : null,
    convention: SESSION_CONVENTION
  };
}

/**
 * The 7x24 RETURN layer, as opposed to the movement share above.
 *
 * closedHours() answers "how much of the instrument's movement happened while the cash market was shut".
 * That is a share of absolute movement, and a share cannot be sized: a trader cannot ask "what did it
 * do" of a percentage of |returns|. This function answers the question that was still open, which is
 * what the instrument actually RETURNED while the reference market was closed, as a distribution with a
 * left tail and an intra-block path - the same two objects every other part of AnalogDesk reports.
 *
 * Two granularities, because they answer different questions:
 *   - hourly returns bucketed by whether the reference market was open, which shows whether the
 *     closed-hours price formation is noisier or quieter than the open-hours one;
 *   - whole closed BLOCKS (a weekend, an overnight), measured entry-to-exit with the intra-block low,
 *     which is what a position actually experiences.
 *
 * It is a measurement of the instrument, reported next to the 5x24 distribution and labelled as such.
 */
export function closedReturns(h) {
  const inside = [], outside = [];
  for (let i = 1; i < h.length; i++) {
    const prev = h[i - 1].c, cur = h[i].c;
    if (!(prev > 0) || !(cur > 0)) continue;
    const ret = (cur / prev - 1) * 100;
    if (isReferenceOpen(h[i].t)) inside.push(ret); else outside.push(ret);
  }

  // Maximal runs of consecutive closed hourly candles. "Consecutive" is checked on the timestamp, not
  // on array position: a feed gap would otherwise be silently read as one long closed block.
  const runs = [];
  let start = -1;
  for (let i = 0; i < h.length; i++) {
    const closed = !isReferenceOpen(h[i].t);
    const contiguous = i > 0 && (h[i].t - h[i - 1].t) === 3600;
    if (closed && contiguous) { if (start < 0) start = i; }
    else if (start >= 0) { runs.push([start, i - 1]); start = -1; }
  }
  if (start >= 0) runs.push([start, h.length - 1]);

  const blocks = [];
  for (const [a, b] of runs) {
    if (a < 1) continue;                     // no pre-block price to measure the entry from
    const hours = b - a + 1;
    if (hours < MIN_BLOCK_HOURS) continue;   // feed gap, not a session break
    const entry = h[a - 1].c, exit = h[b].c;
    if (!(entry > 0) || !(exit > 0)) continue;
    let lo = Infinity, hi = -Infinity;
    for (let i = a; i <= b; i++) {
      if (Number.isFinite(h[i].lo) && h[i].lo > 0) lo = Math.min(lo, h[i].lo);
      if (Number.isFinite(h[i].hi) && h[i].hi > 0) hi = Math.max(hi, h[i].hi);
    }
    blocks.push({
      hours,
      kind: hours >= WEEKEND_BLOCK_HOURS ? "weekend" : "overnight",
      startIso: new Date(h[a].t * 1000).toISOString(),
      endIso: new Date(h[b].t * 1000).toISOString(),
      entry: r(entry, 4), exit: r(exit, 4),
      returnPct: r((exit / entry - 1) * 100, 3),
      maePct: Number.isFinite(lo) ? r((lo / entry - 1) * 100, 3) : null,
      mfePct: Number.isFinite(hi) ? r((hi / entry - 1) * 100, 3) : null
    });
  }

  const dist = (arr) => {
    const a = arr.filter((x) => Number.isFinite(x));
    if (!a.length) return null;
    return {
      n: a.length,
      meanPct: r(a.reduce((x, y) => x + y, 0) / a.length, 4),
      medianPct: r(quantile(a, 0.5), 4),
      stdPct: r(stdev(a), 4),
      p10Pct: r(quantile(a, 0.1), 4),
      p90Pct: r(quantile(a, 0.9), 4),
      minPct: r(Math.min(...a), 4),
      maxPct: r(Math.max(...a), 4),
      shareNegativePct: r(100 * a.filter((x) => x < 0).length / a.length, 1)
    };
  };

  const weekend = blocks.filter((b) => b.kind === "weekend");
  const overnight = blocks.filter((b) => b.kind === "overnight");
  const sdIn = stdev(inside), sdOut = stdev(outside);
  return {
    hourlyInsideSession: dist(inside),
    hourlyOutsideSession: dist(outside),
    hourlyStdRatioOutsideOverInside: Number.isFinite(sdIn) && Number.isFinite(sdOut) && sdIn > 0 ? r(sdOut / sdIn, 3) : null,
    blocks: { total: blocks.length, weekend: weekend.length, overnight: overnight.length },
    weekendBlocks: weekend,
    overnightBlocks: overnight,
    weekendReturnDistribution: dist(weekend.map((b) => b.returnPct)),
    weekendMaeDistribution: dist(weekend.map((b) => b.maePct)),
    weekendShareBreached5PctDrawdownPct: weekend.length ? r(100 * weekend.filter((b) => b.maePct != null && b.maePct <= -5).length / weekend.length, 1) : null,
    convention: CLOSED_RETURN_CONVENTION
  };
}

/**
 * A distribution summary over a pooled set of numbers, in the exact shape the card and the prose
 * already render, so a second venue can be printed next to the first without a second renderer.
 */
export function pooledDistribution(values, { dp = 4 } = {}) {
  const a = (values || []).filter((x) => Number.isFinite(x));
  if (!a.length) return null;
  return {
    n: a.length,
    meanPct: r(a.reduce((x, y) => x + y, 0) / a.length, dp),
    medianPct: r(quantile(a, 0.5), dp),
    stdPct: r(stdev(a), dp),
    p10Pct: r(quantile(a, 0.1), dp),
    p90Pct: r(quantile(a, 0.9), dp),
    minPct: r(Math.min(...a), dp),
    maxPct: r(Math.max(...a), dp),
    shareNegativePct: r(100 * a.filter((x) => x < 0).length / a.length, 1)
  };
}
