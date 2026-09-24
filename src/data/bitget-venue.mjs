/**
 * AnalogDesk - the Bitget official MCP used as a DATA VENUE, not merely as a reachability probe.
 *
 * WHY THIS EXISTS
 * Until this module the Bitget integration was measured and cross-checked but deliberately not
 * consumed: every figure in the project came from keyless non-Bitget sources. That was the honest
 * state of the network (0/3 direct), but it left the headline 7x24 layer measured on one venue only.
 * Bitget's own MCP does serve Bitget's own order book and candles for the RWA perpetuals it lists on
 * tokenised US equities - AAPL/USDT, AMZN/USDT, BABA/USDT, COIN/USDT and 27 more - and those trade
 * 24/7. So the 7x24 layer can be measured on Bitget data, on Bitget's venue, with no API key.
 *
 * WHAT IT IS NOT
 * A perpetual is not a spot wrapper. It has funding, no redemption, and a basis that can diverge from
 * the underlying, so this layer is labelled "Bitget RWA perpetual" everywhere it is rendered and the
 * Gate.io spot-wrapper measurement is kept next to it as an independent second venue on a different
 * instrument class. Neither feeds the retrieval engine, the frozen conformal scale or VALIDATION.md.
 *
 * MEASURED TRAPS, all of which are recorded in the output file rather than worked around silently:
 *  - the candle parameter is `interval`. `granularity` is accepted and IGNORED, and a caller who sends
 *    granularity=1h receives DAILY bars. Every fetch here asserts the echoed `interval` matches the
 *    request and fails the instrument if it does not.
 *  - the default `exchange` is `binance`. Nothing here is Bitget data unless `exchange:"bitget"` is
 *    pinned, so it is pinned on every call and the echoed `exchange` is asserted.
 *  - `crypto_market` ignores `exchange` and returns the aggregator's own listing (measured: 500 rows,
 *    every one exchange=binance, capped at 500 with `limit` ignored). It is therefore used only as a
 *    cross-reference for which symbols are flagged RWA, never as evidence that Bitget lists them.
 *    Whether Bitget lists a symbol is decided by calling Bitget and reading the answer.
 *  - `startTime`/`endTime` are ignored, so there is no pagination: one call returns at most ~1000 bars.
 *    1000 hourly bars is ~41 days, more than the 720 (30 days) this layer uses.
 *  - HTTP 204 with an empty body is a real answer ("listed in the catalog, no data upstream"), not a
 *    transport failure, and is never retried into something else.
 *
 * Node-only: this imports the CONNECT tunnel in proxy.mjs, so it must never enter the browser graph.
 */

import { detectProxy, detectLocalProxy, proxyRequest, parseSSE } from "./proxy.mjs";
import { BITGET_ENDPOINTS, classifyError } from "./bitget.mjs";

export const MCP_URL = BITGET_ENDPOINTS.mcp;
export const MCP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
  "User-Agent": "AnalogDesk Bitget venue measurement"
};

export const BITGET_VENUE = {
  name: "Bitget official MCP (agent.bitget.com/mcp)",
  exchange: "bitget",
  quote: "USDT",
  instrumentClass: "RWA perpetual futures on tokenised US equities, trading 24/7",
  transport: "MCP JSON-RPC 2.0 over streamable HTTP, through a local CONNECT proxy",
  keyRequired: false,
  productType: "perpetual"
};

/** The measured behaviour of the upstream, disclosed so a re-run cannot quietly rely on a fluke. */
export const BITGET_MCP_TRAPS = [
  "the candle parameter is `interval`; `granularity` is accepted and ignored and returns DAILY bars, so every fetch asserts the echoed interval",
  "the default `exchange` is binance; `exchange:bitget` is pinned on every call and the echoed exchange is asserted",
  "`crypto_market` ignores `exchange` and caps at 500 rows with `limit` ignored, so it is a cross-reference only and never evidence that Bitget lists a symbol",
  "`startTime`/`endTime` are ignored, so there is no pagination; one call returns at most ~1000 bars (~41 hourly days)",
  "HTTP 204 with an empty body is a real answer, not a transport failure, and is never retried"
];

export const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

