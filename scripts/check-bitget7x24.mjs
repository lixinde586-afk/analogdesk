/**
 * AnalogDesk - the gate on the PRIMARY venue of the 7x24 layer: Bitget's own data.
 *
 *   npm run check:bitget7x24
 *
 * WHY THIS EXISTS
 * The 7x24 claim was measured on one venue (Gate.io spot wrappers) because that was the only reachable
 * venue listing tokenised US equities with hourly candles. It is now measured PRIMARILY on Bitget's own
 * RWA perpetuals, fetched through the official Bitget MCP with `exchange` pinned to "bitget", and the
 * Gate.io measurement sits beside it as an independent second venue on a different instrument class -
 * and as the only venue on a machine with no route to Bitget.
 *
 * Promoting a venue is exactly the moment a number can start being wrong in a flattering direction, so
 * this gate re-derives every published figure from the rows behind it and refuses to publish if:
 *   - an instrument is reported that did not pass the shared acceptance rules in closed-session.mjs;
 *   - the echoed interval or exchange is not the one that was asked for. The upstream accepts a
 *     `granularity` parameter, ignores it and returns DAILY bars, which would silently turn a 7x24
 *     measurement into a 5x24 one and nobody reading the card would notice;
 *   - a candidate was dropped instead of recorded as a refusal with its stage and reason;
 *   - the summary, the pooled return layer or the cross-venue block disagrees with its own rows;
 *   - the measurement stops reaching the card, the scenario caveat and the prose;
 *   - the venue hierarchy is not honoured: Bitget primary when it measured, Gate.io as the fallback
 *     when Bitget is degraded or absent, and never a Bitget figure invented to fill the gap;
 *   - any Bitget figure leaks into the retrieval result it must not touch.
 *
 * A degraded measurement is a PASS, provided it degrades loudly and the fallback is what the card then
 * quotes. What may never happen is a number with no venue behind it.
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createDesk } from "../src/desk.mjs";
import { renderTemplate } from "../src/llm/template.mjs";
import { cardDigest } from "../src/llm/replay.mjs";
import { PROMPT_VERSION } from "../src/llm/narrate.mjs";
import { buildAllowlist, verifyNumbers, defaultAllowance } from "../src/llm/verify-numbers.mjs";
import { quantile, trackingTier } from "../src/data/xstocks.mjs";
import {
  ACCEPTANCE, SESSION_CONVENTION, CLOSED_RETURN_CONVENTION,
  MIN_BLOCK_HOURS, WEEKEND_BLOCK_HOURS, r, r0, stdev
} from "../src/data/closed-session.mjs";
import { BITGET_VENUE, BITGET_MCP_TRAPS } from "../src/data/bitget-venue.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const FILE = join(ROOT, "data-cache", "bitget-7x24.json");
const GATEIO_FILE = join(ROOT, "data-cache", "wrapper-probe.json");
const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };

let failures = 0, notes = 0;
const ok = (m) => console.log(`  ok   ${m}`);
const bad = (m) => { failures++; console.log(`  FAIL ${m}`); };
const note = (m) => { notes++; console.log(`  note ${m}`); };
const section = (t) => console.log(`\n=== ${t} ===`);
const median = (arr) => { const v = (arr || []).filter(Number.isFinite); return v.length ? quantile(v, 0.5) : NaN; };
const close = (a, b, tol = 1e-9) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;
/** Assert a published aggregate against the same aggregate recomputed from the rows behind it. */
const eq = (label, got, want) => {
  if (got == null || want == null || !close(Number(got), Number(want), 1e-9)) bad(`${label} is ${got} but recomputes to ${want} from its own rows`);
  else ok(`${label} = ${got} recomputes from the rows behind it`);
};

/* ------------------------- 1. the committed measurement ------------------------- */

section("data-cache/bitget-7x24.json");
if (!existsSync(FILE)) {
  bad("no Bitget 7x24 measurement on record - the primary venue of the 7x24 layer is unmeasured. Run: node scripts/measure-bitget-7x24.mjs");
  console.log(`\ncheck:bitget7x24 FAILED (${failures})`);
  process.exit(1);
}
const B = readJson(FILE);
if (!B) { bad("bitget-7x24.json did not parse"); process.exit(1); }
const degraded = Boolean(B.degradation);
ok(`present, measured ${B.generatedAt}`);

section("the venue is Bitget's own, and it says how it was reached");
{
  const v = B.venue || {};
  if (v.exchange !== BITGET_VENUE.exchange) bad(`venue.exchange is ${JSON.stringify(v.exchange)} instead of the pinned "${BITGET_VENUE.exchange}" - the upstream default is binance, so an unpinned fetch is not Bitget data`);
  else ok(`exchange pinned to "${v.exchange}" in the committed file`);
  if (v.keyRequired !== false) bad("the venue is reported as needing credentials; this layer is keyless public data and must stay that way");
  else ok("keyless: no account, no API key");
  if (!/perpetual/i.test(v.instrumentClass || "")) bad(`instrumentClass does not name the instrument ("${v.instrumentClass}") - a perpetual must never be describable as a spot wrapper`);
  else ok(`instrument class stated: ${v.instrumentClass}`);
  if (!v.route) bad("no route recorded - a proxied answer and a direct answer are not the same claim, and the card prints this string");
  else ok(`route recorded: ${v.route}`);
  if (!v.serverInfo?.name) note("no serverInfo - the file does not say which MCP build answered");
  else ok(`answered by ${v.serverInfo.name}@${v.serverInfo.version} (MCP ${v.protocolVersion})`);
  if ((B.traps || []).length < BITGET_MCP_TRAPS.length) bad(`the file carries ${(B.traps || []).length} of the ${BITGET_MCP_TRAPS.length} measured upstream traps - a re-run could rely on a fluke nobody wrote down`);
  else ok(`all ${BITGET_MCP_TRAPS.length} measured upstream traps travel with the numbers (interval echo, binance default, crypto_market cap, no pagination, HTTP 204)`);
}

