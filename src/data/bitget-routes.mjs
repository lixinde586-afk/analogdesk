/**
 * AnalogDesk - dual-route Bitget reachability, Node side only.
 *
 * src/data/bitget.mjs is part of the browser module graph, so it must stay free of node: imports.
 * This module is the one that is allowed to touch node:net and node:tls, and it exists for a single
 * honest reason: on the network this project is built on, every *.bitget.com host resets at the TCP
 * layer on a DIRECT connection, while all three answer through a local HTTP proxy. Reporting only the
 * direct result understates the integration; reporting only the proxied result would tell a reviewer
 * on a plain network to expect something they will not get. So both are measured and both are stated.
 *
 * `reachable` here means "reachable on at least one measured route", and the route that produced the
 * answer is always carried next to it.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { detectProxy, detectLocalProxy, proxyRequest } from "./proxy.mjs";
import { BITGET_ENDPOINTS, probeEndpoint, probeBitgetMcp, probeBitgetLlmGateway, classifyError } from "./bitget.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The committed measurement written by scripts/measure-bitget.mjs. Null when it has not been run. */
export function loadBitgetMeasurement(root = ROOT) {
  try { return JSON.parse(readFileSync(join(root, "data-cache", "bitget-probe.json"), "utf8")); }
  catch { return null; }
}

async function probeViaProxy(url, name, proxy, { timeoutMs = 15000, group = "market-data" } = {}) {
  const t0 = Date.now();
  try {
    const res = await proxyRequest(url, { proxy, method: "GET", headers: { "User-Agent": "AnalogDesk connectivity probe", Accept: "*/*" }, timeoutMs });
    const ok = res.status < 500;
    return {
      url, name, group, route: `proxy ${proxy.host}:${proxy.port}`, probedAt: new Date().toISOString(),
      ok, status: res.status, latencyMs: Date.now() - t0,
      kind: ok ? (res.status < 400 ? "ok" : `http-${res.status}`) : `http-${res.status}`,
      detail: ok ? `reachable through the local proxy, responded ${res.status}` : `proxy answered HTTP ${res.status}`
    };
  } catch (e) {
    const c = classifyError(e);
    return { url, name, group, route: `proxy ${proxy.host}:${proxy.port}`, probedAt: new Date().toISOString(), ok: false, status: null, latencyMs: Date.now() - t0, kind: c.kind, detail: c.detail };
  }
}

/**
 * The narrative gateway is probed on both routes too, and with the patience the real call gets.
 * An 8s direct-only probe timed out on a machine where the narrative layer's own 45s request
 * succeeded, which would print "gateway unreachable" next to a LIVE generation - exactly the one
 * contradiction this file exists to avoid. Direct first (that is what the LLM client uses), and the
 * local proxy only as a second measured route.
 */
async function probeLlmGatewayRouted(url, { timeoutMs = 6000, model = null, proxy = null } = {}) {
  const wait = Math.max(timeoutMs, 20000);
  const direct = await probeBitgetLlmGateway(url, { timeoutMs: wait, model });
  let viaProxy = null;
  if (!direct.ok && proxy) {
    const t0 = Date.now();
    try {
      const res = await proxyRequest(url, {
        proxy, method: "POST", headers: { "Content-Type": "application/json" },
        body: { model: model || "probe", messages: [] }, timeoutMs: wait
      });
      const ok = res.status < 500;
      viaProxy = {
        url, name: direct.name, group: "narrative", route: `proxy ${proxy.host}:${proxy.port}`, probedAt: new Date().toISOString(),
        ok, status: res.status, latencyMs: Date.now() - t0, kind: `http-${res.status}`,
        detail: ok ? `reachable through the local proxy, responded ${res.status}` : `proxy answered HTTP ${res.status}`
      };
    } catch (e) {
      const c = classifyError(e);
      viaProxy = { url, name: direct.name, group: "narrative", route: `proxy ${proxy.host}:${proxy.port}`, probedAt: new Date().toISOString(), ok: false, status: null, latencyMs: Date.now() - t0, kind: c.kind, detail: c.detail };
    }
  }
  const ok = Boolean(direct.ok) || Boolean(viaProxy?.ok);
  return {
    ...direct, ok,
    reachableDirect: Boolean(direct.ok),
    reachableViaProxy: Boolean(viaProxy?.ok),
    answeredOn: direct.ok ? "direct" : (viaProxy?.ok ? viaProxy.route : null),
    status: direct.ok ? direct.status : (viaProxy?.status ?? direct.status),
    latencyMs: direct.ok ? direct.latencyMs : (viaProxy?.latencyMs ?? direct.latencyMs),
    kind: direct.ok ? direct.kind : (viaProxy?.ok ? viaProxy.kind : direct.kind),
    detail: direct.ok ? direct.detail : (viaProxy ? `${direct.kind} direct (${direct.detail}); ${viaProxy.detail}` : direct.detail),
    viaProxy
  };
}

/**
 * Probe every Bitget endpoint on both routes and fold in the committed measurement.
 * Shape-compatible with probeAllBitget() so existing panels keep working.
 */
