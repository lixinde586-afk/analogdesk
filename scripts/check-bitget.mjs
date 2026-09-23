/**
 * Gate: the Bitget integration has to say the truth about itself.
 *
 * This gate exists because the Bitget disclosure has already been wrong once, in the safe direction.
 * The first published version reported "0/3 market-data endpoints reachable", which was an accurate
 * description of a DIRECT connection from this machine and an inaccurate description of Bitget: all
 * three hosts answer through a local HTTP proxy, and when they do, the official US-equity MCP returns
 * real data with no account and no key. A disclosure that understates an integration is still a
 * disclosure that is wrong, and the failure mode it invites is the quiet one - a reviewer reads
 * "unreachable", believes the project never tried, and moves on.
 *
 * So this gate asserts three separate things:
 *   1. BOTH routes were measured, and the route that produced each answer is named. A green badge
 *      that does not say how it got there is worse than a red one.
 *   2. The cross-checks are real arithmetic against this project's own committed data, not a
 *      demo call that happened to return 200. The fear-&-greed agreement is exact or the gate fails;
 *      the earnings-date agreement is a distribution and its shape is asserted, not its perfection.
 *   3. Nothing in the file claims to feed the engine. The retrieval features, the frozen conformal
 *      scale and research/VALIDATION.md are published figures, and a Bitget number that silently
 *      entered them would invalidate every one of them.
 *
 * It also asserts the negative results are still on the record: the entries whose upstream returned
 * an empty body must be listed, so a future run cannot quietly start claiming a deep historical price
 * cross-check that the upstream does not serve.
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FILE = join(ROOT, "data-cache", "bitget-probe.json");

let failures = 0, notes = 0;
const section = (t) => console.log(`\n=== ${t} ===`);
const ok = (m) => console.log(`  ok   ${m}`);
const bad = (m) => { failures++; console.log(`  FAIL ${m}`); };
const note = (m) => { notes++; console.log(`  note ${m}`); };

/* ------------------------- 1. the file, and the route ------------------------- */

section("data-cache/bitget-probe.json");
if (!existsSync(FILE)) {
  bad("no data-cache/bitget-probe.json - run `npm run measure:bitget`. Without it the Bitget disclosure is a connectivity result and nothing else.");
  console.log(`\ncheck:bitget FAILED (${failures})`);
  process.exit(1);
}
const raw = readFileSync(FILE, "utf8");
const P = JSON.parse(raw);
ok(`present, ${(raw.length / 1024).toFixed(0)} KB, generated ${P.generatedAt}`);

const S = P.summary || {};
const R = P.route || {};
if (S.measured !== true) bad("summary.measured is not true - the file records a probe, not a measurement, and nothing below can be asserted");
else ok(`measured on the ${S.route} route against ${S.server}`);

section("both routes were measured, and the answer names the one that produced it");
{
  const hosts = R.hosts || [];
  if (hosts.length < 3) bad(`only ${hosts.length} market-data host(s) recorded; all three Bitget hosts must be probed`);
  else ok(`${hosts.length} market-data hosts probed`);
  for (const h of hosts) {
    if (!h.direct) bad(`${h.key}: no direct-route result recorded`);
    if (!h.proxied && R.proxyUsed) bad(`${h.key}: a proxy was available (${R.proxyUsed}) but no proxied result was recorded`);
    const answered = h.direct?.ok ? "direct" : h.proxied?.ok ? h.proxied.route : "neither";
    if (h.direct?.ok || h.proxied?.ok) ok(`  ${h.key.padEnd(4)} answered on ${answered} (direct: ${h.direct?.ok ? h.direct.status : h.direct?.kind}; proxy: ${h.proxied ? (h.proxied.ok ? h.proxied.status : h.proxied.kind) : "n/a"})`);
    else ok(`  ${h.key.padEnd(4)} answered on neither route (${h.direct?.kind}) - recorded, not hidden`);
  }
  // The honesty assertion: if the direct route did not produce the answer, the file must say so,
  // in the disclosure a reviewer actually reads, with both counts.
  const directN = R.marketDataReachableDirect ?? 0, proxiedN = R.marketDataReachableViaProxy ?? 0, total = R.marketDataTotal ?? 0;
  if (directN < proxiedN) {
    const d = String(R.disclosure || "");
    if (!R.proxyUsed) bad("the proxied route produced answers the direct route did not, but no proxy is named anywhere in the file");
    else ok(`route named: ${R.proxyUsed} (${R.proxySource || "source not recorded"})`);
    if (!d.includes(String(directN)) || !d.includes(String(total))) bad(`the route disclosure does not carry both counts (${directN}/${total} direct), so a reader cannot tell that the green result needed a proxy`);
    else ok(`disclosure states ${directN}/${total} direct and ${proxiedN}/${total} proxied`);
  } else if (directN === total) {
    ok(`all ${total} hosts answered on a direct connection - no proxy was needed and none is claimed`);
  }
}

