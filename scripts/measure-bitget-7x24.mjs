/**
 * AnalogDesk - measure the 7x24 layer on BITGET'S OWN DATA.
 *
 *   npm run measure:bitget7x24
 *   node scripts/measure-bitget-7x24.mjs [--quiet] [--symbols=AAPL,NVDA]
 *
 * WHY THIS EXISTS
 * The 7x24 claim was measured on one venue (Gate.io spot xStocks) because that was the only reachable
 * venue that listed tokenised US equities with hourly candles. Bitget's official MCP does list them -
 * as RWA perpetual futures on Bitget's own exchange, 32 of them, trading 24/7 - and it serves its own
 * ticker, order book and candles with no API key. So the layer that carries the project's headline
 * premise is now measured primarily on Bitget data, from the event's own host, with the Gate.io spot
 * wrapper kept beside it as an independent second venue on a different instrument class.
 *
 * WHAT THIS DOES NOT DO
 * It does not touch the analog library, the retrieval features, the frozen conformal scale or
 * research/VALIDATION.md. Those are fitted and validated as published; a venue added afterwards cannot
 * move a number a reviewer already read. This is a measurement of an instrument layer, labelled as such.
 *
 * HOW IT DECIDES AN INSTRUMENT IS REALLY WHAT IT CLAIMS
 * The same two tests the Gate.io measurement uses, from one shared ACCEPTANCE rule set, because two
 * venues measured under different rules cannot be compared:
 *   1. price: the perpetual's last price must sit within +/-7% of the underlying's last RAW session
 *      close in the frozen library;
 *   2. correlation: its DAILY returns must correlate >= 0.5 with the underlying's over >= 20 sessions.
 * Every refusal is recorded with the stage and the reason. Nothing is estimated, and a venue that
 * cannot be reached produces a degradation block and no figures.
 *
 * A PERPETUAL IS NOT A SPOT WRAPPER
 * Funding, no redemption, and a basis that can diverge. So every figure this script writes is labelled
 * with the instrument class, and the cross-venue section reports agreement between a perp and a spot
 * token as agreement between two different instruments on the same underlying - which is the stronger
 * claim, not the weaker one, and is stated as such rather than as "the same thing measured twice".
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { priceRatioTest, correlation, trackingTier, quantile } from "../src/data/xstocks.mjs";
import {
  ACCEPTANCE, r, r0, stdev, closedHours, closedReturns,
  SESSION_CONVENTION, CLOSED_RETURN_CONVENTION, MIN_BLOCK_HOURS, WEEKEND_BLOCK_HOURS
} from "../src/data/closed-session.mjs";
import {
  openBitgetMcp, normaliseCandles, bitgetMicrostructure, bitgetCatalog,
  BITGET_VENUE, BITGET_MCP_TRAPS, sleep
} from "../src/data/bitget-venue.mjs";

const { TOL_PCT, MIN_CORR, MIN_OVERLAP } = ACCEPTANCE;
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const OUT = join(ROOT, "data-cache", "bitget-7x24.json");
const GATEIO_FILE = join(ROOT, "data-cache", "wrapper-probe.json");
const QUIET = process.argv.includes("--quiet");
const log = (...a) => { if (!QUIET) console.log(...a); };
const argOf = (name) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : null; };
const ONLY = (argOf("symbols") || "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
const HOURLY_LIMIT = 1000;   // upstream ignores startTime/endTime, so this is the whole reachable window (~41 days)
const CONCURRENCY = 3;

const dist = (arr) => {
  const a = (arr || []).filter((x) => Number.isFinite(x));
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

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = new Array(Math.max(1, Math.min(limit, items.length))).fill(0).map(async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  });
  await Promise.all(workers);
  return out;
}

/* 1. the frozen library: the underlying's own closes are the reference both tests are measured against. */
const ds = JSON.parse(readFileSync(join(ROOT, "data-cache", "dataset.json"), "utf8"));
const dates = ds.dates;
const allUniverse = (ds.meta?.universe || []).map((u) => u.s);
const universe = ONLY.length ? allUniverse.filter((s) => ONLY.includes(s)) : allUniverse;
log(`[bitget7x24] library: ${allUniverse.length} instruments x ${dates.length} sessions (${dates[0]} .. ${dates[dates.length - 1]})`);
log(`[bitget7x24] measuring ${universe.length} underlying(s) against ${BITGET_VENUE.name}`);

