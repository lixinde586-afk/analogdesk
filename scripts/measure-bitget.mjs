/**
 * AnalogDesk - measure the official Bitget integration, on both routes, and cross-validate it
 * against the keyless library this project already ships.
 *
 * Why this script exists. Every *.bitget.com host resets at the TCP layer on the network this project
 * was built on, so the first published version of AnalogDesk shipped a disclosure that said the
 * official Bitget MCP contributes nothing. That disclosure was accurate for a DIRECT connection and
 * wrong about Bitget: the hosts are reachable through a local HTTP proxy, and when they are, the
 * official US-equity MCP answers with real data and no API key. Reporting only the direct failure
 * understated the integration; reporting only the proxied success would hide that a reviewer on a
 * plain network gets nothing. So this script probes BOTH routes, records which one produced each
 * answer, and then spends the working route on the only thing that matters: numbers that can be
 * checked against AnalogDesk's own dataset.
 *
 * What it measures, and why each one is a real cross-check rather than a demo call:
 *   1. crypto fear & greed, ~400 daily observations, against the api.alternative.me series already in
 *      data-cache/dataset.json. Overlapping dates, so this is an exact numeric agreement test.
 *   2. earnings disclosure dates from Bitget's calendar against the dates this project derived from
 *      EDGAR full-text search (8-K Item 2.02 / 6-K). Independent derivation, same event, so the day
 *      difference is a measurement of the event feature group, not a restatement of it.
 *   3. instrument identity and sector from Bitget's company profile against the library's own
 *      universe metadata and first session.
 *   4. a live Bitget quote against the frozen snapshot's last close, reported as snapshot staleness
 *      in sessions and percent - the honest way to compare a live print to a dataset that ends
 *      2026-09-18.
 *   5. Bitget's whole-market fear & greed, which this project does not carry at all, recorded as an
 *      addition with its own timestamp rather than smuggled into an existing feature.
 * Entries whose upstream returns HTTP 204 with an empty body (equity_price_historical,
 * etf_price_performance at the time of writing) are recorded as measured-empty. An empty answer from
 * a working transport is a fact about the upstream and is reported, not retried into oblivion.
 *
 * Output: data-cache/bitget-probe.json. No key is used and none is written.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { detectProxy, detectLocalProxy, proxyRequest, parseSSE } from "../src/data/proxy.mjs";
import { BITGET_ENDPOINTS, classifyError } from "../src/data/bitget.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const OUT = join(ROOT, "data-cache", "bitget-probe.json");
const QUIET = process.argv.includes("--quiet");
const log = (...a) => { if (!QUIET) console.log(...a); };

const MCP_URL = BITGET_ENDPOINTS.mcp;
const MCP_HEADERS = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "User-Agent": "AnalogDesk Bitget integration probe" };
const CONCURRENCY = 3;
const QUOTE_SYMBOLS = "ALL";      // every library instrument gets a live quote
const DEEP_SYMBOLS = 24;          // profile + earnings calendar, sampled to keep the run under a minute
const FNG_DAYS = 400;

const r2 = (x) => (Number.isFinite(x) ? Number(Number(x).toFixed(2)) : null);
const r4 = (x) => (Number.isFinite(x) ? Number(Number(x).toFixed(4)) : null);
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

/* ------------------------------- dataset -------------------------------- */

const ds = JSON.parse(readFileSync(join(ROOT, "data-cache", "dataset.json"), "utf8"));
const dates = ds.dates;
const lastDate = dates[dates.length - 1];
const universe = (ds.meta?.universe || []).map((u) => u.s);
const fngLocal = ds.crypto?.FNG || { d: [], v: [] };
const earningsLocal = ds.events?.earnings || {};
const earningsVia = ds.events?.earningsVia || {};

/* --------------------------- route measurement --------------------------- */