/* ------------------------- 2. the server it reached ------------------------- */

section("the official MCP, and what it advertises");
{
  const srv = P.server;
  if (!srv) bad("no server block - the session never opened, so nothing below is a Bitget-sourced figure");
  else {
    const name = srv.serverInfo?.name, ver = srv.serverInfo?.version;
    if (name !== "bitget-mcp-server") bad(`the server that answered identifies itself as "${name}", not bitget-mcp-server - this may not be the official MCP`);
    else ok(`server identifies as ${name}@${ver}, session ${String(srv.sessionId || "").slice(0, 8)}..., handshake in ${srv.initMs}ms`);
    const cats = srv.catalog?.categories || [];
    if (!cats.length) bad("the catalog returned no categories");
    else {
      const total = cats.reduce((s, c) => s + (c.entry_count || 0), 0);
      ok(`catalog: ${cats.length} categories, ${total} entries (${cats.map((c) => `${c.key}:${c.entry_count}`).join(", ")})`);
      const eq = cats.find((c) => c.key === "equity");
      if (!eq || !(eq.entry_count > 0)) bad("no US-equity category in the catalog - the integration this project needs is not the one that answered");
      else ok(`the US-equity category is present with ${eq.entry_count} entries`);
    }
    if (!(srv.toolsAdvertised?.length > 0)) bad("no tools advertised");
    else ok(`tools advertised: ${srv.toolsAdvertised.map((t) => t.name).join(", ")}`);
  }
}

/* ------------------------- 3. the exact cross-check ------------------------- */

section("fear & greed: an exact numeric agreement, or the gate fails");
{
  const fg = P.fearGreedCrossCheck;
  if (!fg) bad("no fearGreedCrossCheck block");
  else {
    if (!String(fg.localSource || "").includes("api.alternative.me")) bad(`the local side of the cross-check does not name api.alternative.me: "${fg.localSource}"`);
    else ok(`local side is ${fg.localSource}`);
    if (!(fg.overlappingDates >= 30)) bad(`only ${fg.overlappingDates} overlapping dates - too few to call anything validated (need >= 30)`);
    else ok(`${fg.overlappingDates} overlapping daily readings compared`);
    if (fg.overlappingDates > 0) {
      const pct = fg.exactMatchPct ?? 0;
      if (!(pct >= 99)) bad(`only ${pct}% of overlapping readings are identical; two independent transports of the same index should agree exactly, so a drift this large means one side changed meaning`);
      else ok(`${fg.exactMatches}/${fg.overlappingDates} identical (${pct}%), mean absolute difference ${fg.meanAbsDifference} index points, worst ${fg.maxAbsDifference} on ${fg.maxAbsDifferenceDate}`);
      if (!(fg.meanAbsDifference <= 0.5)) bad(`mean absolute difference ${fg.meanAbsDifference} index points exceeds the 0.5 tolerance`);
    }
    if (!fg.verdict) bad("the cross-check carries no verdict sentence for a reader");
    else ok(`verdict: ${fg.verdict}`);
  }
}

/* ------------------------- 4. the distributional cross-check ------------------------- */