const lastRawClose = (sym) => {
  const c = ds.prices?.[sym]?.c;
  if (!Array.isArray(c)) return null;
  for (let i = c.length - 1; i >= 0; i--) if (c[i] != null && Number.isFinite(c[i])) return { price: c[i], index: i, date: dates[i] };
  return null;
};
/** Bitget writes Berkshire-B as BRKB; the library may write it BRK.B or BRK-B. */
const perpSymbol = (sym) => `${String(sym).replace(/[^A-Za-z0-9]/g, "").toUpperCase()}/USDT`;

/* 2. open the venue. No proxy, no session, no measurement - and a file that says so. */
const mcp = await openBitgetMcp({ timeoutMs: 40000 });
const startedAt = new Date().toISOString();
if (!mcp.ok) {
  const out = {
    generatedAt: startedAt, venue: { ...BITGET_VENUE, route: mcp.route }, traps: BITGET_MCP_TRAPS,
    thresholds: { priceTolerancePct: TOL_PCT, minReturnCorrelation: MIN_CORR, minOverlapSessions: MIN_OVERLAP },
    degradation: mcp.degradation, instruments: [], rejected: [], summary: null, closedSessionReturns: null,
    crossVenue: null,
    disclosure: `The Bitget venue could not be reached from this machine (${mcp.degradation?.kind}: ${mcp.degradation?.detail}), so the 7x24 layer was NOT measured on Bitget data on this run and no figure here is estimated. The Gate.io spot-wrapper measurement in data-cache/wrapper-probe.json is unaffected and remains on the record; the card says which venue produced the numbers it shows.`
  };
  writeFileSync(OUT, JSON.stringify(out, null, 2));
  log(`[bitget7x24] DEGRADED (${mcp.degradation?.kind}) - wrote a disclosure and no figures: ${OUT}`);
  process.exit(0);
}
log(`[bitget7x24] venue open: ${mcp.route} session=${mcp.sid.slice(0, 8)}... server=${mcp.serverInfo?.name}@${mcp.serverInfo?.version} in ${mcp.initMs}ms`);

/* 3. catalog cross-reference. It ignores `exchange`, so it can never prove a Bitget listing. */
const cat = await bitgetCatalog(mcp);
log(`[bitget7x24] catalog: ${cat.count} rows, ${cat.rwa.length} flagged RWA, exchanges reported: ${cat.exchangesReported.join("/") || "none"}`);
const rwaSet = new Set(cat.rwa.map((s) => String(s).toUpperCase()));