section("one convention, shared with the second venue");
{
  if (B.referenceSessionConvention !== SESSION_CONVENTION) bad("referenceSessionConvention drifted from src/data/closed-session.mjs - two venues under two definitions cannot be compared, and the comparison is the point");
  else ok("the reference-session convention is the shared one from src/data/closed-session.mjs");
  if (B.closedSessionReturns && B.closedSessionReturns.convention !== CLOSED_RETURN_CONVENTION) bad("closedSessionReturns.convention drifted from the shared closed-return convention");
  else if (B.closedSessionReturns) ok("the closed-return convention is the shared one");
  const TH = B.thresholds || {};
  if (TH.priceTolerancePct !== ACCEPTANCE.TOL_PCT || TH.minReturnCorrelation !== ACCEPTANCE.MIN_CORR || TH.minOverlapSessions !== ACCEPTANCE.MIN_OVERLAP) {
    bad(`acceptance thresholds in the file (${JSON.stringify(TH)}) disagree with the shared ACCEPTANCE rule set (${JSON.stringify(ACCEPTANCE)})`);
  } else ok(`acceptance thresholds match the shared rule set: price +/-${TH.priceTolerancePct}%, correlation >= ${TH.minReturnCorrelation}, overlap >= ${TH.minOverlapSessions} sessions`);
  if (TH.minBlockHours !== MIN_BLOCK_HOURS || TH.weekendBlockHours !== WEEKEND_BLOCK_HOURS) bad(`block thresholds in the file disagree with the shared ones (${MIN_BLOCK_HOURS}h minimum, ${WEEKEND_BLOCK_HOURS}h weekend)`);
  else ok(`block thresholds match the shared ones: >= ${TH.minBlockHours}h counts as a closed block, >= ${TH.weekendBlockHours}h as a weekend`);
  const G = readJson(GATEIO_FILE);
  if (!G) note("no data-cache/wrapper-probe.json, so the second venue cannot be compared here - scripts/check-wrapper.mjs gates that file");
  else if (G.degradation) note(`the Gate.io second venue is degraded (${G.degradation.kind}) on this build, so no cross-venue agreement is available`);
  else ok(`the second venue is on record too: ${G.venue?.name} with ${Object.keys(G.bySymbol || {}).length} verified wrapper(s), measured ${G.generatedAt}`);
}

/* ------------------------- 2. degraded path ------------------------- */

if (degraded) {
  section("DEGRADED run - it must say so and report nothing");
  if (!B.disclosure) bad("degraded but carries no disclosure - a silent gap is worse than a measured one");
  else ok(`DEGRADED and disclosed: ${B.degradation.kind} - ${String(B.degradation.detail).slice(0, 140)}`);
  if ((B.instruments || []).length) bad("degraded yet reports instruments - a figure with no venue behind it");
  else ok("the degraded run reports no Bitget instrument and no Bitget figure");
  if (B.summary?.measured) bad("summary.measured is true on a degraded run");
  else ok("summary does not claim a measurement");
  note("sections 3 to 9 assert the measured path only; re-run measure-bitget-7x24.mjs from a machine with a route to Bitget");
}

