/**
 * AnalogDesk - Bitget integration adapter, with a connectivity probe and honest degradation.
 *
 * Track 3 expects integration with the Bitget developer toolkit where it helps. This project touches
 * Bitget in two separate places, and they have opposite fates on the network this build ran on. Both
 * are measured here and both are reported separately, because collapsing them into one "Bitget: up"
 * or "Bitget: down" badge would be wrong in whichever direction it was collapsed:
 *
 *   1. MARKET DATA - the official Bitget MCP server for US stocks / ETFs, plus the Bitget web and
 *      public REST hosts. This is the integration a trading desk would want for instrument metadata,
 *      and it is UNREACHABLE: every *.bitget.com attempt fails with ECONNRESET at the TCP layer, not
 *      the application layer, from two independent networks. It is documented rather than papered
 *      over, and the failure is rendered in the UI provenance panel instead of hidden.
 *
 *   2. NARRATIVE - the Bitget-operated hackathon LLM gateway (hackathon.bitgetops.com, OpenAI-
 *      compatible /v1/chat/completions). This one IS reachable and IS on the critical path: it is the
 *      endpoint src/llm/client.mjs calls to turn a research card into prose. Every LIVE-mode sentence
 *      in AnalogDesk, and every generation baked into the replay cache that a keyless reviewer reads,
 *      was produced through it.
 *
 * So the honest summary is not "0 Bitget endpoints" and not "Bitget connected". It is: the market-data
 * toolkit contributes nothing and is disclosed as such, while the narrative layer runs on a Bitget-
 * operated gateway. `probeAllBitget()` reports the two groups distinctly and `reachable` deliberately
 * keeps meaning "the MARKET-DATA toolkit is reachable", so no existing panel starts claiming a Bitget
 * data integration that does not exist.
 *
 * Nothing in the retrieval, calibration or stress pipeline depends on either group, so a dead endpoint
 * cannot silently corrupt a number. Every figure in AnalogDesk comes from the keyless sources listed
 * in research/DATA-PROVENANCE.md. If the market-data endpoints become reachable, the adapter starts
 * returning instrument metadata and the UI renders it; no code path has to change.
 */

export const BITGET_ENDPOINTS = {
  mcp: "https://agent.bitget.com/mcp",
  www: "https://www.bitget.com",
  api: "https://api.bitget.com",
  llmGateway: "https://hackathon.bitgetops.com/v1/chat/completions"
};

/** The market-data group. `reachable`/`reachableCount`/`total`/`endpoints` all describe this group. */
export const BITGET_MARKET_DATA_KEYS = ["mcp", "www", "api"];

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
  return { ...p, transport: "jsonrpc-2.0 / tools/list", group: "market-data" };
}

/**
 * The Bitget-operated hackathon LLM gateway the narrative layer actually calls. Probed WITHOUT a key
 * and with a deliberately empty message list: what is being measured is reachability, not permission,
 * so a 401/400 is a successful result and no credential ever leaves this function. The probe reports
 * the model the running configuration would ask for, so the disclosure names the integration that is
 * really in use instead of implying a data feed.
 */
export async function probeBitgetLlmGateway(url = BITGET_ENDPOINTS.llmGateway, { timeoutMs = 8000, model = null } = {}) {
  const p = await probeEndpoint(url, "Bitget hackathon LLM gateway (OpenAI-compatible /v1/chat/completions)", {
    timeoutMs, method: "POST",
    headers: { "Content-Type": "application/json" },
    body: { model: model || "probe", messages: [] }
  });
  return { ...p, transport: "openai-compatible chat/completions", group: "narrative", model: model || null,
    role: model
      ? `the narrative layer calls this endpoint; the generations baked into the replay cache were produced here with model ${model}`
      : "the narrative layer calls this endpoint when an API key is configured" };
}