/**
 * Open an MCP session through the local proxy. Never throws: a venue that cannot be reached returns a
 * degradation object, and the caller writes a disclosure instead of a number.
 */
export async function openBitgetMcp({ proxy = undefined, timeoutMs = 40000 } = {}) {
  const p = proxy === undefined ? (detectProxy() || await detectLocalProxy()) : proxy;
  if (!p) {
    return {
      ok: false, route: null, proxy: null,
      degradation: {
        degraded: true, kind: "no-proxy",
        detail: "no local HTTP proxy was found (checked HTTPS_PROXY/HTTP_PROXY/ALL_PROXY and the usual local ports). Every *.bitget.com host resets at the TCP layer on a direct connection from the network this was built on, so the Bitget venue could not be reached and nothing was measured. No figure in this file is estimated."
      }
    };
  }
  const route = `proxy ${p.host}:${p.port}`;
  const t0 = Date.now();
  try {
    const init = await proxyRequest(MCP_URL, {
      proxy: p, method: "POST", headers: MCP_HEADERS, timeoutMs,
      body: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "AnalogDesk", version: "1.0.0" } } }
    });
    const sid = init.headers["mcp-session-id"];
    if (!sid) {
      return { ok: false, route, proxy: p, degradation: { degraded: true, kind: "no-session", detail: `initialize returned HTTP ${init.status} with no mcp-session-id header` } };
    }
    const headers = Object.assign({}, MCP_HEADERS, { "mcp-session-id": sid });
    await proxyRequest(MCP_URL, { proxy: p, method: "POST", headers, body: { jsonrpc: "2.0", method: "notifications/initialized" }, timeoutMs: 20000 }).catch(() => {});
    const info = parseSSE(init.body, 1)?.result || {};
    let counter = 100;
    const rpc = async (method, params, ms = 90000) => {
      const id = ++counter;
      const res = await proxyRequest(MCP_URL, { proxy: p, method: "POST", headers, body: { jsonrpc: "2.0", id, method, params }, timeoutMs: ms });
      return parseSSE(res.body, id);
    };
    return {
      ok: true, route, proxy: p, sid, initMs: Date.now() - t0,
      serverInfo: info.serverInfo || null, protocolVersion: info.protocolVersion || null,
      rpc,
      /** do_query wrapper. `data.results` is an ARRAY for klines and an OBJECT for ticker/book. */
      async query(entryId, params, { timeoutMs: ms = 90000, attempts = 2 } = {}) {
        let last = null;
        for (let a = 0; a < attempts; a++) {
          last = await queryOnce(rpc, entryId, params, ms);
          // A reset or a timeout on a route that otherwise works is transient. A 204, a 400 or a 422 is
          // a real answer from the upstream and must not be retried into a different result.
          if (last.ok || last.empty || (last.errorText && !/connection-reset|timed out|timeout/i.test(last.errorText))) return last;
          if (a + 1 < attempts) await sleep(600);
        }
        return last;
      }
    };
  } catch (e) {
    const c = classifyError(e);
    return { ok: false, route, proxy: p, degradation: { degraded: true, kind: c.kind, detail: c.detail } };
  }
}

async function queryOnce(rpc, entryId, params, timeoutMs) {
  const t0 = Date.now();
  try {
    const j = await rpc("tools/call", { name: "do_query", arguments: { entry_id: entryId, params } }, timeoutMs);
    const text = (j?.result?.content || []).map((c) => c?.text || "").join("");
    let payload = null;
    try { payload = JSON.parse(text); } catch {}
    const results = payload?.data?.results;
    return {
      entryId, params, ms: Date.now() - t0, isError: !!j?.result?.isError,
      status: payload?.status_code ?? null,
      ok: payload?.success === true && payload?.status_code === 200 && results != null && results !== "",
      empty: payload?.success === true && payload?.status_code === 204,
      errorText: typeof payload?.data?.detail === "string" ? payload.data.detail
        : (j?.error?.message || (payload?.success === false ? JSON.stringify(payload?.data ?? payload).slice(0, 200) : null)),
      provider: payload?.provider || null,
      array: Array.isArray(results) ? results : null,
      object: results && !Array.isArray(results) && typeof results === "object" ? results : null,
      raw: results == null || results === "" ? String(text).slice(0, 300) : null
    };
  } catch (e) {
    const c = classifyError(e);
    return { entryId, params, ms: Date.now() - t0, isError: true, status: null, ok: false, empty: false, errorText: `${c.kind}: ${c.detail}`, provider: null, array: null, object: null, raw: null };
  }
}

