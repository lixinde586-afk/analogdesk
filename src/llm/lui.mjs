/**
 * AnalogDesk - language understanding for one trade idea.
 *
 *   npm run check:lui
 *
 * WHY THIS IS ONE MODULE AND NOT THREE
 * The desk is reachable three ways: the browser UI, the zero-dependency HTTP API, and the MCP tool
 * server an agent host can call. All three are handed the same kind of input - a sentence - and a
 * disagreement about what that sentence asked for is the one bug a reviewer notices immediately:
 * "I typed the same thing in the UI and the API and got two different answers." So the parser lives
 * here, isomorphic and dependency-free, and web/app.js, server.mjs and mcp-server.mjs are all clients
 * of this file. scripts/check-lui.mjs drives it over a table of Chinese and English sentences and
 * fails the build if any of them is understood differently than documented.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO
 * It never touches the engine and never invents a number. Snapping a horizon onto the measured grid,
 * clamping k, and printing the disclosure are the desk's job (src/desk.mjs), so there is exactly one
 * place that decides what a request actually ran.
 */
import { ALIASES, SECTOR_PROXIES, AMBIGUOUS_ALIASES, UNHELD_ALIASES } from "../data/universe.mjs";

/** The horizons the engine precomputes forward returns for. Anything else is snapped by the desk. */
export const MEASURED_HORIZONS = [1, 5, 10, 20, 40, 60];

const ALIAS_LIST = [...ALIASES.keys()].sort((a, b) => b.length - a.length);
const TOKEN_RE = /\$?\b[A-Z][A-Z0-9.\-]{0,6}\b/g;
const CJK = /[\u3400-\u9fff]/;

/** Aliases written in Chinese: matched as substrings, because there are no word boundaries to match on. */
const ALIAS_LIST_CJK = ALIAS_LIST.filter((a) => CJK.test(a));

/** The casing the trader actually used, for a latin word: "ual", not "UAL". */
function rawUnheld(upperAlias, original, upperText) {
  const i = upperText.search(new RegExp("(?<![A-Z0-9])" + escapeRe(upperAlias) + "(?![A-Z0-9])"));
  return i < 0 ? upperAlias : original.slice(i, i + upperAlias.length);
}

/**
 * Aliases written in latin: matched on WORD BOUNDARIES only.
 *
 * Substring matching here was a live bug, not a theoretical one. "say it in English" contains the two
 * characters LI, and LI is Li Auto's ticker, so a sentence about the desk's own output language
 * resolved to a Chinese EV maker - and the desk analysed it, confidently, with a full research card.
 * ALIASES is built from every universe name AND the first word of every name, so it holds short latin
 * keys (GE, HD, KO, LI, MS, BA, C) that are substrings of ordinary English words. Word boundaries cost
 * nothing and close the whole class at once.
 */
const ALIAS_LIST_LATIN = ALIAS_LIST.filter((a) => !CJK.test(a) && a.length >= 3)
  .map((a) => ({ a, re: new RegExp("(?<![A-Z0-9])" + escapeRe(String(a).toUpperCase()) + "(?![A-Z0-9])") }));

/**
 * Names of instruments this library does not hold, longest first.
 *
 * These live in UNHELD_ALIASES and deliberately NOT in ALIASES, so they can never resolve to a
 * symbol. Scanning ALIASES for them therefore finds nothing at all and the sentence falls through
 * to the generic "no instrument recognised" dead end - the exact thing this map exists to prevent.
 * Longest first also settles containment: 联合航空 before 美联航, 超微电脑 before 超微.
 */
const UNHELD_LIST = [...UNHELD_ALIASES.keys()].sort((a, b) => b.length - a.length);

export function detectLang(text) {
  const s = String(text || "");
  const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length;
  return cjk > 0 && cjk / Math.max(1, s.length) > 0.12 ? "zh" : "en";
}

function escapeRe(s) { return String(s).replace(/[.*+?^\u0024\u007b\u007d()|[\]\\]/g, "\\$&"); }

/** Bounded Levenshtein. Returns max + 1 as soon as the true distance is provably above max. */
export function editDistance(a, b, max = 2) {
  const s = String(a), t = String(b);
  if (Math.abs(s.length - t.length) > max) return max + 1;
  let prev = Array.from({ length: t.length + 1 }, (_, j) => j);
  for (let i = 1; i <= s.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= t.length; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      if (row[j] < best) best = row[j];
    }
    if (best > max) return max + 1;
    prev = row;
  }
  return prev[t.length];
}

/**
 * Snap a requested horizon onto the measured grid, preferring the LONGER horizon on a tie: if a trader
 * says "15 sessions" the honest reading is "about three weeks", not "two weeks, and the missing days
 * do not matter". The desk discloses the snap either way.
 */
export function nearestHorizon(want, horizons = MEASURED_HORIZONS) {
  let best = horizons[0];
  for (const h of horizons) {
    const d = Math.abs(h - want), db = Math.abs(best - want);
    if (d < db || (d === db && h > best)) best = h;
  }
  return best;
}

/** An explicit count of sessions or days beats every phrase: "15 个交易日" is not "5 个交易日". */
const SESSION_COUNT_RE = /(?<![\d.,])(\d{1,3})\s*(?:个)?\s*(?:交易日|sessions?|trading\s*days?|days?|天)(?![\d.])/i;

/** "3 weeks" / "2 个月": a count in weeks or months, converted to sessions and then snapped. */
const UNIT_COUNT_RE = /(?<![\d.,])(\d{1,3})\s*(?:个)?\s*(weeks?|周|星期|months?|月)(?![\d.])/i;

