/**
 * AnalogDesk - the 7x24 wrapper-measurement gate.
 *
 *   npm run check:wrapper
 *
 * WHY THIS EXISTS
 * "Trades 7x24" was the one claim in this project that was asserted rather than measured: every other
 * figure came from a library of US daily sessions, so the headline premise had no number behind it.
 * scripts/measure-wrapper.mjs fixed that, and this gate exists so the fix cannot quietly rot. It
 * re-derives the acceptance rules from the file's own thresholds and refuses to publish if a wrapper
 * is reported that did not pass them, if a rejection was dropped instead of recorded, or if the
 * measurement stops reaching the card and the prose.
 *
 * It also locks the bug that the verification design was built around. LINK (Chainlink) trades near
 * LI Auto's share price, so a price-proximity test on its own "verifies" a crypto token as a tokenised
 * Chinese EV maker. That specific rejection is asserted by name: if a future edit loosens the
 * correlation floor, this gate fails on the exact case that motivated the two-test rule.
 *
 * A degraded measurement is a PASS, not a failure - provided it degrades loudly. If the venue was
 * unreachable, the file must carry a disclosure, must carry no pairs, and the card must say the
 * wrapper layer was not measured. What may never happen is a number appearing with no venue behind it.
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createDesk } from "../src/desk.mjs";
import { renderTemplate } from "../src/llm/template.mjs";
import { cardDigest } from "../src/llm/replay.mjs";
import { PROMPT_VERSION } from "../src/llm/narrate.mjs";
import { buildAllowlist, verifyNumbers, defaultAllowance } from "../src/llm/verify-numbers.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const PROBE = join(ROOT, "data-cache", "wrapper-probe.json");
const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };

let failures = 0, notes = 0;
const ok = (m) => console.log(`  ok   ${m}`);
const bad = (m) => { failures++; console.log(`  FAIL ${m}`); };
const note = (m) => { notes++; console.log(`  note ${m}`); };
const section = (t) => console.log(`\n=== ${t} ===`);

/* ------------------------- 1. the committed measurement ------------------------- */

section("data-cache/wrapper-probe.json");
if (!existsSync(PROBE)) {
  bad("no wrapper measurement on record - the 7x24 claim is unmeasured again. Run: node scripts/measure-wrapper.mjs");
  console.log(`\ncheck:wrapper FAILED (${failures})`);
  process.exit(1);
}
const W = readJson(PROBE);
if (!W) { bad("wrapper-probe.json did not parse"); process.exit(1); }
ok(`present, measured ${W.generatedAt} on ${W.venue?.name}`);

const TH = W.thresholds || {};
if (!(TH.priceTolerancePct > 0) || !(TH.minReturnCorrelation > 0) || !(TH.minOverlapSessions > 0)) bad(`thresholds missing or zero: ${JSON.stringify(TH)}`);
else ok(`thresholds declared in the file itself: price +/-${TH.priceTolerancePct}%, correlation >= ${TH.minReturnCorrelation}, overlap >= ${TH.minOverlapSessions} sessions`);

const degraded = Boolean(W.degradation);
if (degraded) {
  if (!W.degradation.disclosure) bad("degraded but carries no disclosure - a silent gap is worse than a measured one");
  else ok(`DEGRADED and disclosed: ${W.degradation.kind} - ${W.degradation.detail}`);
  if ((W.pairs || []).length || Object.keys(W.bySymbol || {}).length) bad("degraded yet reports wrappers - a figure with no venue behind it");
  else ok("degraded run reports no wrapper figure, as it must");
  note("the rest of this gate asserts the degraded path only; re-run measure-wrapper.mjs from a network that can reach the venue");
}

/* ------------------------- 2. acceptance rules, re-derived ------------------------- */

