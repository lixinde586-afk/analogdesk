/**
 * AnalogDesk - market signals layer (news / sentiment / macro).
 *
 * The analog card answers "in the episodes that looked like this, what happened next". It did not
 * answer "why is the market like this right now" - the unstructured backdrop a trader actually reads
 * before sizing: the news cycle, where sentiment and positioning stand, and the macro regime. This
 * module closes that layer so the information set matches Track 3's market-context requirement.
 *
 * Two sources, and which one answered is recorded rather than left implicit:
 *   1. bitget-signal's public, key-less market-data MCP (the same endpoint the @bitget-ai/bitget-signal
 *      installer registers): news_feed / tradfi_news, sentiment_index / derivatives_sentiment,
 *      rates_yields / macro_indicators.
 *   2. A primary-source fallback for anything that MCP did not return: the same public RSS feeds it
 *      aggregates, the alternative.me sentiment index, and - in the card view - the FRED-derived
 *      macro features the engine already measured. Nothing is estimated to fill a hole; a hole is a
 *      recorded gap.
 *
 * Isomorphic and dependency-free (global fetch only): scripts/collect-signals.mjs runs this in Node
 * and writes data-cache/signals.json, the bundler ships it to the browser, and desk.mjs projects it
 * onto each card. It deliberately imports nothing so it stays inside the browser graph.
 */

export const SIGNAL_MCP_URL = "https://datahub.noxiaohao.com/mcp";
export const SIGNAL_SCHEMA = "analogdesk.market-signals/1";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------ MCP over HTTP ----------------------------- */

function parseSSE(text) {
  const out = [];
  for (const block of String(text).split(/\r?\n\r?\n/)) {
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("data:")) {
        const d = line.slice(5).trim();
        if (d) { try { out.push(JSON.parse(d)); } catch { /* keep */ } }
      }
    }
  }
  return out;
}

let _rpcId = 0;
async function mcpOpen() {
  let sid = null;
  const rpc = async (method, params, wantResult = true) => {
    const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
    if (sid) headers["Mcp-Session-Id"] = sid;
    const payload = { jsonrpc: "2.0", method, params: params || {} };
    if (wantResult) payload.id = ++_rpcId;
    const r = await fetch(SIGNAL_MCP_URL, { method: "POST", headers, body: JSON.stringify(payload) });
    sid = sid || r.headers.get("mcp-session-id");
    const t = await r.text();
    if (!t.trim()) return null;
    const msgs = parseSSE(t);
    return msgs.length ? msgs[msgs.length - 1] : null;
  };
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "analogdesk", version: "1.0" } });
  await rpc("notifications/initialized", {}, false);
  return {
    sid,
    async call(name, args) {
      const res = await rpc("tools/call", { name, arguments: args || {} });
      const c = res?.result?.content || [];
      return c.map((x) => x.text || "").join("\n");
    }
  };
}

const safeJson = (t) => { try { return JSON.parse(t); } catch { return null; } };
const hasError = (o) => !o ||
  (typeof o?.error === "string" && o.error.trim() !== "") ||
  (o && typeof o === "object" && Object.values(o).some((v) => v && typeof v === "object" && typeof v.error === "string" && v.error.trim()));

/* ----------------------------- RSS primary feed --------------------------- */

/** Public feeds used both as the MCP's own upstream and as the keyless fallback, in display order. */
export const FALLBACK_FEEDS = [
  ["CoinTelegraph", "https://cointelegraph.com/rss"],
  ["Decrypt", "https://decrypt.co/feed"],
  ["The Defiant", "https://thedefiant.io/api/feed"],
  ["Bitcoinist", "https://bitcoinist.com/feed/"],
  ["U.Today", "https://u.today/rss"],
  ["CNBC Markets", "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114"]
];