/* 4. verification. Two tests, shared thresholds, every refusal recorded. */
const accepted = [];
const rejected = [];
const observedTickerFields = new Set();
await mapLimit(universe, CONCURRENCY, async (sym) => {
  const ref = lastRawClose(sym);
  const pair = perpSymbol(sym);
  if (!ref) { rejected.push({ sym, pair, stage: "library", reason: "no raw session close in the frozen library, so there is nothing to verify against" }); return; }
  const t = await mcp.query("crypto_futures_ticker", { symbol: pair, exchange: BITGET_VENUE.exchange });
  if (!t.ok || !t.object) {
    rejected.push({ sym, pair, stage: "listing", reason: t.errorText || (t.empty ? "Bitget returned HTTP 204 with an empty body: catalogued upstream, no data served" : `ticker failed (HTTP ${t.status})`), status: t.status });
    return;
  }
  for (const k of Object.keys(t.object)) observedTickerFields.add(k);
  const last = Number(t.object.last);
  if (!Number.isFinite(last) || last <= 0) { rejected.push({ sym, pair, stage: "ticker", reason: "ticker returned no usable last price", status: t.status }); return; }
  const pt = priceRatioTest(last, ref.price, TOL_PCT);
  if (!pt.ok) { rejected.push({ sym, pair, stage: "price", reason: pt.reason, last: r(last, 4), rawClose: r(ref.price, 4), date: ref.date }); return; }

  const d = await mcp.query("crypto_futures_kline", { symbol: pair, interval: "1d", limit: 200, exchange: BITGET_VENUE.exchange });
  const dn = normaliseCandles(d, { wantInterval: "1d", wantExchange: BITGET_VENUE.exchange });
  if (!d.ok || !dn.rows.length) { rejected.push({ sym, pair, stage: "candles", reason: d.errorText || `daily candles returned HTTP ${d.status} with no rows` }); return; }
  if (dn.trap) { rejected.push({ sym, pair, stage: "interval-echo", reason: `asked for 1d and the upstream echoed interval=${dn.intervalEchoed} exchange=${dn.exchangeEchoed}; a silent fallback would have measured the wrong thing`, intervalEchoed: dn.intervalEchoed, exchangeEchoed: dn.exchangeEchoed }); return; }

  const byDate = new Map(dn.rows.map((x) => [new Date(x.t * 1000).toISOString().slice(0, 10), x]));
  const A = ds.prices[sym].c;
  const ov = [];
  for (let i = 0; i < dates.length; i++) {
    const w = byDate.get(dates[i]);
    if (w && w.c > 0 && A[i] != null && Number.isFinite(A[i]) && A[i] > 0) ov.push({ d: dates[i], w: w.c, u: A[i], qv: w.qv });
  }
  if (ov.length < MIN_OVERLAP) { rejected.push({ sym, pair, stage: "overlap", reason: `only ${ov.length} overlapping sessions, fewer than the ${MIN_OVERLAP} required`, overlap: ov.length }); return; }
  const wr = [], ur = [], prem = [];
  for (let i = 1; i < ov.length; i++) { wr.push(ov[i].w / ov[i - 1].w - 1); ur.push(ov[i].u / ov[i - 1].u - 1); }
  for (const x of ov) prem.push(x.w / x.u - 1);
  const diff = wr.map((x, i) => x - ur[i]);
  const corr = correlation(wr, ur);
  const sd = (a) => { const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((s2, x) => s2 + (x - m) ** 2, 0) / (a.length - 1)); };
  const teBp = sd(diff) * 1e4;
  // The tier is classified from the figures that actually get PUBLISHED, not from their unrounded
  // originals. A row whose own printed numbers recompute to a different tier than the one printed on
  // it is a row a reviewer cannot reproduce - and the tight/fair boundary sits at exactly 60 bp/day,
  // where rounding an unrounded 60.4 down to 60 flips the answer. The accept/reject decision below
  // still uses the raw correlation, so rounding can only make a row harder to classify, never easier
  // to accept.
  const corrPublished = r(corr, 4), tePublished = r0(teBp);
  const tier = trackingTier(corrPublished, tePublished);
  if (!Number.isFinite(corr) || corr < MIN_CORR) {
    rejected.push({ sym, pair, stage: "correlation", reason: `daily returns correlate at ${Number.isFinite(corr) ? corr.toFixed(3) : "n/a"} with ${sym}, below the ${MIN_CORR} floor - price proximity alone is not evidence`, corr: r(corr, 4), overlap: ov.length });
    return;
  }
  const qv24 = Number(t.object.quoteVolume ?? t.object.quote_volume ?? t.object.turnover24h ?? t.object.usdtVolume ?? NaN);
  accepted.push({
    sym, pair, exchange: dn.exchangeEchoed, productType: BITGET_VENUE.productType,
    instrumentClass: BITGET_VENUE.instrumentClass,
    flaggedRwaInCatalog: rwaSet.has(pair.toUpperCase()),
    overlapSessions: ov.length, from: ov[0].d, to: ov[ov.length - 1].d,
    lastRawClose: r(ref.price, 4), lastRawCloseDate: ref.date, perpLast: r(last, 4),
    priceDeviationPct: r(pt.devPct, 2),
    returnCorrelation: corrPublished, trackingErrorBpPerDay: tePublished,
    premiumMedianPct: r(quantile(prem, 0.5) * 100, 2),
    premiumP10Pct: r(quantile(prem, 0.1) * 100, 2), premiumP90Pct: r(quantile(prem, 0.9) * 100, 2),
    medianDailyVolumeBase: r0(quantile(ov.map((x) => x.qv), 0.5)),
    quoteVolume24hUsdt: Number.isFinite(qv24) ? r0(qv24) : null,
    tier: tier.tier, tierLabel: tier.label
  });
});
log(`[bitget7x24] verification: ${accepted.length} accepted, ${rejected.length} rejected`);
accepted.sort((a, b) => a.sym.localeCompare(b.sym));

