import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, "..", "..");
export const CACHE = join(ROOT, "data-cache");
export const RAW = join(CACHE, "raw");
mkdirSync(RAW, { recursive: true });

const UA_BROWSER = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
export const UA_SEC = "AnalogDesk research-desk analogdesk@example.com"; // SEC asks for a contact UA
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cachePath(url) {
  const h = createHash("sha1").update(url).digest("hex").slice(0, 10);
  const slug = url.replace(/^https?:\/\//, "").replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 90);
  return join(RAW, `${slug}__${h}.dat`);
}

/** GET with retry/backoff + on-disk cache. `ttlHours` = reuse cache if younger than this. */
/** Cache-reuse window for data-cache/raw. Raise it to rebuild from disk without re-hitting the network. */
export const CACHE_TTL_HOURS = Number(process.env.ANALOGDESK_CACHE_TTL_HOURS || 24);

/**
 * End date of the EDGAR full-text-search window. It defaults to today, and because the whole URL is
 * the on-disk cache key, that makes every earnings search a cache miss on any day after the one it
 * was first fetched - which, offline, silently returns zero earnings dates for all 55 companies and
 * quietly rewrites four distance features (dte, eventLoad5, isFomcDay and the event group weight
 * behind them). Pin it (ANALOGDESK_EDGAR_END=YYYY-MM-DD) to rebuild from data-cache/raw and get the
 * same events block the published numbers were measured on.
 */
export const EDGAR_END = process.env.ANALOGDESK_EDGAR_END || new Date().toISOString().slice(0, 10);

export async function get(url, { headers = {}, timeout = 30000, retries = 3, ttlHours = CACHE_TTL_HOURS, force = false, label = "" } = {}) {
  const cp = cachePath(url);
  if (!force && existsSync(cp)) {
    const ageH = (Date.now() - statSync(cp).mtimeMs) / 3600000;
    if (ageH < ttlHours) return readFileSync(cp, "utf8");
  }
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(timeout), redirect: "follow" });
      if (r.status === 403 || r.status === 429) { await sleep(700 * (i + 1)); lastErr = new Error(`HTTP ${r.status}`); continue; }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const t = await r.text();
      writeFileSync(cp, t, "utf8");
      if (label) process.stdout.write(`  [ok] ${label}\n`);
      return t;
    } catch (e) {
      lastErr = e;
      await sleep(500 * (i + 1));
    }
  }
  throw new Error(`GET failed ${url}: ${lastErr?.cause?.code || lastErr?.message}`);
}

/* ------------------------------- prices ---------------------------------- */
/**
 * api.stockanalysis.com daily OHLCV. Verified: range=10Y -> 2513 rows (15Y/30Y silently fall back to 1Y).
 *
 * The vendor returns TWO price bases on one row and AnalogDesk keeps both, because they answer
 * different questions and are not interchangeable:
 *   o / h / l / c  the session's traded prices - split-adjusted but NOT dividend-adjusted, so all
 *                  four sit on one scale. The only basis on which an intraday low may be compared
 *                  with an entry price, so it is what path risk (MAE/MFE) and the overnight gap use.
 *   a              close adjusted for splits AND dividends - the total-return basis, so it is what
 *                  every forward return uses: A[q+H]/A[q] - 1.
 * Dividing one basis by the other is a category error, not a rounding issue: `a` sits below `c` by the
 * cumulative dividend factor (0.47x for RTX over this window), so a raw low over an adjusted close
 * reports a large favourable excursion on a name that actually fell. A row missing either basis is
 * dropped here rather than back-filled from the other downstream.
 */
export async function fetchPrices(sym, { range = "10Y" } = {}) {
  const url = `https://api.stockanalysis.com/api/symbol/s/${encodeURIComponent(sym)}/history?range=${range}&period=Daily`;
  const t = await get(url, { headers: { "User-Agent": UA_BROWSER }, label: `prices ${sym}` });
  const j = JSON.parse(t);
  if (!j?.data?.length) throw new Error(`no price rows for ${sym}`);
  const rows = j.data.map((r) => ({
    d: r.t, o: r.o ?? null, h: r.h ?? null, l: r.l ?? null,
    c: r.c ?? null, a: r.a ?? null, v: r.v ?? null
  })).filter((r) => r.d && r.a != null && r.c != null && r.o != null && r.h != null && r.l != null);
  rows.sort((x, y) => (x.d < y.d ? -1 : 1));
  return rows;
}