async function probeDirect(url, { timeoutMs = 8000 } = {}) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { method: "GET", headers: { "User-Agent": "AnalogDesk probe", Accept: "*/*" }, signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
    return { route: "direct", ok: true, status: res.status, latencyMs: Date.now() - t0, kind: res.ok ? "ok" : `http-${res.status}`, detail: res.ok ? null : `reachable, responded ${res.status}` };
  } catch (e) {
    const c = classifyError(e);
    return { route: "direct", ok: false, status: null, latencyMs: Date.now() - t0, kind: c.kind, detail: c.detail };
  }
}

async function probeViaProxy(url, proxy, { timeoutMs = 15000 } = {}) {
  const t0 = Date.now();
  try {
    const res = await proxyRequest(url, { proxy, method: "GET", headers: { "User-Agent": "AnalogDesk probe", Accept: "*/*" }, timeoutMs });
    return { route: `proxy ${proxy.host}:${proxy.port}`, ok: true, status: res.status, latencyMs: Date.now() - t0, kind: res.status < 400 ? "ok" : `http-${res.status}`, detail: res.status < 400 ? null : `reachable, responded ${res.status}` };
  } catch (e) {
    const c = classifyError(e);
    return { route: `proxy ${proxy.host}:${proxy.port}`, ok: false, status: null, latencyMs: Date.now() - t0, kind: c.kind, detail: c.detail };
  }
}

/* ------------------------------ MCP session ------------------------------ */

async function openMcp(proxy, { timeoutMs = 40000 } = {}) {
  const t0 = Date.now();
  const init = await proxyRequest(MCP_URL, {
    proxy, method: "POST", headers: MCP_HEADERS, timeoutMs,
    body: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "AnalogDesk", version: "1.0.0" } } }
  });
  const sid = init.headers["mcp-session-id"];
  if (!sid) throw new Error(`initialize returned no mcp-session-id (HTTP ${init.status})`);
  const headers = Object.assign({}, MCP_HEADERS, { "mcp-session-id": sid });
  await proxyRequest(MCP_URL, { proxy, method: "POST", headers, body: { jsonrpc: "2.0", method: "notifications/initialized" }, timeoutMs: 20000 }).catch(() => {});
  const info = parseSSE(init.body, 1)?.result || {};
  let counter = 100;
  const rpc = async (method, params, ms = 120000) => {
    const id = ++counter;
    const res = await proxyRequest(MCP_URL, { proxy, method: "POST", headers, body: { jsonrpc: "2.0", id, method, params }, timeoutMs: ms });
    return parseSSE(res.body, id);
  };
  return { sid, serverInfo: info.serverInfo || null, protocolVersion: info.protocolVersion || null, initMs: Date.now() - t0, rpc };
}

async function query(mcp, entryId, params, { timeoutMs = 120000, attempts = 2 } = {}) {
  let last = null;
  for (let a = 0; a < attempts; a++) {
    last = await queryOnce(mcp, entryId, params, timeoutMs);
    // A reset or a timeout on a route that is otherwise working is transient; a 204 or a 422 is a
    // real answer from the upstream and must not be retried into a different result.
    if (last.ok || last.empty || (last.errorText && !/connection-reset|timed out|timeout/i.test(last.errorText))) return last;
    if (a + 1 < attempts) await sleep(600);
  }
  return last;
}