/* 5. hourly closed-session behaviour + live microstructure, for the instruments that passed. */
for (const a of accepted) {
  const h = await mcp.query("crypto_futures_kline", { symbol: a.pair, interval: "1h", limit: HOURLY_LIMIT, exchange: BITGET_VENUE.exchange });
  const hn = normaliseCandles(h, { wantInterval: "1h", wantExchange: BITGET_VENUE.exchange });
  a.hourlyCandles = hn.n;
  a.intervalEchoed = hn.intervalEchoed;
  a.exchangeEchoed = hn.exchangeEchoed;
  if (!h.ok || hn.trap || !hn.rows.length) {
    a.closedHours = null; a.closedReturns = null;
    a.hourlyError = hn.trap ? `asked for 1h and the upstream echoed interval=${hn.intervalEchoed} exchange=${hn.exchangeEchoed}` : (h.errorText || `hourly candles returned HTTP ${h.status} with no rows`);
  } else {
    a.hourlyFrom = new Date(hn.rows[0].t * 1000).toISOString();
    a.hourlyTo = new Date(hn.rows[hn.rows.length - 1].t * 1000).toISOString();
    // One fetch, two readings: the movement share and the return distribution are computed from the same
    // candles, so they can never disagree about which hours they cover.
    a.closedHours = closedHours(hn.rows);
    a.closedReturns = closedReturns(hn.rows);
  }
  await sleep(60);
  const b = await mcp.query("crypto_futures_order_book", { symbol: a.pair, limit: 50, exchange: BITGET_VENUE.exchange });
  a.microstructure = b.ok && b.object ? bitgetMicrostructure(b.object) : null;
  if (!a.microstructure) a.microstructureError = b.errorText || `order book returned HTTP ${b.status}`;
  if (a.microstructure?.spreadBps == null) delete a.microstructure;
  await sleep(60);
  log(`  ${a.sym.padEnd(6)} ${a.pair.padEnd(12)} corr ${String(a.returnCorrelation).padEnd(7)} TE ${String(a.trackingErrorBpPerDay).padStart(4)}bp/d  spread ${a.microstructure ? String(a.microstructure.spreadBps).padStart(6) + "bp" : "   n/a"}  hourly ${String(a.hourlyCandles).padStart(4)}  closed-move ${a.closedHours?.referenceClosedMoveSharePct ?? "n/a"}%`);
}

/* 6. pool the closed-session blocks, and always print the distinct weekends next to the block count. */
const withReturns = accepted.filter((a) => a.closedReturns);
const weekend = [], overnight = [];
const weekendWeeks = new Set();
for (const a of withReturns) {
  for (const b of a.closedReturns.weekendBlocks || []) { weekend.push(Object.assign({ sym: a.sym, pair: a.pair, tier: a.tier }, b)); weekendWeeks.add(b.startIso.slice(0, 10)); }
  for (const b of a.closedReturns.overnightBlocks || []) overnight.push(Object.assign({ sym: a.sym, pair: a.pair }, b));
}
const wk = weekend.map((b) => b.returnPct);
const returnLayer = {
  convention: CLOSED_RETURN_CONVENTION,
  instrumentsWithReturnLayer: withReturns.length,
  distinctWeekendStarts: weekendWeeks.size,
  hourlyStdRatioOutsideOverInside: (() => {
    const v = withReturns.map((a) => a.closedReturns.hourlyStdRatioOutsideOverInside).filter(Number.isFinite);
    return v.length ? { n: v.length, meanPct: r(v.reduce((x, y) => x + y, 0) / v.length, 4), medianPct: r(quantile(v, 0.5), 4), stdPct: r(stdev(v), 4), p10Pct: r(quantile(v, 0.1), 4), p90Pct: r(quantile(v, 0.9), 4), minPct: r(Math.min(...v), 4), maxPct: r(Math.max(...v), 4), shareNegativePct: r(100 * v.filter((x) => x < 0).length / v.length, 1) } : null;
  })(),
  pooled: {
    weekendReturnDistribution: dist(wk),
    weekendMaeDistribution: dist(weekend.map((b) => b.maePct)),
    weekendMfeDistribution: dist(weekend.map((b) => b.mfePct)),
    weekendShareBreached5PctDrawdownPct: weekend.length ? r(100 * weekend.filter((b) => b.maePct != null && b.maePct <= -5).length / weekend.length, 1) : null,
    weekendShareBreached10PctDrawdownPct: weekend.length ? r(100 * weekend.filter((b) => b.maePct != null && b.maePct <= -10).length / weekend.length, 1) : null,
    overnightReturnDistribution: dist(overnight.map((b) => b.returnPct)),
    overnightMaeDistribution: dist(overnight.map((b) => b.maePct))
  },
  caveat: `Pooled across ${withReturns.length} Bitget RWA perpetuals. These blocks are NOT independent draws: the whole tokenised-equity complex moves together and every instrument shares the same ${weekendWeeks.size} weekend(s), so the effective sample size is ${weekendWeeks.size} weekend(s), not ${weekend.length} blocks. Both counts are printed wherever this is quoted. A perpetual also carries funding and a basis, so its closed-session return is the return of a 7x24 SYNTHETIC position, not of a redeemable spot token.`
};

