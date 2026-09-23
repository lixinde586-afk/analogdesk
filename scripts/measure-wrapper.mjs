/**
 * AnalogDesk - the 7x24 wrapper-layer measurement.
 *
 *   node scripts/measure-wrapper.mjs        writes data-cache/wrapper-probe.json and prints a table
 *   node scripts/measure-wrapper.mjs --quiet
 *
 * WHY THIS EXISTS
 * The desk is about a market that never closes, but every figure it published came from a library of
 * US daily sessions. research/LIMITATIONS.md §9 named that gap: the 7x24 claim was narrative, not
 * measurement. This script measures it. It walks the tokenised-equity listings on a venue that is
 * actually reachable from this network, verifies each one against the underlying with two independent
 * tests, and records what the wrapper adds on top of the analog distribution the desk already computes:
 * tracking correlation, tracking error, premium, spread, depth, and - the number the thesis needs -
 * how much of the wrapper's own price movement happens while the reference cash market is shut.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * None of this feeds the retrieval engine, the conformal scale or any validation figure. Those stay
 * frozen on the primary-market library so that adding a venue cannot move a number a reviewer has
 * already read. The output is committed to data-cache/wrapper-probe.json and read by desk.mjs as
 * data, exactly like network-probe.json: the static bundle and the server therefore report the same
 * wrapper figures without either of them needing the venue at request time.
 *
 * HONESTY RULES
 *  - Two tests, not one. A candidate must sit within +/-TOL_PCT of the underlying's last RAW session
 *    close AND correlate with its daily returns. Price proximity alone is not evidence: LINK trades
 *    near LI Auto's share price, and a price-only test would have "verified" a crypto token as a
 *    tokenised Chinese EV maker. Rejections are recorded with the reason that rejected them.
 *  - The reference-session window is deliberately CONSERVATIVE. US cash hours are 13:30-20:00 UTC in
 *    daylight time and 14:30-21:00 UTC in standard time; this counts every Monday-Friday hourly bucket
 *    from 13:00 to 20:59 UTC as "open", which is 40h a week against the real 32.5h. Any bias in the
 *    closed-hours share is therefore downward: the reported figure understates how much of the
 *    wrapper's movement lands outside the cash session rather than overstating it.
 *  - Every number is rounded before it is written, because the research card is the only thing the
 *    language model may quote and a payload carrying sixteen digits licenses sixteen digits of prose.
 *  - If the venue is unreachable the script still writes a file: a degradation block, and no invented
 *    figure. The card then says the wrapper layer was not measured on this build, which is true.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  VENUE, pairListUrl, bookUrl, candlesUrl, candidateBases, priceRatioTest,
  correlation, trackingTier, quantile, probeVenue, venueDegradation
} from "../src/data/xstocks.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const OUT = join(ROOT, "data-cache", "wrapper-probe.json");
const QUIET = process.argv.includes("--quiet");
const log = (...a) => { if (!QUIET) console.log(...a); };

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const H = { "User-Agent": UA, Accept: "application/json" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Acceptance thresholds. Both are asserted by scripts/check-wrapper.mjs so they cannot drift silently. */
export const TOL_PCT = 7;          // max |wrapper/raw close - 1| in percent for the price test
export const MIN_CORR = 0.5;       // floor on daily-return correlation with the underlying
export const MIN_OVERLAP = 20;     // sessions of overlap required before a correlation means anything
export const MAX_CANDIDATE_SUFFIX = 3;

/** US cash regular trading hours, counted generously (see the header). Hour buckets 13..20 UTC, Mon-Fri. */
const OPEN_HOURS_UTC = [13, 14, 15, 16, 17, 18, 19, 20];
const OPEN_DAYS_UTC = [1, 2, 3, 4, 5];
const CASH_HOURS_PER_WEEK = 6.5 * 5;   // the real figure, used for the calendar share
const WEEK_HOURS = 168;

