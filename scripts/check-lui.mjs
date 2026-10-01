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
  ["how do the next five days look", { symbol: null, horizon: 5 }],

  // --- the language layer's disclosure: what the sentence asked for that one card cannot carry
  ["把 k 调到 100 的 NVDA 一周", { symbol: "NVDA", horizon: 5, k: 100 }],
  ["用 30 个类比看英伟达 5 天", { symbol: "NVDA", horizon: 5, k: 30 }],
  ["我想做空英伟达，未来 5 个交易日", { symbol: "NVDA", horizon: 5, direction: "short" }],
  ["I want to short QQQ over the next 10 sessions", { symbol: "QQQ", horizon: 10, direction: "short", language: "en" }],
  ["short NVDA next week", { symbol: "NVDA", direction: "short" }],
  // a stated stop is a risk tolerance, not a position: inferring a side from it would be a guess
  ["止损 10% 的 NVDA 一周", { symbol: "NVDA", horizon: 5, riskTolerancePct: 10, direction: null }],
  ["in the short term what happens to NVDA", { symbol: "NVDA", direction: null }],
  ["give me a short answer on SPY", { symbol: "SPY", direction: null }],
  ["NVDA short story over 5 sessions", { symbol: "NVDA", horizon: 5, direction: null }],
  ["NVDA vs AMD over the next 5 sessions", { symbol: "NVDA", horizon: 5, direction: null }],
  // sector and commodity words resolve to ONE instrument, and say so on the card
  ["半导体板块未来 10 个交易日", { symbol: "XLK", horizon: 10, matchedHow: "sector-proxy" }],
  ["crude oil over the next 10 sessions", { symbol: "XLE", horizon: 10, matchedHow: "sector-proxy" }],
  ["hang seng tech 5 days", { symbol: "KWEB", horizon: 5, matchedHow: "sector-proxy" }],
  ["china concept stocks 5 days", { symbol: "KWEB", horizon: 5, matchedHow: "sector-proxy" }],
  ["超微未来 5 天", { symbol: "AMD", horizon: 5 }],
  // instruments this library does not hold resolve to NOTHING, not to a lookalike
  ["台积电未来一个月", { symbol: null, horizon: 20 }],
  ["美联航未来一周", { symbol: null, horizon: 5 }],
  ["bitcoin next week", { symbol: null, horizon: 5 }],
  ["TSMC over the next 10 sessions", { symbol: null, horizon: 10 }],
  // an unheld name beside a held one does not take the held one down with it
  ["比特币和英伟达怎么看", { symbol: "NVDA" }],
  ["bitcoin and NVDA over the next 5 sessions", { symbol: "NVDA", horizon: 5 }],
  // earnings is detected and disclosed, and never moves the as-of date on its own
  ["NVDA earnings next week", { symbol: "NVDA", earningsIntent: true, date: null }],
  ["Should I buy BABA into earnings this week?", { symbol: "BABA", earningsIntent: true, direction: "long" }],
  ["英伟达财报前五天会不会被砸", { symbol: "NVDA", earningsIntent: true }],
  // an explicit language request outranks the CJK character count in both directions
  ["用英文再说一遍 NVDA 一周", { symbol: "NVDA", horizon: 5, language: "en", languageRequest: "en" }],
  ["用中文讲一下 SPY 未来 5 天", { symbol: "SPY", language: "zh", languageRequest: "zh" }],
  // LI is Li Auto's ticker and "LI" is two characters of "English": word boundaries, not substrings
  ["say it in English", { symbol: null, languageRequest: "en", language: "en" }],
  ["the oil painting of TSLA", { symbol: "TSLA", matchedHow: "exact" }]
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