/* 7. cross-venue: the same underlying on a Bitget perpetual and a Gate.io spot wrapper. */
const gateio = existsSync(GATEIO_FILE) ? JSON.parse(readFileSync(GATEIO_FILE, "utf8")) : null;
const crossVenue = (() => {
  if (!gateio || gateio.degradation || !Array.isArray(gateio.pairs) || !gateio.pairs.length) {
    return { available: false, reason: "no Gate.io wrapper measurement on record to compare against" };
  }
  const g = new Map(gateio.pairs.map((p) => [p.sym, p]));
  const both = [];
  for (const a of withReturns) {
    const b = g.get(a.sym);
    if (!b || !b.closedHours || !b.closedReturns) continue;
    both.push({
      sym: a.sym, bitgetPair: a.pair, gatePair: b.pair,
      bitgetHoursObserved: a.closedHours?.hoursObserved ?? null, gateHoursObserved: b.closedHours?.hoursObserved ?? null,
      bitgetInstrument: BITGET_VENUE.productType, gateInstrument: "spot tokenised-equity wrapper",
      closedMoveSharePct: { bitget: a.closedHours.referenceClosedMoveSharePct, gateio: b.closedHours.referenceClosedMoveSharePct },
      hourlyStdRatio: { bitget: a.closedReturns.hourlyStdRatioOutsideOverInside, gateio: b.closedReturns.hourlyStdRatioOutsideOverInside },
      returnCorrelation: { bitget: a.returnCorrelation, gateio: b.returnCorrelation },
      trackingErrorBpPerDay: { bitget: a.trackingErrorBpPerDay, gateio: b.trackingErrorBpPerDay },
      spreadBps: { bitget: a.microstructure?.spreadBps ?? null, gateio: b.microstructure?.spreadBps ?? null },
      weekendMedianReturnPct: { bitget: a.closedReturns.weekendReturnDistribution?.medianPct ?? null, gateio: b.closedReturns.weekendReturnDistribution?.medianPct ?? null }
    });
  }
  const dif = (f) => dist(both.map((x) => { const p = f(x); return p[0] != null && p[1] != null ? p[0] - p[1] : NaN; }));
  return {
    available: both.length > 0,
    comparedSymbols: both.length,
    windowHours: {
      bitgetMedian: (() => { const v = both.map((x) => x.bitgetHoursObserved).filter(Number.isFinite); return v.length ? r0(quantile(v, 0.5)) : null; })(),
      gateioMedian: (() => { const v = both.map((x) => x.gateHoursObserved).filter(Number.isFinite); return v.length ? r0(quantile(v, 0.5)) : null; })(),
      note: "the venues do not serve the same hourly depth, so the observed window is reported for each side rather than assumed equal"
    },
    bitgetVenue: { name: BITGET_VENUE.name, instrument: BITGET_VENUE.instrumentClass, route: mcp.route, generatedAt: startedAt },
    gateVenue: { name: gateio.venue?.name || "Gate.io spot v4", instrument: "spot tokenised-equity wrapper (xStocks)", generatedAt: gateio.generatedAt },
    perSymbol: both,
    medianDifferenceBitgetMinusGateio: {
      closedMoveSharePct: dif((x) => [x.closedMoveSharePct.bitget, x.closedMoveSharePct.gateio]),
      hourlyStdRatio: dif((x) => [x.hourlyStdRatio.bitget, x.hourlyStdRatio.gateio]),
      returnCorrelation: dif((x) => [x.returnCorrelation.bitget, x.returnCorrelation.gateio]),
      spreadBps: dif((x) => [x.spreadBps.bitget, x.spreadBps.gateio])
    },
    note: "Two venues, two instrument classes, one underlying, one shared definition of the reference session (src/data/closed-session.mjs). Agreement between a Bitget perpetual and a Gate.io spot token is stronger evidence than the same instrument measured twice, and disagreement is reported rather than averaged away."
  };
})();