section("every reported wrapper actually passed both tests");
const pairs = W.pairs || [];
if (!degraded) {
  if (pairs.length < 20) bad(`only ${pairs.length} verified wrappers - a measurement this thin does not support a claim about a market`);
  else ok(`${pairs.length} verified wrappers over ${Object.keys(W.bySymbol || {}).length} of ${W.summary?.universeSymbols} library instruments (${W.summary?.coveragePct}% coverage)`);

  const badRows = [];
  for (const p of pairs) {
    const errs = [];
    if (!(p.returnCorrelation >= TH.minReturnCorrelation)) errs.push(`correlation ${p.returnCorrelation} < ${TH.minReturnCorrelation}`);
    if (!(p.overlapSessions >= TH.minOverlapSessions)) errs.push(`overlap ${p.overlapSessions} < ${TH.minOverlapSessions}`);
    if (!(Math.abs(p.priceDeviationPct) <= TH.priceTolerancePct)) errs.push(`price deviation ${p.priceDeviationPct}% outside +/-${TH.priceTolerancePct}%`);
    if (!p.tier || p.tier === "rejected" || p.tier === "unknown") errs.push(`tier is ${p.tier} - a wrapper that does not track must not be reported as one`);
    if (!p.tierLabel) errs.push("no tier label - tracking quality must be shown next to the number");
    if (!p.pair.endsWith(`_${W.venue?.quote}`)) errs.push(`pair ${p.pair} is not quoted in ${W.venue?.quote}`);
    if (!p.pair.toUpperCase().startsWith(p.sym.toUpperCase())) errs.push(`pair ${p.pair} does not carry the underlying ticker ${p.sym}`);
    if (errs.length) badRows.push(`${p.sym}/${p.pair}: ${errs.join("; ")}`);
  }
  if (badRows.length) badRows.forEach((r) => bad(r));
  else ok(`all ${pairs.length} reported wrappers satisfy the price test, the correlation test, the overlap floor and carry a tier`);

  const noClosed = pairs.filter((p) => p.closedHours?.referenceClosedMoveSharePct == null);
  if (noClosed.length > pairs.length * 0.25) bad(`${noClosed.length} of ${pairs.length} wrappers have no closed-hours measurement - the headline 7x24 figure would rest on a minority of the sample`);
  else ok(`${pairs.length - noClosed.length}/${pairs.length} wrappers carry a closed-hours measurement`);

  const noBook = pairs.filter((p) => !p.microstructure?.spreadBps);
  note(`${pairs.length - noBook.length}/${pairs.length} wrappers carry a live order-book snapshot (${noBook.length} without)`);

  const closed = pairs.map((p) => p.closedHours?.referenceClosedMoveSharePct).filter(Number.isFinite);
  const med = W.summary?.medianReferenceClosedMoveSharePct;
  if (!(med > 0 && med < 100)) bad(`median closed-hours move share is ${med} - not a usable percentage`);
  else ok(`median ${med}% of wrapper movement lands outside the cash session (range ${Math.min(...closed)}% to ${Math.max(...closed)}% over ${closed.length} pairs)`);
}

/* ------------------------- 3. rejections are recorded, not dropped ------------------------- */

section("rejections");
const rejected = W.rejected || [];
if (!degraded) {
  if (!rejected.length) bad("zero rejections recorded - a filter that refuses nothing is not a filter");
  else ok(`${rejected.length} candidate(s) refused and every refusal is recorded with its stage and reason`);
  const silent = rejected.filter((r) => !r.stage || !r.reason);
  if (silent.length) bad(`${silent.length} rejection(s) carry no reason: ${silent.slice(0, 3).map((r) => r.pair).join(", ")}`);
  else ok("every rejection names the test that refused it");

  // The regression test for the price-only-test bug. LI Auto and Chainlink trade at similar levels, so
  // LINK passes a price test against LI and must be refused by the correlation test. If this assertion
  // ever fails, the two-test rule has been weakened and a crypto token is being reported as an equity.
  const link = rejected.find((r) => r.sym === "LI" && r.pair === "LINK_USDT");
  if (!link) bad("LINK_USDT is no longer recorded as a rejected candidate for LI - the price-proximity trap this design exists to catch is unguarded");
  else if (link.stage !== "correlation") bad(`LINK_USDT was refused at stage "${link.stage}", not by the correlation test - the price test alone cannot be what rejects it`);
  else ok(`the price-proximity trap is still caught: LINK_USDT passed on price and was refused on correlation (${link.corr}, floor ${TH.minReturnCorrelation})`);

  const byStage = rejected.reduce((a, r) => { a[r.stage] = (a[r.stage] || 0) + 1; return a; }, {});
  ok(`refusal stages: ${Object.entries(byStage).map(([k, v]) => `${k} ${v}`).join(", ")}`);
}

/* ------------------------- 4. the calendar figure is arithmetic, not assertion ------------------------- */

