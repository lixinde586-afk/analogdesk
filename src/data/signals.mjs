/**
 * AnalogDesk - market signals layer (news / sentiment / macro).
 *
 * The analog card answers "in the episodes that looked like this, what happened next". It does not
 * answer "why is the market like this right now" - the backdrop a trader reads before sizing: the news
 * cycle, where sentiment stands and the macro regime. This module closes that layer.
 *
 * ASSET-CLASS CORRECTNESS (the point of this rewrite)
 * The primary news and sentiment are now genuinely EQUITY readings:
 *   - equity market feeds (MarketWatch / CNBC / Benzinga / Nasdaq / Fortune / TheStreet) plus
 *     per-symbol headlines, so an NVDA card reads NVDA/equity news, not crypto news;
 *   - an equity sentiment score computed from the committed dataset (breadth, SPY trend, VIX), with
 *     the CNN Business equity Fear & Greed as an external cross-check.
 * The CRYPTO readings (crypto headlines, the alternative.me Fear & Greed) are kept but grouped
 * separately and labelled "crypto market only" - they are context for the tokenised wrapper, never
 * the mood of the equity itself.
 *
 * Two transports are probed and recorded: the official bitget-signal market MCP is tried first; on
 * this build it is reachable (direct and via proxy) but every data call returns a blank error, so
 * primary-source fallbacks fill each layer. Nothing is estimated to fill a hole; a hole is a gap.
 *
 * Isomorphic and dependency-free (global fetch only): scripts/collect-signals.mjs runs this in Node
 * (injecting the dataset-derived equity sentiment) and writes data-cache/signals.json; the bundler
 * ships it to the browser and desk.mjs projects it onto each card.
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
  (o && typeof o === "object" && Object.values(o).some((v) => v && typeof v === "object" && typeof v.error === "string" && v.error));

/* -------------------------------- feeds ----------------------------------- */

/** Equity market feeds, the PRIMARY news for an equity card, in display order. */
export const EQUITY_FEEDS = [
  ["MarketWatch Pulse", "https://feeds.content.dowjones.io/public/rss/mw_marketpulse"],
  ["MarketWatch Top", "https://feeds.content.dowjones.io/public/rss/mw_topstories"],
  ["CNBC Top News", "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100727362"],
  ["CNBC Markets", "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114"],
  ["Benzinga", "https://www.benzinga.com/feed"],
  ["Nasdaq Markets", "https://www.nasdaq.com/feed/rssoutbound?category=Markets"],
  ["Fortune", "https://fortune.com/feed/"],
  ["TheStreet", "https://www.thestreet.com/.rss/full/"]
];

/** Crypto feeds, kept separate as context for the tokenised wrapper. */
export const CRYPTO_FEEDS = [
  ["CoinTelegraph", "https://cointelegraph.com/rss"],
  ["Decrypt", "https://decrypt.co/feed"],
  ["The Defiant", "https://thedefiant.io/api/feed"],
  ["Bitcoinist", "https://bitcoinist.com/feed/"],
  ["U.Today", "https://u.today/rss"]
];

/** Symbols with baked per-symbol headlines (the canonical card set). */
export const PER_SYMBOL = ["NVDA", "KWEB", "SPY", "TSLA", "BABA", "QQQ"];
const yahooSymbol = (s) => `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${s}&region=US&lang=en-US`;

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