/* 8. summary + disclosure. */
const med = (f) => { const v = accepted.map(f).filter(Number.isFinite); return v.length ? r(quantile(v, 0.5), 4) : null; };
const tiers = {};
for (const a of accepted) tiers[a.tier] = (tiers[a.tier] || 0) + 1;
const summary = {
  measured: true,
  measuredAt: startedAt,
  route: mcp.route,
  server: mcp.serverInfo ? `${mcp.serverInfo.name}@${mcp.serverInfo.version}` : null,
  venue: BITGET_VENUE.name,
  exchangePinned: BITGET_VENUE.exchange,
  instrumentClass: BITGET_VENUE.instrumentClass,
  instrumentsVerified: accepted.length,
  underlyingSymbolsCovered: new Set(accepted.map((a) => a.sym)).size,
  universeSymbols: allUniverse.length,
  coveragePct: r(100 * new Set(accepted.map((a) => a.sym)).size / allUniverse.length, 1),
  candidatesTested: accepted.length + rejected.length,
  rejectedCount: rejected.length,
  catalogRwaFlagged: cat.rwa.length,
  tiers,
  medianReturnCorrelation: med((a) => a.returnCorrelation),
  minReturnCorrelation: (() => { const v = accepted.map((a) => a.returnCorrelation).filter(Number.isFinite); return v.length ? r(Math.min(...v), 4) : null; })(),
  medianTrackingErrorBpPerDay: r0(med((a) => a.trackingErrorBpPerDay)),
  medianPremiumPct: med((a) => a.premiumMedianPct),
  medianSpreadBps: med((a) => a.microstructure?.spreadBps),
  maxSpreadBps: (() => { const v = accepted.map((a) => a.microstructure?.spreadBps).filter(Number.isFinite); return v.length ? r(Math.max(...v), 2) : null; })(),
  medianDepthWithin50BpsUsdt: r0(med((a) => a.microstructure?.depthWithin50BpsUsdt)),
  medianReferenceClosedMoveSharePct: med((a) => a.closedHours?.referenceClosedMoveSharePct),
  instrumentsWithClosedHours: accepted.filter((a) => a.closedHours).length,
  instrumentsWithReturnLayer: withReturns.length,
  weekendBlocksObserved: weekend.length,
  overnightBlocksObserved: overnight.length,
  distinctWeekendStarts: weekendWeeks.size,
  pooledWeekendMedianReturnPct: returnLayer.pooled.weekendReturnDistribution?.medianPct ?? null,
  pooledWeekendP10ReturnPct: returnLayer.pooled.weekendReturnDistribution?.p10Pct ?? null,
  pooledWeekendStdPct: returnLayer.pooled.weekendReturnDistribution?.stdPct ?? null,
  pooledWeekendShareNegativePct: returnLayer.pooled.weekendReturnDistribution?.shareNegativePct ?? null,
  pooledWeekendMedianMaePct: returnLayer.pooled.weekendMaeDistribution?.medianPct ?? null,
  pooledWeekendP10MaePct: returnLayer.pooled.weekendMaeDistribution?.p10Pct ?? null,
  pooledWeekendShareBreached5PctDrawdownPct: returnLayer.pooled.weekendShareBreached5PctDrawdownPct,
  medianHourlyStdRatioOutsideOverInside: returnLayer.hourlyStdRatioOutsideOverInside?.medianPct ?? null,
  crossVenueCompared: crossVenue.available ? crossVenue.comparedSymbols : 0
};