section("earnings dates: two independent derivations of the same event");
{
  const ec = P.earningsCrossCheck;
  if (!ec) bad("no earningsCrossCheck block");
  else {
    if (!String(ec.bitgetSource || "").includes("Bitget")) bad("the Bitget side of the earnings cross-check is not named");
    if (!String(ec.localSource || "").includes("EDGAR")) bad("the local side does not name EDGAR full-text search, which is the derivation being tested");
    if (String(ec.bitgetSource || "").includes("Bitget") && String(ec.localSource || "").includes("EDGAR")) ok("both derivations named: Bitget's disclosure date against this project's EDGAR full-text inference");
    if (!(ec.matchedDates >= 100)) bad(`only ${ec.matchedDates} dates matched across both sides - too few for a distribution (need >= 100)`);
    else ok(`${ec.matchedDates} disclosure dates compared across ${ec.symbolsWithBothSides} symbol(s)`);
    for (const k of ["exactSameDayPct", "within3DaysPct", "within7DaysPct"]) {
      if (ec[k] == null) bad(`the earnings cross-check reports no ${k} - the distribution cannot be read without it`);
    }
    if (ec.exactSameDayPct != null && ec.within3DaysPct != null && ec.within7DaysPct != null) {
      ok(`same day ${ec.exactSameDayPct}%, within 3 days ${ec.within3DaysPct}%, within 7 days ${ec.within7DaysPct}%`);
      // The two quantities are not the same by construction, so a near-100% same-day match would mean
      // one side was derived from the other rather than measured independently.
      if (ec.exactSameDayPct > 90) bad(`a ${ec.exactSameDayPct}% same-day match between a published disclosure date and an inferred filing date is implausible - check that the two sides are genuinely independent`);
      if (!(ec.within7DaysPct > 0)) bad("no matched date falls within seven days, which suggests the two calendars are not describing the same events");
      if (!String(ec.note || "").includes("not the same quantity")) bad("the note does not explain why an exact match is NOT the expected result, so the low same-day percentage will read as a failure");
      else ok("the note states that a filing date and an announced briefing date are not the same quantity by construction");
    }
    if (!(ec.perSymbol?.length > 0)) bad("no per-symbol detail, so the aggregate cannot be audited");
    else ok(`per-symbol detail for ${ec.perSymbol.length} symbol(s), including the derivation route (${JSON.stringify((ec.perSymbol.find((x) => x.localDerivation) || {}).localDerivation || {})})`);
  }
}

/* ------------------------- 5. quotes, profiles, and staleness ------------------------- */

section("live quotes and profiles, reported as staleness rather than agreement");
{
  const q = P.quotes, pr = P.profiles;
  if (!q) bad("no quotes block");
  else {
    const answered = q.symbolsAnswered || 0, queried = q.symbolsQueried || 1;
    if (!(answered / queried >= 0.5)) bad(`only ${answered}/${queried} symbols answered a live quote - too few to report as coverage`);
    else ok(`${answered}/${queried} library instruments answered a live Bitget quote`);
    const failed = (q.perSymbol || []).filter((x) => !x.ok);
    if (failed.length && failed.some((x) => !x.error)) bad("a symbol failed without recording why");
    else if (failed.length) ok(`${failed.length} symbol(s) not covered, each with its reason: ${failed.map((x) => x.sym).join(", ")}`);
    const st = q.stalenessVsSnapshot;
    if (!st) bad("no staleness block - a live quote compared to a frozen snapshot without it is a misleading number");
    else {
      if (!String(st.note || "").includes("frozen")) bad("the staleness note does not say the library is frozen, so the drift could be read as a price disagreement");
      else ok(`staleness stated: median ${st.medianAbsDriftPct}% drift over ${st.comparedSymbols} symbols between the ${st.snapshotDate} snapshot and the live quote`);
      if (st.maxAbsDriftPct == null) bad("no maximum drift reported");
    }
  }
  if (!pr) bad("no profiles block");
  else {
    const answered = pr.symbolsAnswered || 0, queried = pr.symbolsQueried || 1;
    if (!(answered / queried >= 0.5)) bad(`only ${answered}/${queried} profiles answered`);
    else ok(`${answered}/${queried} company profiles answered (identity, exchange, industry, ISIN)`);
    const withIsin = (pr.perSymbol || []).filter((x) => x.ok && x.bitgetIsin).length;
    if (!withIsin) note("no profile carried an ISIN, so identity agreement is asserted on name and exchange only");
    else ok(`${withIsin} profile(s) carry an ISIN, which is an unambiguous identity check rather than a ticker match`);
  }
}