section("the reference-market closed share");
const rm = W.referenceMarket;
if (!rm) bad("no referenceMarket block - the one 7x24 figure that needs no venue is missing");
else {
  const derived = 100 * (rm.weekHours - rm.sessionsPerWeek * 6.5) / rm.weekHours;
  if (Math.abs(derived - rm.closedSharePct) > 0.15) bad(`closedSharePct ${rm.closedSharePct} does not follow from ${rm.sessionsPerWeek} sessions/week x 6.5h over ${rm.weekHours}h (expected ${derived.toFixed(1)})`);
  else ok(`${rm.closedSharePct}% of the week closed, and it re-derives from the session calendar: ${rm.sessions} sessions / ${rm.weeksObserved} weeks = ${rm.sessionsPerWeek}/week x 6.5h = ${rm.cashOpenHoursPerWeek}h of ${rm.weekHours}h`);
  if (!(rm.closedSharePct > 70 && rm.closedSharePct < 90)) bad(`closedSharePct ${rm.closedSharePct} is outside any plausible range for a US cash market`);
}

/* ------------------------- 5. no raw doubles ------------------------- */

section("display precision");
{
  const long = [];
  const walk = (node, path) => {
    if (typeof node === "number") {
      const dp = (String(node).split(".")[1] || "").length;
      if (dp > 4) long.push(`${path} = ${node}`);
      return;
    }
    if (Array.isArray(node)) return node.forEach((v, i) => walk(v, `${path}[${i}]`));
    if (node && typeof node === "object") return Object.entries(node).forEach(([k, v]) => walk(v, path ? `${path}.${k}` : k));
  };
  walk(pairs, "");
  walk(rm, "referenceMarket");
  walk(W.summary, "summary");
  if (long.length) bad(`${long.length} value(s) carry more than 4 decimals, which licenses the model to print them: ${long.slice(0, 5).join(", ")}`);
  else ok("every wrapper value is rounded to display precision before it is committed");
}

/* ------------------------- 6. it reaches the card, the caveat and the prose ------------------------- */