/* -------------------------------- FRED ----------------------------------- */
export const FRED_SERIES = [
  ["VIXCLS",       "CBOE VIX close (daily)"],
  ["T10YIE",       "10y breakeven inflation (daily, market-implied -> no release lag)"],
  ["T10Y2Y",       "10y-2y Treasury slope (daily)"],
  ["DGS10",        "10y Treasury yield (daily)"],
  ["DGS3MO",       "3-month Treasury bill secondary-market rate (daily; FRED retired the DGS3M id)"],
  ["DFEDTARU",     "Fed funds target upper (daily; changes only on FOMC decision days)"],
  ["DTWEXBGS",     "Broad trade-weighted USD index (daily)"],
  ["DCOILWTICO",   "WTI crude (daily)"],
  ["BAMLH0A0HYM2", "HY OAS credit spread (daily)"],
  ["CPIAUCSL",     "CPI level (monthly; used only with an explicit publication-lag convention)"],
  ["NASDAQCOM",    "Nasdaq Composite (daily)"]
];
export async function fetchFred(id, { cosd = "2015-06-01" } = {}) {
  const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=${cosd}`;
  const t = await get(url, { headers: { "User-Agent": UA_BROWSER }, label: `fred ${id}` });
  const L = t.trim().split(/\r?\n/);
  const out = [];
  for (let i = 1; i < L.length; i++) {
    const [d, v] = L[i].split(",");
    if (!d || v == null || v === "" || v === ".") continue;
    const n = Number(v);
    if (Number.isFinite(n)) out.push({ d, v: n });
  }
  return out;
}

/* --------------------------- crypto (DeFiLlama) -------------------------- */
/** CoinGecko/Kraken/Solana RPC are unreachable from this network; coins.llama.fi is reachable. */
export async function fetchCryptoHistory(coinId, { fromTs, span = 500 } = {}) {
  const out = [];
  let start = fromTs;
  const now = Math.floor(Date.now() / 1000);
  let guard = 0;
  while (start < now && guard++ < 40) {
    const url = `https://coins.llama.fi/chart/coingecko:${coinId}?start=${start}&span=${span}&period=1d`;
    let j;
    try { j = JSON.parse(await get(url, { headers: { "User-Agent": UA_BROWSER }, label: `llama ${coinId}@${start}` })); }
    catch (e) { break; }
    const arr = j?.coins?.[`coingecko:${coinId}`]?.prices || [];
    if (!arr.length) break;
    for (const pt of arr) out.push({ ts: pt.timestamp, p: pt.price });
    const last = arr[arr.length - 1].timestamp;
    if (last <= start) break;
    start = last + 1;
    await sleep(180);
  }
  out.sort((a, b) => a.ts - b.ts);
  const seen = new Set();
  return out.filter((r) => (seen.has(r.ts) ? false : (seen.add(r.ts), true)));
}

/** alternative.me crypto Fear & Greed (full history, keyless). */
export async function fetchFearGreed() {
  const t = await get("https://api.alternative.me/fng/?limit=0", { headers: { "User-Agent": UA_BROWSER }, label: "fear&greed" });
  const j = JSON.parse(t);
  return (j.data || []).map((r) => ({ d: new Date(Number(r.timestamp) * 1000).toISOString().slice(0, 10), v: Number(r.value) }))
    .filter((r) => Number.isFinite(r.v)).sort((a, b) => (a.d < b.d ? -1 : 1));
}

/* ------------------------- SEC EDGAR (events) ---------------------------- */
const EDGAR_FTS = "https://efts.sec.gov/LATEST/search-index";