const disclosure = `The 7x24 layer is measured primarily on Bitget's own data: ${summary.instrumentsVerified} Bitget RWA perpetual${summary.instrumentsVerified === 1 ? "" : "s"} on tokenised US equities, verified against ${summary.underlyingSymbolsCovered} of ${summary.universeSymbols} library instruments (${summary.coveragePct}%), fetched through the official Bitget MCP (${summary.server}) on the ${summary.route} route with exchange pinned to "${summary.exchangePinned}" and the echoed interval and exchange asserted on every fetch. Each candidate had to pass a price test against the underlying's raw session close and a daily-return correlation test; ${summary.rejectedCount} refusal${summary.rejectedCount === 1 ? "" : "s"} recorded with the stage and the reason. Median return correlation ${summary.medianReturnCorrelation}, median tracking error ${summary.medianTrackingErrorBpPerDay} bp/day, median spread ${summary.medianSpreadBps} bp. Closed-session returns: ${summary.weekendBlocksObserved} weekend blocks over ${summary.distinctWeekendStarts} distinct weekend(s) and ${summary.overnightBlocksObserved} overnight blocks, pooled weekend median ${summary.pooledWeekendMedianReturnPct}% (p10 ${summary.pooledWeekendP10ReturnPct}%, sd ${summary.pooledWeekendStdPct}%), median intra-weekend adverse excursion ${summary.pooledWeekendMedianMaePct}%, ${summary.pooledWeekendShareBreached5PctDrawdownPct}% of weekends trading at least 5% below the pre-weekend close, and closed-hour price formation at ${summary.medianHourlyStdRatioOutsideOverInside}x the open-hour level. ${crossVenue.available ? `Cross-venue: the same ${crossVenue.comparedSymbols} underlying(s) on a Bitget perpetual and a Gate.io spot wrapper, measured under one shared reference-session convention.` : "No cross-venue comparison was possible on this run."} A perpetual is not a redeemable spot token - it carries funding and a basis - so every figure is labelled with its instrument class. This is a measurement of the instrument layer: no retrieval, conformal or validation figure in AnalogDesk uses it, and the outcome distribution AnalogDesk retrieves remains built on 5x24 daily sessions. The route matters and is disclosed: Bitget hosts reset at the TCP layer on a direct connection from the build machine, so this measurement needs a local HTTP proxy; on a machine without one the script writes a degradation block and no figures, and the Gate.io measurement stands alone.`;

const out = {
  generatedAt: startedAt,
  venue: { ...BITGET_VENUE, route: mcp.route, serverInfo: mcp.serverInfo, protocolVersion: mcp.protocolVersion },
  traps: BITGET_MCP_TRAPS,
  observedTickerFields: [...observedTickerFields].sort(),
  thresholds: { priceTolerancePct: TOL_PCT, minReturnCorrelation: MIN_CORR, minOverlapSessions: MIN_OVERLAP, hourlyCandlesRequested: HOURLY_LIMIT, minBlockHours: MIN_BLOCK_HOURS, weekendBlockHours: WEEKEND_BLOCK_HOURS },
  referenceSessionConvention: SESSION_CONVENTION,
  degradation: null,
  catalog: { rows: cat.count, rwaFlagged: cat.rwa.length, exchangesReported: cat.exchangesReported, note: cat.note, rwaSymbols: cat.rwa },
  library: { symbols: allUniverse.length, sessions: dates.length, from: dates[0], to: dates[dates.length - 1], measured: ONLY.length ? `${universe.length} symbol(s) only: ${ONLY.join(",")}` : "all" },
  instruments: accepted,
  rejected,
  summary,
  closedSessionReturns: returnLayer,
  crossVenue,
  disclosure
};
writeFileSync(OUT, JSON.stringify(out, null, 2));
log(`\n[bitget7x24] ${disclosure}`);
log(`\n[bitget7x24] rejected ${rejected.length} candidate(s); wrote ${OUT}`);
