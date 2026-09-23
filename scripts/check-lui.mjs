/**
 * AnalogDesk - language-understanding gate.
 *
 *   npm run check:lui
 *
 * WHY THIS EXISTS
 * "LUI fluency" is only a claim until something fails the build when a sentence is misunderstood. The
 * desk is driven by one parser (src/llm/lui.mjs) that the browser UI, the HTTP API and the MCP tool
 * server all share, and this file is its contract: every row below is a sentence a reviewer might
 * actually type, in Chinese or English, with the exact interpretation the desk promises.
 *
 * It also asserts the invariants that keep the parser honest rather than merely agreeable:
 *   - a symbol is only ever returned if the analog library really contains it;
 *   - a horizon is only ever returned if it is one the engine measures;
 *   - a repaired typo is reported as such (matchedHow "fuzzy") and never silently used;
 *   - every generated follow-up suggestion parses back into a usable request (self-consistency);
 *   - ordinary English words are never fuzzy-matched into a ticker.
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { UNIVERSE } from "../src/data/universe.mjs";
import {
  parseIdea, mergeContext, followUpSuggestions, explain, detectLang,
  nearestHorizon, editDistance, suggestSymbol, sessionOnOrBefore, MEASURED_HORIZONS
} from "../src/llm/lui.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dataset = JSON.parse(readFileSync(resolve(ROOT, "data-cache", "dataset.json"), "utf8"));
const D = dataset.dates;
const LAST = D[D.length - 1];

/** The library shape every caller hands the parser: symbols, the session calendar, the horizon grid. */
const LIB = {
  symbols: UNIVERSE.map((u) => ({ symbol: u.s })),
  dates: D, from: dataset.meta.from, to: LAST, horizons: MEASURED_HORIZONS
};
const KNOWN = new Set(LIB.symbols.map((s) => s.symbol));

/* Independent calendar helpers: the test must not reuse the module's own date arithmetic, or a shared
   bug would make every date assertion pass. */
const shift = (iso, days) => new Date(Date.parse(iso + "T00:00:00Z") + days * 86400000).toISOString().slice(0, 10);
const onOrBefore = (iso) => D.filter((d) => d <= iso).pop() || D[0];

let failures = 0, checks = 0;
const ok = (m) => { checks++; console.log("  ok   " + m); };
const bad = (m) => { checks++; failures++; console.log("  FAIL " + m); };
const fmt = (v) => (v === null ? "null" : typeof v === "string" ? JSON.stringify(v) : String(v));
const eq = (label, got, want) => (got === want ? ok(label + " = " + fmt(got)) : bad(label + ": got " + fmt(got) + ", want " + fmt(want)));

/**
 * One row per sentence. "want" lists only the fields that matter for that sentence; every row is also
 * checked against the global invariants at the bottom.
 */