/* ------------------------- 6. the negatives stay on the record ------------------------- */

section("what did not come back, and what is not consumed");
{
  const me = P.measuredEmpty;
  if (!me) bad("no measuredEmpty block - an empty upstream answer would go unrecorded and a later run could claim a cross-check that was never possible");
  else {
    const ids = (me.entries || []).map((e) => e.entryId);
    if (!ids.includes("equity_price_historical")) bad("equity_price_historical is not recorded; if it starts returning data the deep price cross-check becomes possible and nobody will notice it was never done");
    else ok(`empty-upstream entries recorded: ${ids.join(", ")}`);
    for (const e of me.entries || []) {
      if (e.status !== 204 && !e.ok) note(`${e.entryId} returned status ${e.status} rather than an empty 204`);
    }
    if (!String(me.note || "").includes("strongest test")) bad("the note does not say that the missing historical series would have been the strongest available cross-check");
    else ok("the note states that the deep historical price cross-check was the strongest test available and is absent");
  }
  const wm = P.wholeMarketSentiment;
  if (!wm) note("no whole-market sentiment block recorded");
  else {
    if (wm.usedByEngine !== false) bad("wholeMarketSentiment.usedByEngine is not explicitly false - a live series entering a frozen, published distance function would invalidate research/VALIDATION.md");
    else ok("the Bitget whole-market sentiment reading is recorded and explicitly NOT consumed by the engine");
    if (!String(wm.note || "").includes("frozen")) bad("the sentiment note does not explain why it is excluded (the distance function is frozen and validated as published)");
    else ok("the exclusion is justified in the note rather than left implicit");
    if (wm.reading) ok(`reading: score ${wm.reading.score} (${wm.reading.rating}) at ${wm.reading.timestamp}, provider ${wm.provider}`);
  }
  const d = String(P.disclosure || "");
  for (const must of ["NONE of it feeds the retrieval engine", "research/VALIDATION.md", "on a direct connection"]) {
    if (!d.includes(must)) bad(`the disclosure does not state "${must}"`);
  }
  if (d.includes("NONE of it feeds the retrieval engine") && d.includes("research/VALIDATION.md") && d.includes("on a direct connection")) ok("the disclosure states the engine boundary and the direct-connection count");
}

/* ------------------------- 7. no secret, and it ships ------------------------- */

section("hygiene and the static build");
{
  if (/\bsk-[A-Za-z0-9]{16,}\b/.test(raw) || /Bearer\s+[A-Za-z0-9_.-]{20,}/.test(raw) || /"(api[_-]?key|apiKey|token)"\s*:\s*"[^"]{8,}"/i.test(raw)) bad("the committed measurement appears to contain a credential - it is written from an unauthenticated probe and must stay that way");
  else ok("no credential pattern in the committed file");

  const bundle = join(ROOT, "dist", "app.bundle.js");
  if (!existsSync(bundle)) note("dist/app.bundle.js is not built yet - run npm run compile");
  else {
    const src = readFileSync(bundle, "utf8");
    if (!src.includes("fearGreedCrossCheck")) bad("the bundle does not carry the Bitget cross-check, so the keyless static site cannot show what the official MCP returned");
    else ok("the bundle carries the Bitget cross-check, so the keyless static site shows the same figures as the server");
    if (!existsSync(join(ROOT, "dist", "bitget-probe.json"))) note("dist/bitget-probe.json is absent - the per-symbol audit trail is not published next to the bundle");
    else ok("dist/bitget-probe.json published, per-symbol rows included");
  }
}

console.log(`\ncheck:bitget ${failures ? `FAILED (${failures})` : "passed"}${notes ? ` - ${notes} note(s)` : ""}`);
process.exit(failures ? 1 : 0);