function decodeCdata(s) {
  return String(s || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").trim();
}

function parseRss(xml, source) {
  const out = [];
  for (const block of String(xml).split("<item>").slice(1)) {
    const titleM = block.match(/<title[^>]*>([\s\S]*?)<\/title>/);
    const linkM = block.match(/<link[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/) || block.match(/<link[^>]*\shref=["']([^"']+)["']/);
    const dateM = block.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/) || block.match(/<dc:date[^>]*>([\s\S]*?)<\/dc:date>/);
    const title = titleM ? decodeCdata(titleM[1]) : "";
    if (!title) continue;
    const ts = dateM ? Date.parse(dateM[1]) : NaN;
    out.push({ title, source, link: linkM ? decodeCdata(linkM[1]) : "", publishedAt: Number.isFinite(ts) ? new Date(ts).toISOString() : null });
  }
  return out;
}

async function fetchFeed([source, url]) {
  const r = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(20000), headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return parseRss(await r.text(), source);
}

/** alternative.me current Fear & Greed, 0..100 (keyless). */
async function fetchFearGreed100() {
  const r = await fetch("https://api.alternative.me/fng/?limit=1", { signal: AbortSignal.timeout(20000), headers: { "User-Agent": UA } });
  const j = await r.json();
  const v = Number(j?.data?.[0]?.value);
  return Number.isFinite(v) ? v : null;
}

export function sentimentBand(v100) {
  if (v100 == null || !Number.isFinite(v100)) return "unknown";
  if (v100 <= 25) return "Extreme Fear";
  if (v100 <= 45) return "Fear";
  if (v100 <= 55) return "Neutral";
  if (v100 <= 75) return "Greed";
  return "Extreme Greed";
}

/* ------------------------------ collection -------------------------------- */

const NEWS_FEEDS_MCP = "cointelegraph,coindesk,decrypt,blockworks,cnbc";

async function collectViaMcp() {
  const out = { news: [], sentiment: {}, macro: [], newsOk: false, sentimentOk: false, macroOk: false };
  let mcp;
  try { mcp = await mcpOpen(); } catch (e) { return { ...out, reachable: false, error: e.message }; }

  // News: news_feed returns one block per feed; count real items.
  try {
    const nf = safeJson(await mcp.call("news_feed", { action: "latest", feeds: NEWS_FEEDS_MCP, limit: 5 }));
    if (Array.isArray(nf)) {
      for (const f of nf) for (const it of f.items || []) out.news.push({ title: it.title, source: f.feed, link: it.link || it.url || "", publishedAt: it.publishedAt || it.date || null });
    }
    const tn = safeJson(await mcp.call("tradfi_news", { action: "crypto_news", limit: 8 }));
    if (Array.isArray(tn)) for (const it of tn) out.news.push({ title: it.title, source: "tradfi", link: it.link || "", publishedAt: it.publishedAt || null });
    out.newsOk = out.news.length > 0;
  } catch { /* news gap */ }

  // Sentiment.
  try {
    const si = safeJson(await mcp.call("sentiment_index", { action: "current" }));
    const v = si && (si.value ?? si.fear_greed ?? si.index ?? null);
    // A real Fear & Greed reading sits roughly in 5..95; an exact 0 is this endpoint's zero-value
    // placeholder for "no data" (observed alongside macro levels that were all 0), not Extreme Fear.
    if (Number.isFinite(Number(v)) && Number(v) > 0 && Number(v) <= 100) out.sentiment.fearGreed = Number(v);
    const ls = safeJson(await mcp.call("derivatives_sentiment", { action: "long_short", symbol: "BTCUSDT", period: "4h" }));
    if (ls && !hasError(ls)) out.sentiment.longShort = ls;
    const tr = safeJson(await mcp.call("derivatives_sentiment", { action: "taker_ratio", symbol: "BTCUSDT", period: "4h" }));
    if (tr && !hasError(tr)) out.sentiment.takerRatio = tr;
    out.sentimentOk = out.sentiment.fearGreed != null;
  } catch { /* sentiment gap */ }

  // Macro: rates dashboard + indicator snapshot; keep only subfields carrying a finite value.
  try {
    const ry = safeJson(await mcp.call("rates_yields", { action: "rates_snapshot" }));
    if (ry && !hasError(ry)) for (const [k, v] of Object.entries(ry)) {
      const x = v && typeof v === "object" ? (v.value ?? v.rate ?? null) : v;
      // An exact 0 for a rate/level is the placeholder shape (the whole snapshot came back as zeros),
      // not a reading - unemployment, fed funds, CPI are never literally 0.
      if (Number.isFinite(Number(x)) && Number(x) !== 0) out.macro.push({ key: k, value: Number(x) });
    }
    const mi = safeJson(await mcp.call("macro_indicators", { action: "multi_indicator", indicators: "cpi,core_pce,nonfarm_payrolls,gdp_growth,unemployment" }));
    if (mi && !hasError(mi)) for (const [k, v] of Object.entries(mi)) {
      const x = v && typeof v === "object" ? (v.value ?? v.latest ?? null) : v;
      if (Number.isFinite(Number(x)) && Number(x) !== 0) out.macro.push({ key: k, value: Number(x) });
    }
    out.macroOk = out.macro.length > 0;
  } catch { /* macro gap */ }

  return { ...out, reachable: true };
}

function dedupeAndRank(items, cap = 30) {
  const seen = new Set();
  const ranked = items.map((it, i) => ({ ...it, _i: i, _t: it.publishedAt ? Date.parse(it.publishedAt) : -Infinity }))
    .filter((it) => {
      const k = it.title.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, " ").trim();
      if (seen.has(k)) return false; seen.add(k); return true;
    })
    .sort((a, b) => (b._t - a._t) || (a._i - b._i));
  return ranked.slice(0, cap).map(({ title, source, link, publishedAt }) => ({ title, source, link, publishedAt }));
}

