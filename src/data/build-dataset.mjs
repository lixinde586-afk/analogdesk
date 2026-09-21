import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { UNIVERSE } from "./universe.mjs";
import { CACHE, fetchPrices, fetchFred, FRED_SERIES, fetchCryptoHistory, fetchFearGreed, fetchEarningsDates, fetchFomcDates } from "./sources.mjs";

const FROM_TS = Math.floor(new Date("2016-01-01T00:00:00Z").getTime() / 1000);
const round = (x, n = 4) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** n) / 10 ** n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isoDay = (ts) => new Date(ts * 1000).toISOString().slice(0, 10);

async function pMap(items, fn, limit = 4, gapMs = 120) {
  const out = new Array(items.length);
  let i = 0, active = 0;
  await new Promise((res) => {
    const next = () => {
      if (i >= items.length && active === 0) return res();
      while (active < limit && i < items.length) {
        const idx = i++; active++;
        (async () => {
          try { out[idx] = { ok: true, v: await fn(items[idx], idx) }; }
          catch (e) { out[idx] = { ok: false, e: e.message }; }
          finally { active--; await sleep(gapMs); next(); }
        })();
      }
    };
    next();
  });
  return out;
}

const t0 = Date.now();
const notes = [];
console.log("== AnalogDesk dataset build ==");

console.log("[1/5] FOMC calendar (federalreserve.gov)");
const fomc = await fetchFomcDates();
console.log(`      fomc dates: ${fomc.length} (${fomc[0]} .. ${fomc[fomc.length - 1]})`);
if (fomc.length < 60) notes.push(`FOMC calendar only has ${fomc.length} dates - check federalreserve.gov parsing`);

console.log("[2/5] FRED macro series");
const macro = {};
for (const [id, desc] of FRED_SERIES) {
  try {
    const rows = await fetchFred(id);
    macro[id] = { desc, d: rows.map((r) => r.d), v: rows.map((r) => round(r.v, 4)) };
    console.log(`      ${id}: ${rows.length} obs ${rows[0]?.d}..${rows[rows.length - 1]?.d}`);
  } catch (e) { notes.push(`FRED ${id} failed: ${e.message}`); console.log(`      ${id}: FAILED ${e.message}`); }
  await sleep(140);
}

console.log("[3/5] crypto cross-asset (coins.llama.fi) + Fear&Greed");
const crypto = {};
for (const [id, key] of [["bitcoin", "BTC"], ["ethereum", "ETH"]]) {
  try {
    const rows = await fetchCryptoHistory(id, { fromTs: FROM_TS });
    const map = new Map();
    for (const r of rows) { const d = isoDay(r.ts); if (!map.has(d)) map.set(d, round(r.p, 2)); }
    const ds = [...map.keys()].sort();
    crypto[key] = { d: ds, p: ds.map((d) => map.get(d)) };
    console.log(`      ${key}: ${ds.length} daily points ${ds[0]}..${ds.at(-1)}`);
  } catch (e) { notes.push(`crypto ${id} failed: ${e.message}`); console.log(`      ${key}: FAILED ${e.message}`); }
}
try {
  const fg = await fetchFearGreed();
  crypto.FNG = { d: fg.map((r) => r.d), p: fg.map((r) => r.v) };
  console.log(`      FNG: ${fg.length} obs ${fg[0]?.d}..${fg.at(-1)?.d}`);
} catch (e) { notes.push(`FNG failed: ${e.message}`); }

console.log(`[4/5] prices for ${UNIVERSE.length} symbols (api.stockanalysis.com, 10Y)`);
const pRes = await pMap(UNIVERSE, async (u) => fetchPrices(u.s), 5, 130);
const prices = {}; const pfail = [];
pRes.forEach((r, i) => {
  const u = UNIVERSE[i];
  if (r.ok) prices[u.s] = r.v; else { pfail.push(`${u.s}: ${r.e}`); notes.push(`prices ${u.s} failed: ${r.e}`); }
});
console.log(`      ok=${Object.keys(prices).length} fail=${pfail.length}${pfail.length ? " -> " + pfail.join(", ") : ""}`);

const stocks = UNIVERSE.filter((u) => !u.etf && u.cik);
console.log(`[5/5] earnings 8-K dates for ${stocks.length} companies (SEC EDGAR FTS)`);
const eRes = await pMap(stocks, async (u) => fetchEarningsDates(u.cik), 2, 320);
const earnings = {}; const earningsVia = {}; const efail = [];
eRes.forEach((r, i) => {
  const u = stocks[i];
  if (r.ok) { earnings[u.s] = r.v.dates; earningsVia[u.s] = r.v.via; }
  else { efail.push(`${u.s}: ${r.e}`); notes.push(`earnings ${u.s} failed: ${r.e}`); }
});
const eCounts = Object.values(earnings).map((a) => a.length).sort((a, b) => a - b);
console.log(`      ok=${Object.keys(earnings).length} fail=${efail.length} | per co: min=${eCounts[0]} med=${eCounts[Math.floor(eCounts.length / 2)]} max=${eCounts.at(-1)}`);
const sixK = Object.entries(earningsVia).filter(([, v]) => v["6-K"] > 0).map(([s]) => s);
const noDates = Object.entries(earnings).filter(([, a]) => a.length === 0).map(([s]) => s);
console.log(`      6-K fallback fired for ${sixK.length}/${stocks.length}: ${sixK.join(", ") || "-"}`);
if (!sixK.length) notes.push("6-K fallback never fired - verify the China ADR CIKs");
if (noDates.length) notes.push(`still zero earnings dates after the 6-K fallback: ${noDates.join(", ")}`);