const I = B.instruments || [];
const S = B.summary || null;
const RL = B.closedSessionReturns || null;
const CV = B.crossVenue || null;
const TH = B.thresholds || {};
if (!degraded) {
  /* ------------------------- 3. acceptance, re-derived ------------------------- */

  section("every reported instrument actually passed both tests");
  if (I.length < 20) bad(`only ${I.length} verified instruments - a measurement this thin does not carry the project's headline premise`);
  else ok(`${I.length} verified Bitget perpetual(s) over ${S?.underlyingSymbolsCovered} of ${S?.universeSymbols} library instruments (${S?.coveragePct}% coverage)`);
  {
    const offenders = [];
    for (const a of I) {
      const errs = [];
      if (!(Math.abs(a.priceDeviationPct) <= TH.priceTolerancePct)) errs.push(`price deviation ${a.priceDeviationPct}% outside +/-${TH.priceTolerancePct}%`);
      if (!(a.returnCorrelation >= TH.minReturnCorrelation)) errs.push(`correlation ${a.returnCorrelation} < ${TH.minReturnCorrelation}`);
      if (!(a.overlapSessions >= TH.minOverlapSessions)) errs.push(`overlap ${a.overlapSessions} < ${TH.minOverlapSessions}`);
      const tier = trackingTier(a.returnCorrelation, a.trackingErrorBpPerDay);
      if (tier.tier !== a.tier) errs.push(`tier ${a.tier} but its own correlation and tracking error recompute to ${tier.tier}`);
      if (!a.tierLabel) errs.push("no tier label - tracking quality must be printed next to the number");
      if (a.exchange !== BITGET_VENUE.exchange) errs.push(`exchange is ${a.exchange}, not ${BITGET_VENUE.exchange}`);
      if (a.productType !== "perpetual") errs.push(`productType is ${a.productType} - the instrument class must be named on every row`);
      if (!String(a.pair).toUpperCase().startsWith(String(a.sym).replace(/[^A-Za-z0-9]/g, "").toUpperCase())) errs.push(`pair ${a.pair} does not carry the underlying ticker ${a.sym}`);
      if (errs.length) offenders.push(`${a.sym}/${a.pair}: ${errs.join("; ")}`);
    }
    if (offenders.length) offenders.slice(0, 8).forEach((o) => bad(o));
    else ok(`all ${I.length} instruments satisfy the price test, the correlation test, the overlap floor, the tier rule and the instrument class`);
  }

  /* ------------------------- 4. the interval / exchange echo trap ------------------------- */

  section("the hourly window really is hourly, and really is Bitget");
  {
    const withHours = I.filter((a) => a.hourlyCandles > 0);
    if (!withHours.length) bad("no instrument carries hourly candles - the closed-session layer would be unmeasured");
    else ok(`${withHours.length}/${I.length} instruments carry hourly candles`);
    const wrongInterval = withHours.filter((a) => a.intervalEchoed !== "1h");
    const wrongExchange = withHours.filter((a) => a.exchangeEchoed !== BITGET_VENUE.exchange);
    if (wrongInterval.length) bad(`${wrongInterval.length} instrument(s) echo interval=${wrongInterval[0].intervalEchoed} instead of 1h - the upstream silently returned daily bars, which would make this a 5x24 measurement labelled 7x24`);
    else ok("every hourly fetch echoes interval=1h, so the trap where a granularity parameter is accepted, ignored and answered with daily bars is caught rather than trusted");
    if (wrongExchange.length) bad(`${wrongExchange.length} instrument(s) echo exchange=${wrongExchange[0].exchangeEchoed} instead of ${BITGET_VENUE.exchange} - that is not Bitget data`);
    else ok(`every hourly fetch echoes exchange=${BITGET_VENUE.exchange}, so the rows are Bitget's own book and not the aggregator default`);
    const thin = withHours.filter((a) => a.hourlyCandles < 720);
    if (thin.length) note(`${thin.length} instrument(s) served fewer than 720 hourly buckets (${thin.map((a) => `${a.sym}:${a.hourlyCandles}`).slice(0, 5).join(", ")}) - a shorter window than the second venue's`);
    else ok(`every instrument served at least 720 hourly buckets (median ${median(withHours.map((a) => a.hourlyCandles))}), so the window is at least as deep as the Gate.io measurement`);
    const noClosed = I.filter((a) => a.closedHours?.referenceClosedMoveSharePct == null);
    if (noClosed.length > I.length * 0.25) bad(`${noClosed.length} of ${I.length} instruments have no closed-hours measurement - the headline figure would rest on a minority of the sample`);
    else ok(`${I.length - noClosed.length}/${I.length} instruments carry a closed-hours measurement`);
    const shares = I.map((a) => a.closedHours?.referenceClosedMoveSharePct).filter(Number.isFinite);
    if (!(S?.medianReferenceClosedMoveSharePct > 0 && S.medianReferenceClosedMoveSharePct < 100)) bad(`median closed-hours move share is ${S?.medianReferenceClosedMoveSharePct} - not a usable percentage`);
    else ok(`median ${S.medianReferenceClosedMoveSharePct}% of the instrument's own movement lands outside the cash session (range ${Math.min(...shares)}% to ${Math.max(...shares)}% over ${shares.length} instruments)`);
    // A spread that does not recompute from its own book is a spread that was typed in.
    const books = I.filter((a) => a.microstructure);
    const badBook = books.filter((a) => {
      const m = a.microstructure;
      return !(m.bestAsk > m.bestBid) || !close(m.mid, (m.bestBid + m.bestAsk) / 2, 1e-6)
        || !close(m.spreadBps, ((m.bestAsk - m.bestBid) / m.mid) * 1e4, 0.011);
    });
    if (books.length && badBook.length) bad(`${badBook.length} order-book snapshot(s) do not recompute: mid or spreadBps disagree with their own bestBid/bestAsk`);
    else if (books.length) ok(`all ${books.length} order-book snapshots recompute from their own best bid and ask (median spread ${S?.medianSpreadBps} bp)`);
    else note("no order-book snapshot on this run - the liquidity figure is absent rather than estimated");
  }

  /* ------------------------- 5. refusals are recorded, not dropped ------------------------- */

  section("refusals");
  {
    const rej = B.rejected || [];
    if (!rej.length) bad("zero refusals recorded - a filter that refuses nothing is not a filter");
    else ok(`${rej.length} candidate(s) refused, each with its stage and reason`);
    const silent = rej.filter((x) => !x.stage || !x.reason);
    if (silent.length) bad(`${silent.length} refusal(s) carry no reason: ${silent.slice(0, 3).map((x) => x.pair).join(", ")}`);
    else ok("every refusal names the test that refused it");
    const stages = {};
    for (const x of rej) stages[x.stage] = (stages[x.stage] || 0) + 1;
    ok(`refusal stages: ${Object.entries(stages).map(([k, n]) => `${k} ${n}`).join(", ")}`);
    // A price-stage refusal must actually fail the price test, recomputed from the prices it recorded.
    const priceRej = rej.filter((x) => x.stage === "price" && Number.isFinite(x.last) && Number.isFinite(x.rawClose));
    const lyingPrice = priceRej.filter((x) => Math.abs((x.last / x.rawClose - 1) * 100) <= TH.priceTolerancePct);
    if (priceRej.length && lyingPrice.length) bad(`${lyingPrice.length} price-stage refusal(s) would actually PASS the price test (${lyingPrice[0].pair}: ${lyingPrice[0].last} against ${lyingPrice[0].rawClose}) - either the filter is refusing what it should accept or the recorded prices are not the ones it used`);
    else if (priceRej.length) ok(`all ${priceRej.length} price-stage refusals fail the price test when it is recomputed from their own recorded prices`);
    const corrRej = rej.filter((x) => x.stage === "correlation" && Number.isFinite(x.corr));
    const lyingCorr = corrRej.filter((x) => x.corr >= TH.minReturnCorrelation);
    if (corrRej.length && lyingCorr.length) bad(`${lyingCorr.length} correlation-stage refusal(s) would actually PASS the correlation floor`);
    else if (corrRej.length) ok(`the correlation floor is doing real work: ${corrRej.map((x) => `${x.pair} at ${x.corr}`).join(", ")} refused despite trading near the underlying's price - the trap this two-test rule was built for`);
    // Nothing may be silently skipped: every library symbol is either verified or refused.
    const covered = new Set([...I.map((a) => a.sym), ...rej.map((x) => x.sym)]);
    if (covered.size !== (B.library?.symbols ?? covered.size)) bad(`${B.library?.symbols} library instruments were tested but only ${covered.size} distinct symbols appear as verified or refused - some candidates were dropped instead of recorded`);
    else ok(`every one of the ${covered.size} library instruments is accounted for: ${new Set(I.map((a) => a.sym)).size} verified, ${new Set(rej.map((x) => x.sym)).size} refused`);
    const notListed = rej.filter((x) => x.stage === "listing");
    if (notListed.length) ok(`${notListed.length} symbol(s) Bitget simply does not list as a tokenised instrument - recorded as an answer, not as a failure to ask`);
  }

  /* ------------------------- 6. the summary is the rows, not a retyping ------------------------- */

  section("summary arithmetic");
  {
    const med = (f) => { const v = I.map(f).filter(Number.isFinite); return v.length ? r(quantile(v, 0.5), 4) : null; };
    eq("summary.instrumentsVerified", S.instrumentsVerified, I.length);
    eq("summary.underlyingSymbolsCovered", S.underlyingSymbolsCovered, new Set(I.map((a) => a.sym)).size);
    eq("summary.universeSymbols", S.universeSymbols, B.library?.symbols ?? S.universeSymbols);
    eq("summary.coveragePct", S.coveragePct, r(100 * new Set(I.map((a) => a.sym)).size / (B.library?.symbols || S.universeSymbols), 1));
    eq("summary.candidatesTested", S.candidatesTested, I.length + (B.rejected || []).length);
    eq("summary.rejectedCount", S.rejectedCount, (B.rejected || []).length);
    eq("the tier histogram", Object.values(S.tiers || {}).reduce((x, y) => x + y, 0), I.length);
    const tierRecount = {};
    for (const a of I) tierRecount[a.tier] = (tierRecount[a.tier] || 0) + 1;
    if (JSON.stringify(Object.entries(S.tiers || {}).sort()) !== JSON.stringify(Object.entries(tierRecount).sort())) bad(`the tier histogram ${JSON.stringify(S.tiers)} is not the recount ${JSON.stringify(tierRecount)}`);
    else ok(`tier histogram recomputes: ${Object.entries(tierRecount).map(([k, n]) => `${k} ${n}`).join(", ")}`);
    eq("summary.medianReturnCorrelation", S.medianReturnCorrelation, med((a) => a.returnCorrelation));
    eq("summary.minReturnCorrelation", S.minReturnCorrelation, r(Math.min(...I.map((a) => a.returnCorrelation)), 4));
    eq("summary.medianTrackingErrorBpPerDay", S.medianTrackingErrorBpPerDay, r0(med((a) => a.trackingErrorBpPerDay)));
    eq("summary.medianPremiumPct", S.medianPremiumPct, med((a) => a.premiumMedianPct));
    eq("summary.medianSpreadBps", S.medianSpreadBps, med((a) => a.microstructure?.spreadBps));
    eq("summary.maxSpreadBps", S.maxSpreadBps, r(Math.max(...I.map((a) => a.microstructure?.spreadBps).filter(Number.isFinite)), 2));
    eq("summary.medianDepthWithin50BpsUsdt", S.medianDepthWithin50BpsUsdt, r0(med((a) => a.microstructure?.depthWithin50BpsUsdt)));
    eq("summary.medianReferenceClosedMoveSharePct", S.medianReferenceClosedMoveSharePct, med((a) => a.closedHours?.referenceClosedMoveSharePct));
    eq("summary.instrumentsWithClosedHours", S.instrumentsWithClosedHours, I.filter((a) => a.closedHours).length);
    eq("summary.instrumentsWithReturnLayer", S.instrumentsWithReturnLayer, I.filter((a) => a.closedReturns).length);
    if (S.exchangePinned !== BITGET_VENUE.exchange) bad("summary.exchangePinned is not the venue's pinned exchange");
    if (!/bitget/i.test(String(S.server || ""))) bad(`summary.server is ${JSON.stringify(S.server)} - the file does not say the answer came from Bitget's own MCP`);
    else ok(`summary names the server that answered: ${S.server} on the ${S.route} route`);
    if (S.minReturnCorrelation < TH.minReturnCorrelation) bad(`the weakest accepted instrument correlates at ${S.minReturnCorrelation}, below the ${TH.minReturnCorrelation} floor`);
    else ok(`the weakest accepted instrument still clears the floor (${S.minReturnCorrelation} >= ${TH.minReturnCorrelation})`);
    if (!/perpetual/i.test(String(B.disclosure || "")) || !/proxy|route/i.test(String(B.disclosure || ""))) bad("the disclosure does not carry both the instrument class and the route - the two things a reader needs before trusting a figure from a proxied venue");
    else ok("the disclosure states the instrument class and the route it was fetched on");
  }
  /* ------------------------- 7. the return layer ------------------------- */

  section("the return layer: what the instrument did while the cash market was shut");
  {
    if (!RL) bad("no closedSessionReturns block - the movement share would be published with no return distribution behind it");
    else {
      const wk = [], ov = [], weeks = new Set();
      for (const a of I) {
        for (const b of a.closedReturns?.weekendBlocks || []) { wk.push(b); weeks.add(String(b.startIso).slice(0, 10)); }
        for (const b of a.closedReturns?.overnightBlocks || []) ov.push(b);
      }
      eq("summary.weekendBlocksObserved", S.weekendBlocksObserved, wk.length);
      eq("summary.overnightBlocksObserved", S.overnightBlocksObserved, ov.length);
      eq("summary.distinctWeekendStarts", S.distinctWeekendStarts, weeks.size);
      eq("closedSessionReturns.distinctWeekendStarts", RL.distinctWeekendStarts, weeks.size);
      eq("closedSessionReturns.instrumentsWithReturnLayer", RL.instrumentsWithReturnLayer, I.filter((a) => a.closedReturns).length);
      const pw = RL.pooled?.weekendReturnDistribution, pm = RL.pooled?.weekendMaeDistribution;
      if (!pw || !(pw.n > 0)) bad("the pooled weekend return distribution is empty, so the primary venue has no return-layer number");
      else ok(`${pw.n} weekend closed-market block(s) pooled over ${RL.instrumentsWithReturnLayer} instrument(s)`);
      if (!(RL.distinctWeekendStarts > 0) || RL.distinctWeekendStarts > (pw?.n ?? 0)) bad("distinctWeekendStarts is not a usable bound on the pooled sample size");
      else ok(`effective-sample bound stated: ${RL.distinctWeekendStarts} distinct weekend(s) behind ${pw?.n} pooled block(s) - quoting the block count alone would overstate the sample ${pw ? (pw.n / RL.distinctWeekendStarts).toFixed(0) : "n/a"}x`);
      eq("pooled weekend median return", pw?.medianPct, r(quantile(wk.map((b) => b.returnPct), 0.5), 4));
      eq("pooled weekend p10 return", pw?.p10Pct, r(quantile(wk.map((b) => b.returnPct), 0.1), 4));
      eq("pooled weekend sd", pw?.stdPct, r(stdev(wk.map((b) => b.returnPct)), 4));
      eq("pooled weekend share negative", pw?.shareNegativePct, r(100 * wk.filter((b) => b.returnPct < 0).length / wk.length, 1));
      eq("pooled weekend median MAE", pm?.medianPct, r(quantile(wk.map((b) => b.maePct), 0.5), 4));
      eq("pooled share breaching a 5% intra-block drawdown", RL.pooled?.weekendShareBreached5PctDrawdownPct, r(100 * wk.filter((b) => b.maePct != null && b.maePct <= -5).length / wk.length, 1));
      eq("summary.pooledWeekendMedianReturnPct", S.pooledWeekendMedianReturnPct, pw?.medianPct);
      eq("summary.pooledWeekendP10ReturnPct", S.pooledWeekendP10ReturnPct, pw?.p10Pct);
      eq("summary.pooledWeekendMedianMaePct", S.pooledWeekendMedianMaePct, pm?.medianPct);
      eq("summary.medianHourlyStdRatioOutsideOverInside", S.medianHourlyStdRatioOutsideOverInside, RL.hourlyStdRatioOutsideOverInside?.medianPct);
      // Every block must recompute from its own entry/exit/low and be classified by its own length.
      let checked = 0, wrong = 0, maeBad = 0, kindBad = 0, shortBad = 0;
      for (const a of I) {
        const crx = a.closedReturns;
        if (!crx) continue;
        if ((crx.blocks?.weekend ?? -1) !== (crx.weekendBlocks || []).length || (crx.blocks?.overnight ?? -1) !== (crx.overnightBlocks || []).length) kindBad++;
        for (const b of [...(crx.weekendBlocks || []), ...(crx.overnightBlocks || [])]) {
          if (b.hours < MIN_BLOCK_HOURS) shortBad++;
          if (b.kind === "weekend" && b.hours < WEEKEND_BLOCK_HOURS) kindBad++;
          if (b.kind === "overnight" && b.hours >= WEEKEND_BLOCK_HOURS) kindBad++;
          if (!(b.entry > 0) || !(b.exit > 0)) { wrong++; continue; }
          if (Math.abs(Number((((b.exit / b.entry) - 1) * 100).toFixed(3)) - b.returnPct) > 0.002) wrong++;
          if (b.maePct != null && (b.maePct > 0.0001 || b.maePct > b.returnPct + 0.0001)) maeBad++;
          checked++;
        }
        const own = crx.weekendReturnDistribution;
        if (own && (crx.weekendBlocks || []).length && Math.abs(own.medianPct - median((crx.weekendBlocks || []).map((b) => b.returnPct))) > 0.01) wrong++;
      }
      if (!checked) bad("no closed block carried an entry and an exit price, so nothing was verifiable");
      else if (wrong) bad(`${wrong} of ${checked} closed block(s) do not recompute from their own prices`);
      else ok(`all ${checked} closed block(s) recompute from their own entry and exit prices, per instrument and pooled`);
      if (maeBad) bad(`${maeBad} closed block(s) report an adverse excursion that is a gain, or better than the block's own return`);
      else if (checked) ok("every intra-block adverse excursion is a loss and never better than its own block's return");
      if (kindBad) bad(`${kindBad} block(s) are classified against the wrong length rule (>= ${WEEKEND_BLOCK_HOURS}h weekend, >= ${MIN_BLOCK_HOURS}h overnight)`);
      else ok(`every block is classified by its own length: ${wk.length} weekend(s) and ${ov.length} overnight break(s)`);
      if (shortBad) bad(`${shortBad} block(s) are shorter than the ${MIN_BLOCK_HOURS}h minimum - a feed gap is being reported as a session break`);
      const cav = String(RL.caveat || "");
      const missing = ["NOT independent", "weekend(s)", "perpetual"].filter((m) => !cav.includes(m));
      if (missing.length) bad(`the return-layer caveat does not state ${missing.map((m) => `"${m}"`).join(", ")}, so a reader could take ${pw?.n} correlated blocks for ${pw?.n} independent draws, or a synthetic position for a redeemable spot token`);
      else ok("the caveat states what this is not: correlated blocks over a handful of weekends, on a perpetual rather than a redeemable spot token");
      if (cav.includes("5x24") || /not the retrieved|no retrieval/i.test(cav)) ok("the caveat also says these returns are not the retrieved outcome distribution");
      else note("the caveat does not repeat the 5x24 boundary - the card and the prose carry it");
    }
  }

  /* ------------------------- 8. cross-venue ------------------------- */

  section("cross-venue: a perpetual against a spot wrapper on the same underlying");
  {
    if (!CV) note("no crossVenue block at all - not even a reason");
    else if (!CV.available) note(`cross-venue unavailable on this run: ${CV.reason || "no reason recorded"}`);
    else {
      eq("crossVenue.comparedSymbols", CV.comparedSymbols, (CV.perSymbol || []).length);
      eq("summary.crossVenueCompared", S.crossVenueCompared, CV.comparedSymbols);
      const incomplete = (CV.perSymbol || []).filter((x) =>
        !Number.isFinite(x.closedMoveSharePct?.bitget) || !Number.isFinite(x.closedMoveSharePct?.gateio)
        || !Number.isFinite(x.returnCorrelation?.bitget) || !Number.isFinite(x.returnCorrelation?.gateio)
        || !x.bitgetPair || !x.gatePair);
      if (incomplete.length) bad(`${incomplete.length} cross-venue row(s) are missing one side: ${incomplete.slice(0, 3).map((x) => x.sym).join(", ")}`);
      else ok(`all ${CV.comparedSymbols} row(s) carry both sides, each labelled with its own instrument (${CV.perSymbol[0].bitgetInstrument} against ${CV.perSymbol[0].gateInstrument})`);
      if (!CV.bitgetVenue?.name || !CV.gateVenue?.name) bad("the cross-venue block does not name both venues - an agreement figure with no venues attached is unverifiable");
      else ok(`both venues named and timestamped: ${CV.bitgetVenue.name} (${CV.bitgetVenue.generatedAt}) against ${CV.gateVenue.name} (${CV.gateVenue.generatedAt})`);
      if (!CV.windowHours?.note) bad("the observed window is not stated per side, so two different depths would be compared as if they were equal");
      else ok(`window stated per side rather than assumed equal: median ${CV.windowHours.bitgetMedian} hourly buckets on Bitget against ${CV.windowHours.gateioMedian} on Gate.io`);
      const diffs = (CV.perSymbol || []).map((x) => x.closedMoveSharePct.bitget - x.closedMoveSharePct.gateio);
      const md = CV.medianDifferenceBitgetMinusGateio?.closedMoveSharePct;
      eq("cross-venue median difference in closed-move share", md?.medianPct, r(quantile(diffs, 0.5), 4));
      eq("cross-venue n", md?.n, CV.comparedSymbols);
      if (!/perpetual|instrument class/i.test(String(CV.note || ""))) bad("the cross-venue note does not say the two sides are different instrument classes - agreement between a perpetual and a spot token is the stronger claim and must be labelled as such");
      else ok("the note states that this is agreement between two instrument classes, not the same thing measured twice");
      // Both sides must have been measured under the one shared convention, or the difference between
      // them is a difference of definitions rather than of markets. The convention is stamped per row by
      // closedReturns()/closedHours() in the shared module; the pooled header of each file carries its
      // own pooling note instead, so this compares the rows, which is where the definition lives.
      const G2 = readJson(GATEIO_FILE);
      if (G2 && !G2.degradation) {
        const one = (arr, f) => [...new Set(arr.map(f).filter(Boolean))];
        const gateRet = one(G2.pairs || [], (x) => x.closedReturns?.convention);
        const bitgetRet = one(I, (x) => x.closedReturns?.convention);
        if (gateRet.length !== 1 || bitgetRet.length !== 1) bad(`the closed-return convention is not stamped uniformly: ${gateRet.length} distinct string(s) on the Gate.io side, ${bitgetRet.length} on the Bitget side`);
        else if (gateRet[0] !== bitgetRet[0] || gateRet[0] !== CLOSED_RETURN_CONVENTION) bad("the two venues were measured under different closed-return conventions, so the cross-venue difference is a definition difference, not a market difference");
        else ok("every row on both venues carries the identical closed-return convention string, so the return layer is compared like for like");
        const gateSess = one(G2.pairs || [], (x) => x.closedHours?.convention);
        const bitgetSess = one(I, (x) => x.closedHours?.convention);
        if (gateSess.length !== 1 || gateSess[0] !== bitgetSess[0] || gateSess[0] !== SESSION_CONVENTION) bad("the movement-share side of the comparison was measured under different session conventions");
        else ok("the movement-share side carries the identical session convention on both venues too");
      }
    }
  }

  /* ------------------------- 9. display precision ------------------------- */

  section("display precision");
  {
    // The card is the only thing the language model may quote, so a payload carrying sixteen digits
    // licenses sixteen digits of prose. Raw price levels straight off an order book are exempt - they
    // are not quoted in prose, and rounding them would misstate a book - but they must still recompute
    // from one another, which section 4 asserts. Everything else is display-rounded.
    const EXEMPT = new Set(["mid", "bestBid", "bestAsk"]);
    const long = [];
    const walk = (node, path, key = null) => {
      if (typeof node === "number") {
        const dp = (String(node).split(".")[1] || "").length;
        if (dp > 4 && !EXEMPT.has(key)) long.push(`${path} = ${node}`);
        return;
      }
      if (Array.isArray(node)) return node.forEach((v, i) => walk(v, `${path}[${i}]`, key));
      if (node && typeof node === "object") return Object.entries(node).forEach(([k, v]) => walk(v, path ? `${path}.${k}` : k, k));
    };
    walk(I, "instruments"); walk(S, "summary"); walk(RL, "closedSessionReturns"); walk(CV, "crossVenue");
    if (long.length) bad(`${long.length} value(s) carry more than 4 decimals, which licenses the model to print them: ${long.slice(0, 5).join(", ")}`);
    else ok("every published percentage, bp and share figure is rounded to display precision before it is committed");
  }
}
/* ------------------------- 10. it reaches the card, the caveat and the prose ------------------------- */