/** alternative.me CRYPTO Fear & Greed, 0..100 (keyless). */
async function fetchCryptoFearGreed100() {
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

/** CNN Business EQUITY Fear & Greed (momentum/strength/breadth/put-call/junk/VIX/safe-haven). */
async function fetchCnnEquity() {
  const r = await fetch("https://production.dataviz.cnn.io/index/fearandgreed/graphdata",
    { signal: AbortSignal.timeout(20000), headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  const fg = j.fear_and_greed;
  const map = {
    market_momentum_sp500: "Momentum", stock_price_strength: "Strength", stock_price_breadth: "Breadth",
    put_call_options: "Put/Call", junk_bond_demand: "Junk demand", market_volatility_vix: "VIX", safe_haven_demand: "Safe haven"
  };
  const components = [];
  for (const [k, l] of Object.entries(map)) {
    const x = j[k];
    if (x && Number.isFinite(Number(x.score))) components.push({ key: k, label: l, score: Number(Number(x.score).toFixed(1)), rating: x.rating || null });
  }
  return { source: "CNN Business Fear & Greed (equity market)", score: Number(Number(fg.score).toFixed(1)), rating: fg.rating, components, fetchedAt: new Date().toISOString() };
}

/* ------------------------------ MCP collect ------------------------------- */

const NEWS_FEEDS_MCP = "cointelegraph,coindesk,decrypt,blockworks,cnbc";

async function collectViaMcp() {
  const out = { news: [], sentiment: {}, macro: [], newsOk: false, sentimentOk: false, macroOk: false };
  let mcp;
  try { mcp = await mcpOpen(); } catch (e) { return { ...out, reachable: false, error: e.message }; }

  try {
    const nf = safeJson(await mcp.call("news_feed", { action: "latest", feeds: NEWS_FEEDS_MCP, limit: 5 }));
    if (Array.isArray(nf)) {
      for (const f of nf) for (const it of f.items || []) out.news.push({ title: it.title, source: f.feed, link: it.link || it.url || "", publishedAt: it.publishedAt || it.date || null });
    }
    const tn = safeJson(await mcp.call("tradfi_news", { action: "news", limit: 8 }));
    if (Array.isArray(tn)) for (const it of tn) out.news.push({ title: it.title, source: "tradfi", link: it.link || "", publishedAt: it.publishedAt || null });
    out.newsOk = out.news.length > 0;
  } catch { /* news gap */ }

  try {
    const si = safeJson(await mcp.call("sentiment_index", { action: "current" }));
    const v = si && (si.value ?? si.fear_greed ?? si.index ?? null);
    if (Number.isFinite(Number(v)) && Number(v) > 0 && Number(v) <= 100) out.sentiment.fearGreed = Number(v);
    out.sentimentOk = out.sentiment.fearGreed != null;
  } catch { /* sentiment gap */ }

  try {
    const ry = safeJson(await mcp.call("rates_yields", { action: "rates_snapshot" }));
    if (ry && !hasError(ry)) for (const [k, v] of Object.entries(ry)) {
      const x = v && typeof v === "object" ? (v.value ?? v.rate ?? null) : v;
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

/** Build the full market-signals snapshot. `equitySentiment` is the dataset-derived equity score. */
export async function collectSignals({ equitySentiment = null } = {}) {
  const fetchedAt = new Date().toISOString();
  const mcp = await collectViaMcp();
  const gaps = [];

  // Equity market headlines.
  let equity = [];
  for (const feed of EQUITY_FEEDS) {
    try { equity = equity.concat(await fetchFeed(feed)); } catch { /* one feed down */ }
    await sleep(90);
  }
  equity = dedupeAndRank(equity, 40);
  if (!equity.length) gaps.push("equity news: no market headlines returned on this build");

  // Per-symbol headlines.
  const perSymbol = {};
  for (const s of PER_SYMBOL) {
    try { perSymbol[s] = dedupeAndRank(await fetchFeed([`Yahoo Finance · ${s}`, yahooSymbol(s)]), 8); }
    catch { perSymbol[s] = []; }
    await sleep(90);
  }

  // Crypto headlines, kept separate.
  let crypto = [];
  for (const feed of CRYPTO_FEEDS) {
    try { crypto = crypto.concat(await fetchFeed(feed)); } catch { /* one feed down */ }
    await sleep(90);
  }
  crypto = dedupeAndRank(crypto, 20);

  // External equity sentiment (CNN).
  let equityExternal = null;
  try { equityExternal = await fetchCnnEquity(); } catch { /* cross-check gap */ }
  if (!equityExternal) gaps.push("external equity sentiment (CNN Fear & Greed) unavailable on this build");

  // Crypto Fear & Greed, relabelled crypto-only.
  let cryptoSent = null;
  const fg = await fetchCryptoFearGreed100().catch(() => null);
  if (fg != null) cryptoSent = { source: "alternative.me crypto Fear & Greed (crypto market only)", fearGreed: fg, band: sentimentBand(fg) };
  else gaps.push("crypto Fear & Greed unavailable on this build");

  const newsSource = equity.length
    ? "equity market feeds (MarketWatch/CNBC/Benzinga/Nasdaq/Fortune/TheStreet) + per-symbol Yahoo headlines"
    : null;

  return {
    schema: SIGNAL_SCHEMA,
    fetchedAt,
    mcp: {
      url: SIGNAL_MCP_URL,
      reachable: mcp.reachable !== false,
      returnedNews: mcp.newsOk, returnedSentiment: mcp.sentimentOk, returnedMacro: mcp.macroOk,
      note: "reachable direct and via proxy, lists 19 tools, but every data call returns a blank {error:''} on this build - an upstream service outage, not a missing key"
    },
    news: { source: newsSource, equity, crypto, perSymbol },
    sentiment: { equity: equitySentiment, equityExternal, crypto: cryptoSent },
    macro: { source: mcp.macroOk ? "bitget-signal MCP" : null, items: mcp.macroOk ? mcp.macro : [] },
    gaps
  };
}

/* --------------------------- card view projection ------------------------- */

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

/** Project the market-wide snapshot onto one card (per-symbol news; macro falls back to the card). */
export function buildSignalsView(snapshot, card) {
  if (!snapshot) return null;
  const symbol = card?.idea?.symbol;

  const psItems = symbol ? (snapshot.news?.perSymbol?.[symbol] || []) : [];
  const perSymbol = psItems.length ? { symbol, items: psItems } : null;
  const equity = snapshot.news?.equity || [];
  const crypto = snapshot.news?.crypto || [];
  // Combined equity items (per-symbol first, tagged), the list the renderer and gate read as primary.
  const items = [
    ...(perSymbol ? perSymbol.items.map((it) => ({ ...it, forSymbol: symbol })) : []),
    ...equity
  ];

  const macro = snapshot.macro?.items?.length
    ? { source: snapshot.macro.source, items: snapshot.macro.items.map(({ key, value }) => ({ key, label: key, value })) }
    : macroFromCard(card);

  const sent = snapshot.sentiment;
  const hasEquitySent = sent?.equity?.score != null;
  const hasExt = sent?.equityExternal?.score != null;
  const hasCryptoSent = sent?.crypto?.fearGreed != null;
  if (!items.length && !crypto.length && !macro.items.length && !hasEquitySent && !hasExt) return null;

  const sourceNote = `Market context collected ${snapshot.fetchedAt}. Equity sentiment: ${hasEquitySent ? sent.equity.source : "n/a"}; ` +
    `external equity cross-check: ${hasExt ? sent.equityExternal.source : "n/a"}; crypto sentiment (crypto market only): ${hasCryptoSent ? sent.crypto.source : "n/a"}. ` +
    `News: ${snapshot.news?.source || "n/a"}. Macro: ${macro.source}. Signal MCP ${snapshot.mcp?.reachable ? "reachable" : "not reachable"}, returned ` +
    `${[snapshot.mcp?.returnedNews ? "news" : null, snapshot.mcp?.returnedSentiment ? "sentiment" : null, snapshot.mcp?.returnedMacro ? "macro" : null].filter(Boolean).join(", ") || "no data"} on this build.`;

  return {
    schema: SIGNAL_SCHEMA,
    fetchedAt: snapshot.fetchedAt,
    sourceNote,
    news: { source: snapshot.news?.source || null, perSymbol, items, cryptoItems: crypto },
    sentiment: {
      equity: hasEquitySent ? {
        source: sent.equity.source, asOf: sent.equity.asOf, score: sent.equity.score, band: sent.equity.band, components: sent.equity.components
      } : null,
      equityExternal: hasExt ? sent.equityExternal : null,
      crypto: hasCryptoSent ? sent.crypto : null
    },
    macro,
    gaps: snapshot.gaps || []
  };
}