const cal = [...new Set((prices.SPY || prices.QQQ || []).map((r) => r.d))].sort();
if (!cal.length) throw new Error("no benchmark calendar - SPY/QQQ prices missing");
const idxOf = new Map(cal.map((d, i) => [d, i]));
const pricesAligned = {};
for (const u of UNIVERSE) {
  const rows = prices[u.s]; if (!rows) continue;
  const o = new Array(cal.length).fill(null), h = o.slice(), l = o.slice(), a = o.slice(), v = o.slice();
  let dropped = 0;
  for (const r of rows) {
    const i = idxOf.get(r.d); if (i == null) { dropped++; continue; }
    o[i] = round(r.o, 4); h[i] = round(r.h, 4); l[i] = round(r.l, 4); a[i] = round(r.a, 4); v[i] = r.v;
  }
  pricesAligned[u.s] = { o, h, l, a, v };
  if (dropped) notes.push(`${u.s}: ${dropped} price rows outside benchmark calendar`);
}

const dataset = {
  meta: {
    builtAt: new Date().toISOString(), buildSeconds: Math.round((Date.now() - t0) / 1000),
    from: cal[0], to: cal.at(-1), nDates: cal.length, nSymbols: Object.keys(pricesAligned).length,
    universe: UNIVERSE.map((u) => ({ s: u.s, n: u.n, sec: u.sec, etf: !!u.etf })),
    sources: {
      prices: "api.stockanalysis.com /api/symbol/s/{SYM}/history?range=10Y&period=Daily (keyless)",
      macro: "fred.stlouisfed.org/graph/fredgraph.csv (keyless)",
      crypto: "coins.llama.fi/chart/coingecko:{id} (keyless)",
      sentiment: "api.alternative.me/fng (keyless)",
      earningsDates: 'efts.sec.gov full-text search (keyless, contact UA): forms=8-K q="Item 2.02" for domestic filers; forms=6-K q="unaudited" / q="financial results" fallback for foreign private issuers; filing dates clustered at 6 calendar days',
      fomc: "federalreserve.gov fomccalendars.htm + fomc_historical.htm (parsed document dates)"
    },
    notes
  },
  dates: cal,
  prices: pricesAligned,
  macro,
  crypto,
  events: { fomc, earnings, earningsVia }
};

mkdirSync(CACHE, { recursive: true });
const payload = JSON.stringify(dataset);
writeFileSync(join(CACHE, "dataset.json"), payload);
console.log(`\nwrote data-cache/dataset.json (${(payload.length / 1e6).toFixed(2)} MB)`);

const rep = [
  "# Dataset build report", "",
  `- builtAt: ${dataset.meta.builtAt}  (${dataset.meta.buildSeconds}s)`,
  `- trading calendar: ${cal[0]} .. ${cal.at(-1)}  (${cal.length} sessions)`,
  `- symbols with prices: ${Object.keys(pricesAligned).length}/${UNIVERSE.length}`,
  `- companies with earnings dates: ${Object.keys(earnings).length}/${stocks.length}`,
  `- FOMC decision dates parsed: ${fomc.length}`,
  `- FRED series: ${Object.keys(macro).join(", ")}`,
  `- crypto/sentiment: ${Object.keys(crypto).join(", ")}`, "",
  "## Per-symbol coverage", "",
  "| symbol | rows | first | last | earnings events | via |", "|---|---|---|---|---|---|",
  ...UNIVERSE.map((u) => {
    const pr = pricesAligned[u.s]; if (!pr) return `| ${u.s} | MISSING | - | - | - | - |`;
    const filled = pr.a.filter((x) => x != null).length;
    const firstI = pr.a.findIndex((x) => x != null);
    const lastI = pr.a.length - 1 - [...pr.a].reverse().findIndex((x) => x != null);
    const via = earningsVia[u.s];
    const viaTxt = via ? (via["6-K"] > 0 ? `6-K (${via["6-K"]} hits)` : `8-K (${via["8-K"]} hits)`) : "-";
    return `| ${u.s} | ${filled} | ${cal[firstI]} | ${cal[lastI]} | ${(earnings[u.s] || []).length} | ${viaTxt} |`;
  }), "", "## Notes / gaps", "", ...(notes.length ? notes.map((n) => `- ${n}`) : ["- none"])
].join("\n");
writeFileSync(join(CACHE, "build-report.md"), rep, "utf8");
console.log("wrote data-cache/build-report.md");