section("the measurement reaches the research card, and the venue hierarchy is honoured");
const dataset = readJson(join(ROOT, "data-cache", "dataset.json"));
const V = readJson(join(ROOT, "research", "validation-results.json")) || readJson(join(ROOT, "dist", "validation-summary.json"));
const GATE = readJson(GATEIO_FILE);
if (!dataset) bad("no data-cache/dataset.json - run npm run build:data");
else {
  const desk = createDesk({ dataset, validationResults: V, provenance: {}, wrapper: GATE, bitget7x24: B });
  const universe = (dataset.meta?.universe || []).map((u) => u.s);
  const verified = degraded ? null : (I[0]?.sym || null);
  const gateVerified = Object.keys(GATE?.bySymbol || {});
  const refusedSyms = [...new Set((B.rejected || []).map((x) => x.sym))];
  const fallbackSym = refusedSyms.find((s) => gateVerified.includes(s)) || null;
  const neitherSym = universe.find((s) => !gateVerified.includes(s) && !refusedSyms.includes(s) && !I.some((a) => a.sym === s)) || null;

  if (!verified) note("no verified Bitget instrument to test the primary path with");
  else {
    const { card } = desk.analyze({ symbol: verified, date: "latest", horizon: 5, k: 50, includeStress: true });
    const w = card.wrapper, bg = w?.bitget;
    if (w?.primaryVenue !== "bitget") bad(`${verified} has a verified Bitget instrument but the card names ${w?.primaryVenue} as the primary venue - the hierarchy did not survive into the card`);
    else ok(`${verified}: the card names Bitget as the primary venue of the 7x24 layer`);
    if (bg?.status !== "measured") bad(`${verified}: card.wrapper.bitget.status is ${bg?.status}, not "measured"`);
    else {
      ok(`${verified} card carries a measured Bitget block (${bg.instrument}, ${bg.tracking.tier}, closed-hours move ${bg.sevenByTwentyFour.closedMoveSharePct}%)`);
      if (bg.exchangePinned !== BITGET_VENUE.exchange) bad("the card does not print the pinned exchange");
      if (bg.intervalEchoed !== "1h" || bg.exchangeEchoed !== BITGET_VENUE.exchange) bad(`the card reports echoes ${bg.intervalEchoed}/${bg.exchangeEchoed} - the trap assertion did not travel with the number`);
      else ok("the interval and exchange echoes travel with the number onto the card");
      if (!/perpetual/i.test(String(bg.instrumentClass || ""))) bad("the card does not name the instrument class, so a perpetual could be read as a spot wrapper");
      else ok(`the card names the instrument class and the route: ${bg.instrumentClass} via ${bg.route}`);
      if (!/Bitget's own data/.test(String(w.venueNote || ""))) bad("venueNote does not say the headed figures are Bitget's own data");
      else ok("venueNote says which venue the headed figures came from, and that Gate.io is kept beside it as a second venue");
      if (!/perpetual is not|not a redeemable|funding/i.test(String(bg.caveat || ""))) bad("the block caveat does not say a perpetual carries funding and a basis - the one thing that separates it from the spot wrapper beside it");
      else ok("the caveat says a perpetual is not a redeemable spot token, and that nothing here feeds the engine");
    }
    const cvRow = w?.crossVenue;
    if (!cvRow && CV?.available && (CV.perSymbol || []).some((x) => x.sym === verified)) bad(`${verified} has a cross-venue row in the file but none reached the card`);
    else if (cvRow) ok(`${verified} card carries its cross-venue row (closed-move share ${cvRow.closedMoveSharePct.bitget}% on Bitget against ${cvRow.closedMoveSharePct.gateio}% on Gate.io)`);
    const lap = (card.stress || []).find((x) => x.id === "liquidity-air-pocket");
    if (!lap) note("no liquidity-air-pocket scenario on this card to annotate");
    else if (!/Bitget RWA perpetual/.test(lap.caveat || "")) bad("the liquidity-air-pocket caveat does not quote the primary venue's instrument class");
    else ok("the liquidity-air-pocket caveat quotes the Bitget measurement, labelled as a perpetual");

    for (const language of ["en", "zh"]) {
      const { card: c2 } = desk.analyze({ symbol: verified, date: "latest", horizon: 5, k: 50, includeStress: true });
      const text = renderTemplate(c2, { language }).text;
      const gate2 = verifyNumbers(text, buildAllowlist(c2, defaultAllowance(c2)));
      if (!gate2.ok) bad(`${verified} ${language} prose cites ${gate2.unsupportedCount} numeral(s) not in the card: ${gate2.unsupported.map((u) => `"${u.value}"`).join(", ")}`);
      else ok(`${verified} ${language} prose passes the numeric gate with the Bitget paragraph (${gate2.total} numerals traced)`);
      const expects = language === "en"
        ? /measured primarily on Bitget's own data[\s\S]*Second venue, same premise/
        : /主要以 Bitget 自家数据测量[\s\S]*第二场地，同一前提/;
      if (!expects.test(text)) bad(`${verified} ${language} prose does not present Bitget first and Gate.io as the second venue`);
      else ok(`${verified} ${language} prose presents Bitget as primary and Gate.io as the second venue`);
      if (!/perpetual|永续/.test(text)) bad(`${verified} ${language} prose quotes Bitget figures without naming the instrument class`);
      if (!/5x24/.test(text)) bad(`${verified} ${language} prose does not restate that the retrieved distribution is built on 5x24 daily sessions`);
    }

    // The boundary that makes this safe to add: loading the venue must not move a retrieval figure.
    const deskNoB = createDesk({ dataset, validationResults: V, provenance: {}, wrapper: GATE, bitget7x24: null });
    const withB = desk.analyze({ symbol: verified, date: "latest", horizon: 5, k: 50 }).card;
    const noB = deskNoB.analyze({ symbol: verified, date: "latest", horizon: 5, k: 50 }).card;
    const core = (c) => JSON.stringify({ d: c.distribution, r: c.retrieval, cf: c.conformal, e: c.excursion, v: c.validation });
    if (core(withB) !== core(noB)) bad("loading the Bitget venue changed the retrieval result - a measurement of the instrument layer must not touch the analog engine");
    else ok("retrieval, conformal, excursion and validation figures are byte-identical with and without the Bitget venue: nothing leaked into the engine");
    const idA = cardDigest(withB, { promptVersion: PROMPT_VERSION, language: "en" });
    const idB = cardDigest(noB, { promptVersion: PROMPT_VERSION, language: "en" });
    if (idA === idB) bad("a card built without the Bitget measurement hashes the same as one with it - a runtime that forgets to load the file would serve stale prose undetected");
    else ok(`loading the measurement changes the card id (${idA} against ${idB}), so a runtime that forgets it cannot silently serve another runtime's prose`);
    const again = cardDigest(desk.analyze({ symbol: verified, date: "latest", horizon: 5, k: 50 }).card, { promptVersion: PROMPT_VERSION, language: "en" });
    if (again !== idA) bad("the Bitget block is not deterministic: the same request hashed twice to different ids, so the replay cache would miss");
    else ok("committed data, not a live call: two runs hash to the same card id");
  }

  if (!fallbackSym) note("no symbol was refused by Bitget while being verified on Gate.io - nothing to test the second-venue fallback with");
  else {
    const { card } = desk.analyze({ symbol: fallbackSym, date: "latest", horizon: 5, k: 50, includeStress: false });
    const w = card.wrapper;
    if (w?.primaryVenue !== "gateio") bad(`${fallbackSym} was refused by Bitget and verified on Gate.io, but the card names ${w?.primaryVenue} as primary - the second venue is not standing in when it should`);
    else ok(`${fallbackSym}: Bitget refused it, so the card falls back to the Gate.io second venue and says why`);
    if (w?.bitget?.status !== "no-verified-instrument") bad(`${fallbackSym}: card.wrapper.bitget.status is ${w?.bitget?.status} instead of "no-verified-instrument"`);
    else if (!(w.bitget.refusals || []).length || !w.bitget.reason) bad(`${fallbackSym}: the Bitget refusal reached the card without its stage and reason - an absence with no reason is indistinguishable from never asking`);
    else ok(`${fallbackSym}: the refusal is on the card with its stage and reason (${w.bitget.refusals.map((x) => `${x.pair} at the ${x.stage} stage`).join("; ")})`);
    const text = renderTemplate(card, { language: "en" }).text;
    if (!/no verified instrument/.test(text)) bad(`${fallbackSym}: the prose does not say Bitget has no verified instrument for it`);
    else if (!/no Bitget figure is estimated/.test(text)) bad(`${fallbackSym}: the prose reports the absence without saying that no figure was estimated to fill it`);
    else ok(`${fallbackSym}: the prose states the absence and that no Bitget figure was estimated`);
    const g2 = verifyNumbers(text, buildAllowlist(card, defaultAllowance(card)));
    if (!g2.ok) bad(`${fallbackSym} en prose cites ${g2.unsupportedCount} unsupported numeral(s) on the fallback path: ${g2.unsupported.map((u) => `"${u.value}"`).join(", ")}`);
    else ok(`${fallbackSym} en prose passes the numeric gate on the fallback path`);
  }

  if (!neitherSym) note("every library instrument is covered by at least one venue - nothing to test the two-venue absence path with");
  else {
    const { card } = desk.analyze({ symbol: neitherSym, date: "latest", horizon: 5, k: 50, includeStress: false });
    if (card.wrapper?.primaryVenue !== null) bad(`${neitherSym} has no verified instrument on either venue but the card names ${card.wrapper.primaryVenue} as primary`);
    else ok(`${neitherSym}: neither venue verified an instrument, so the card reports the calendar share only and names no venue figure`);
  }

  /* --------- 10b. no proxy at all: Bitget degrades and Gate.io stands alone --------- */

  section("the no-proxy fallback: a degraded Bitget venue must demote itself, not disappear");
  {
    const degradedPayload = {
      generatedAt: B.generatedAt, venue: B.venue, traps: B.traps, thresholds: B.thresholds,
      referenceSessionConvention: B.referenceSessionConvention,
      degradation: { degraded: true, kind: "no-proxy", detail: "no local HTTP proxy was found, and every *.bitget.com host resets at the TCP layer on a direct connection" },
      instruments: [], rejected: [], summary: null, closedSessionReturns: null, crossVenue: null,
      disclosure: "the Bitget venue could not be reached, so nothing was measured and no figure here is estimated"
    };
    const deskD = createDesk({ dataset, validationResults: V, provenance: {}, wrapper: GATE, bitget7x24: degradedPayload });
    const sym = gateVerified[0] || universe[0];
    const { card } = deskD.analyze({ symbol: sym, date: "latest", horizon: 5, k: 50, includeStress: false });
    const w = card.wrapper;
    if (w?.primaryVenue !== "gateio") bad(`with Bitget degraded, the card names ${w?.primaryVenue} as primary instead of falling back to Gate.io`);
    else ok(`with Bitget degraded, ${sym} falls back to the Gate.io measurement and the card says so`);
    if (w?.bitget?.status !== "not-measured") bad(`with Bitget degraded, card.wrapper.bitget.status is ${w?.bitget?.status} instead of "not-measured"`);
    else if (w.bitget.degradation?.kind !== "no-proxy") bad("the degradation kind did not travel to the card, so a reviewer cannot tell a network failure from an absent listing");
    else ok(`the degradation travels to the card with its kind (${w.bitget.degradation.kind}) and its reason`);
    for (const language of ["en", "zh"]) {
      const text = renderTemplate(card, { language }).text;
      const expects = language === "en" ? /was not measurable on this build[\s\S]*no Bitget figure is estimated/ : /本次构建无法测量[\s\S]*不用估算填补/;
      if (!expects.test(text)) bad(`${sym} ${language} prose does not disclose the degraded primary venue on the fallback path`);
      else ok(`${sym} ${language} prose discloses that the primary venue was not measurable and that nothing was estimated to fill it`);
      const g3 = verifyNumbers(text, buildAllowlist(card, defaultAllowance(card)));
      if (!g3.ok) bad(`${sym} ${language} prose cites ${g3.unsupportedCount} unsupported numeral(s) on the degraded path: ${g3.unsupported.map((u) => `"${u.value}"`).join(", ")}`);
    }
    // The same, with no Bitget file at all: a fresh clone that never ran the measurement.
    const deskN = createDesk({ dataset, validationResults: V, provenance: {}, wrapper: GATE, bitget7x24: null });
    const wn = deskN.analyze({ symbol: sym, date: "latest", horizon: 5, k: 50, includeStress: false }).card.wrapper;
    if (wn?.primaryVenue !== "gateio" || wn?.bitget?.status !== "not-measured") bad("with no Bitget measurement on record at all, the card does not fall back cleanly to Gate.io");
    else ok("with no data-cache/bitget-7x24.json at all, the card still reports the Gate.io venue and marks the primary venue as not measured");
  }
}

/* ------------------------- 11. it ships ------------------------- */

section("the static build and the wiring");
{
  const bundle = join(ROOT, "dist", "app.bundle.js");
  if (!existsSync(bundle)) note("dist/app.bundle.js is not built yet - run npm run compile");
  else {
    const src = readFileSync(bundle, "utf8");
    if (!src.includes("globalThis.AnalogDesk.bitget7x24 = ")) bad("the bundle never assigns AnalogDesk.bitget7x24 - the static site would render cards whose primary 7x24 venue is missing while the server renders one, and the two would hash differently");
    else if (src.includes("globalThis.AnalogDesk.bitget7x24 = null;")) bad("the bundle ships bitget7x24 = null - the committed measurement did not make it into the static build");
    else ok("the bundle carries the Bitget measurement, so the keyless static site reports the same primary-venue figures as the server");
  }
  const published = join(ROOT, "dist", "bitget-7x24.json");
  if (!existsSync(published)) note("dist/bitget-7x24.json is absent - the full audit trail, refusals included, is not published beside the bundle");
  else {
    const a = readJson(published);
    if (!a) bad("dist/bitget-7x24.json did not parse");
    else if (a.generatedAt !== B.generatedAt) bad(`dist/bitget-7x24.json is a different run (${a.generatedAt}) from data-cache/bitget-7x24.json (${B.generatedAt}) - the published audit trail is not the one the bundle quotes`);
    else ok("dist/bitget-7x24.json is the same run the bundle and the server read, refusals included");
  }
  const pkg = readJson(join(ROOT, "package.json"));
  if (!pkg?.scripts?.["check:bitget7x24"]) bad("package.json has no check:bitget7x24 script - this gate cannot be run by name");
  else ok("npm run check:bitget7x24 is wired");
  if (!/\bcheck:bitget7x24\b/.test(pkg?.scripts?.check || "")) bad("npm run check does not include check:bitget7x24 - the primary venue would rot silently between releases");
  else ok("npm run check includes this gate");
  if (!pkg?.scripts?.["measure:bitget7x24"]) bad("package.json has no measure:bitget7x24 script, so the measurement cannot be re-run by name");
  else ok("npm run measure:bitget7x24 is wired");
}

console.log(`\ncheck:bitget7x24 ${failures ? `FAILED (${failures})` : "passed"}${notes ? ` - ${notes} note(s)` : ""}`);
process.exit(failures ? 1 : 0);