console.log("\n=== the disclosure fields: a narrowing has to be able to say what it narrowed ===");
const unheldZh = parseIdea("台积电未来一个月", LIB).unheld;
if (!unheldZh) bad("台积电 reported no unheld instrument");
else if (unheldZh.ticker !== "TSM" || !unheldZh.whyZh) bad("台积电 unheld is incomplete: " + JSON.stringify(unheldZh));
else ok("台积电 -> " + unheldZh.name + " (" + unheldZh.ticker + "), explanation in both languages");
const unheldMixed = parseIdea("比特币和英伟达怎么看", LIB);
eq("an unheld name beside a held one keeps the held one", unheldMixed.symbol, "NVDA");
eq("and still reports the unheld one", unheldMixed.unheld && unheldMixed.unheld.ticker, "BTC");
eq("a fragment of the matched phrase is not a second instrument", (parseIdea("hang seng tech 5 days", LIB).droppedInstruments || []).length, 0);
const cmp = parseIdea("NVDA vs AMD over the next 5 sessions", LIB);
eq("a comparison reports the name it did not analyse", (cmp.droppedInstruments || []).map((d) => d.symbol).join(","), "AMD");
eq("and flags the comparison itself", cmp.comparison, true);
eq("three names keep the two that were dropped", (parseIdea("compare NVDA AMD and TSLA next week", LIB).droppedInstruments || []).map((d) => d.symbol).join(","), "AMD,TSLA");
const proxy = parseIdea("半导体板块未来 10 个交易日", LIB).sectorProxy;
if (!proxy || proxy.symbol !== "XLK" || !proxy.whyZh || !proxy.want || !proxy.have) bad("半导体板块 did not tag the XLK substitution completely");
else ok("半导体板块 -> XLK with want/have/why/whyZh");
const amb = parseIdea("超微未来 5 天", LIB).ambiguousAlias;
if (!amb || amb.symbol !== "AMD" || !amb.whyZh) bad("超微 did not report its ambiguity in both languages");
else ok("超微 -> AMD, ambiguity disclosed");

console.log("\n=== conversation: an edit is reported separately from an inheritance ===");
const d1 = parseIdea("我想做空英伟达，未来 5 个交易日", LIB);
eq("the short is read off the sentence", d1.direction, "short");
const d2 = mergeContext(d1, parseIdea("k 改成 100", LIB));
eq("a parameter-only follow-up keeps the instrument", d2.symbol, "NVDA");
eq("and the horizon it never restated", d2.horizon, 5);
eq("and the side it never restated", d2.direction, "short");
eq("the k it did restate lands", d2.k, 100);
eq("everything carried is reported as carried", (d2.inherited || []).join(","), "symbol,horizon,direction");
const d3 = mergeContext(d2, parseIdea("拉长到一个月", LIB));
eq("a horizon-only follow-up moves the horizon", d3.horizon, 20);
eq("the side survives a second turn", d3.direction, "short");
eq("and the edit is named as an edit, not an inheritance", (d3.changed || []).join(","), "horizon");
const d4 = mergeContext(d3, parseIdea("用英文再说一遍", LIB));
eq("an explicit switch changes the answer language", d4.language, "en");
const d5 = mergeContext(d4, parseIdea("what about 10 sessions", LIB));
eq("the switched-to language persists into the next turn", d5.language, "en");
eq("with the instrument still carried", d5.symbol, "NVDA");
// Naming an instrument the library does not hold is a new topic, not a fragment of the old one.
const d6 = mergeContext(d5, parseIdea("台积电未来一个月", LIB));
eq("an unheld name does not inherit the previous symbol", d6.symbol, null);
eq("and inherits nothing else either", (d6.inherited || []).length, 0);
eq("but it does keep the conversation language", d6.language, "en");
eq("and it still reports what it recognised", d6.unheld && d6.unheld.ticker, "TSM");
// Provenance travels with the value it describes, never on its own.
const d7 = mergeContext(parseIdea("NVDA 未来 5 个交易日", LIB), parseIdea("拉长到一个月", LIB));
eq("a new horizon does not keep the old raw wording", d7.horizonRaw, null);
eq("the horizon itself is still this sentence's", d7.horizon, 20);

console.log("\n=== a chip offered for a narrowed question must itself parse ===");
const chipCmp = followUpSuggestions(cmp, { language: "en", horizons: MEASURED_HORIZONS, droppedInstruments: cmp.droppedInstruments });
eq("a comparison offers the other name first", chipCmp[0].label, "switch to AMD");
if (parseIdea(chipCmp[0].q, LIB).symbol !== "AMD") bad("the switch chip does not parse back to AMD: " + chipCmp[0].q);
else ok("switch chip parses: " + chipCmp[0].q);
const earnP = parseIdea("NVDA earnings next week", LIB);
const chipEarn = followUpSuggestions(earnP, { language: "en", horizons: MEASURED_HORIZONS, earningsDate: "2026-08-20" });
eq("an earnings question offers the report date", chipEarn[0].label, "as of the report 2026-08-20");
if (parseIdea(chipEarn[0].q, LIB).date !== "2026-08-20") bad("the earnings chip does not parse back to its own date: " + chipEarn[0].q);
else ok("earnings chip parses: " + chipEarn[0].q);

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