async function queryOnce(mcp, entryId, params, timeoutMs) {
  const t0 = Date.now();
  try {
    const j = await mcp.rpc("tools/call", { name: "do_query", arguments: { entry_id: entryId, params } }, timeoutMs);
    const text = (j?.result?.content || []).map((c) => c?.text || "").join("");
    let payload = null;
    try { payload = JSON.parse(text); } catch {}
    const results = payload?.data?.results;
    return {
      entryId, params, ms: Date.now() - t0, isError: !!j?.result?.isError,
      status: payload?.status_code ?? null,
      ok: payload?.success === true && (payload?.status_code === 200) && Array.isArray(results),
      empty: payload?.success === true && payload?.status_code === 204,
      errorText: typeof payload?.data?.detail === "string" ? payload.data.detail : (j?.error?.message || (payload?.success === false ? JSON.stringify(payload?.data || payload).slice(0, 200) : null)),
      provider: payload?.provider || null,
      results: Array.isArray(results) ? results : null,
      raw: Array.isArray(results) ? null : String(text).slice(0, 400)
    };
  } catch (e) {
    const c = classifyError(e);
    return { entryId, params, ms: Date.now() - t0, isError: true, status: null, ok: false, empty: false, errorText: `${c.kind}: ${c.detail}`, provider: null, results: null, raw: null };
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const worker = async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/* --------------------------------- run ---------------------------------- */

const startedAt = new Date().toISOString();
const envProxy = detectProxy();
const localProxy = envProxy || await detectLocalProxy();
log(`proxy: ${localProxy ? localProxy.source : "none found"}`);

const marketHosts = [
  { key: "mcp", url: BITGET_ENDPOINTS.mcp, name: "Bitget official MCP (US stocks / ETF, read-only)" },
  { key: "www", url: BITGET_ENDPOINTS.www, name: "Bitget web (www)" },
  { key: "api", url: BITGET_ENDPOINTS.api + "/api/v2/public/time", name: "Bitget public REST (api)" }
];

const routes = [];
for (const h of marketHosts) {
  const direct = await probeDirect(h.url);
  const proxied = localProxy ? await probeViaProxy(h.url, localProxy) : null;
  routes.push({ key: h.key, url: h.url, name: h.name, direct, proxied });
  log(`  ${h.key.padEnd(4)} direct=${direct.ok ? "OK " + direct.status : direct.kind}  proxy=${proxied ? (proxied.ok ? "OK " + proxied.status : proxied.kind) : "n/a"}`);
}

const gw = await probeDirect(BITGET_ENDPOINTS.llmGateway.replace("/chat/completions", "/models"));
const reachableDirect = routes.filter((x) => x.direct?.ok).length;
const reachableProxied = routes.filter((x) => x.proxied?.ok).length;
const usableRoute = localProxy && reachableProxied > 0 ? localProxy : null;

let mcp = null, mcpError = null, catalog = null, tools = null;
if (usableRoute) {
  try {
    mcp = await openMcp(usableRoute);
    log(`MCP session ${mcp.sid} server=${mcp.serverInfo?.name}@${mcp.serverInfo?.version} in ${mcp.initMs}ms`);
    const tl = await mcp.rpc("tools/list", {}, 60000);
    tools = (tl?.result?.tools || []).map((t) => ({ name: t.name, summary: String(t.description || "").replace(/\s+/g, " ").slice(0, 160) }));
    const gj = await mcp.rpc("tools/call", { name: "guide", arguments: {} }, 60000);
    const gt = (gj?.result?.content || []).map((c) => c?.text || "").join("");
    try { catalog = JSON.parse(gt); } catch { catalog = { raw: gt.slice(0, 400) }; }
  } catch (e) {
    const c = classifyError(e);
    mcpError = `${c.kind}: ${c.detail}`;
    log("MCP session failed: " + mcpError);
  }
}

const out = {
  generatedAt: startedAt,
  venue: {
    name: "Bitget official MCP (agent.bitget.com/mcp) - bitget-mcp-server, read-only US equity / ETF / crypto data, no account and no API key",
    transport: "MCP JSON-RPC 2.0 over streamable HTTP, proxied through a local HTTP CONNECT tunnel",
    endpoint: MCP_URL
  },
  route: {
    proxyUsed: usableRoute ? `${usableRoute.host}:${usableRoute.port}` : null,
    proxySource: usableRoute ? usableRoute.source : null,
    envProxy: envProxy ? envProxy.source : null,
    marketDataReachableDirect: reachableDirect,
    marketDataReachableViaProxy: reachableProxied,
    marketDataTotal: marketHosts.length,
    hosts: routes,
    narrativeGateway: Object.assign({ url: BITGET_ENDPOINTS.llmGateway, name: "Bitget hackathon LLM gateway (OpenAI-compatible /v1/chat/completions)", group: "narrative" }, gw),
    disclosure: reachableDirect === marketHosts.length
      ? "All three Bitget market-data hosts answered on a direct connection."
      : `${reachableDirect}/${marketHosts.length} Bitget market-data hosts answer on a DIRECT connection from this machine; ${reachableProxied}/${marketHosts.length} answer through a local HTTP proxy (${usableRoute ? usableRoute.host + ":" + usableRoute.port : "none available"}). Every figure below was fetched on the proxied route and is labelled as such, because a reviewer on a plain network will get the direct result instead and must not be told otherwise.`
  },
  server: mcp ? { sessionId: mcp.sid, serverInfo: mcp.serverInfo, protocolVersion: mcp.protocolVersion, initMs: mcp.initMs, toolsAdvertised: tools, catalog } : null,
  sessionError: mcpError,
  library: { symbols: universe.length, sessions: dates.length, lastDate, snapshotNote: `the shipped library is frozen at ${lastDate}; a Bitget quote is live, so the two are compared as staleness, never as agreement` }
};

if (!mcp) {
  out.summary = { measured: false, reason: mcpError || "no usable route to the Bitget MCP from this machine" };
  out.disclosure = "The Bitget MCP could not be reached on any available route at measurement time, so this file records the probe and nothing else. No Bitget-sourced figure is claimed anywhere in AnalogDesk.";
  writeFileSync(OUT, JSON.stringify(out, null, 1));
  log("wrote " + OUT + " (no session)");
  process.exit(0);
}

/* ---- 1. crypto fear & greed, cross-validated against the local series ---- */
// The entry rejects an explicit interval: {limit, interval:"1d"} comes back empty while {limit} alone
// returns daily rows. Ask for the daily series the way the catalog actually serves it.
const fngCall = await query(mcp, "crypto_sentiment_crypto_fear_greed", { limit: FNG_DAYS });
const bitgetFng = new Map();
for (const row of fngCall.results || []) {
  const d = String(row.date || "").slice(0, 10);
  const v = Number(row.value);
  if (d && Number.isFinite(v)) bitgetFng.set(d, v);
}
// The committed crypto series stores its values under "p" (price/point), not "v". Read whichever
// key is present so this cross-check cannot silently compare against an all-NaN map.
const localVals = fngLocal.p || fngLocal.v || [];
const localFng = new Map((fngLocal.d || []).map((d, i) => [d, Number(localVals[i])]));
let overlap = 0, sumAbs = 0, exact = 0, maxAbs = 0, worstDate = null;
for (const [d, v] of bitgetFng) {
  const lv = localFng.get(d);
  if (!Number.isFinite(lv)) continue;
  overlap++;
  const diff = Math.abs(v - lv);
  sumAbs += diff;
  if (diff === 0) exact++;
  if (diff > maxAbs) { maxAbs = diff; worstDate = d; }
}
out.fearGreedCrossCheck = {
  entryId: "crypto_sentiment_crypto_fear_greed",
  provider: fngCall.provider,
  call: { ms: fngCall.ms, status: fngCall.status, ok: fngCall.ok, observationsReturned: bitgetFng.size },
  localSource: "api.alternative.me/fng (keyless), already committed in data-cache/dataset.json",
  overlappingDates: overlap,
  exactMatches: exact,
  exactMatchPct: overlap ? r2(100 * exact / overlap) : null,
  meanAbsDifference: overlap ? r4(sumAbs / overlap) : null,
  maxAbsDifference: overlap ? r4(maxAbs) : null,
  maxAbsDifferenceDate: worstDate,
  verdict: overlap === 0
    ? "no overlapping dates - nothing was validated"
    : exact === overlap
      ? `all ${overlap} overlapping daily readings are identical to the independently-sourced series this project already ships`
      : `${exact}/${overlap} identical; mean absolute difference ${r4(sumAbs / overlap)} index points`,
  note: "Two independent transports, two independent operators, the same index. This is the one cross-check in this file where an exact numeric agreement is the expected result, so anything less is reported rather than rounded away."
};
log(`FNG cross-check: ${overlap} overlapping dates, ${exact} exact, meanAbsDiff=${out.fearGreedCrossCheck.meanAbsDifference}`);

/* ---- 2/3/4. per-symbol: quote, profile, earnings calendar ---- */
const deepSymbols = universe.slice(0, DEEP_SYMBOLS);
const quoteSymbols = QUOTE_SYMBOLS === "ALL" ? universe : deepSymbols;

const quotes = await mapLimit(quoteSymbols, CONCURRENCY, async (sym) => {
  const q = await query(mcp, "equity_price_quote", { symbol: sym });
  const row = (q.results || [])[0];
  if (!row) return { sym, ok: false, error: q.errorText || "no row", ms: q.ms };
  const arr = ds.prices[sym];
  const lastClose = arr ? Number(arr.c[arr.c.length - 1]) : NaN;
  const live = Number(row.last_price);
  const drift = Number.isFinite(live) && Number.isFinite(lastClose) && lastClose > 0 ? (live / lastClose - 1) * 100 : NaN;
  return {
    sym, ok: true, ms: q.ms, provider: q.provider,
    lastPrice: Number.isFinite(live) ? r4(live) : null,
    prevClose: Number.isFinite(Number(row.prev_close)) ? r4(Number(row.prev_close)) : null,
    marketCap: Number.isFinite(Number(row.total_market_cap)) ? Math.round(Number(row.total_market_cap)) : null,
    priceToBook: Number.isFinite(Number(row.pb)) ? r4(Number(row.pb)) : null,
    turnoverRatePct: Number.isFinite(Number(row.turnover_rate)) ? r4(Number(row.turnover_rate) * 100) : null,
    snapshotClose: Number.isFinite(lastClose) ? r4(lastClose) : null,
    snapshotDate: lastDate,
    driftFromSnapshotPct: Number.isFinite(drift) ? r2(drift) : null
  };
});

const profiles = await mapLimit(deepSymbols, CONCURRENCY, async (sym) => {
  const p = await query(mcp, "equity_profile", { symbol: sym });
  const row = (p.results || [])[0];
  const local = (ds.meta?.universe || []).find((u) => u.s === sym) || {};
  const firstLocal = ds.prices[sym] ? dates[0] : null;
  return row ? {
    sym, ok: true, ms: p.ms,
    bitgetName: row.legal_name || row.name || null,
    bitgetExchange: row.stock_exchange || null,
    bitgetIndustry: row.industry_category || null,
    bitgetIsin: row.isin || null,
    bitgetFirstPriceDate: row.first_stock_price_date || null,
    bitgetEntityStatus: row.entity_status || null,
    localSector: local.sec || null,
    localFirstSession: firstLocal,
    libraryStartsAfterListing: row.first_stock_price_date && firstLocal ? String(firstLocal) > String(row.first_stock_price_date) : null
  } : { sym, ok: false, error: p.errorText || "no row", ms: p.ms };
});

const calendars = await mapLimit(deepSymbols, CONCURRENCY, async (sym) => {
  const c = await query(mcp, "equity_calendar", { symbol: sym });
  const rows = c.results || [];
  const bitgetDates = rows
    .map((x) => String(x.perf_briefing_fore_dsclsr_date || x.perf_report_dsclsr_date || "").slice(0, 10))
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();
  const localDates = (earningsLocal[sym] || []).slice().sort();
  const via = earningsVia[sym] || {};
  // For each Bitget-disclosed date, the nearest date this project derived from EDGAR.
  const pairs = [];
  for (const bd of bitgetDates) {
    let best = null, bestDiff = Infinity;
    for (const ld of localDates) {
      const diff = Math.round((Date.parse(bd) - Date.parse(ld)) / 86400000);
      if (Math.abs(diff) < Math.abs(bestDiff)) { bestDiff = diff; best = ld; }
    }
    if (best) pairs.push({ bitgetDate: bd, localDate: best, daysBitgetMinusLocal: bestDiff });
  }
  const within = (n) => pairs.filter((p) => Math.abs(p.daysBitgetMinusLocal) <= n).length;
  const diffs = pairs.map((p) => Math.abs(p.daysBitgetMinusLocal));
  return {
    sym, ok: rows.length > 0, ms: c.ms,
    bitgetDatesReturned: bitgetDates.length,
    localDatesDerived: localDates.length,
    localDerivation: via,
    matched: pairs.length,
    exactSameDay: within(0),
    within1Day: within(1),
    within3Days: within(3),
    within7Days: within(7),
    medianAbsDayDifference: diffs.length ? diffs.slice().sort((a, b) => a - b)[Math.floor(diffs.length / 2)] : null,
    maxAbsDayDifference: diffs.length ? Math.max(...diffs) : null,
    sample: pairs.slice(-4)
  };
});

const okQuotes = quotes.filter((q) => q.ok);
const drifts = okQuotes.map((q) => q.driftFromSnapshotPct).filter((x) => Number.isFinite(x));
const absDrifts = drifts.map((x) => Math.abs(x)).sort((a, b) => a - b);
const okCal = calendars.filter((c) => c.ok && c.matched > 0);
const allMatched = okCal.reduce((s, c) => s + c.matched, 0);
const allSameDay = okCal.reduce((s, c) => s + c.exactSameDay, 0);
const allWithin3 = okCal.reduce((s, c) => s + c.within3Days, 0);
const allWithin7 = okCal.reduce((s, c) => s + c.within7Days, 0);
const okProf = profiles.filter((p) => p.ok);

out.quotes = {
  entryId: "equity_price_quote",
  symbolsQueried: quoteSymbols.length,
  symbolsAnswered: okQuotes.length,
  provider: okQuotes[0]?.provider || null,
  perSymbol: quotes,
  stalenessVsSnapshot: {
    snapshotDate: lastDate,
    comparedSymbols: drifts.length,
    medianAbsDriftPct: absDrifts.length ? r2(absDrifts[Math.floor(absDrifts.length / 2)]) : null,
    maxAbsDriftPct: absDrifts.length ? r2(absDrifts[absDrifts.length - 1]) : null,
    note: `Bitget quotes are live; the library is frozen at ${lastDate}. The drift is therefore a measurement of how stale the snapshot is, not a disagreement about a price. It is reported so a reviewer can decide whether the frozen card is still readable.`
  }
};
out.profiles = { entryId: "equity_profile", symbolsQueried: deepSymbols.length, symbolsAnswered: okProf.length, perSymbol: profiles };
out.earningsCrossCheck = {
  entryId: "equity_calendar",
  symbolsQueried: deepSymbols.length,
  symbolsWithBothSides: okCal.length,
  bitgetSource: "Bitget equity calendar (perf_briefing_fore_dsclsr_date / perf_report_dsclsr_date)",
  localSource: "EDGAR full-text search, 8-K Item 2.02 for domestic filers with a 6-K fallback for foreign private issuers, filing dates clustered at 6 calendar days",
  matchedDates: allMatched,
  exactSameDay: allSameDay,
  exactSameDayPct: allMatched ? r2(100 * allSameDay / allMatched) : null,
  within3Days: allWithin3,
  within3DaysPct: allMatched ? r2(100 * allWithin3 / allMatched) : null,
  within7Days: allWithin7,
  within7DaysPct: allMatched ? r2(100 * allWithin7 / allMatched) : null,
  perSymbol: calendars,
  note: "Two independent derivations of the same corporate event. Bitget publishes a disclosure date; this project infers one from filing text. They are not the same quantity by construction - a filing can land a day either side of the announced briefing date - so the day difference is reported as a distribution rather than collapsed into a pass/fail."
};

/* ---- 5. the one Bitget series this project does not carry ---- */
const mfg = await query(mcp, "sentiment_market_fear_greed", {});
const mfgRow = (mfg.results || [])[0];
out.wholeMarketSentiment = {
  entryId: "sentiment_market_fear_greed",
  provider: mfg.provider,
  ok: !!mfgRow,
  call: { ms: mfg.ms, status: mfg.status },
  reading: mfgRow ? {
    score: Number.isFinite(Number(mfgRow.score)) ? r4(Number(mfgRow.score)) : null,
    rating: mfgRow.rating || null,
    timestamp: mfgRow.timestamp || null,
    previousClose: Number.isFinite(Number(mfgRow.previous_close)) ? r4(Number(mfgRow.previous_close)) : null,
    previous1Week: Number.isFinite(Number(mfgRow.previous_1_week)) ? r4(Number(mfgRow.previous_1_week)) : null,
    previous1Month: Number.isFinite(Number(mfgRow.previous_1_month)) ? r4(Number(mfgRow.previous_1_month)) : null,
    previous1Year: Number.isFinite(Number(mfgRow.previous_1_year)) ? r4(Number(mfgRow.previous_1_year)) : null
  } : null,
  usedByEngine: false,
  note: "Recorded, not consumed. AnalogDesk's distance function is frozen and validated as published; adding a live sentiment series to it would invalidate every figure in research/VALIDATION.md. This reading is surfaced as provenance - a Bitget-sourced number a reviewer can see - and is deliberately excluded from the retrieval features, the conformal scale and the stress engine."
};

/* ---- entries that answered with an empty body ---- */
const empties = [];
for (const [entryId, params] of [["equity_price_historical", { symbol: "NVDA" }], ["etf_price_performance", { symbol: "SPY" }]]) {
  const q = await query(mcp, entryId, params);
  empties.push({ entryId, params, status: q.status, empty: q.empty, ok: q.ok, ms: q.ms, errorText: q.errorText });
  log(`  ${entryId}: status=${q.status} empty=${q.empty} ok=${q.ok}`);
}
out.measuredEmpty = {
  entries: empties,
  note: "These entries completed the transport and returned HTTP 204 with an empty body at measurement time. That is recorded instead of being retried until something came back: a working session with an empty upstream is a fact about the upstream, and a deep historical price cross-check would have been the strongest test in this file, so its absence is stated rather than papered over."
};

out.summary = {
  measured: true,
  measuredAt: new Date().toISOString(),
  route: usableRoute ? `proxy ${usableRoute.host}:${usableRoute.port}` : "direct",
  server: mcp.serverInfo ? `${mcp.serverInfo.name}@${mcp.serverInfo.version}` : null,
  catalogCategories: (catalog?.categories || []).length,
  catalogEntries: (catalog?.categories || []).reduce((s, c) => s + (c.entry_count || 0), 0),
  toolsAdvertised: (tools || []).length,
  quotesAnswered: `${okQuotes.length}/${quoteSymbols.length}`,
  profilesAnswered: `${okProf.length}/${deepSymbols.length}`,
  earningsDatesCompared: allMatched,
  earningsExactSameDayPct: out.earningsCrossCheck.exactSameDayPct,
  earningsWithin3DaysPct: out.earningsCrossCheck.within3DaysPct,
  fearGreedOverlappingDates: overlap,
  fearGreedExactMatches: exact,
  medianSnapshotDriftPct: out.quotes.stalenessVsSnapshot.medianAbsDriftPct,
  entriesMeasuredEmpty: empties.filter((e) => e.empty).length
};
out.disclosure = `Fetched through ${out.summary.route} from ${out.summary.server} on ${out.summary.startedAt || startedAt}. The Bitget integration contributes ${okQuotes.length} live equity quotes, ${okProf.length} company profiles, ${allMatched} earnings-disclosure dates cross-checked against this project's own EDGAR derivation, and ${overlap} days of crypto fear & greed cross-checked against the independently-sourced series already in the dataset. NONE of it feeds the retrieval engine, the frozen conformal scale, or any figure in research/VALIDATION.md - those stay exactly as published and remain reproducible from keyless sources alone. This file exists so the cross-check is auditable, and so the route it needed is stated: on a direct connection from this machine, ${reachableDirect}/${marketHosts.length} Bitget market-data hosts answer.`;

writeFileSync(OUT, JSON.stringify(out, null, 1));
log(`\nwrote ${OUT}`);
log(`summary: ${JSON.stringify(out.summary)}`);