const HORIZON_PHRASES = [
  [1, ["overnight", "tomorrow", "next session", "next close", "one day", "1 day", "T+1",
       "隔夜", "明天", "明日", "次日", "一天", "1天", "一个交易日"]],
  [5, ["a week", "one week", "1 week", "this week", "next week", "five days",
       "一周", "1周", "一星期", "1星期", "本周", "下周", "这周", "五天", "5天", "五个交易日", "5个交易日"]],
  [10, ["two weeks", "2 weeks", "fortnight", "ten days",
        "两周", "2周", "二周", "两星期", "2星期", "十天", "10天", "十个交易日", "10个交易日"]],
  [20, ["a month", "one month", "1 month", "this month", "twenty days",
        "一个月", "1个月", "本月", "下个月", "二十天", "20天", "二十个交易日", "20个交易日"]],
  [40, ["two months", "2 months", "forty days",
        "两个月", "2个月", "四十天", "40天", "四十个交易日", "40个交易日"]],
  [60, ["three months", "3 months", "a quarter", "one quarter", "quarterly", "half a year", "sixty days",
        "三个月", "3个月", "一季度", "一个季度", "季度", "半年", "六十天", "60天", "六十个交易日", "60个交易日"]]
];

/** Longest phrase first, so "three months" is never read as "a month". */
const PHRASE_MATCHERS = (() => {
  const en = [], zh = [];
  for (const [h, list] of HORIZON_PHRASES) {
    for (const p of list) {
      if (CJK.test(p)) zh.push({ h, len: p.length, re: new RegExp(escapeRe(p)) });
      else en.push({ h, len: p.length, re: new RegExp(p.split(/\s+/).map(escapeRe).join("\\s+"), "i") });
    }
  }
  en.sort((a, b) => b.len - a.len);
  zh.sort((a, b) => b.len - a.len);
  return { en, zh };
})();

/* --------------------------------- dates ---------------------------------- */

const DAY_MS = 86400000;

function libDates(lib) {
  const d = lib && lib.dates;
  return Array.isArray(d) && d.length ? d : null;
}

function lastSession(lib) {
  const d = libDates(lib);
  if (d) return d[d.length - 1];
  return (lib && lib.to) || new Date().toISOString().slice(0, 10);
}

/** The last session on or before an ISO date, or the ISO date itself when no calendar is available. */
export function sessionOnOrBefore(dates, iso) {
  if (!Array.isArray(dates) || !dates.length) return iso;
  let lo = 0, hi = dates.length - 1, ans = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid] <= iso) { ans = dates[mid]; lo = mid + 1; } else hi = mid - 1;
  }
  return ans || dates[0];
}