section("the measurement reaches the research card");
const dataset = readJson(join(ROOT, "data-cache", "dataset.json"));
const V = readJson(join(ROOT, "research", "validation-results.json")) || readJson(join(ROOT, "dist", "validation-summary.json"));
if (!dataset) bad("no data-cache/dataset.json - run npm run build:data");
else {
  const desk = createDesk({ dataset, validationResults: V, provenance: {}, wrapper: W });
  const measuredSym = pairs[0]?.sym || null;
  const universe = (dataset.meta?.universe || []).map((u) => u.s);
  const uncoveredSym = universe.find((s) => !(W.bySymbol || {})[s]) || null;

  if (!measuredSym) note("no verified wrapper to test the measured path with");
  else {
    const { card } = desk.analyze({ symbol: measuredSym, date: "latest", horizon: 5, k: 50, includeStress: true });
    const w = card.wrapper;
    if (w?.status !== "measured") bad(`${measuredSym} has a verified wrapper in the file but the card reports status ${w?.status}`);
    else {
      ok(`${measuredSym} card carries a measured wrapper block (${w.instrument}, ${w.tracking.tier}, closed-hours move ${w.sevenByTwentyFour.closedMoveSharePct}%)`);
      if (w.sevenByTwentyFour.referenceClosedSharePct !== rm?.closedSharePct) bad("the card's closed-share does not match the committed measurement");
      const lap = (card.stress || []).find((x) => x.id === "liquidity-air-pocket");
      if (!lap) note("no liquidity-air-pocket scenario on this card to annotate");
      else if (!/Measured on the wrapper itself/.test(lap.caveat || "")) bad("the liquidity-air-pocket caveat still only confesses to the gap instead of quoting the measurement");
      else ok("the liquidity-air-pocket caveat now carries the measured closed-hours figures");
    }
    for (const language of ["en", "zh"]) {
      const { card: c2 } = desk.analyze({ symbol: measuredSym, date: "latest", horizon: 5, k: 50, includeStress: true });
      const text = renderTemplate(c2, { language }).text;
      const gate = verifyNumbers(text, buildAllowlist(c2, defaultAllowance(c2)));
      if (!gate.ok) bad(`${measuredSym} ${language} template cites ${gate.unsupportedCount} numeral(s) not in the card: ${gate.unsupported.map((u) => `"${u.value}"`).join(", ")}`);
      else ok(`${measuredSym} ${language} template passes the numeric gate with the wrapper paragraph (${gate.total} numerals traced)`);
      const expects = language === "en" ? /measured rather than asserted/ : /被测量出来的/;
      if (!expects.test(text)) bad(`${measuredSym} ${language} template does not render the wrapper paragraph at all`);
    }
  }

  if (!uncoveredSym) note("every library instrument has a verified wrapper - nothing to test the honest-absence path with");
  else {
    const { card } = desk.analyze({ symbol: uncoveredSym, date: "latest", horizon: 5, k: 50, includeStress: false });
    if (card.wrapper?.status !== "no-verified-wrapper") bad(`${uncoveredSym} has no verified wrapper but the card reports ${card.wrapper?.status}`);
    else ok(`${uncoveredSym} correctly reports "no verified wrapper" and borrows no figure from another instrument`);
    const text = renderTemplate(card, { language: "en" }).text;
    const gate = verifyNumbers(text, buildAllowlist(card, defaultAllowance(card)));
    if (!gate.ok) bad(`${uncoveredSym} en template cites ${gate.unsupportedCount} unsupported numeral(s): ${gate.unsupported.map((u) => `"${u.value}"`).join(", ")}`);
    else ok(`${uncoveredSym} en template passes the numeric gate on the absence path`);
  }

  // Determinism: the wrapper block is committed data, so two runs must hash identically or the replay
  // cache misses and a keyless reviewer silently drops back to TEMPLATE.
  const a = desk.analyze({ symbol: measuredSym || universe[0], date: "latest", horizon: 5, k: 50 }).card;
  const b = desk.analyze({ symbol: measuredSym || universe[0], date: "latest", horizon: 5, k: 50 }).card;
  const idA = cardDigest(a, { promptVersion: PROMPT_VERSION, language: "en" });
  const idB = cardDigest(b, { promptVersion: PROMPT_VERSION, language: "en" });
  if (idA !== idB) bad(`the wrapper block is not deterministic: the same request hashed to ${idA} and ${idB}`);
  else ok(`the wrapper block is committed data, not a live call: two runs hash to the same card id (${idA})`);

  const withWrapper = cardDigest(a, { promptVersion: PROMPT_VERSION, language: "en" });
  const deskNoW = createDesk({ dataset, validationResults: V, provenance: {}, wrapper: null });
  const without = cardDigest(deskNoW.analyze({ symbol: measuredSym || universe[0], date: "latest", horizon: 5, k: 50 }).card, { promptVersion: PROMPT_VERSION, language: "en" });
  if (withWrapper === without) bad("a card built without the wrapper measurement hashes the same as one with it - a runtime that forgets to load the file would serve stale prose undetected");
  else ok("loading the measurement changes the card id, so a runtime that forgets it cannot silently serve another runtime's prose");
}

/* --------------- 6b. the return layer, not just the movement share --------------- */