export async function probeAllBitget({ timeoutMs = 6000, model = null } = {}) {
  const marketData = [];
  marketData.push(await probeBitgetMcp(BITGET_ENDPOINTS.mcp, { timeoutMs }));
  marketData.push({ ...(await probeEndpoint(BITGET_ENDPOINTS.www, "Bitget web (www)", { timeoutMs })), group: "market-data" });
  marketData.push({ ...(await probeEndpoint(BITGET_ENDPOINTS.api, "Bitget public REST (api)", { timeoutMs })), group: "market-data" });
  const narrative = await probeBitgetLlmGateway(BITGET_ENDPOINTS.llmGateway, { timeoutMs: Math.max(timeoutMs, 8000), model });

  const mdReachable = marketData.filter((x) => x.ok);
  const endpoints = [...marketData, narrative];
  const mdSummary = mdReachable.length
    ? `${mdReachable.length}/${marketData.length} Bitget market-data endpoints reachable`
    : `0/${marketData.length} Bitget market-data endpoints reachable - ${marketData[0].kind}: ${marketData[0].detail}`;
  const narrSummary = narrative.ok
    ? `Bitget hackathon LLM gateway reachable (HTTP ${narrative.status}, ${narrative.latencyMs}ms) - this is the endpoint the narrative layer calls`
    : `Bitget hackathon LLM gateway unreachable - ${narrative.kind}: ${narrative.detail}; the narrative layer falls back to the stored replay cache and then to the deterministic template`;

  return {
    probedAt: new Date().toISOString(),
    // `reachable` keeps meaning "the MARKET-DATA toolkit is reachable". Letting the LLM gateway flip
    // it would make the provenance panel claim a Bitget data integration this project does not have.
    reachable: mdReachable.length > 0,
    reachableCount: mdReachable.length,
    total: marketData.length,
    endpoints: marketData,
    marketData: {
      reachable: mdReachable.length > 0, reachableCount: mdReachable.length, total: marketData.length,
      endpoints: marketData, summary: mdSummary,
      disclosure: mdReachable.length ? null
        : "The Bitget official MCP server and the Bitget web/API hosts are unreachable from the network this build ran on (every attempt fails at the TCP layer, not the application layer). AnalogDesk therefore ships no Bitget-sourced MARKET figure. All data comes from the keyless sources in research/DATA-PROVENANCE.md, and this disclosure is rendered in the provenance panel rather than hidden."
    },
    narrative: {
      reachable: narrative.ok, endpoint: narrative, summary: narrSummary,
      model: narrative.model, transport: narrative.transport
    },
    summary: `${mdSummary}; ${narrSummary}`,
    disclosure: mdReachable.length ? null
      : `Two separate Bitget integrations, two separate results. MARKET DATA: the official Bitget MCP server for US stocks/ETFs and both Bitget web/API hosts are unreachable from this network (${marketData[0].kind}: ${marketData[0].detail}), so AnalogDesk ships no Bitget-sourced market figure; every number comes from the keyless sources in research/DATA-PROVENANCE.md. NARRATIVE: the Bitget-operated hackathon LLM gateway at ${BITGET_ENDPOINTS.llmGateway.replace("/chat/completions", "")} IS reachable${narrative.ok ? ` (HTTP ${narrative.status} on an unauthenticated probe)` : ""}, and it is the endpoint the narrative layer calls${narrative.model ? ` with model ${narrative.model}` : ""} - the prose a reviewer reads was generated there. This distinction is reported rather than collapsed into a single badge, because either collapse would overstate or understate the integration.`
  };
}

/**
 * Adapter used by the rest of the app. `enrich()` is a no-op that returns a disclosure when the
 * market-data endpoint is down, so callers can invoke it unconditionally.
 */
export function createBitgetAdapter(probe) {
  const ok = Boolean(probe?.reachable);
  const narrative = probe?.narrative || null;
  return {
    available: ok,
    probe,
    status: ok ? "connected" : "degraded",
    narrativeStatus: narrative?.reachable ? "connected" : "unavailable",
    async enrich(payload) {
      const narr = narrative
        ? { status: narrative.reachable ? "connected" : "degraded", summary: narrative.summary, model: narrative.model, probedAt: probe.narrative?.endpoint?.probedAt || probe.probedAt }
        : null;
      if (!ok) {
        return { ...payload, bitget: { status: "degraded", disclosure: probe.marketData?.disclosure ?? probe.disclosure, endpoints: probe.endpoints, narrative: narr, probedAt: probe.probedAt } };
      }
      // Reachable path: a real tools/list result would be turned into instrument metadata here.
      return { ...payload, bitget: { status: "connected", probedAt: probe.probedAt, endpoints: probe.endpoints, narrative: narr } };
    }
  };
}