/** EDGAR FTS wants `"` as %22 and spaces as `+`; hand-encoding keeps the raw-cache keys stable. */
async function edgarFts(term, forms, cik, from, end, label) {
  const q = `%22${term.replace(/ /g, "+")}%22`;
  const url = `${EDGAR_FTS}?q=${q}&forms=${forms}&ciks=${cik}&startdt=${from}&enddt=${end}&dateRange=custom`;
  const t = await get(url, { headers: { "User-Agent": UA_SEC, Accept: "application/json" }, label });
  return (JSON.parse(t)?.hits?.hits || []).map((h) => h._source?.file_date || h._source?.filed).filter(Boolean);
}

/**
 * Collapse filing dates that belong to one reporting event. A single earnings release is often
 * filed more than once (8-K then 8-K/A, or a 6-K cover plus its exhibit), and a foreign private
 * issuer may file the results 6-K a day or two away from the press release. Any date within
 * `days` calendar days of an already-kept anchor counts as the same event; the earliest wins.
 */
export function clusterDates(dates, days = 6) {
  const out = [];
  let anchor = null;
  for (const d of [...new Set(dates)].sort()) {
    if (anchor === null || (Date.parse(d) - Date.parse(anchor)) / 86400000 > days) { out.push(d); anchor = d; }
  }
  return out;
}

/** 6-K full-text terms that reliably catch a foreign private issuer's quarterly results. */
export const SIX_K_QUERIES = ["unaudited", "financial results"];

/**
 * Earnings-release dates, keyless: one EDGAR full-text-search request per 10-year window.
 *   domestic filers        -> 8-K containing "Item 2.02" (Results of Operations)
 *   foreign private issuer -> 8-K returns nothing (BABA/PDD/JD/BIDU/NIO/LI report on 6-K), so
 *                             fall back to 6-K full-text search on results language.
 * @returns {{dates:string[], via:{"8-K":number,"6-K":number}}}
 */
export async function fetchEarningsDates(cik, { from = "2015-06-01", to, clusterDays = 6 } = {}) {
  const end = to || EDGAR_END;
  const via = { "8-K": 0, "6-K": 0 };
  const found = new Set();
  try {
    const hits = await edgarFts("Item 2.02", "8-K", cik, from, end, `edgar 8-K ${cik}`);
    hits.forEach((d) => found.add(d)); via["8-K"] = hits.length;
  } catch (e) { console.log(`      edgar 8-K ${cik} failed: ${e.message}`); }
  if (via["8-K"] === 0) {
    for (const term of SIX_K_QUERIES) {
      try {
        const hits = await edgarFts(term, "6-K", cik, from, end, `edgar 6-K ${cik} q="${term}"`);
        hits.forEach((d) => found.add(d)); via["6-K"] += hits.length;
      } catch (e) { console.log(`      edgar 6-K ${cik} q="${term}" failed: ${e.message}`); }
      await sleep(220);
    }
  }
  return { dates: clusterDates([...found], clusterDays), via };
}

/** FOMC decision dates, parsed from federalreserve.gov document URLs (monetaryYYYYMMDDa1.pdf / fomcminutesYYYYMMDD). */
export async function fetchFomcDates() {
  const urls = [
    "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm",
    "https://www.federalreserve.gov/monetarypolicy/fomc_historical.htm"
  ];
  const found = new Set();
  for (const u of urls) {
    try {
      const t = await get(u, { headers: { "User-Agent": UA_BROWSER }, label: `fed ${u.split("/").pop()}` });
      for (const m of t.matchAll(/(?:monetary|fomcminutes|fomcpressconf|fomcpresconf|fomcprojtabl)(\d{4})(\d{2})(\d{2})/g)) {
        const iso = `${m[1]}-${m[2]}-${m[3]}`;
        const dow = new Date(iso + "T12:00:00Z").getUTCDay();
        if (dow >= 1 && dow <= 5) found.add(iso); // decision days are weekdays
      }
    } catch { /* historical page may be missing; calendars page alone covers recent years */ }
  }
  return [...found].sort();
}