section("the return layer: what the wrapper did while the cash market was shut");
{
  const probeFile = JSON.parse(readFileSync(join(ROOT, "data-cache", "wrapper-probe.json"), "utf8"));
  const rl = probeFile.closedSessionReturns;
  if (!rl) bad("wrapper-probe.json carries no closedSessionReturns block - the movement share is published but the return distribution the thesis actually needs is not");
  else {
    const pw = rl.pooled?.weekendReturnDistribution;
    if (!pw || !(pw.n > 0)) bad("the pooled weekend return distribution is empty, so the 7x24 claim still has no return-layer number behind it");
    else ok(`${pw.n} weekend closed-market blocks pooled over ${rl.pairsWithReturnLayer} wrapper(s) and ${rl.distinctWeekendStarts} distinct weekend start(s)`);

    // The pooled n must be the sum of the per-pair blocks, or the pooling is counting something else.
    const perPair = (probeFile.pairs || []).reduce((s, a) => s + (a.closedReturns?.weekendBlocks?.length || 0), 0);
    if (perPair !== (rl.weekendBlocks?.length ?? -1)) bad(`pooled weekend blocks (${rl.weekendBlocks?.length}) do not equal the sum over pairs (${perPair})`);
    else ok(`pooled count reconciles with the per-pair counts (${perPair})`);

    // Distinct weekend starts bound the effective sample size. If that number is missing or larger
    // than n, the caveat that makes the pooled n readable is not backed by anything.
    if (!(rl.distinctWeekendStarts > 0) || rl.distinctWeekendStarts > (pw?.n ?? 0)) bad("distinctWeekendStarts is not a usable bound on the pooled sample size");
    else ok(`effective-sample bound stated: ${rl.distinctWeekendStarts} distinct weekend(s) behind ${pw.n} pooled block(s)`);

    // Recompute every block from its own entry/exit/low. A block whose stored return does not match
    // its stored prices is a block that was edited after measurement.
    let checked = 0, wrong = 0, maeBad = 0;
    for (const b of rl.weekendBlocks || []) {
      if (!(b.entry > 0) || !(b.exit > 0)) { wrong++; continue; }
      const ret = Number((((b.exit / b.entry) - 1) * 100).toFixed(3));
      if (Math.abs(ret - b.returnPct) > 0.002) wrong++;
      // The intra-block low cannot sit above the exit, and the MAE cannot be a gain.
      if (b.maePct != null && (b.maePct > 0.0001 || b.maePct > b.returnPct + 0.0001)) maeBad++;
      checked++;
    }
    if (!checked) bad("no weekend block carried an entry and an exit price, so nothing was verifiable");
    else if (wrong) bad(`${wrong}/${checked} weekend block(s) have a return that does not match their own entry and exit prices`);
    else ok(`all ${checked} weekend block(s) recompute from their own entry/exit prices`);
    if (maeBad) bad(`${maeBad} weekend block(s) report an adverse excursion that is a gain, or above the block's own return`);
    else if (checked) ok("every intra-block adverse excursion is a loss and never better than the block's own return");

    // The pooled figures the card and the UI quote must be the pooled ones, recomputed here.
    const med = (arr) => { const a = arr.filter(Number.isFinite).slice().sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : NaN; };
    const recomputed = med((rl.weekendBlocks || []).map((b) => b.returnPct));
    if (Number.isFinite(recomputed) && pw?.medianPct != null && Math.abs(recomputed - pw.medianPct) > 0.01) bad(`pooled median weekend return (${pw.medianPct}%) does not match the median of the pooled blocks (${recomputed.toFixed(3)}%)`);
    else if (pw) ok(`pooled median weekend return ${pw.medianPct}% (p10 ${pw.p10Pct}%, sd ${pw.stdPct}%) recomputes from the blocks`);
    if (pw && !(Number.isFinite(pw.shareNegativePct))) bad("the pooled distribution reports no share-negative figure");
    else if (pw) ok(`${pw.shareNegativePct}% of pooled weekend blocks closed below their pre-weekend price`);

    // The caveat is the whole reason this block is safe to publish next to a validated 5x24 engine.
    const cav = String(rl.caveat || "");
    for (const must of ["NOT the outcome distribution", "5x24", "distinct weekend starts"]) {
      if (!cav.includes(must)) bad(`the return-layer caveat does not state "${must}", so a reader could take a wrapper weekend for the retrieved distribution`);
    }
    if (cav.includes("NOT the outcome distribution") && cav.includes("5x24") && cav.includes("distinct weekend starts")) ok("the caveat says what this is not: wrapper returns, not the retrieved 5x24 outcome distribution, with the sample-size bound stated");
  }
}

/* ------------------------- 7. it ships ------------------------- */

section("the static build");
{
  const bundle = join(ROOT, "dist", "app.bundle.js");
  if (!existsSync(bundle)) note("dist/app.bundle.js is not built yet - run npm run compile");
  else {
    const src = readFileSync(bundle, "utf8");
    if (!src.includes("globalThis.AnalogDesk.wrapper = ")) bad("the bundle never assigns AnalogDesk.wrapper - the static site would render cards with no 7x24 block");
    else if (src.includes("globalThis.AnalogDesk.wrapper = null;")) bad("the bundle ships wrapper = null - the committed measurement did not make it into the static build");
    else ok("the bundle carries the wrapper measurement, so the keyless static site reports the same 7x24 figures as the server");
    if (!existsSync(join(ROOT, "dist", "wrapper-probe.json"))) note("dist/wrapper-probe.json is absent - the full audit trail (rejections included) is not published next to the bundle");
    else ok("dist/wrapper-probe.json published, rejections included");
  }
}

console.log(`\ncheck:wrapper ${failures ? `FAILED (${failures})` : "passed"}${notes ? ` - ${notes} note(s)` : ""}`);
process.exit(failures ? 1 : 0);