/**
 * Candle rows -> the normalised hourly shape the shared closed-session module consumes.
 * Returns `intervalEchoed` / `exchangeEchoed` and a `trap` flag, because a silent fallback to daily
 * bars would turn a 7x24 measurement into a 5x24 one and nobody would notice.
 */
export function normaliseCandles(res, { wantInterval, wantExchange = "bitget" } = {}) {
  const arr = res?.array || [];
  const rows = arr
    .map((k) => ({
      t: Number(k.time) > 1e12 ? Math.round(Number(k.time) / 1000) : Math.round(Number(k.time)),
      c: Number(k.close), hi: Number(k.high), lo: Number(k.low), o: Number(k.open), qv: Number(k.volume),
      interval: k.interval ?? null, exchange: k.exchange ?? null
    }))
    .filter((x) => Number.isFinite(x.t) && Number.isFinite(x.c) && x.c > 0)
    .sort((a, b) => a.t - b.t);
  const intervals = [...new Set(rows.map((x) => x.interval).filter(Boolean))];
  const exchanges = [...new Set(rows.map((x) => x.exchange).filter(Boolean))];
  const intervalEchoed = intervals.length === 1 ? intervals[0] : (intervals[0] ?? null);
  const exchangeEchoed = exchanges.length === 1 ? exchanges[0] : (exchanges[0] ?? null);
  const trap = (wantInterval && intervalEchoed && intervalEchoed !== wantInterval) || (wantExchange && exchangeEchoed && exchangeEchoed !== wantExchange);
  return { rows, intervalEchoed, exchangeEchoed, intervals, exchanges, trap: Boolean(trap), n: rows.length };
}

/** Spread and resting depth from a Bitget order book. `bids`/`asks` are [price, amount] pairs. */
export function bitgetMicrostructure(book, { midOverride = null, depthBps = 50 } = {}) {
  const bids = (book?.bids || []).map((x) => [Number(x[0]), Number(x[1])]).filter((x) => Number.isFinite(x[0]) && x[0] > 0 && Number.isFinite(x[1]));
  const asks = (book?.asks || []).map((x) => [Number(x[0]), Number(x[1])]).filter((x) => Number.isFinite(x[0]) && x[0] > 0 && Number.isFinite(x[1]));
  if (!bids.length || !asks.length) return null;
  const bestBid = Math.max(...bids.map((x) => x[0]));
  const bestAsk = Math.min(...asks.map((x) => x[0]));
  const mid = midOverride > 0 ? midOverride : (bestBid + bestAsk) / 2;
  if (!(mid > 0)) return null;
  const within = (side, px) => side.filter((x) => Math.abs(x[0] / mid - 1) * 1e4 <= depthBps).reduce((s, x) => s + x[0] * x[1], 0);
  return {
    bestBid, bestAsk, mid,
    spreadBps: Math.round(((bestAsk - bestBid) / mid) * 1e4 * 100) / 100,
    depthWithin50BpsUsdt: Math.round((within(bids) + within(asks)) * 100) / 100,
    levels: { bids: bids.length, asks: asks.length },
    snapshotAt: book?.timestamp || new Date().toISOString()
  };
}

/** The catalog cross-reference: which symbols the aggregator flags as RWA. Never proof of a listing. */
export async function bitgetCatalog(mcp, { category = null } = {}) {
  const res = await mcp.query("crypto_market", category ? { category } : {});
  const rows = res?.array || [];
  return {
    ok: res.ok, status: res.status, rows, count: rows.length,
    rwa: rows.filter((x) => x.is_rwa === true).map((x) => x.symbol),
    exchangesReported: [...new Set(rows.map((x) => x.exchange).filter(Boolean))],
    note: "crypto_market ignores the exchange parameter and caps at 500 rows; used only to cross-reference which symbols are flagged RWA, never as evidence that Bitget lists them"
  };
}