// The return layer. A closed run shorter than MIN_BLOCK_HOURS is a gap in the exchange feed, not a
// session break, and measuring a "weekend" across a feed gap would report the gap as risk.
const MIN_BLOCK_HOURS = 12;
// Friday cash close to Monday cash open is ~64h of shut reference market. Anything at or above this
// is a genuine weekend; below it and above MIN_BLOCK_HOURS is an overnight break.
const WEEKEND_BLOCK_HOURS = 48;

const stdev = (a) => {
  if (!a || a.length < 2) return NaN;
  const m = a.reduce((x, y) => x + y, 0) / a.length;
  return Math.sqrt(a.reduce((s2, x) => s2 + (x - m) ** 2, 0) / (a.length - 1));
};

const r = (x, dp = 2) => (x == null || !Number.isFinite(x) ? null : Number(Number(x).toFixed(dp)));
const r0 = (x) => r(x, 0);

async function live(url, { timeout = 25000, retries = 3, label = "" } = {}) {
  let last = null;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, { headers: H, signal: AbortSignal.timeout(timeout) });
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} ${label || url}`), { code: `HTTP_${res.status}` });
      return await res.json();
    } catch (e) {
      last = e;
      if (i < retries - 1) await sleep(500 * (i + 1));
    }
  }
  throw last;
}

/** Gate.io candle row -> object. [t, quoteVol, close, high, low, open, baseVol, windowClosed] */
function rows(candles) {
  return (candles || [])
    .map((k) => ({ t: Number(k[0]), c: Number(k[2]), qv: Number(k[1]), hi: Number(k[3]), lo: Number(k[4]) }))
    .filter((x) => Number.isFinite(x.t) && Number.isFinite(x.c))
    .sort((a, b) => a.t - b.t);
}

function isReferenceOpen(epochSeconds) {
  const d = new Date(epochSeconds * 1000);
  return OPEN_DAYS_UTC.includes(d.getUTCDay()) && OPEN_HOURS_UTC.includes(d.getUTCHours());
}

/**
 * The headline 7x24 measurement for one pair: how much of its own realised hourly movement, and how
 * many of its traded hours, fall outside the reference cash session.
 */
function closedHours(h) {
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
    convention: "Mon-Fri hourly buckets 13:00-20:59 UTC counted as reference-session OPEN (conservative: the real US cash session is 32.5h/week, this counts 40h)"
  };
}

/**
 * The 7x24 RETURN layer, as opposed to the movement share above.
 *
 * closedHours() answers "how much of the wrapper's movement happened while the cash market was shut".
 * That is a share of absolute movement, and a share cannot be sized: a trader cannot ask "what did it
 * do" of a percentage of |returns|. This function answers the question that was still open, which is
 * what the wrapper actually RETURNED while the reference market was closed, as a distribution with a
 * left tail and an intra-block path - the same two objects every other part of AnalogDesk reports.
 *
 * Two granularities, because they answer different questions:
 *   - hourly returns bucketed by whether the reference market was open, which shows whether the
 *     closed-hours price formation is noisier or quieter than the open-hours one;
 *   - whole closed BLOCKS (a weekend, an overnight), measured entry-to-exit with the intra-block low,
 *     which is the number a holder of the wrapper over a weekend actually experiences.
 *
 * Nothing here feeds the retrieval engine, the frozen conformal scale or research/VALIDATION.md. It is
 * a measurement of the wrapper instrument, reported next to the 5x24 distribution and labelled as such.
 */
function closedReturns(h) {
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
    convention: "hourly buckets; reference session = Mon-Fri 13:00-20:59 UTC (40h/week, deliberately wider than the real 32.5h cash session so closed-hours figures are understated rather than flattered); a block is a maximal run of consecutive closed candles of at least " + MIN_BLOCK_HOURS + "h, weekend if at least " + WEEKEND_BLOCK_HOURS + "h; MAE uses the intra-block candle low against the pre-block close"
  };
}

/** Spread and resting depth at the moment of the snapshot. Both change every second, so both are timestamped. */
function microstructure(book) {
  const asks = (book?.asks || []).map((x) => [Number(x[0]), Number(x[1])]).filter((x) => Number.isFinite(x[0]) && x[0] > 0 && Number.isFinite(x[1]));
  const bids = (book?.bids || []).map((x) => [Number(x[0]), Number(x[1])]).filter((x) => Number.isFinite(x[0]) && x[0] > 0 && Number.isFinite(x[1]));
  if (!asks.length || !bids.length) return null;
  // Gate returns each side as [price, amount] pairs; the order is not documented as ascending, so the
  // touch is taken as an extreme rather than as element 0. Assuming an order the docs do not promise
  // is exactly how a spread figure ends up measuring the wrong level.
  const a0 = Math.min(...asks.map((x) => x[0]));
  const b0 = Math.max(...bids.map((x) => x[0]));
  if (!(a0 > b0)) return null;
  const m = (a0 + b0) / 2;
  const askQty = asks.filter((x) => x[0] === a0).reduce((s, x) => s + x[1], 0);
  const bidQty = bids.filter((x) => x[0] === b0).reduce((s, x) => s + x[1], 0);
  const within = (side, bps) => side.filter(([p, q]) => Math.abs(p / m - 1) * 1e4 <= bps).reduce((s, [, q]) => s + q * m, 0);
  return {
    bestBid: r(b0, 4), bestAsk: r(a0, 4),
    spreadBps: r(((a0 - b0) / m) * 1e4, 2),
    topOfBookUsdt: r0(Math.min(bidQty * b0, askQty * a0)),
    depthWithin50BpsUsdt: r0(within(bids, 50) + within(asks, 50)),
    depthWithin200BpsUsdt: r0(within(bids, 200) + within(asks, 200)),
    levels: asks.length + bids.length
  };
}

/* ---------------------------------- run ---------------------------------- */

const datasetPath = join(ROOT, "data-cache", "dataset.json");
if (!existsSync(datasetPath)) {
  console.error("data-cache/dataset.json is missing. Run: npm run build:data");
  process.exit(1);
}
const ds = JSON.parse(readFileSync(datasetPath, "utf8"));
const dates = ds.dates;
const universe = (ds.meta?.universe || []).map((u) => u.s);

/* 1. the reference-market calendar figure: derived from the committed session list, no venue needed */
const t0 = Date.parse(`${dates[0]}T00:00:00Z`), t1 = Date.parse(`${dates[dates.length - 1]}T00:00:00Z`);
const weeks = (t1 - t0) / (7 * 864e5);
const sessionsPerWeek = dates.length / weeks;
const cashOpenHoursPerWeek = sessionsPerWeek * 6.5;
const referenceMarket = {
  sessions: dates.length, from: dates[0], to: dates[dates.length - 1],
  weeksObserved: r(weeks, 1), sessionsPerWeek: r(sessionsPerWeek, 3),
  cashOpenHoursPerWeek: r(cashOpenHoursPerWeek, 2), weekHours: WEEK_HOURS,
  closedSharePct: r(100 * (WEEK_HOURS - cashOpenHoursPerWeek) / WEEK_HOURS, 1),
  closedHoursPerWeek: r(WEEK_HOURS - cashOpenHoursPerWeek, 2),
  note: "Computed from the library's own session calendar: 6.5 cash hours on every listed session, against 168 hours in a week. This is the share of the week in which the reference market for a tokenised US equity is shut while the wrapper keeps trading."
};
log(`reference market: ${referenceMarket.sessions} sessions, ${referenceMarket.sessionsPerWeek}/week -> closed ${referenceMarket.closedSharePct}% of the week (${referenceMarket.closedHoursPerWeek}h)`);

/* 2. venue reachability. A dead venue produces a disclosure, never a number. */
const probe = await probeVenue({ timeoutMs: 10000 });
log(`venue probe: ${probe.ok ? `reachable (HTTP ${probe.status}, ${probe.latencyMs}ms)` : `${probe.kind} - ${probe.detail}`}`);

const base = {
  generatedAt: new Date().toISOString(),
  venue: { name: VENUE.name, base: VENUE.base, quote: VENUE.quote, docs: VENUE.docs, role: VENUE.role },
  probe: { ok: probe.ok, status: probe.status ?? null, kind: probe.kind, detail: probe.detail, latencyMs: probe.latencyMs, probedAt: probe.probedAt },
  thresholds: { priceTolerancePct: TOL_PCT, minReturnCorrelation: MIN_CORR, minOverlapSessions: MIN_OVERLAP, maxCandidateSuffixChars: MAX_CANDIDATE_SUFFIX },
  referenceMarket,
  degradation: null, pairs: [], bySymbol: {}, rejected: [], issuerFamilies: {}, summary: null, disclosure: null
};

if (!probe.ok) {
  base.degradation = venueDegradation(probe);
  base.disclosure = base.degradation.disclosure;
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(base, null, 2), "utf8");
  console.log(`\nvenue unreachable - wrote a degradation block to data-cache/wrapper-probe.json. No wrapper figure is invented.`);
  process.exit(0);
}

/* 3. discovery. One call for the pair list, one for every ticker: 2 requests instead of ~200. */
const pairs = await live(pairListUrl(), { label: "pair list" });
const spotUsdt = pairs.filter((p) => p.quote === VENUE.quote).map((p) => ({ base: String(p.base || "").toUpperCase(), quote: p.quote }));
const allT = await live(`${VENUE.base}/spot/tickers`, { timeout: 45000, label: "all tickers" });
const tick = new Map(allT.map((x) => [String(x.currency_pair || "").toUpperCase(), x]));
log(`discovery: ${spotUsdt.length} USDT spot pairs listed, ${allT.length} tickers`);

const lastRawClose = (sym) => {
  const c = ds.prices?.[sym]?.c;
  if (!Array.isArray(c)) return null;
  for (let i = c.length - 1; i >= 0; i--) if (c[i] != null && Number.isFinite(c[i])) return { price: c[i], index: i, date: dates[i] };
  return null;
};

/* 4. verification: price test on the live ticker, then return correlation on daily candles. */
const accepted = [];
const rejected = [];
const families = {};
for (const sym of universe) {
  const ref = lastRawClose(sym);
  const cands = ref ? candidateBases(sym, spotUsdt, { maxExtraChars: MAX_CANDIDATE_SUFFIX }) : [];
  for (const cand of cands) {
    const suffix = cand.suffix === "(none)" ? "(none)" : cand.suffix;
    const t = tick.get(cand.pair);
    if (!t) { rejected.push({ sym, pair: cand.pair, stage: "ticker", reason: "listed but no ticker was returned" }); continue; }
    const last = Number(t.last);
    const pt = priceRatioTest(last, ref.price, TOL_PCT);
    if (!pt.ok) {
      rejected.push({ sym, pair: cand.pair, stage: "price", reason: pt.reason, last: r(last, 4), rawClose: r(ref.price, 4), date: ref.date });
      continue;
    }
    let daily;
    try { daily = rows(await live(candlesUrl(cand.pair, "1d", { limit: 500 }), { label: `1d ${cand.pair}` })); }
    catch (e) { rejected.push({ sym, pair: cand.pair, stage: "candles", reason: `daily candles failed: ${e.message}` }); continue; }
    await sleep(90);

    const byDate = new Map(daily.map((x) => [new Date(x.t * 1000).toISOString().slice(0, 10), x]));
    const A = ds.prices[sym].c;
    const ov = [];
    for (let i = 0; i < dates.length; i++) {
      const w = byDate.get(dates[i]);
      if (w && w.c > 0 && A[i] != null && Number.isFinite(A[i]) && A[i] > 0) ov.push({ d: dates[i], w: w.c, u: A[i], qv: w.qv });
    }
    if (ov.length < MIN_OVERLAP) {
      rejected.push({ sym, pair: cand.pair, stage: "overlap", reason: `only ${ov.length} overlapping sessions, fewer than the ${MIN_OVERLAP} required`, overlap: ov.length });
      continue;
    }
    const wr = [], ur = [], prem = [];
    for (let i = 1; i < ov.length; i++) { wr.push(ov[i].w / ov[i - 1].w - 1); ur.push(ov[i].u / ov[i - 1].u - 1); }
    for (const x of ov) prem.push(x.w / x.u - 1);
    const diff = wr.map((x, i) => x - ur[i]);
    const corr = correlation(wr, ur);
    const n = ov.length;
    const sd = (a) => { const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((s2, x) => s2 + (x - m) ** 2, 0) / (a.length - 1)); };
    const teBp = sd(diff) * 1e4;
    const tier = trackingTier(corr, teBp);
    if (!Number.isFinite(corr) || corr < MIN_CORR) {
      rejected.push({ sym, pair: cand.pair, stage: "correlation", reason: `daily returns correlate at ${Number.isFinite(corr) ? corr.toFixed(3) : "n/a"} with ${sym}, below the ${MIN_CORR} floor - price proximity alone is not evidence`, corr: r(corr, 4), overlap: n });
      continue;
    }
    accepted.push({
      sym, pair: cand.pair, issuerSuffix: suffix, overlapSessions: n,
      from: ov[0].d, to: ov[n - 1].d,
      lastRawClose: r(ref.price, 4), lastRawCloseDate: ref.date, wrapperLast: r(last, 4),
      priceDeviationPct: r(pt.devPct, 2),
      returnCorrelation: r(corr, 4), trackingErrorBpPerDay: r0(teBp),
      premiumMedianPct: r(quantile(prem, 0.5) * 100, 2),
      premiumP10Pct: r(quantile(prem, 0.1) * 100, 2), premiumP90Pct: r(quantile(prem, 0.9) * 100, 2),
      medianDailyQuoteVolumeUsdt: r0(quantile(ov.map((x) => x.qv), 0.5)),
      quoteVolume24hUsdt: r0(Number(t.quote_volume)),
      tier: tier.tier, tierLabel: tier.label
    });
  }
}
log(`verification: ${accepted.length} accepted, ${rejected.length} rejected`);

/* 5. one canonical wrapper per underlying = the accepted pair with the most 24h quote volume. */
const bySym = {};
for (const a of accepted) (bySym[a.sym] = bySym[a.sym] || []).push(a);
const canonical = [];
for (const [sym, list] of Object.entries(bySym)) {
  list.sort((x, y) => (y.quoteVolume24hUsdt || 0) - (x.quoteVolume24hUsdt || 0));
  canonical.push(list[0]);
  for (const extra of list.slice(1)) rejected.push({ sym, pair: extra.pair, stage: "duplicate", reason: `also verified against ${sym}, but ${list[0].pair} carries more 24h quote volume, so it is the canonical wrapper reported for this underlying`, quoteVolume24hUsdt: extra.quoteVolume24hUsdt });
}

/* 6. live microstructure + hourly closed-session behaviour for the canonical wrappers. */
for (const a of canonical) {
  try {
    const book = await live(bookUrl(a.pair, 50), { label: `book ${a.pair}` });
    a.microstructure = microstructure(book);
  } catch (e) { a.microstructure = null; a.microstructureError = e.message.slice(0, 120); }
  await sleep(90);
  try {
    const h = rows(await live(candlesUrl(a.pair, "1h", { limit: 720 }), { label: `1h ${a.pair}` }));
    a.closedHours = closedHours(h);
    // Same 720 hourly candles, second reading: the movement share above and the return distribution
    // below are computed from one fetch, so they can never disagree about which hours they cover.
    a.closedReturns = closedReturns(h);
  } catch (e) { a.closedHours = null; a.closedHoursError = e.message.slice(0, 120); }
  await sleep(90);
  if (a.microstructure?.spreadBps == null) delete a.microstructure;
  log(`  ${a.sym.padEnd(6)} ${a.pair.padEnd(10)} corr ${String(a.returnCorrelation).padEnd(7)} TE ${String(a.trackingErrorBpPerDay).padStart(4)}bp/d  spread ${a.microstructure ? String(a.microstructure.spreadBps).padStart(6) + "bp" : "   n/a"}  closed-move ${a.closedHours?.referenceClosedMoveSharePct ?? "n/a"}%`);
}

/* 6b. pool every wrapper's closed-session blocks into one return distribution.
   Pooling across pairs is deliberate and is stated wherever it is quoted: a weekend block for one
   wrapper is not an independent draw from the same distribution as another wrapper's, because the
   whole crypto-quoted complex moves together. The pooled n is therefore reported next to the number
   of distinct wrappers and the distinct weekends that produced it, so the effective sample size is
   visible rather than implied by n alone. */
const returnLayer = (() => {
  const weekend = [], overnight = [];
  const pairsWith = [];
  const weekendWeeks = new Set();
  for (const a of canonical) {
    const cr = a.closedReturns;
    if (!cr) continue;
    if (cr.hourlyStdRatioOutsideOverInside != null) pairsWith.push(a.sym);
    for (const b of cr.weekendBlocks || []) { weekend.push(Object.assign({ sym: a.sym, pair: a.pair, tier: a.tier }, b)); weekendWeeks.add(b.startIso.slice(0, 10)); }
    for (const b of cr.overnightBlocks || []) overnight.push(Object.assign({ sym: a.sym, pair: a.pair }, b));
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
  const wk = weekend.map((b) => b.returnPct);
  return {
    convention: "pooled over the canonical wrapper of every verified underlying; one hourly fetch of 720 candles per pair, so the window is the same ~30 days for every pair and the distinct weekend starts bound the effective sample size",
    pairsWithReturnLayer: pairsWith.length,
    distinctWeekendStarts: weekendWeeks.size,
    hourlyStdRatioOutsideOverInside: dist(canonical.map((a) => a.closedReturns?.hourlyStdRatioOutsideOverInside).filter((x) => x != null)),
    hourlyOutsideSession: dist([].concat(...canonical.map((a) => (a.closedReturns?.hourlyOutsideSession ? [a.closedReturns.hourlyOutsideSession.medianPct] : [])))),
    pooled: {
      weekendReturnDistribution: dist(wk),
      weekendMaeDistribution: dist(weekend.map((b) => b.maePct)),
      weekendMfeDistribution: dist(weekend.map((b) => b.mfePct)),
      weekendShareBreached5PctDrawdownPct: weekend.length ? r(100 * weekend.filter((b) => b.maePct != null && b.maePct <= -5).length / weekend.length, 1) : null,
      weekendShareBreached10PctDrawdownPct: weekend.length ? r(100 * weekend.filter((b) => b.maePct != null && b.maePct <= -10).length / weekend.length, 1) : null,
      overnightReturnDistribution: dist(overnight.map((b) => b.returnPct)),
      overnightMaeDistribution: dist(overnight.map((b) => b.maePct))
    },
    weekendBlocks: weekend,
    overnightBlocks: overnight.slice(0, 400),
    caveat: "These are wrapper returns measured on a tokenised-equity venue while the reference cash market was shut. They are NOT the outcome distribution AnalogDesk retrieves, which is built on 5x24 daily sessions of the underlying and is validated as published in research/VALIDATION.md. A weekend block return is a single draw per wrapper per weekend, the blocks are highly cross-correlated across wrappers, and 720 hourly candles is roughly four weekends per pair - so the pooled n overstates the number of independent observations and the distinct weekend starts are the honest bound."
  };
})();

/* 7. aggregate, and the block the research card quotes. */
const pick = (k) => canonical.map((a) => a[k]).filter((x) => Number.isFinite(x));
const sub = (k, k2) => canonical.map((a) => a[k]?.[k2]).filter((x) => Number.isFinite(x));
const tiers = {};
for (const a of canonical) tiers[a.tier] = (tiers[a.tier] || 0) + 1;
for (const a of accepted) families[a.issuerSuffix] = (families[a.issuerSuffix] || 0) + 1;

const summary = {
  wrappersVerified: canonical.length,
  underlyingSymbolsCovered: Object.keys(bySym).length,
  universeSymbols: universe.length,
  coveragePct: r(100 * Object.keys(bySym).length / universe.length, 1),
  candidatesTested: accepted.length + rejected.length,
  rejectedCount: rejected.length,
  issuerFamilies: families,
  tiers,
  medianReturnCorrelation: r(quantile(pick("returnCorrelation"), 0.5), 4),
  minReturnCorrelation: r(Math.min(...pick("returnCorrelation")), 4),
  medianTrackingErrorBpPerDay: r0(quantile(pick("trackingErrorBpPerDay"), 0.5)),
  maxTrackingErrorBpPerDay: r0(Math.max(...pick("trackingErrorBpPerDay"))),
  medianPremiumPct: r(quantile(pick("premiumMedianPct"), 0.5), 2),
  maxAbsPremiumP90Pct: r(Math.max(...pick("premiumP90Pct").map(Math.abs)), 2),
  medianSpreadBps: r(quantile(sub("microstructure", "spreadBps"), 0.5), 2),
  maxSpreadBps: r(Math.max(...sub("microstructure", "spreadBps")), 2),
  medianDepthWithin50BpsUsdt: r0(quantile(sub("microstructure", "depthWithin50BpsUsdt"), 0.5)),
  medianQuoteVolume24hUsdt: r0(quantile(pick("quoteVolume24hUsdt"), 0.5)),
  medianReferenceClosedMoveSharePct: r(quantile(sub("closedHours", "referenceClosedMoveSharePct"), 0.5), 1),
  maxReferenceClosedMoveSharePct: r(Math.max(...sub("closedHours", "referenceClosedMoveSharePct")), 1),
  minReferenceClosedMoveSharePct: r(Math.min(...sub("closedHours", "referenceClosedMoveSharePct")), 1),
  pairsWithClosedHoursMeasurement: sub("closedHours", "referenceClosedMoveSharePct").length,
  pairsWithMicrostructure: sub("microstructure", "spreadBps").length,
  pairsWithReturnLayer: sub("closedReturns", "hourlyStdRatioOutsideOverInside").length,
  medianHourlyStdRatioOutsideOverInside: r(quantile(sub("closedReturns", "hourlyStdRatioOutsideOverInside"), 0.5), 3),
  weekendBlocksObserved: canonical.reduce((n, a) => n + (a.closedReturns?.weekendBlocks?.length || 0), 0),
  overnightBlocksObserved: canonical.reduce((n, a) => n + (a.closedReturns?.overnightBlocks?.length || 0), 0),
  pooledWeekendMedianReturnPct: returnLayer.pooled.weekendReturnDistribution?.medianPct ?? null,
  pooledWeekendP10ReturnPct: returnLayer.pooled.weekendReturnDistribution?.p10Pct ?? null,
  pooledWeekendStdPct: returnLayer.pooled.weekendReturnDistribution?.stdPct ?? null,
  pooledWeekendShareNegativePct: returnLayer.pooled.weekendReturnDistribution?.shareNegativePct ?? null,
  pooledWeekendMedianMaePct: returnLayer.pooled.weekendMaeDistribution?.medianPct ?? null,
  pooledWeekendP10MaePct: returnLayer.pooled.weekendMaeDistribution?.p10Pct ?? null,
  pooledWeekendShareBreached5PctDrawdownPct: returnLayer.pooled.weekendShareBreached5PctDrawdownPct ?? null
};

base.issuerFamilies = families;
base.closedSessionReturns = returnLayer;
base.pairs = canonical;
base.rejected = rejected;
base.bySymbol = Object.fromEntries(canonical.map((a) => [a.sym, a]));
base.summary = summary;
base.disclosure = [
  `Wrapper layer measured on ${VENUE.name} at ${base.generatedAt}: ${summary.wrappersVerified} tokenised-equity wrappers verified against ${summary.underlyingSymbolsCovered} of ${summary.universeSymbols} library instruments (${summary.coveragePct}% coverage), each after a price test against the underlying's raw session close and a daily-return correlation test.`,
  `Median return correlation ${summary.medianReturnCorrelation}, median tracking error ${summary.medianTrackingErrorBpPerDay} bp/day, median premium ${summary.medianPremiumPct}%, median spread ${summary.medianSpreadBps} bp.`,
  `The 7x24 part, measured: the reference cash market is closed for ${referenceMarket.closedSharePct}% of the week (${referenceMarket.closedHoursPerWeek}h of 168h), and across the verified wrappers a median ${summary.medianReferenceClosedMoveSharePct}% of the wrapper's own realised hourly price movement happened while it was closed.`,
  `The return layer, measured: over ${returnLayer.pooled.weekendReturnDistribution?.n ?? 0} weekend closed-market blocks across ${returnLayer.pairsWithReturnLayer} wrappers the median wrapper return was ${returnLayer.pooled.weekendReturnDistribution?.medianPct ?? "n/a"}% (p10 ${returnLayer.pooled.weekendReturnDistribution?.p10Pct ?? "n/a"}%, sd ${returnLayer.pooled.weekendReturnDistribution?.stdPct ?? "n/a"}%), the median intra-weekend adverse excursion was ${returnLayer.pooled.weekendMaeDistribution?.medianPct ?? "n/a"}%, and ${returnLayer.pooled.weekendShareBreached5PctDrawdownPct ?? "n/a"}% of those weekends traded at least 5% below the pre-weekend close. Closed-hour price formation is ${summary.medianHourlyStdRatioOutsideOverInside ?? "n/a"}x as volatile hour-for-hour as open-hour formation.`,
  `This is a measurement of the instrument layer, not a new price source: no retrieval, conformal or validation figure in AnalogDesk uses it, and the outcome distribution AnalogDesk retrieves remains built on 5x24 daily sessions. Snapshots change every second; what is reported is the state at generatedAt.`
].join(" ");

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(base, null, 2), "utf8");

log(`\nsym    pair      n   corr    TE bp/d  prem med%  spread bp  depth<=50bp USDT  closed-move%  tier`);
for (const a of canonical.slice().sort((x, y) => y.returnCorrelation - x.returnCorrelation)) {
  log(`${a.sym.padEnd(6)} ${a.pair.padEnd(9)} ${String(a.overlapSessions).padEnd(4)} ${String(a.returnCorrelation).padEnd(7)} ${String(a.trackingErrorBpPerDay).padStart(6)} ${String(a.premiumMedianPct).padStart(10)} ${String(a.microstructure?.spreadBps ?? "n/a").padStart(10)} ${String(a.microstructure?.depthWithin50BpsUsdt ?? "n/a").padStart(18)} ${String(a.closedHours?.referenceClosedMoveSharePct ?? "n/a").padStart(12)}  ${a.tier}`);
}
console.log(`\n${base.disclosure}`);
console.log(`\nrejected ${rejected.length} candidate(s); wrote data-cache/wrapper-probe.json`);