export async function probeAllBitgetRouted({ timeoutMs = 6000, model = null, proxy = undefined, measurement = undefined } = {}) {
  const p = proxy === undefined ? (detectProxy() || await detectLocalProxy()) : proxy;
  const m = measurement === undefined ? loadBitgetMeasurement() : measurement;

  const targets = [
    { url: BITGET_ENDPOINTS.mcp, name: "Bitget official MCP (US stocks / ETF, read-only)" },
    { url: BITGET_ENDPOINTS.www, name: "Bitget web (www)" },
    { url: BITGET_ENDPOINTS.api, name: "Bitget public REST (api)" }
  ];

  const marketData = [];
  for (const t of targets) {
    const direct = t.url === BITGET_ENDPOINTS.mcp
      ? await probeBitgetMcp(t.url, { timeoutMs })
      : { ...(await probeEndpoint(t.url, t.name, { timeoutMs })), group: "market-data" };
    const viaProxy = p ? await probeViaProxy(t.url, t.name, p, { timeoutMs: Math.max(timeoutMs, 12000) }) : null;
    const ok = Boolean(direct.ok) || Boolean(viaProxy?.ok);
    marketData.push({
      ...direct,
      ok,
      reachableDirect: Boolean(direct.ok),
      reachableViaProxy: Boolean(viaProxy?.ok),
      answeredOn: direct.ok ? "direct" : (viaProxy?.ok ? viaProxy.route : null),
      status: direct.ok ? direct.status : (viaProxy?.status ?? direct.status),
      kind: direct.ok ? direct.kind : (viaProxy?.ok ? viaProxy.kind : direct.kind),
      detail: direct.ok ? direct.detail : (viaProxy ? `${direct.kind} direct (${direct.detail}); ${viaProxy.detail}` : direct.detail),
      viaProxy
    });
  }

  const narrative = await probeLlmGatewayRouted(BITGET_ENDPOINTS.llmGateway, { timeoutMs, model, proxy: p });
  const up = marketData.filter((x) => x.ok);
  const upDirect = marketData.filter((x) => x.reachableDirect);
  const routeNote = p ? `via ${p.host}:${p.port}` : "no local proxy available";

  const mdSummary = up.length
    ? `${up.length}/${marketData.length} Bitget market-data endpoints reachable (${upDirect.length}/${marketData.length} on a direct connection; the rest ${routeNote})`
    : `0/${marketData.length} Bitget market-data endpoints reachable on either route - ${marketData[0].kind}: ${marketData[0].detail}`;

  const narrSummary = narrative.ok
    ? `Bitget hackathon LLM gateway reachable (HTTP ${narrative.status}, ${narrative.latencyMs}ms, ${narrative.answeredOn || "direct"}) - this is the endpoint the narrative layer calls`
    : `Bitget hackathon LLM gateway unreachable on either route - ${narrative.kind}: ${narrative.detail}; the narrative layer falls back to the stored replay cache and then to the deterministic template`;

  const s = m?.summary || null;
  const measSummary = s
    ? `Official Bitget MCP measured ${s.measuredAt}: ${s.server}, ${s.catalogEntries} catalog entries in ${s.catalogCategories} categories, fetched on the ${s.route} route. Cross-checks against this project's own keyless data: ${s.fearGreedExactMatches}/${s.fearGreedOverlappingDates} overlapping crypto fear-&-greed readings identical (mean absolute difference 0 index points); ${s.earningsDatesCompared} earnings-disclosure dates compared against the EDGAR-derived calendar, ${s.earningsWithin3DaysPct}% within three days; ${s.quotesAnswered} live equity quotes and ${s.profilesAnswered} company profiles answered. None of it feeds the retrieval engine, the frozen conformal scale or research/VALIDATION.md.`
    : null;

  const disclosure = up.length
    ? `Bitget market data IS reachable, and the route matters: ${upDirect.length}/${marketData.length} endpoints answer on a direct connection from this machine and ${up.length}/${marketData.length} answer through a local HTTP proxy (${p ? p.host + ":" + p.port : "none"}). ${measSummary || "No measurement has been committed yet - run node scripts/measure-bitget.mjs."} A reviewer on a network without that proxy will get the direct result, so both are reported rather than the more flattering one.`
    : `Two separate Bitget integrations, two separate results. MARKET DATA: all ${marketData.length} Bitget hosts fail on both a direct connection and through the local proxy (${marketData[0].kind}: ${marketData[0].detail}), so AnalogDesk ships no Bitget-sourced market figure; every number comes from the keyless sources in research/DATA-PROVENANCE.md. NARRATIVE: the Bitget-operated hackathon LLM gateway at ${BITGET_ENDPOINTS.llmGateway.replace("/chat/completions", "")} IS reachable${narrative.ok ? ` (HTTP ${narrative.status} on an unauthenticated probe)` : ""}, and it is the endpoint the narrative layer calls${narrative.model ? ` with model ${narrative.model}` : ""}.`;

  return {
    probedAt: new Date().toISOString(),
    reachable: up.length > 0,
    reachableCount: up.length,
    reachableDirectCount: upDirect.length,
    total: marketData.length,
    proxy: p ? { host: p.host, port: p.port, source: p.source } : null,
    endpoints: marketData,
    marketData: {
      reachable: up.length > 0, reachableCount: up.length, reachableDirectCount: upDirect.length, total: marketData.length,
      endpoints: marketData, summary: mdSummary, disclosure: up.length ? null : marketData[0].detail
    },
    narrative: { reachable: narrative.ok, endpoint: narrative, summary: narrSummary, model: narrative.model, transport: narrative.transport },
    measurement: m ? {
      generatedAt: m.generatedAt, route: m.route, server: m.server, summary: s,
      fearGreedCrossCheck: m.fearGreedCrossCheck || null,
      earningsCrossCheck: m.earningsCrossCheck ? (({ perSymbol, ...rest }) => rest)(m.earningsCrossCheck) : null,
      quotes: m.quotes ? (({ perSymbol, ...rest }) => rest)(m.quotes) : null,
      profiles: m.profiles ? (({ perSymbol, ...rest }) => rest)(m.profiles) : null,
      wholeMarketSentiment: m.wholeMarketSentiment || null,
      measuredEmpty: m.measuredEmpty || null
    } : null,
    measurementSummary: measSummary,
    summary: `${mdSummary}; ${narrSummary}${measSummary ? "; " + measSummary : ""}`,
    disclosure
  };
}