const CASES = [
  ["NVDA 未来 5 个交易日会怎么走", { symbol: "NVDA", matchedHow: "exact", horizon: 5, horizonHow: "sessions", language: "zh" }],
  ["英伟达财报前五天会不会被砸", { symbol: "NVDA", matchedHow: "alias", horizon: 5, language: "zh" }],
  ["阿里巴巴 未来 20 个交易日 回撤不超过 10%", { symbol: "BABA", matchedHow: "alias", horizon: 20, riskTolerancePct: 10 }],
  ["拼多多 一个月", { symbol: "PDD", matchedHow: "alias", horizon: 20 }],
  ["最近一周 SPY 怎么样", { symbol: "SPY", horizon: 5 }],
  ["过去一个月英伟达", { symbol: "NVDA", horizon: 20 }],
  ["META 过去 10 个交易日", { symbol: "META", horizon: 10, horizonHow: "sessions" }],
  ["苹果 最近 5 天", { symbol: "AAPL", matchedHow: "alias", horizon: 5 }],
  ["明天 JPM 会怎样", { symbol: "JPM", horizon: 1 }],
  ["NIO 隔夜", { symbol: "NIO", horizon: 1 }],
  ["今天 INTC", { symbol: "INTC", date: "latest", dateHow: "latest" }],
  ["BABA 未来 7 天", { symbol: "BABA", horizon: 5, horizonRaw: 7 }],
  ["UNH 未来 100 个交易日", { symbol: "UNH", horizon: 60, horizonRaw: 100 }],
  ["GLD 半年", { symbol: "GLD", horizon: 60 }],
  ["止损 8% 的 TSLA 一个月", { symbol: "TSLA", horizon: 20, riskTolerancePct: 8 }],
  ["英伟达 我能承受 15% 回撤吗", { symbol: "NVDA", riskTolerancePct: 15 }],
  ["10 个交易日前的苹果", { symbol: "AAPL", date: D[D.length - 11], dateHow: "n-sessions-ago", horizon: null }],
  ["5 天前的 NVDA 状态", { symbol: "NVDA", date: onOrBefore(shift(LAST, -5)), dateHow: "n-days-ago", horizon: null }],
  ["NVDA 上周怎么样", { symbol: "NVDA", date: onOrBefore(shift(LAST, -7)), dateHow: "last-week" }],
  ["比特币 一周", { symbol: null, horizon: 5 }],
  ["那 20 天呢", { symbol: null, horizon: 20 }],
  ["换成 KWEB", { symbol: "KWEB", horizon: null }],
  ["DIA 一周", { symbol: "DIA", matchedHow: "exact", horizon: 5 }],
  ["nvida one week", { symbol: "NVDA", matchedHow: "fuzzy", matched: "nvida", horizon: 5, language: "en" }],
  ["NVDIA 一周内表现", { symbol: "NVDA", matchedHow: "fuzzy", horizon: 5 }],
  ["TSLAA 一周", { symbol: "TSLA", matchedHow: "fuzzy", horizon: 5 }],
  ["goog one month", { symbol: "GOOGL", horizon: 20 }],
  ["what happened to tesla over the last month", { symbol: "TSLA", matchedHow: "alias", horizon: 20, horizonHow: "duration", date: null }],
  ["in the past two weeks QQQ", { symbol: "QQQ", horizon: 10 }],
  ["over the last 3 weeks AMZN", { symbol: "AMZN", horizon: 20, horizonRaw: 15 }],
  ["as of last month, SPY", { symbol: "SPY", date: onOrBefore(shift(LAST, -30)), dateHow: "last-month", horizon: null }],
  ["yesterday META", { symbol: "META", date: D[D.length - 2], dateHow: "yesterday" }],
  ["as of 2020-03-23, SPY 60 sessions", { symbol: "SPY", date: "2020-03-23", dateHow: "iso", horizon: 60 }],
  ["can I tolerate a 12% drawdown on AMD over 20 sessions", { symbol: "AMD", horizon: 20, riskTolerancePct: 12 }],
  ["max drawdown 15% on NVDA over a quarter", { symbol: "NVDA", horizon: 60, riskTolerancePct: 15 }],
  ["NVDA k=999 next 5 sessions", { symbol: "NVDA", horizon: 5, k: 999 }],
  ["top 100 analogs for XOM a week", { symbol: "XOM", horizon: 5, k: 100 }],
  ["show me NVDA over 60 sessions with k=100", { symbol: "NVDA", horizon: 60, k: 100 }],
  ["KWEB 15 个交易日", { symbol: "KWEB", horizon: 20, horizonRaw: 15 }],
  ["three months from now on QQQ", { symbol: "QQQ", horizon: 60 }],
  ["2 months on XOM", { symbol: "XOM", horizon: 40 }],
  ["MSFT next session", { symbol: "MSFT", horizon: 1 }],
  ["Meta Platforms 5 days", { symbol: "META", horizon: 5 }],
  ["AAPL", { symbol: "AAPL", matchedHow: "exact", horizon: null, language: "en" }],
  ["", { symbol: null, horizon: null, date: null, k: null, riskTolerancePct: null }],
  ["ZZZZZ", { symbol: null }],
  ["what will this week bring for the market", { symbol: null, horizon: 5 }],
  ["how do the next five days look", { symbol: null, horizon: 5 }]
];

console.log("=== sentences: one contract row each (" + CASES.length + " rows; library " + D.length + " sessions to " + LAST + ") ===");
for (const [q, want] of CASES) {
  const p = parseIdea(q, LIB);
  const label = (JSON.stringify(q).length > 46 ? JSON.stringify(q).slice(0, 45) + "..." : JSON.stringify(q)).padEnd(48);
  let rowBad = 0;
  for (const [field, v] of Object.entries(want)) {
    if (p[field] !== v) { bad(label + field + ": got " + fmt(p[field]) + ", want " + fmt(v)); rowBad++; }
  }
  if (p.symbol != null && !KNOWN.has(p.symbol)) { bad(label + "symbol " + p.symbol + " is not in the library"); rowBad++; }
  if (p.horizon != null && !MEASURED_HORIZONS.includes(p.horizon)) { bad(label + "horizon " + p.horizon + " is not measured"); rowBad++; }
  if (p.k != null && !(Number.isFinite(p.k) && p.k > 0)) { bad(label + "k is not a positive number"); rowBad++; }
  if (p.riskTolerancePct != null && !(p.riskTolerancePct >= 1 && p.riskTolerancePct <= 50)) { bad(label + "risk tolerance outside 1..50"); rowBad++; }
  if (p.matchedHow === "fuzzy" && !p.suggestion) { bad(label + "fuzzy match without a reported suggestion"); rowBad++; }
  if (p.date && p.date !== "latest" && !/^\d{4}-\d{2}-\d{2}$/.test(p.date)) { bad(label + "date is not an ISO session: " + p.date); rowBad++; }
  if (!rowBad) ok(label + "-> " + (p.symbol || "-") + "  H" + (p.horizon ?? "-") + "  " + (p.date || "-") + (p.k ? "  k" + p.k : "") + (p.riskTolerancePct ? "  risk" + p.riskTolerancePct : "") + (p.matchedHow === "fuzzy" ? "  (fuzzy)" : ""));
}

