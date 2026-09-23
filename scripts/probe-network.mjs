/**
 * AnalogDesk - network reachability probe.
 *
 *   node scripts/probe-network.mjs        writes data-cache/network-probe.json and prints a table
 *
 * Every source AnalogDesk uses, plus every source it wanted to use and could not, plus the Bitget
 * toolkit. The result is written to disk so research/DATA-PROVENANCE.md and the UI provenance panel
 * report measured facts from this machine rather than claims. Re-run it after any network change.
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { probeEndpoint, classifyError, BITGET_ENDPOINTS } from "../src/data/bitget.mjs";
import { probeAllBitgetRouted } from "../src/data/bitget-routes.mjs";
import { UA_BROWSER, UA_SEC } from "../src/data/sources.mjs";
import { VENUE as WRAPPER_VENUE } from "../src/data/xstocks.mjs";
import { resolveConfig } from "../src/llm/config.mjs";
import { PROMPT_VERSION } from "../src/llm/narrate.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

const TARGETS = [
  { name: "api.stockanalysis.com", role: "USED - daily OHLCV + adjusted close, 71 instruments, 10y", url: "https://api.stockanalysis.com/api/symbol/s/SPY/history?range=1Y&period=Daily", headers: { "User-Agent": UA_BROWSER } },
  { name: "fred.stlouisfed.org", role: "USED - 11 macro series, keyless CSV", url: "https://fred.stlouisfed.org/graph/fredgraph.csv?id=VIXCLS&cosd=2024-01-01", headers: { "User-Agent": UA_BROWSER } },
  { name: "efts.sec.gov", role: "USED - EDGAR full-text search for 8-K Item 2.02 and 6-K results filings (this probe query can 500; the pipeline retries with backoff)", url: "https://efts.sec.gov/LATEST/search-index?q=%22Item+2.02%22&forms=8-K&ciks=0000320193&startdt=2024-01-01&enddt=2026-09-21&dateRange=custom", headers: { "User-Agent": UA_SEC, Accept: "application/json" } },
  { name: "www.federalreserve.gov", role: "USED - FOMC decision calendar, parsed from document URLs", url: "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm", headers: { "User-Agent": UA_BROWSER } },
  { name: "coins.llama.fi", role: "USED - BTC and ETH daily history (CoinGecko/Kraken are not reachable here)", url: "https://coins.llama.fi/chart/coingecko:bitcoin?start=1757000000&span=5&period=1d", headers: { "User-Agent": UA_BROWSER } },
  { name: "api.alternative.me", role: "USED - crypto fear & greed index, keyless", url: "https://api.alternative.me/fng/?limit=2", headers: { "User-Agent": UA_BROWSER } },
  { name: "api.github.com", role: "AVAILABLE - not used by the data pipeline", url: "https://api.github.com/rate_limit", headers: { "User-Agent": UA_BROWSER } },
  { name: "registry.npmjs.org", role: "AVAILABLE - the project has zero runtime dependencies, so this is only for tooling", url: "https://registry.npmjs.org/-/ping", headers: { "User-Agent": UA_BROWSER } },
  { name: "hackathon.bitgetops.com", role: "USED - the Bitget-operated hackathon LLM gateway the narrative layer calls (OpenAI-compatible). Probed unauthenticated, so a 401/404 is a successful reachability result and no key leaves this script.", url: BITGET_ENDPOINTS.llmGateway, headers: { "User-Agent": UA_BROWSER, "Content-Type": "application/json" } },
  { name: "api.gateio.ws", role: "USED - tokenised-equity wrapper layer for scripts/measure-wrapper.mjs (7x24 measurement: tracking, premium, spread, closed-hours movement). NOT a price source for the analog library.", url: `${WRAPPER_VENUE.base}/spot/time`, headers: { "User-Agent": UA_BROWSER } },
  { name: "query1.finance.yahoo.com", role: "NOT USED - responds but rejects keyless programmatic access (HTTP 403 / crumb+cookie required), so it is not a dependency", url: "https://query1.finance.yahoo.com/v8/finance/chart/SPY?range=1mo&interval=1d", headers: { "User-Agent": UA_BROWSER } },
  { name: "stooq.com", role: "NOT USED - reachable but kept out of the pipeline so every source is a single keyless endpoint with a stable contract", url: "https://stooq.com/q/d/l/?s=spy.us&i=d", headers: { "User-Agent": UA_BROWSER } },
  { name: "api.coingecko.com", role: "NOT USED - unreachable from this network (connect timeout); coins.llama.fi is used instead", url: "https://api.coingecko.com/api/v3/ping", headers: { "User-Agent": UA_BROWSER } },
  { name: "api.kraken.com", role: "NOT USED - unreachable from this network (connect timeout); coins.llama.fi is used instead", url: "https://api.kraken.com/0/public/Time", headers: { "User-Agent": UA_BROWSER } },
  { name: "en.wikipedia.org", role: "NOT USED - unreachable from this network (connect timeout); no narrative depends on it", url: "https://en.wikipedia.org/api/rest_v1/page/summary/Apple_Inc.", headers: { "User-Agent": UA_BROWSER } }
];

const out = { generatedAt: new Date().toISOString(), host: process.platform, node: process.version, targets: [], bitget: null };
console.log("== AnalogDesk network probe ==");
for (const t of TARGETS) {
  const r = await probeEndpoint(t.url, t.name, { timeoutMs: 15000, headers: t.headers });
  out.targets.push({ name: t.name, role: t.role, url: t.url, ok: r.ok, status: r.status, kind: r.kind, detail: r.detail, latencyMs: r.latencyMs });
  console.log(`${r.ok ? "REACHABLE " : "UNREACHABLE"} ${t.name.padEnd(28)} ${String(r.status ?? r.kind).padEnd(18)} ${String(r.latencyMs).padStart(6)}ms  ${t.role}`);
}
// The narrative gateway probe names the model this build is configured for, so the recorded
// disclosure says which integration is actually in use instead of implying a market-data feed.
const cfg = resolveConfig();
out.bitget = await probeAllBitgetRouted({ timeoutMs: 8000, model: cfg.llm.model });
out.llm = { mode: cfg.llm.enabled ? "LIVE" : "TEMPLATE", model: cfg.llm.model, baseUrl: cfg.llm.baseUrl, keyPresent: Boolean(cfg.llm.enabled), promptVersion: PROMPT_VERSION };
console.log(`\nBitget, market data: ${out.bitget.marketData.summary}`);
for (const e of out.bitget.marketData.endpoints) console.log(`   ${e.ok ? "REACHABLE " : "UNREACHABLE"} ${e.name.padEnd(48)} ${e.kind}${e.detail ? " - " + e.detail : ""}`);
console.log(`Bitget, narrative:   ${out.bitget.narrative.summary}`);
const ng = out.bitget.narrative.endpoint;
console.log(`   ${ng.ok ? "REACHABLE " : "UNREACHABLE"} ${ng.name.padEnd(48)} ${ng.kind}${ng.detail ? " - " + ng.detail : ""}`);

out.usedSources = out.targets.filter((t) => t.role.startsWith("USED") && t.ok).map((t) => t.name);
out.unusedSources = out.targets.filter((t) => t.role.startsWith("NOT USED")).map((t) => ({
  name: t.name, role: t.role, reachable: t.ok, status: t.status, kind: t.kind, detail: t.detail
}));
out.rejectedSources = out.unusedSources.filter((t) => !t.reachable);
out.summary = `${out.usedSources.length} used sources reachable; ${out.unusedSources.length} candidate sources not used (${out.rejectedSources.length} of them unreachable from this machine); Bitget market-data toolkit ${out.bitget.marketData.reachable ? "reachable" : "unreachable"} (${out.bitget.marketData.reachableCount}/${out.bitget.marketData.total}, ${out.bitget.marketData.reachableDirectCount ?? 0}/${out.bitget.marketData.total} of them on a direct connection); Bitget narrative gateway ${out.bitget.narrative.reachable ? "reachable" : "unreachable"}.`;
console.log(`\n${out.summary}`);

mkdirSync(join(ROOT, "data-cache"), { recursive: true });
// Cross-check the other committed measurement so the two files cannot drift apart unnoticed: the
// wrapper probe names a venue, and if that venue is unreachable here the wrapper figures on every
// card are stale rather than merely old.
try {
  const wp = JSON.parse(readFileSync(join(ROOT, "data-cache", "wrapper-probe.json"), "utf8"));
  out.wrapperMeasurement = { generatedAt: wp.generatedAt, venue: wp.venue?.name || null, degraded: Boolean(wp.degradation), verifiedWrappers: Object.keys(wp.bySymbol || {}).length, referenceClosedSharePct: wp.referenceMarket?.closedSharePct ?? null, medianClosedMoveSharePct: wp.summary?.medianReferenceClosedMoveSharePct ?? null };
  console.log(`wrapper measurement: ${out.wrapperMeasurement.verifiedWrappers} verified wrapper(s) at ${out.wrapperMeasurement.generatedAt}${wp.degradation ? " (DEGRADED - venue unreachable when measured)" : ""}`);
} catch {
  out.wrapperMeasurement = null;
  console.log("wrapper measurement: none on record - run node scripts/measure-wrapper.mjs");
}
writeFileSync(join(ROOT, "data-cache", "network-probe.json"), JSON.stringify(out, null, 2), "utf8");
console.log("wrote data-cache/network-probe.json");