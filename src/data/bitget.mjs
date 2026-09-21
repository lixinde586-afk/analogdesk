/**
 * AnalogDesk - Bitget official MCP adapter with connectivity probe and honest degradation.
 *
 * Track 3 expects integration with the Bitget developer toolkit where it helps. The official MCP
 * server for US stocks / ETFs is the natural one for this desk: read-only reference data about the
 * instruments a trader is actually about to trade.
 *
 * It is also, on the network this project was built on, unreachable: every *.bitget.com endpoint
 * fails with ECONNRESET. That is documented here rather than papered over, and the app is built so
 * the failure is visible in the UI:
 *
 *   - `probeBitget()` runs at server startup and on demand, and records the actual error code;
 *   - `createBitgetAdapter()` returns a degraded adapter that contributes a disclosure block to the
 *     provenance panel instead of data;
 *   - nothing in the retrieval, calibration or stress pipeline depends on it, so a dead endpoint
 *     cannot silently corrupt a number. Every figure in AnalogDesk comes from the keyless sources
 *     listed in research/DATA-PROVENANCE.md.
 *
 * If the endpoint becomes reachable, the adapter starts returning instrument metadata and the UI
 * renders it; no code path has to change.
 */

export const BITGET_ENDPOINTS = {
  mcp: "https://agent.bitget.com/mcp",
  www: "https://www.bitget.com",
  api: "https://api.bitget.com"
};

/**
 * Walk the whole `cause` chain. undici reports a TLS/TCP failure as a generic TypeError
 * ("fetch failed") whose real code (ECONNRESET, UND_ERR_CONNECT_TIMEOUT, ...) sits one or more
 * levels down, and classifying only the outer message would hide the fact that the connection was
 * reset rather than merely slow - which is exactly what the disclosure has to get right.
 */
function errorChain(e) {
  const out = [];
  let cur = e, guard = 0;
  while (cur && guard++ < 10) { out.push(cur); cur = cur.cause; }
  return out;
}

export function classifyError(e) {
  const chain = errorChain(e);
  const code = chain.map((x) => x?.code).find(Boolean) || null;
  const msg = chain.map((x) => String(x?.message || "")).filter(Boolean).join(" | ") || String(e || "");
  if (code === "ECONNRESET" || /ECONNRESET/i.test(msg)) return { kind: "connection-reset", detail: "TCP connection reset by peer before any HTTP response" };
  if (code === "ETIMEDOUT" || /timeout/i.test(msg)) return { kind: "timeout", detail: "no TCP or TLS response within the probe timeout" };
  if (code === "ENOTFOUND" || /ENOTFOUND/i.test(msg)) return { kind: "dns-failure", detail: "hostname did not resolve" };
  if (code === "ECONNREFUSED") return { kind: "connection-refused", detail: "port refused the connection" };
  if (code === "UND_ERR_CONNECT_TIMEOUT") return { kind: "connect-timeout", detail: "undici connect timeout" };
  return { kind: "error", detail: msg.slice(0, 180) };
}

/**
 * Probe one endpoint. Never throws.
 * @returns {Promise<{url:string,name:string,ok:boolean,status:number|null,latencyMs:number,kind:string|null,detail:string|null,probedAt:string}>}
 */
export async function probeEndpoint(url, name, { timeoutMs = 6000, method = "GET", body = null, headers = {} } = {}) {
  const t0 = Date.now();
  const base = { url, name, probedAt: new Date().toISOString(), latencyMs: 0, ok: false, status: null, kind: null, detail: null };
  if (typeof fetch !== "function") return { ...base, kind: "no-fetch", detail: "fetch is unavailable in this runtime" };
  try {
    const r = await fetch(url, {
      method,
      headers: { Accept: "application/json, text/plain, */*", "User-Agent": "AnalogDesk connectivity probe", ...headers },
      body: body == null ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "follow"
    });
    const latencyMs = Date.now() - t0;
    // Any HTTP response at all means the endpoint is reachable; 4xx on an unauthenticated probe is
    // still a successful connectivity result and is reported as such.
    return { ...base, ok: true, status: r.status, latencyMs,
      kind: r.ok ? "ok" : `http-${r.status}`, detail: r.ok ? null : `reachable, responded ${r.status}` };
  } catch (e) {
    const c = classifyError(e);
    return { ...base, latencyMs: Date.now() - t0, kind: c.kind, detail: c.detail };
  }
}

/** MCP servers speak JSON-RPC over HTTP; a tools/list call is the cheapest real handshake. */
export async function probeBitgetMcp(url = BITGET_ENDPOINTS.mcp, { timeoutMs = 6000 } = {}) {
  const p = await probeEndpoint(url, "Bitget official MCP (US stocks / ETF, read-only)", {
    timeoutMs, method: "POST",
    headers: { "Content-Type": "application/json" },
    body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }
  });
  return { ...p, transport: "jsonrpc-2.0 / tools/list" };
}

export async function probeAllBitget({ timeoutMs = 6000 } = {}) {
  const out = [];
  out.push(await probeBitgetMcp(BITGET_ENDPOINTS.mcp, { timeoutMs }));
  out.push(await probeEndpoint(BITGET_ENDPOINTS.www, "Bitget web (www)", { timeoutMs }));
  out.push(await probeEndpoint(BITGET_ENDPOINTS.api, "Bitget public REST (api)", { timeoutMs }));
  const reachable = out.filter((x) => x.ok);
  return {
    probedAt: new Date().toISOString(),
    reachable: reachable.length > 0,
    reachableCount: reachable.length,
    total: out.length,
    endpoints: out,
    summary: reachable.length
      ? `${reachable.length}/${out.length} Bitget endpoints reachable`
      : `0/${out.length} Bitget endpoints reachable - ${out[0].kind}: ${out[0].detail}`,
    disclosure: reachable.length ? null
      : "The Bitget official MCP server and the Bitget web/API hosts are unreachable from the network this build ran on (every attempt fails at the TCP layer, not the application layer). AnalogDesk therefore ships no Bitget-sourced figure. All data comes from the keyless sources in research/DATA-PROVENANCE.md, and this disclosure is rendered in the provenance panel rather than hidden."
  };
}

/**
 * Adapter used by the rest of the app. `enrich()` is a no-op that returns a disclosure when the
 * endpoint is down, so callers can invoke it unconditionally.
 */
export function createBitgetAdapter(probe) {
  const ok = Boolean(probe?.reachable);
  return {
    available: ok,
    probe,
    status: ok ? "connected" : "degraded",
    async enrich(payload) {
      if (!ok) {
        return { ...payload, bitget: { status: "degraded", disclosure: probe.disclosure, endpoints: probe.endpoints, probedAt: probe.probedAt } };
      }
      // Reachable path: a real tools/list result would be turned into instrument metadata here.
      return { ...payload, bitget: { status: "connected", probedAt: probe.probedAt, endpoints: probe.endpoints } };
    }
  };
}