function shiftIso(iso, days) {
  const t = Date.parse(String(iso) + "T00:00:00Z");
  return new Date((Number.isFinite(t) ? t : Date.now()) + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Relative dates are resolved against the LIBRARY's last session, not against the wall clock. A frozen
 * static bundle has no "today" that means anything to the data inside it, and a reviewer who opens the
 * demo three weeks after the build should still get the last session in the library when they type
 * "今天" - with the resolved date printed on the card, which is where the as-of session has always been.
 */
const DATE_RULES = [
  { how: "latest", days: 0, re: /\b(?:today|latest|current)\b|今天|今日|当前|现在|当下|目前/i },
  { how: "yesterday", days: -1, dur: () => 1, re: /\byesterday\b|昨天|昨日|上个交易日|上一交易日/i },
  { how: "last-week", days: -7, dur: () => 5, re: /\blast week\b|上周|上一周|上星期|上个星期|一周前|1周前/i },
  { how: "last-month", days: -30, dur: () => 20, re: /\blast month\b|上个月|上月|一个月前|1个月前/i },
  { how: "n-weeks-ago", days: null, per: -7, dur: (m) => Number(m[1]) * 5,
    re: /(\d{1,3})\s*(?:个)?\s*(?:weeks?|周|星期)\s*(?:ago|前)/i },
  { how: "n-sessions-ago", days: null, sessions: true, dur: (m) => Number(m[1]),
    re: /(\d{1,3})\s*(?:个)?\s*(?:交易日|sessions?)\s*(?:ago|前)/i },
  { how: "n-days-ago", days: null, per: -1, dur: (m) => Number(m[1]),
    re: /(\d{1,3})\s*(?:个)?\s*(?:calendar\s*)?(?:days?|天)\s*(?:ago|前)/i }
];

/**
 * "what happened over the last month" asks for a 20-session HORIZON; "as of last month" asks for an
 * as-of DATE. The words are the same, so the difference is read off what precedes them: a duration
 * marker turns the phrase into a horizon and leaves the as-of date alone (the dropdown, i.e. latest).
 */
const DURATION_MARK = /(?:over|in|for|during)\s+(?:the\s+)?(?:past|last|previous)?\s*$|(?:past|previous)\s+$|最近|过去|近$|这$/i

/* --------------------------- risk tolerance ------------------------------ */

/**
 * The one piece of personalisation the desk accepts: how much drawdown the person asking says they can
 * hold. It is a stated preference, not an inference - nothing is guessed about the user, and the answer
 * is computed from the same analog sample as everything else on the card (src/desk.mjs).
 */
const RISK_RES = [
  /(?:最大)?回撤\s*(?:不超过|低于|小于|控制在|不多于|<=|<|在|为)?\s*(\d{1,2}(?:\.\d+)?)\s*%/,
  /(?:承受|接受|容忍|承担|扛得住)\s*(?:最多\s*)?(?:到\s*)?(\d{1,2}(?:\.\d+)?)\s*%/,
  /止损\s*(?:设在|放在|位)?\s*(\d{1,2}(?:\.\d+)?)\s*%?/,
  /max(?:imum)?\s+(?:drawdown|draw[-\s]?down|loss)\s*(?:of|at|is|:|<=|<)?\s*(\d{1,2}(?:\.\d+)?)\s*%?/i,
  /drawdown\s*(?:no more than|under|below|of|<=|<|:)?\s*(\d{1,2}(?:\.\d+)?)\s*%?/i,
  /stop[\s-]*loss\s*(?:at|of|is|:)?\s*(\d{1,2}(?:\.\d+)?)\s*%?/i,
  /(?:can|could)\s+(?:i\s+)?(?:tolerate|take|hold|accept)\s*(?:a\s*)?(\d{1,2}(?:\.\d+)?)\s*%/i
];

/* ------------------------------ position direction ----------------------- */

/**
 * Which side of the instrument the sentence describes.
 *
 * This used to be invisible. "我想做空英伟达" and "buy NVDA" parsed to exactly the same request, and
 * the desk answered both with the long-side distribution: forward returns of the instrument itself,
 * and path risk measured as how far DOWN it traded. For a short that is the wrong tail - what hurts a
 * short is how far the price ran UP - so a trader who said "short" out loud was handed a card
 * describing the opposite position, with nothing on it saying so.
 *
 * The grammar is deliberately narrow. Only an explicit position word sets a direction: 止损 (a stop
 * level) and 看跌 (a bearish view) are not positions, and inferring a side from sentiment is exactly
 * the kind of confident wrong this desk refuses to print. When a direction IS detected the desk says
 * what it did and did not recompute (src/desk.mjs).
 */
const DIRECTION_RES = [
  { dir: "short", re: /做空|沽空|卖空|开空|空头(?:仓位|头寸)?|融券(?:卖出|做空)?|买入看跌|\bgo\s+short\b|\bsell\s+short\b|\bshorting\b|\bshort\s+(?:position|side|it|the)\b|\bbet\s+against\b|\bbuy\s+puts?\b|\bshort(?:ing)?\s+(?!term\b|run\b|story\b|answer\b|view\b|term\b|notice\b|order\b|list\b|sample\b)\$?[A-Z][A-Z0-9.\-]{0,6}\b/i },
  { dir: "long", re: /做多|开多|买入|买进|加仓|建仓|持有多头|买入看涨|\bgo\s+long\b|\bbuy\b|\blong\s+(?:position|side)\b/i }
];

/* --------------------------------- intent -------------------------------- */

/** Two instruments in one sentence. The desk analyses one at a time and has no comparison mode. */
const COMPARISON_RE = /\bvs\.?\b|\bversus\b|\bcompare(?:d)?\s+(?:to|with)\b|\bcompare\b|对比|比较|相比|哪个(?:更|好|强)|哪只(?:更|好|强)/i;

/**
 * The sentence is about an earnings report.
 *
 * Detected, disclosed, and deliberately NOT acted on. Snapping the as-of date to the nearest report
 * would quietly change which card was answered - and one of the canonical cards the replay cache was
 * warmed against IS an earnings question, so a silent snap would move its digest and cost the keyless
 * demo its model-written narrative. Instead the desk says why no date moved, and the UI offers the
 * report date as a one-click chip, so the trader chooses it rather than being handed it.
 *
 * Written with explicit ASCII lookarounds rather than \b on purpose. \b around the atom "earnings"
 * under the i flag evaluates to FALSE on this runtime (node v24) for a pattern whose .source and
 * .flags are byte-identical to one that evaluates to TRUE - verified with a fresh RegExp built from
 * the same source string, so it is a compile-path defect and not a typo. It cost English earnings
 * questions their disclosure while Chinese ones kept working, because 财报 uses no boundary at all.
 * Lookarounds are what the rest of this file already uses for latin words (ALIAS_LIST_LATIN) and
 * they do not depend on the affected path.
 */
const EARNINGS_RE = /财报|业绩(?:公告|发布|会)?|电话会议|业绩说明会|(?<![A-Za-z0-9_])earnings(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])EPS(?![A-Za-z0-9_])/i;

/**
 * An explicit request to switch the answer's language.
 *
 * detectLang() counts CJK characters, so "用英文再说一遍" - a sentence asking for English, written in
 * Chinese - detected as Chinese, and the desk answered in the language the trader was trying to leave.
 * An explicit request outranks the character count.
 */
const LANGUAGE_REQUEST_RES = [
  { lang: "zh", re: /(?:用|换成|换回|改成|切换到|转为|以)\s*(?:中文|汉语|华语|普通话|国语)|(?:中文|汉语)\s*(?:回答|讲|说|再讲|再说|重新)|(?:in|switch\s+to|answer\s+in)\s+Chinese/i },
  { lang: "en", re: /(?:用|换成|换回|改成|切换到|转为|以)\s*(?:英文|英语|English)|(?:英文|英语)\s*(?:回答|讲|说|再讲|再说|重新)|(?:in|switch\s+to|answer\s+in)\s+English/i }
];

/* -------------------------------- symbols -------------------------------- */

function normalizeSymbols(lib) {
  const raw = (lib && lib.symbols) || [];
  return raw.map((s) => (typeof s === "string" ? s : s && s.symbol)).filter(Boolean);
}

/**
 * Repair one typo instead of erroring on it.
 *
 * A judge demoing this desk types fast. "NVDIA" used to produce "symbol not in analog library", which
 * is a correct sentence and a dead end. Fuzzy matching is bounded on purpose: only latin tokens of four
 * characters or more, distance 1 up to five characters and 2 beyond, first character fixed, and the
 * winner has to be UNIQUE - an ambiguous repair is worse than an error because it looks confident. The
 * repair is always reported (matchedHow: "fuzzy") so the UI and the API can say what was assumed.
 */
export function suggestSymbol(token, symbols) {
  const t = String(token || "").toUpperCase();
  if (t.length < 4 || !/^[A-Z0-9.\-]+$/.test(t)) return null;
  const max = t.length <= 5 ? 1 : 2;
  let best = null, ties = 0;
  for (const s of symbols) {
    if (s.length < 3 || s[0] !== t[0]) continue;
    const d = editDistance(t, s, max);
    if (d > max) continue;
    if (best == null || d < best.distance) { best = { symbol: s, distance: d }; ties = 1; }
    else if (d === best.distance) ties++;
  }
  if (!best || ties > 1) return null;
  return { symbol: best.symbol, token: t, distance: best.distance };
}

/* -------------------------------- parsing -------------------------------- */

const ALIAS_UPPER = new Map([...ALIASES.entries()].map(([a, s]) => [String(a).toUpperCase(), s]));
const ALIAS_KEYS_UPPER = [...ALIAS_UPPER.keys()].filter((a) => a.length >= 4 && !CJK.test(a));

/** Words that are about the sentence, not about an instrument. Never fuzzy-matched into a ticker. */
const STOPWORDS = new Set(["WHAT", "WILL", "WEEK", "WEEKS", "DAYS", "DAY", "NEXT", "THIS", "THAT", "WITH",
  "FROM", "HAVE", "DOES", "LOOK", "LOOKS", "SHOW", "TELL", "MEAN", "MEANS", "THE", "AND", "FOR", "YOU",
  "NOW", "AGO", "MONTH", "MONTHS", "YEAR", "TODAY", "LIKE", "ABOUT", "AFTER", "BEFORE", "STILL", "SHOULD",
  "WOULD", "COULD", "THERE", "THEIR", "THEM", "THEN", "THEY", "THAN", "THAT", "WHICH", "WHILE", "WHERE"]);

function blank(s, i, n) { return s.slice(0, i) + " ".repeat(n) + s.slice(i + n); }

/**
 * Parse one free-text trade idea.
 *
 * Conservative by construction: a ticker is accepted only if the analog library really contains it (or an
 * alias does), a repaired typo is reported rather than silently used, and anything this function cannot
 * determine stays null so the caller's own control (the dropdown, the default) decides. Deliberately no
 * clamping and no snapping here - the desk owns that and prints what it changed.
 */
export function parseIdea(text, lib = {}, opts = {}) {
  const q = String(text == null ? "" : text);
  const out = {
    raw: q,
    language: opts.language || detectLang(q),
    symbol: null, matched: null, matchedHow: null, suggestion: null,
    horizon: null, horizonRaw: null, horizonHow: null,
    date: null, dateHow: null,
    k: null, riskTolerancePct: null,
    // What the sentence asked for that a one-instrument, long-side, closed-grid answer cannot fully
    // carry. Every one of these is disclosed by the desk rather than dropped on the floor.
    direction: null, directionMatched: null,
    instruments: [], droppedInstruments: [], comparison: false,
    sectorProxy: null, ambiguousAlias: null, unheld: null,
    earningsIntent: false, languageRequest: null,
    // Set only by mergeContext(): whether an explicit switch has happened in this conversation.
    languageSticky: null
  };
  if (!q.trim()) return out;

  // An explicit language request outranks the CJK character count (see LANGUAGE_REQUEST_RES).
  for (const r of LANGUAGE_REQUEST_RES) if (r.re.test(q)) { out.languageRequest = r.lang; out.language = r.lang; break; }

  // Direction, comparison and earnings are read off the whole sentence and never move a grid value.
  for (const r of DIRECTION_RES) {
    const m = q.match(r.re);
    if (m) { out.direction = r.dir; out.directionMatched = m[0]; break; }
  }
  out.comparison = COMPARISON_RE.test(q);
  out.earningsIntent = EARNINGS_RE.test(q);

  const symbols = normalizeSymbols(lib);
  const known = new Set(symbols);
  const horizons = (lib && lib.horizons) || MEASURED_HORIZONS;
  const dates = libDates(lib);
  let work = q;

  // --- as-of date first, because "5 天前" is a date and must not be read as a 5-day horizon
  const iso = q.match(/\b(20\d{2})[-/.](\d{1,2})(?:[-/.](\d{1,2}))?\b/);
  if (iso) {
    out.date = iso[1] + "-" + iso[2].padStart(2, "0") + "-" + (iso[3] || "15").padStart(2, "0");
    out.dateHow = "iso";
    work = blank(work, iso.index, iso[0].length);
  } else {
    for (const r of DATE_RULES) {
      const m = q.match(r.re);
      if (!m) continue;
      const anchor = lastSession(lib);
      const pre = q.slice(Math.max(0, m.index - 18), m.index);
      if (r.dur && DURATION_MARK.test(pre)) {
        const want = r.dur(m);
        if (Number.isFinite(want) && want > 0) {
          out.horizonRaw = want;
          out.horizon = nearestHorizon(want, horizons);
          out.horizonHow = "duration";
          work = blank(work, m.index, m[0].length);
          break;
        }
      }
      if (r.days === 0) { out.date = "latest"; out.dateHow = "latest"; }
      else if (r.sessions) {
        const n = Number(m[1]);
        out.date = dates && dates.length > n ? dates[dates.length - 1 - n] : shiftIso(anchor, -Math.ceil(n * 7 / 5));
        out.dateHow = "n-sessions-ago";
      } else if (r.days != null) {
        out.date = sessionOnOrBefore(dates, shiftIso(anchor, r.days));
        out.dateHow = r.how;
      } else {
        out.date = sessionOnOrBefore(dates, shiftIso(anchor, r.per * Number(m[1])));
        out.dateHow = r.how;
      }
      work = blank(work, m.index, m[0].length);
      break;
    }
  }

  // --- horizon: an explicit count of sessions/days beats every phrase
  const cnt = work.match(SESSION_COUNT_RE);
  const unit = cnt ? null : work.match(UNIT_COUNT_RE);
  if (cnt) {
    out.horizonRaw = Number(cnt[1]);
    out.horizon = nearestHorizon(out.horizonRaw, horizons);
    out.horizonHow = "sessions";
  } else if (unit) {
    const n = Number(unit[1]);
    const isMonth = /months?|月/i.test(unit[2]);
    out.horizonRaw = Math.round(n * (isMonth ? 20 : 5));
    out.horizon = nearestHorizon(out.horizonRaw, horizons);
    out.horizonHow = "units";
  } else {
    const packed = work.replace(/\s+/g, "");
    for (const p of PHRASE_MATCHERS.en) if (p.re.test(work)) { out.horizon = p.h; out.horizonHow = "phrase"; break; }
    if (out.horizon == null) {
      for (const p of PHRASE_MATCHERS.zh) if (p.re.test(packed)) { out.horizon = p.h; out.horizonHow = "phrase"; break; }
    }
  }

  // --- neighbour count, raw: the desk clamps it and says so
  //
  // The Chinese patterns were added after a reviewer-facing test exposed the gap: "KWEB with 100
  // neighbours" parsed k=100 and produced a card that disclosed the deviation from the validated
  // k=50, while "把 KWEB 的 k 调到 100 再看看" parsed nothing at all and silently ran k=50. Same
  // request, two languages, and one of them answered a different question than the one asked.
  const km = q.match(/\b(?:k|top|neighbou?rs?|analog(?:ue)?s?)\s*[=:：]?\s*(\d{1,3})\b/i)
    || q.match(/\b(\d{1,3})\s*(?:neighbou?rs?|analog(?:ue)?s?|matches|episodes)\b/i)
    // k first, then a Chinese connective, then the number: "把 k 调到 100"
    || q.match(/\bk\s*(?:值)?\s*(?:调到|调至|调成|设为|设置为|设成|改成|改为|换成|换到|取|用|要|为|是)\s*(\d{1,3})/i)
    // the number first, then the noun: "用 100 个类比"
    || q.match(/(\d{1,3})\s*个?\s*(?:类比|相似样本|相似片段|历史样本|近邻|邻居|样本)/)
    || q.match(/(?:邻居|类比数|近邻|样本数)\s*[=:：]?\s*(\d{1,3})/);
  if (km) {
    const v = Number(km[1]);
    if (Number.isFinite(v) && v > 0) out.k = v;
  }

  // --- stated drawdown tolerance (personalisation)
  for (const re of RISK_RES) {
    const m = q.match(re);
    if (!m) continue;
    const v = Number(m[1]);
    if (Number.isFinite(v) && v > 0) { out.riskTolerancePct = Math.min(50, Math.max(1, v)); break; }
  }

  // --- instrument: exact ticker, then an alias phrase, then an alias word, then one bounded repair
  const upper = q.toUpperCase();
  const tokenList = [...upper.matchAll(TOKEN_RE)];
  const tokens = tokenList.map((m) => m[0]);
  // The token in the casing the user actually typed, for the hint line: "nvida", not "NVIDA".
  const rawOf = (tok) => {
    const m = tokenList.find((x) => x[0] === tok);
    return m ? q.slice(m.index, m.index + m[0].length) : tok;
  };
  // An exact ticker, on a pass of its own. It used to share a loop with the single-word alias lookup,
  // so the first token that was ANY alias won: "the oil painting of TSLA" was answered as XLE,
  // because "oil" sits earlier in the sentence than the ticker does. A symbol that exists in this
  // library outranks every word that happens to appear beside it.
  for (const tok of tokens) {
    const clean = tok.replace(/^\$/, "");
    if (known.has(clean)) { out.symbol = clean; out.matched = rawOf(tok); out.matchedHow = "exact"; break; }
  }
  /*
   * A named instrument this library does not hold, and the span of the sentence it occupies.
   *
   * Detected before any repair path, and detected even when a held symbol was already found, because
   * the two are different problems and both deserve an answer:
   *
   *   - 超微电脑 must not resolve to AMD through the shorter alias 超微 sitting inside it. That alias
   *     match is a FRAGMENT of the unheld name, not a second instrument, so it is excluded by span.
   *   - "比特币和英伟达怎么看" names one instrument this desk does not hold and one it does. Refusing
   *     the whole sentence would be hiding behind a limitation, so 英伟达 still resolves and BTC is
   *     disclosed beside it.
   *
   * Excluding the span rather than the sentence is what makes both of those true at once.
   */
  let unheldSpan = null;
  for (const a of UNHELD_LIST) {
    const at = CJK.test(a)
      ? q.indexOf(a)
      : upper.search(new RegExp("(?<![A-Z0-9])" + escapeRe(a) + "(?![A-Z0-9])"));
    if (at < 0) continue;
    const meta = UNHELD_ALIASES.get(a);
    out.unheld = { word: CJK.test(a) ? a : rawUnheld(a, q, upper), name: meta.name, ticker: meta.ticker,
      why: meta.why, whyZh: meta.whyZh || null };
    unheldSpan = [at, at + a.length];
    break;
  }
  /** True when [at, at+len) lies inside the span an unheld name already occupies. */
  const insideUnheld = (at, len) => unheldSpan != null && at >= unheldSpan[0] && at + len <= unheldSpan[1];

  /*
   * Alias PHRASES before alias WORDS, longest first.
   *
   * ALIASES is built from every universe name and the first word of every name, so it holds both
   * "CHINA CONCEPT STOCKS" -> KWEB and "CHINA" -> FXI (the first word of "China Large-Cap"). A
   * token-by-token lookup takes whichever the sentence mentions first and answered the wrong fund;
   * this scan is sorted by length, so the specific reading beats the fragment it contains.
   *
   * Both scans run ahead of the typo repair even though the repair is the weaker signal, because they
   * match on WORD BOUNDARIES: a bounded "DIA" cannot be found inside "NVDIA", so the accidental
   * substring the repair used to have to outrun no longer exists.
   */
  if (!out.symbol) {
    for (const a of ALIAS_LIST_CJK) {
      const at = upper.indexOf(a);
      if (at < 0 || insideUnheld(at, a.length)) continue;
      const via = ALIASES.get(a);
      if (via && known.has(via)) { out.symbol = via; out.matched = a; out.matchedHow = "alias"; break; }
    }
  }
  if (!out.symbol) {
    for (const { a, re } of ALIAS_LIST_LATIN) {
      const m = re.exec(upper);
      if (!m || insideUnheld(m.index, a.length)) continue;
      const via = ALIASES.get(a);
      if (via && known.has(via)) { out.symbol = via; out.matched = a; out.matchedHow = "alias"; break; }
    }
  }
  // A whole-token alias, for keys the word-boundary scan skips: ALIAS_LIST_LATIN starts at three
  // characters, and a shorter alias can still be an entire token.
  if (!out.symbol) {
    for (const m of tokenList) {
      const clean = m[0].replace(/^\$/, "");
      if (insideUnheld(m.index, m[0].length)) continue;
      const via = ALIASES.get(clean) || ALIAS_UPPER.get(clean);
      if (via && known.has(via)) { out.symbol = via; out.matched = rawOf(m[0]); out.matchedHow = "alias"; break; }
    }
  }
  // One bounded typo repair, and the last resort: it is the only path here that guesses.
  if (!out.symbol && opts.fuzzy !== false) {
    for (const m of tokenList) {
      const clean = m[0].replace(/^\$/, "");
      if (STOPWORDS.has(clean) || insideUnheld(m.index, m[0].length)) continue;
      const s = suggestSymbol(clean, symbols);
      if (s) { out.symbol = s.symbol; out.matched = rawOf(m[0]); out.matchedHow = "fuzzy"; out.suggestion = s; break; }
    }
    if (!out.symbol) {
      for (const m of tokenList) {
        const clean = m[0].replace(/^\$/, "");
        if (STOPWORDS.has(clean) || insideUnheld(m.index, m[0].length)) continue;
        const s = suggestSymbol(clean, ALIAS_KEYS_UPPER);
        const via = s && ALIAS_UPPER.get(s.symbol);
        if (via && known.has(via)) {
          out.symbol = via; out.matched = rawOf(m[0]); out.matchedHow = "fuzzy";
          out.suggestion = { symbol: via, token: clean, distance: s.distance, viaAlias: s.symbol };
          break;
        }
      }
    }
  }

  /*
   * A sector, basket or commodity word resolves to ONE instrument, and that substitution is a real
   * loss of meaning rather than a harmless synonym: "半导体" is not NVDA, and "原油" is not a
   * crude-oil return. The word is tagged here so the desk can print what was asked for, what was
   * actually analysed, and why the two are not the same thing.
   */
  if (out.symbol && out.matched) {
    // A repair reached through an alias key ("chip" -> CHIPS) carries that key in suggestion.viaAlias.
    // Looking the tag up under the typed word instead would lose it exactly where the trader was
    // loosest with the sector word, which is where the disclosure matters most.
    const key = String((out.suggestion && out.suggestion.viaAlias) || out.matched).toUpperCase();
    const sp = SECTOR_PROXIES.get(key);
    if (sp && sp.symbol === out.symbol) {
      out.sectorProxy = { word: String(out.matched), want: sp.want, have: sp.have, why: sp.why, whyZh: sp.whyZh || null, symbol: sp.symbol };
      if (out.matchedHow !== "exact") out.matchedHow = "sector-proxy";
    }
    const amb = AMBIGUOUS_ALIASES.get(key);
    if (amb && amb.symbol === out.symbol) {
      out.ambiguousAlias = { word: String(out.matched), also: amb.also, why: amb.why, whyZh: amb.whyZh || null, symbol: amb.symbol };
    }
  }

  /*
   * Every OTHER instrument the sentence named.
   *
   * The desk analyses one instrument at a time and has no comparison mode, so "NVDA vs AMD 哪个现在
   * 风险收益比更好" used to become a single-name NVDA card that never mentioned AMD at all - a
   * question half-answered and looking whole. The extra names are carried out so the desk prints
   * them and the UI can offer a one-click switch to each. They are deliberately NOT merged into the
   * analysis: two instruments' analog sets averaged together would describe neither.
   *
   * Only tokens of three characters or more are considered, and stopwords are skipped, so an
   * incidental short token that happens to equal a ticker (CAT, DIA, THE) is not reported as a
   * second instrument the trader asked about.
   */
  if (out.symbol) {
    out.instruments.push({ symbol: out.symbol, matched: out.matched });
    const seen = new Set([out.symbol]);
    const primary = String(out.matched || "").toUpperCase();
    // A FRAGMENT of the matched phrase is not a second instrument. "hang seng tech" resolves through
    // the alias HANG SENG TECH -> KWEB, but the bare word "tech" is itself an alias (for XLK, the
    // first word of "Tech Select ETF"), and reporting XLK beside it invents a comparison the trader
    // never made - a disclosure that is itself wrong, which is worse than no disclosure.
    const fragment = (m) => { const s = String(m || "").toUpperCase(); return primary.length > s.length && primary.includes(s); };
    const take = (sym, matched) => {
      if (!sym || seen.has(sym) || fragment(matched)) return;
      seen.add(sym);
      out.droppedInstruments.push({ symbol: sym, matched });
      out.instruments.push({ symbol: sym, matched });
    };
    for (const tok of tokens) {
      const clean = tok.replace(/^\$/, "");
      if (clean.length < 3 || STOPWORDS.has(clean) || clean === primary) continue;
      if (known.has(clean)) take(clean, rawOf(tok));
      else { const via = ALIASES.get(clean) || ALIAS_UPPER.get(clean); if (via && known.has(via)) take(via, rawOf(tok)); }
    }
    // Chinese names the latin token scan cannot see at all. Longest alias first, and each match is
    // consumed, so "阿里巴巴" cannot also report "阿里" as a second instrument.
    const mask = new Array(q.length).fill(false);
    for (const a of ALIAS_LIST_CJK) {
      let idx = q.indexOf(a);
      while (idx >= 0) {
        let free = true;
        for (let t = idx; t < idx + a.length; t++) if (mask[t]) { free = false; break; }
        if (free) {
          for (let t = idx; t < idx + a.length; t++) mask[t] = true;
          const via = ALIASES.get(a);
          if (via && known.has(via)) take(via, a);
          break;
        }
        idx = q.indexOf(a, idx + 1);
      }
    }
    out.droppedInstruments = out.droppedInstruments.filter((d) => d.symbol !== out.symbol);
    out.instruments = out.instruments.filter((d, i, arr) => arr.findIndex((x) => x.symbol === d.symbol) === i);
  }

  return out;
}

/**
 * Follow-up sentences are usually partial: "那 20 天呢？" carries a horizon and nothing else. Inheriting
 * the rest of the previous request is what makes the desk read as a conversation rather than a form, and
 * every inherited field is reported so the caller can print what it assumed instead of hiding it.
 */
export function mergeContext(prev, next) {
  const out = Object.assign({}, next, { inherited: [], changed: [] });
  if (!prev) return out;
  /*
   * Whether an explicit language switch has happened at all in this conversation.
   *
   * languageRequest itself stays per-turn - explain() prints "(requested)" beside the one turn that
   * asked for it and no other - but the switch it made is sticky. Without this the request held for
   * exactly one answer, and the next fragment, written in the language the trader had just asked to
   * leave, flipped the whole desk back.
   */
  const stickyLang = out.languageRequest || prev.languageSticky || null;
  // The conversation language is kept even when nothing else is: see the unheld early return below.
  const keepLanguage = () => {
    if (out.languageRequest) out.language = out.languageRequest;
    else if (stickyLang && prev.language) out.language = prev.language;
    out.languageSticky = stickyLang;
  };

  /*
   * A sentence that NAMES an instrument this library does not hold is not a fragment about the
   * previous one, so nothing is inherited from it. Carrying the old symbol across would answer a
   * question nobody asked: 台积电 typed after a QQQ card would produce another QQQ card, with a
   * full model-written narrative behind it, and the refusal the trader was owed would never appear.
   * An unheld name ends the topic instead of being quietly overridden by it.
   */
  if (out.unheld && !next.symbol) { keepLanguage(); return out; }

  /*
   * Fields that describe the request, and therefore carry forward when the next sentence is silent
   * about them. "direction" and the two alias tags belong here because a follow-up such as
   * "k 改成 100" is still about the short position the trader named two sentences ago.
   */
  const CARRY = ["symbol", "horizon", "horizonRaw", "horizonHow", "date", "dateHow", "k",
                 "riskTolerancePct", "direction", "directionMatched", "sectorProxy", "ambiguousAlias"];
  const NAMED = new Set(["symbol", "horizon", "date", "k", "riskTolerancePct", "direction"]);
  /*
   * Provenance of a value, not a value in its own right, so each one is carried only when the field
   * it describes was carried. Without this, "asked for 5" survived into a turn that asked for 20 and
   * the parse line printed the PREVIOUS sentence's raw wording beside this sentence's number - a
   * disclosure that reads as a contradiction, which is worse than printing nothing. CARRY is ordered
   * so every owner precedes its own provenance, which is what makes one forward pass enough.
   */
  const PROVENANCE = { horizonRaw: "horizon", horizonHow: "horizon", dateHow: "date",
                       directionMatched: "direction", sectorProxy: "symbol", ambiguousAlias: "symbol" };
  const carried = new Set();

  for (const f of CARRY) {
    const empty = out[f] == null || out[f] === "";
    if (empty && prev[f] != null && prev[f] !== "") {
      if (PROVENANCE[f] && !carried.has(PROVENANCE[f])) continue;
      out[f] = prev[f];
      carried.add(f);
      if (NAMED.has(f)) out.inherited.push(f);
    } else if (!empty && NAMED.has(f) && prev[f] != null && prev[f] !== "" && prev[f] !== out[f]) {
      // Reported separately from "inherited": "carried over" and "you changed this" are different
      // statements, and a desk that shows only the first one hides the edit it just applied.
      out.changed.push(f);
    }
  }

  // An explicit language switch applies to THIS answer, and the switched-to language then persists as
  // the conversation's language - so "用英文再说一遍" followed by "那 20 天呢" stays in English.
  keepLanguage();

  // Intent flags (comparison, earnings) describe the current sentence, not the conversation, so they
  // are deliberately NOT inherited: a stale "you asked to compare two names" on a card that no longer
  // mentions the second one would be a disclosure of nothing.
  if (out.symbol && !out.instruments.some((x) => x.symbol === out.symbol)) {
    out.instruments = [{ symbol: out.symbol, matched: out.matched },
      ...out.instruments.filter((x) => x.symbol !== out.symbol)];
  }
  return out;
}

/**
 * The next four things a trader usually asks, as sentences the parser already understands. Rendered as
 * chips under a finished card so the desk can be driven entirely by typing - and so a reviewer never has
 * to guess the grammar.
 */
export function followUpSuggestions(parsed = {}, opts = {}) {
  const zh = String(opts.language || parsed.language || "en") === "zh";
  const list = opts.horizons || MEASURED_HORIZONS;
  const H = parsed.horizon || 5;
  const context = [];
  // The desk analyses one instrument at a time, so a comparison question is answered for the first
  // name only. Offering the second as a chip turns a disclosed limitation into one click.
  for (const d of (opts.droppedInstruments || parsed.droppedInstruments || []).slice(0, 2)) {
    context.push(zh
      ? { label: "换成 " + d.symbol, q: d.symbol + " 未来 " + H + " 个交易日，历史相似状态的分布和最大回撤" }
      : { label: "switch to " + d.symbol, q: d.symbol + " over the next " + H + " sessions: the distribution of the historical analogs and the worst drawdown" });
  }
  // An earnings question does not move the as-of date on its own (see EARNINGS_RE). The report date
  // is offered instead, so the trader chooses it rather than being handed a card they did not ask for.
  const earnDate = opts.earningsDate || null;
  if (earnDate && (parsed.earningsIntent || opts.earningsIntent)) {
    const esym = parsed.symbol || opts.fallbackSymbol || "SPY";
    context.push(zh
      ? { label: "移到财报日 " + earnDate, q: esym + " 截至 " + earnDate + "，未来 " + H + " 个交易日" }
      : { label: "as of the report " + earnDate, q: esym + " as of " + earnDate + " over " + H + " sessions" });
  }
  const at = list.indexOf(H);
  const i = at < 0 ? 1 : at;
  const longer = list[Math.min(list.length - 1, i + 1)];
  const shorter = list[Math.max(0, i - 1)];
  const sym = parsed.symbol || opts.fallbackSymbol || "SPY";
  const other = opts.alternateSymbol && opts.alternateSymbol !== sym ? opts.alternateSymbol : (sym === "SPY" ? "QQQ" : "SPY");
  const tol = parsed.riskTolerancePct || 10;
  const out = [];
  const sess = (n) => (n === 1 ? "1 session" : n + " sessions");
  if (longer !== H) out.push(zh
    ? { label: longer + " 个交易日", q: sym + " 未来 " + longer + " 个交易日呢？" }
    : { label: sess(longer), q: "What about " + sym + " over " + longer + " sessions?" });
  if (shorter !== H) out.push(zh
    ? { label: shorter + " 个交易日", q: sym + " 换成 " + shorter + " 个交易日" }
    : { label: sess(shorter), q: "Same state, " + sym + " over " + shorter + " sessions" });
  out.push(zh
    ? { label: "承受 " + tol + "% 回撤", q: sym + " 未来 " + H + " 个交易日，我能承受 " + tol + "% 的回撤吗？" }
    : { label: tol + "% drawdown?", q: "Can I tolerate a " + tol + "% drawdown on " + sym + " over " + H + " sessions?" });
  out.push(zh
    ? { label: "上个月", q: sym + " 上个月的情况怎么样？" }
    : { label: "as of last month", q: "How did this state look for " + sym + " as of last month?" });
  out.push(zh
    ? { label: "换成 " + other, q: other + " 未来 " + H + " 个交易日" }
    : { label: "switch to " + other, q: "Now " + other + " over " + H + " sessions" });
  return context.concat(out).slice(0, opts.limit || 4);
}

/**
 * One-line trace of what the parser understood, for the API response and the MCP tool output.
 *
 * This is where a narrowing of the question becomes visible. A trace that lists only what the desk
 * decided to answer is indistinguishable from a trace of what was asked, and the difference between
 * those two is the whole disclosure.
 */
export function explain(parsed = {}, opts = {}) {
  const zh = String(opts.language || parsed.language || "en") === "zh";
  const bits = [];
  if (parsed.symbol) {
    const how = parsed.matchedHow === "fuzzy"
      ? (zh ? "（由 " + parsed.matched + " 模糊匹配）" : " (fuzzy from " + parsed.matched + ")")
      : parsed.matchedHow === "alias"
        ? (zh ? "（别名 " + parsed.matched + "）" : " (alias " + parsed.matched + ")")
        : "";
    bits.push((zh ? "标的 " : "symbol ") + parsed.symbol + how);
  } else bits.push(zh ? "未识别标的" : "no symbol recognised");
  if (parsed.horizon) bits.push((zh ? "期限 " : "horizon ") + parsed.horizon + (zh ? " 个交易日" : " sessions")
    + (parsed.horizonRaw && parsed.horizonRaw !== parsed.horizon ? (zh ? "（由 " + parsed.horizonRaw + " 对齐）" : " (from " + parsed.horizonRaw + ")") : ""));
  if (parsed.sectorProxy) bits.push(zh
    ? "「" + parsed.sectorProxy.word + "」是板块/篮子词，本库无对应标的，已用 " + parsed.sectorProxy.symbol + " 代替"
    : '"' + parsed.sectorProxy.word + '" is a sector word; resolved to ' + parsed.sectorProxy.symbol);
  if (parsed.ambiguousAlias) bits.push(zh
    ? "「" + parsed.ambiguousAlias.word + "」有歧义，已取 " + parsed.ambiguousAlias.symbol
    : '"' + parsed.ambiguousAlias.word + '" is ambiguous; resolved to ' + parsed.ambiguousAlias.symbol);
  if (parsed.direction) bits.push((zh ? "方向 " : "direction ") + (parsed.direction === "short" ? (zh ? "做空" : "short") : (zh ? "做多" : "long")));
  if (parsed.date) bits.push((zh ? "截至 " : "as of ") + parsed.date + (parsed.dateHow && parsed.dateHow !== "iso" ? " (" + parsed.dateHow + ")" : ""));
  if (parsed.k) bits.push("k=" + parsed.k);
  if (parsed.riskTolerancePct) bits.push((zh ? "可承受回撤 " : "drawdown tolerance ") + parsed.riskTolerancePct + "%");
  if ((parsed.droppedInstruments || []).length) bits.push(zh
    ? "未分析：" + parsed.droppedInstruments.map((d) => d.symbol).join("、")
    : "not analysed: " + parsed.droppedInstruments.map((d) => d.symbol).join(", "));
  if (parsed.earningsIntent) bits.push(zh ? "提到财报（未改动截至日）" : "mentions earnings (as-of date unchanged)");
  bits.push((zh ? "语言 中文" : "language en") + (parsed.languageRequest ? (zh ? "（本轮指定）" : " (requested)") : ""));
  return bits.join(" · ");
}