console.log("\n=== conversation: a partial follow-up inherits the previous request ===");
const first = parseIdea("NVDA 未来 5 个交易日", LIB);
const second = mergeContext(first, parseIdea("那 20 天呢", LIB));
eq("follow-up inherits the symbol", second.symbol, "NVDA");
eq("follow-up keeps its own horizon", second.horizon, 20);
eq("the inheritance is reported", JSON.stringify(second.inherited), '["symbol"]');
const third = mergeContext(second, parseIdea("换成 KWEB", LIB));
eq("a named symbol beats the inherited one", third.symbol, "KWEB");
eq("the horizon is still inherited", third.horizon, 20);
const fourth = mergeContext(third, parseIdea("止损 10%", LIB));
eq("a risk-only follow-up keeps the symbol", fourth.symbol, "KWEB");
eq("a risk-only follow-up keeps the horizon", fourth.horizon, 20);
eq("the stated tolerance is parsed", fourth.riskTolerancePct, 10);

console.log("\n=== every suggested follow-up must parse back into a real request ===");
for (const lang of ["zh", "en"]) {
  const sug = followUpSuggestions(first, { language: lang, alternateSymbol: "KWEB" });
  if (sug.length !== 4) bad(lang + ": expected 4 suggestions, got " + sug.length);
  else ok(lang + ": 4 suggestions offered");
  for (const s of sug) {
    const p = parseIdea(s.q, LIB);
    if (!p.symbol) bad(lang + " suggestion names no instrument: " + s.q);
    else if (!p.horizon && !p.date && !p.riskTolerancePct) bad(lang + " suggestion asks for nothing: " + s.q);
    else ok(lang + " [" + s.label + "] -> " + p.symbol + " H" + (p.horizon ?? "-")
      + (p.riskTolerancePct ? " risk" + p.riskTolerancePct : "") + (p.date ? " as-of " + p.date : ""));
  }
}

console.log("\n=== primitives ===");
eq("editDistance NVDIA -> NVDA", editDistance("NVDIA", "NVDA"), 1);
eq("editDistance stops at the bound", editDistance("NVDA", "QQQQQQQ", 2), 3);
eq("nearestHorizon(15) prefers the longer", nearestHorizon(15), 20);
eq("nearestHorizon(7)", nearestHorizon(7), 5);
eq("nearestHorizon(100)", nearestHorizon(100), 60);
eq("suggestSymbol refuses a 3-letter token", suggestSymbol("AMD", [...KNOWN]), null);
eq("suggestSymbol repairs one typo", suggestSymbol("NVDIA", [...KNOWN]).symbol, "NVDA");
eq("detectLang zh", detectLang("英伟达未来五天怎么走"), "zh");
eq("detectLang en", detectLang("what about NVDA next week"), "en");
eq("sessionOnOrBefore snaps to a real session", sessionOnOrBefore(D, "2024-07-04"), onOrBefore("2024-07-04"));

console.log("\n=== explain(): the trace the API and the MCP tool hand back ===");
const exZh = explain(parseIdea("NVDIA 一周 回撤不超过 10%", LIB), { language: "zh" });
if (!/NVDA/.test(exZh) || !/NVDIA/.test(exZh) || !/10%/.test(exZh)) bad("zh explain hides the repair or the tolerance: " + exZh);
else ok("zh explain: " + exZh);
const exEn = explain(parseIdea("tesla over the last month", LIB), { language: "en" });
if (!/TSLA/.test(exEn) || !/20 sessions/.test(exEn)) bad("en explain missing symbol or horizon: " + exEn);
else ok("en explain: " + exEn);

console.log("\n" + CASES.length + " sentences, " + checks + " assertions");
console.log(failures ? "\ncheck:lui FAILED (" + failures + ")" : "\ncheck:lui passed");
process.exit(failures ? 1 : 0);