/** Build the full market-signals snapshot: MCP first, primary-source fallback for every gap. */
export async function collectSignals() {
  const fetchedAt = new Date().toISOString();
  const mcp = await collectViaMcp();
  const gaps = [];

  let newsItems = mcp.newsOk ? mcp.news : [];
  let newsSource = mcp.newsOk ? "bitget-signal MCP" : null;
  if (!mcp.newsOk) {
    for (const feed of FALLBACK_FEEDS) {
      try { newsItems = newsItems.concat(await fetchFeed(feed)); } catch { /* one feed down */ }
      await sleep(120);
    }
    if (newsItems.length) newsSource = "public RSS feeds (signal MCP returned no news)";
    else gaps.push("news: neither the signal MCP nor the public RSS feeds returned headlines on this build");
  }

  let sentiment = mcp.sentimentOk ? mcp.sentiment : {};
  let sentimentSource = mcp.sentimentOk ? "bitget-signal MCP" : null;
  if (!mcp.sentimentOk) {
    const fg = await fetchFearGreed100().catch(() => null);
    if (fg != null) { sentiment = { fearGreed: fg }; sentimentSource = "alternative.me (signal MCP returned no sentiment)"; }
    else gaps.push("sentiment: no Fear & Greed reading from either source");
    gaps.push("derivatives positioning (long/short, taker ratio): the signal MCP returned no data and no keyless fallback exists");
  }

  let macroItems = mcp.macroOk ? mcp.macro : [];
  let macroSource = mcp.macroOk ? "bitget-signal MCP" : null;
  if (!mcp.macroOk) gaps.push("macro levels: the signal MCP returned none; this card shows FRED-derived macro features instead");

  return {
    schema: SIGNAL_SCHEMA,
    fetchedAt,
    mcp: { url: SIGNAL_MCP_URL, reachable: mcp.reachable !== false, returnedNews: mcp.newsOk, returnedSentiment: mcp.sentimentOk, returnedMacro: mcp.macroOk },
    news: { source: newsSource, items: dedupeAndRank(newsItems) },
    sentiment: { source: sentimentSource, fearGreed: sentiment.fearGreed ?? null, band: sentimentBand(sentiment.fearGreed), longShort: sentiment.longShort || null, takerRatio: sentiment.takerRatio || null },
    macro: { source: macroSource, items: macroItems },
    gaps
  };
}

/* --------------------------- card view projection ------------------------- */

/** Macro features carried on every card, used as the traceable fallback when the MCP gives no levels. */
const MACRO_FEATURE_VIEW = [
  ["vix", "VIX level"],
  ["slope", "10y-2y Treasury slope"],
  ["dRate90", "Fed funds target change, 90d (bp)"],
  ["beiChg20", "10y breakeven change, 20d (bp)"],
  ["usdChg20", "Trade-weighted USD change, 20d (%)"],
  ["oilChg20", "WTI crude change, 20d (%)"],
  ["hyChg20", "HY OAS change, 20d (bp)"]
];

function macroFromCard(card) {
  const all = card.currentState?.allFeatures || [];
  const items = [];
  for (const [feature, label] of MACRO_FEATURE_VIEW) {
    const f = all.find((x) => x.feature === feature);
    if (f && f.value != null && Number.isFinite(Number(f.value))) items.push({ key: feature, label, value: f.value });
  }
  return { source: "FRED-derived engine features on this card", items };
}

/**
 * Project the market-wide snapshot onto one card. The snapshot is identical for every card (it is the
 * market backdrop, not a per-symbol claim); only macro falls back to that card's own measured features.
 */
export function buildSignalsView(snapshot, card) {
  if (!snapshot) return null;
  const hasNews = (snapshot.news?.items?.length || 0) > 0;
  const hasSentiment = snapshot.sentiment?.fearGreed != null;
  const macro = snapshot.macro?.items?.length
    ? { source: snapshot.macro.source, items: snapshot.macro.items.map(({ key, value }) => ({ key, label: key, value })) }
    : macroFromCard(card);
  if (!hasNews && !hasSentiment && !macro.items.length) return null;
  const fg = snapshot.sentiment?.fearGreed ?? null;
  return {
    schema: SIGNAL_SCHEMA,
    fetchedAt: snapshot.fetchedAt,
    sourceNote: `Market context collected ${snapshot.fetchedAt}. News: ${snapshot.news?.source || "unavailable"}. Sentiment: ${snapshot.sentiment?.source || "unavailable"}. Macro: ${macro.source}. The signal MCP is ${snapshot.mcp?.reachable ? "reachable" : "not reachable"} and returned ${[
      snapshot.mcp?.returnedNews ? "news" : null, snapshot.mcp?.returnedSentiment ? "sentiment" : null, snapshot.mcp?.returnedMacro ? "macro" : null].filter(Boolean).join(", ") || "no data"} on this build.`,
    news: hasNews ? { source: snapshot.news.source, items: snapshot.news.items } : { source: null, items: [] },
    sentiment: hasSentiment ? {
      source: snapshot.sentiment.source,
      fearGreedValue: fg,
      fearGreedRaw: Number((fg / 100).toFixed(3)),
      band: snapshot.sentiment.band || sentimentBand(fg),
      longShort: snapshot.sentiment.longShort, takerRatio: snapshot.sentiment.takerRatio
    } : null,
    macro,
    gaps: snapshot.gaps || []
  };
}
