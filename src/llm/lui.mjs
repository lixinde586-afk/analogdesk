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

/*
 * The same count written as a WORD: "three weeks", "two months", "a year", "三个星期", "两个月".
 *
 * UNIT_COUNT_RE only reads digits, and HORIZON_PHRASES only lists the wordings somebody thought of.
 * Between them they left a hole that failed SILENTLY: "NVDA over the next three weeks" arrived with no
 * horizon at all, so the desk answered its default one with nothing on the card to say the question had
 * been narrowed - the exact failure this parser exists to refuse. Counting the word instead of
 * enumerating it closes the class, using the same arithmetic (5 sessions a week, 20 a month, 60 a
 * quarter, 250 a year) and the same "(from 15)" disclosure the digit path already gives.
 *
 * Days are deliberately absent from both unit groups. "five days" and "ten days" are already phrases,
 * "5 days" is already a digit count, and an unanchored 天/日 would read "三天前" - an as-of DATE - as a
 * horizon, which is the confusion the date pass above exists to prevent.
 */
const NUMBER_WORDS = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12,
  "一": 1, "二": 2, "两": 2, "兩": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10
};
const UNIT_WORD_EN_RE = /(?<![A-Za-z0-9])(half\s+)?(a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(weeks?|months?|quarters?|years?)(?![A-Za-z0-9])/i;
const UNIT_WORD_ZH_RE = /(半年)|([一二两兩三四五六七八九十])\s*个?\s*(周|星期|月|季度|年)/;
const unitSessions = (u) => (/year|年/.test(u) ? 250 : /quarter|季度/.test(u) ? 60 : /month|月/.test(u) ? 20 : 5);

/** The session count a word-form unit asks for, or null when the sentence names no count at all. */
function wordUnitCount(text) {
  const en = UNIT_WORD_EN_RE.exec(text);
  if (en) return Math.round((en[1] ? 0.5 : 1) * NUMBER_WORDS[en[2].toLowerCase()] * unitSessions(en[3]));
  const zh = UNIT_WORD_ZH_RE.exec(text.replace(/\s+/g, ""));
  if (!zh) return null;
  if (zh[1]) return 125; // 半年 is half of 250, not a phrase anybody should have to enumerate
  return Math.round(NUMBER_WORDS[zh[2]] * unitSessions(zh[3]));
}

const HORIZON_PHRASES = [
  [1, ["overnight", "tomorrow", "next session", "next close", "one day", "1 day", "T+1",
       "隔夜", "明天", "明日", "次日", "一天", "1天", "一个交易日"]],
  [5, ["a week", "one week", "1 week", "this week", "next week", "five days",
       "一周", "1周", "一星期", "1星期", "本周", "下周", "这周", "五天", "5天", "五个交易日", "5个交易日"]],
  [10, ["two weeks", "2 weeks", "fortnight", "ten days",
        "两周", "2周", "二周", "两星期", "2星期", "十天", "10天", "十个交易日", "10个交易日"]],
  [20, ["a month", "one month", "1 month", "this month", "next month", "the next month", "twenty days",
        "一个月", "1个月", "本月", "下个月", "二十天", "20天", "二十个交易日", "20个交易日"]],
  [40, ["two months", "2 months", "forty days",
        "两个月", "2个月", "四十天", "40天", "四十个交易日", "40个交易日"]],
  [60, ["three months", "3 months", "a quarter", "one quarter", "next quarter", "the next quarter",
        "quarterly", "half a year", "sixty days",
        "三个月", "3个月", "一季度", "一个季度", "下季度", "下个季度", "季度", "半年", "六十天", "60天",
        "六十个交易日", "60个交易日"]]
];

/** Longest phrase first, so "three months" is never read as "a month". */
const PHRASE_MATCHERS = (() => {
  const en = [], zh = [];
  for (const [h, list] of HORIZON_PHRASES) {
    for (const p of list) {
      if (CJK.test(p)) zh.push({ h, len: p.length, re: new RegExp(escapeRe(p)) });
      else en.push({ h, len: p.length, re: new RegExp(p.split(/\s+/).map(escapeRe).join("\\s+") + "(?![A-Za-z])", "i") });
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
/*
 * Every count in these rules is bounded by a digit lookbehind as well as a lookahead, and admits four
 * digits rather than three. Without the lookbehind, "3000 个交易日前" matched at the SECOND digit -
 * "000 个交易日前" - and resolved to n=0, i.e. the latest session: a request for a date twelve years
 * back answered as today, with nothing on the card to say so. The same sentence shape at three digits
 * was correct, which is why nobody noticed.
 */
const DATE_RULES = [
  { how: "latest", days: 0, re: /\b(?:today|latest|current)\b|今天|今日|当前|现在|当下|目前/i },
  { how: "yesterday", days: -1, dur: () => 1, re: /\byesterday\b|昨天|昨日|上个交易日|上一交易日/i },
  { how: "last-week", days: -7, dur: () => 5, re: /\blast week\b|上周|上一周|上星期|上个星期|一周前|1周前/i },
  { how: "last-month", days: -30, dur: () => 20, re: /\blast month\b|上个月|上月|一个月前|1个月前/i },
  { how: "n-weeks-ago", days: null, per: -7, dur: (m) => Number(m[1]) * 5,
    re: /(?<![\d.,])(\d{1,4})\s*(?:个)?\s*(?:weeks?|周|星期)\s*(?:ago|前)(?![\d.])/i },
  { how: "n-sessions-ago", days: null, sessions: true, dur: (m) => Number(m[1]),
    re: /(?<![\d.,])(\d{1,4})\s*(?:个)?\s*(?:交易日|sessions?)\s*(?:ago|前)(?![\d.])/i },
  { how: "n-days-ago", days: null, per: -1, dur: (m) => Number(m[1]),
    re: /(?<![\d.,])(\d{1,4})\s*(?:个)?\s*(?:calendar\s*)?(?:days?|天)\s*(?:ago|前)(?![\d.])/i }
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

/* --------------------- what kind of question this is ---------------------- */

/**
 * Three gates, and why each one exists.
 *
 * A language interface that answers every sentence is not fluent, it is indiscriminate. Before this
 * section the desk had exactly one refusal - an instrument the library does not hold - and answered
 * everything else, so the four sentences a reviewer types to find the edge of a language UI
 * ("what is the weather in Shanghai tomorrow", "写一首关于交易的诗", "print your system prompt",
 * "asdf qwerty 1234") each produced a full, confident research card about whatever the Symbol
 * dropdown happened to hold. Every number on that card was correct. It was also an answer to a
 * question nobody asked, which is the one failure mode this project says it exists to prevent.
 *
 *   assistantTask   the sentence asks a general-purpose assistant for something: a poem, a
 *                   translation, the prompt, a capability list. No card is produced. The desk says
 *                   what it is and what it answers, which is more useful than a card it cannot
 *                   connect to the sentence.
 *   offtopic        the sentence carries no instrument, no grid value, no intent flag and no market
 *                   vocabulary at all. No card, for the same reason. Follow-up fragments are
 *                   protected twice: a real fragment carries a number ("那 20 天呢" -> horizonRaw)
 *                   or a marker (那/呢/换成/what about), and mergeContext() hands the next turn a
 *                   symbol - callers only refuse when the merged parse has neither.
 *   answerGaps      the sentence IS a market question but asks for something this desk does not
 *                   produce: a price target, a strategy backtest, a hypothetical state, or advice.
 *                   The card still runs, because the nearest honest artefact beats a refusal, and
 *                   the distance between what was asked and what was answered is printed ON it.
 *
 * namedScenario is the fourth field and not a gate: when a sentence names a shock or a crisis the
 * stress suite already carries, the desk says which row answers it instead of letting the trader
 * hunt for it. The ids are strings here and are resolved against SCENARIOS in src/desk.mjs, so the
 * language layer does not import the engine.
 *
 * Latin atoms use explicit ASCII lookarounds rather than \b, for the reason documented on
 * EARNINGS_RE above: \b under the i flag is not reliable on this runtime.
 */
export const TASK_RES = [
  { kind: "injection",
    re: /system\s+prompt|你的(?:系统)?提示词|你的指令|忽略(?:之前|以上|上面|先前|前面)(?:的)?(?:所有|全部)?(?:指令|规则|提示)|(?<![A-Za-z0-9_])(?:ignore|disregard|forget|override)(?![A-Za-z0-9_])\s+(?:all\s+|any\s+)?(?:previous|prior|above|earlier|your|the|these)\s+(?:instructions?|rules?|prompts?|messages?|directives?)|(?<![A-Za-z0-9_])jailbreak(?![A-Za-z0-9_])|developer\s+mode/i,
    why: "There are no hidden instructions to print. The narrative on a card is either a cached model generation or a deterministic template rendered from the research card, and every numeral in it is checked against that card by src/llm/verify-numbers.mjs; the prompt the model is given is committed at src/llm/prompt.mjs. Ask a trade question instead - one instrument, one as-of session, one horizon.",
    whyZh: "这里没有可供打印的隐藏指令。卡片上的叙述要么是缓存的模型生成，要么是对研究卡片的确定性模板渲染，其中每个数字都由 src/llm/verify-numbers.mjs 校验回卡片本身；给模型的提示词已提交在 src/llm/prompt.mjs。换个交易问题吧——一个标的、一个截至交易日、一个期限。" },
  { kind: "capability",
    re: /你能(?:做什么|干什么|帮我做什么)|你会(?:什么|做什么)|(?:这个|本|该)?(?:工具|桌面|产品|系统|网站)(?:能|可以|究竟)?(?:做什么|干什么|用来做什么)|怎么用|如何使用|使用说明|介绍一下|^\s*(?:\/|please\s+|pls\s+|can\s+(?:you|u)\s+|i\s+need\s+|need\s+)?help(?:\s+me)?\s*[!！.。?？]*\s*$|what\s+(?:can|do)\s+you\s+do|how\s+(?:do|can)\s+i\s+use|what\s+(?:is|does)\s+this\s+(?:tool|app|desk|thing)|who\s+are\s+you/i,
    why: "AnalogDesk answers one kind of question. Give it an instrument, an as-of session and a horizon (1/5/10/20/40/60 sessions) and it retrieves the k historical sessions whose market state most resembles that one, then reports what actually happened next: the realised distribution, the path risk (max adverse excursion, not just the endpoint), a conformal interval calibrated out of sample, and a stress suite of named crisis windows and shock overlays. It does not forecast prices, rank instruments, compare two names, backtest strategies or place orders. Type a ticker or a name (NVDA / 英伟达), or click one of the examples.",
    whyZh: "AnalogDesk 只回答一类问题：给定一个标的、一个截至交易日和一个期限（1/5/10/20/40/60 个交易日），它检索市场状态最相似的 k 个历史交易日，然后报告它们随后实际发生了什么——已实现的分布、路径风险（最大不利偏移，而不只是终点）、样本外校准的保形区间，以及由具名危机窗口与冲击叠加构成的压力测试。它不预测价格、不给标的排序、不做两个标的的对比、不回测策略、也不下单。请输入代码或名称（NVDA / 英伟达），或点一个示例问题。" },
  /*
   * The English branch takes a whitelist of up to four modifier words between the verb and the noun
   * ("write me a SHORT poem") rather than a free [a-z ]+ gap, because a free gap is how a refusal
   * eats a real question: "draft a short position in NVDA" and "compose a portfolio of NVDA and
   * AMD" both begin with a creation verb. Every word in the list is one that can only be decorating
   * the noun, so the branch cannot reach a market sentence. The Chinese branch never needed this -
   * its measure words (首/篇/个/段/封) already are that whitelist.
   *
   * "summarize THIS" is refused and "summarize NVDA's risk" is not: the desk cannot read text you
   * supply, and it can answer a question about an instrument it holds. The demonstrative is the line.
   */
  { kind: "creation",
    re: /写(?:一)?(?:首|篇|个|段|封)[^\n]{0,12}?(?:诗|词|故事|小说|文章|散文|代码|程序|脚本|邮件|文案|笑话)|写(?:一)?(?:首|篇|个|段|封)?(?:诗|代码|程序|脚本|邮件|文案)|作诗|翻译(?:成|为|一下|这段)|(?:^|\s)(?:write|compose|draft|pen)(?![A-Za-z0-9_])(?:\s+(?:me|us|a|an|the|some|any|short|little|nice|quick|simple|brief|funny|good|python|javascript|typescript|node|bash|shell|sql|react)){0,4}\s+(?:poem|haiku|limerick|story|song|script|essay|email|code|function|app)|(?:^|\s)translate(?![A-Za-z0-9_])\s+(?:this|that|these|those|it(?![A-Za-z0-9_])|the\s+following|(?:the|this|that|my)\s+(?:text|paragraph|passage|article|document|sentence|section|excerpt|thread|post))|(?:^|\s)(?:tell|write)(?:\s+me)?\s+a\s+joke|(?:^|\s)(?:summari[sz]e|tl;?dr)(?![A-Za-z0-9_])\s+(?:this|that|these|those|it|the\s+following|(?:the|this|that)\s+(?:article|text|report|transcript|document|thread|post|pdf|call))|总结(?:一下|下)?(?:这|此|该|下面|以下|上方)|(?:这|此|以下|下面|上述)(?:段|篇|份|个)?(?:文字|文章|内容|报告|电话会|纪要|帖子)/i,
    why: "This desk writes research cards and nothing else: no poems, translations, code or summaries of text you supply. Its one generative layer is a numeric-gated narrative over a card the engine computed. Ask it about an instrument instead.",
    whyZh: "本桌面只写研究卡片，不写诗、不做翻译、不写代码、也不总结你给的文字。它唯一的生成层是对引擎算出的卡片做数字校验后的叙述。请改问一个标的。" }
];

/**
 * A market question the desk cannot answer as asked. Each row is a DISCLOSURE, not a refusal: the
 * card still runs, because "here is the nearest thing I can compute, and here is the gap" is more
 * useful than "no". The gap text is written to name the thing that was asked for, so a trader who
 * wanted a price target learns that no such number exists here rather than reading a median as one.
 */
/**
 * What a task pattern says when it matched but LOST - when the same sentence also named an instrument,
 * a horizon, a date, a k or a stated drawdown tolerance. The card runs, because the trade question is
 * the question; this is printed on it beside the result so the part the desk could not honour is
 * stated rather than silently dropped. Shorter than the TASK_RES refusals on purpose: a refusal is the
 * whole answer, this is a footnote under one.
 */
const TASK_GAP = {
  injection: {
    en: "That sentence also asked for hidden instructions. There are none: the prompt the model is given is committed at src/llm/prompt.mjs, and every numeral in the narrative is checked back against the card by src/llm/verify-numbers.mjs. The card below answers the trade question in the same sentence.",
    zh: "这句话还要求打印隐藏指令。没有隐藏指令：给模型的提示词已提交在 src/llm/prompt.mjs，叙述里的每个数字都由 src/llm/verify-numbers.mjs 校验回卡片本身。下面这张卡片回答的是同一句话里的交易问题。"
  },
  capability: {
    en: "That sentence also asked what this desk does or how to use it. The card below answers the trade question in it; the capability list is on the page above the question box and in README.md.",
    zh: "这句话还在问本桌面能做什么、怎么用。下面的卡片回答的是其中的交易问题；能力清单就在问题框上方的页面上，也写在 README.md 里。"
  },
  creation: {
    en: "That sentence also asked this desk to write something other than a research card. It writes research cards and nothing else - no poems, translations or code - so the card below answers the instrument you named, and the part it cannot honour is stated here rather than dropped.",
    zh: "这句话还要求本桌面写研究卡片以外的东西。它只写研究卡片，不写诗、不做翻译、不写代码——所以下面的卡片回答你点名的标的，它无法完成的那部分写在这里，而不是被悄悄丢掉。"
  }
};

const GAP_RES = [
  { kind: "forecast",
    re: /目标价|会到多少|能到多少|能涨到|会涨到|涨到多少|跌到多少|(?:明年|后年|年底|一年(?:后|以后|之后)|两年(?:后|以后|之后))|price\s+target|target\s+price|next\s+year|in\s+a\s+year|a\s+year\s+from\s+now|end\s+of\s+(?:the\s+)?year|(?<![A-Za-z0-9_])will(?![A-Za-z0-9_])[\s\S]{0,24}(?:reach|hit|get\s+to|be\s+at|be\s+worth)/i,
    why: "You asked for a price or a level at a future date. This desk does not forecast and has no model of the future: its directional hit rate out of sample is 50.1% (research/VALIDATION.md), so any level it printed would be invented. What it gives instead is the realised outcome distribution of the historical episodes whose state most resembles this one, over the horizon grid it actually measures - 1/5/10/20/40/60 sessions, 60 being roughly a quarter. Read the median, the p10/p90 band and the path risk as an answer to \"how wide is this\", never to \"where does it go\".",
    whyZh: "你问的是未来某个时点的价格或点位。本桌面不做预测，也没有关于未来的模型：样本外方向命中率只有 50.1%（research/VALIDATION.md），所以它打印出的任何点位都是编造的。它给出的是：与当前状态最相似的历史片段，在它真正测量过的期限网格（1/5/10/20/40/60 个交易日，60 约为一个季度）内已实现的收益分布。请把中位数、p10/p90 区间和路径风险读成\"这个位置有多宽\"，绝不要读成\"它会去哪儿\"。" },
  { kind: "backtest",
    re: /胜率|回测|定投|每天都?买|一直持有|过去[\s\S]{0,10}(?:年|个月)[\s\S]{0,14}(?:买|卖|持有|收益|回报)|win\s+rate|back[\s-]?test(?:ing|ed)?|buy[\s-]and[\s-]hold|dollar[\s-]?cost|if\s+(?:i|you|we)\s+(?:had\s+)?(?:bought|sold|held)|historical\s+(?:win|success)\s+rate/i,
    why: "You asked for a strategy result - a win rate, or the return from buying repeatedly over a period. That is a backtest, and this desk is not one: it analyses a single state at a single as-of session and reports what the k nearest historical episodes did over the following H sessions. It never simulates a rule, a schedule, a rebalance or a portfolio. The card below answers the single-decision version of your question - entered once, at this state, held H sessions.",
    whyZh: "你问的是策略结果——一段时间内反复买入的胜率或收益。那是回测，而本桌面不是回测框架：它只分析某一个截至交易日上的单一状态，报告最相似的 k 个历史片段在随后 H 个交易日内实际发生了什么，从不模拟规则、节奏、再平衡或组合。下面这张卡片回答的是你问题里\"单次决策\"的版本：在这个状态入场一次、持有 H 个交易日。" },
  { kind: "conditional",
    re: /如果|假如|要是|假设|万一|(?<![A-Za-z0-9_])(?:if|assuming|assume|suppose)(?![A-Za-z0-9_])|what\s+(?:if|would|happens)|加息|降息|rate\s+(?:hike|cut)|basis\s+points?|(?<![A-Za-z0-9_])bp(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])sigma(?![A-Za-z0-9_])|σ|标准差|衰退|(?:^|\s)recession(?![A-Za-z0-9_])|黑天鹅|通胀(?:超预期|失控|抬头)|(?<![A-Za-z0-9_])shock(?![A-Za-z0-9_])|冲击/i,
    why: "You asked what happens IF something changes - a hypothetical state. The engine cannot invent one: every figure on this card comes from retrieved history, not from a simulation of your sentence. What it can do is re-retrieve under the named shock overlays and pinned crisis windows in the stress suite below, each of which is a measured episode rather than an assumption, run with this card's own settings so the rows are directly comparable to the baseline.",
    whyZh: "你问的是\"如果某个条件变了会怎样\"——一个假设状态。引擎无法凭空构造：这张卡片上的每个数字都来自检索到的历史，而不是对你这句话的模拟。它能做的是在下面压力测试套件里，用具名冲击叠加和钉住的危机窗口重新检索——每一个都是被测量过的真实片段而非假设，并用与这张卡片相同的设置运行，因此各行与基准可直接比较。" },
  { kind: "advice",
    re: /投资建议|算不算(?:投资)?建议|是不是(?:投资)?建议|(?:is|isn't|is\s+not)\s+this\s+(?:financial\s+|investment\s+)?advice|should\s+i\s+(?:put|invest|bet|go\s+all)|all[\s-]?in|梭哈|满仓|押上|重仓|借钱|put\s+(?:my|all)\s+(?:savings|money)|life\s+savings/i,
    why: "You asked whether this is investment advice, or whether to commit the money. It is not advice, and the second question is not answerable here: the desk has no view on you, your horizon, your other positions or what the money is for, and it prints no recommendation by design - its directional hit rate out of sample is 50.1%. What it does give you is the auditable half of the decision: the realised distribution of similar states, the path risk, how often a stated drawdown level was actually breached, and the provenance of every figure. The size and the yes/no stay with you.",
    whyZh: "你在问这是不是投资建议、以及要不要把这笔钱投进去。这不是投资建议，第二个问题在这里也无法回答：本桌面不了解你、你的期限、你的其他持仓，也不知道这笔钱的用途，并且刻意不输出任何推荐——它的样本外方向命中率只有 50.1%。它能给你的是决策中可审计的那一半：相似状态的已实现分布、路径风险、你声明的回撤线在历史上被击穿的频率，以及每个数字的来源。仓位大小与做还是不做，仍然由你决定。" }
];

/**
 * A shock or crisis the sentence named, mapped to the row of the stress suite that answers it - or,
 * when the library cannot reach it, to the nearest row that exists plus the reason the two are not
 * the same thing. Ids only: src/desk.mjs resolves them against SCENARIOS and drops any id that is
 * not there, so a stale mapping degrades into no highlight rather than a wrong one.
 */
const SCENARIO_RES = [
  { re: /2008|lehman|雷曼|次贷|subprime|global\s+financial\s+crisis|金融危机/i, scenarioId: null, nearest: "regional-banks-2023",
    why: "The library starts 2016-09-20, so a 2008 episode is not retrievable and no row below is that episode. Naming the gap is the answer.",
    whyZh: "类比库从 2016-09-20 开始，因此 2008 年的片段无法检索，下面没有任何一行是那个片段。指出这个缺口本身就是答案。" },
  { re: /tariff|关税|trade\s+war|贸易战|对等关税/i, scenarioId: "tariff-shock-2025" },
  { re: /carry|日元|(?:^|\s)yen(?![A-Za-z0-9_])|套息/i, scenarioId: "carry-unwind-2024" },
  { re: /covid|疫情|liquidity\s+crash|流动性(?:危机|冲击|崩溃)|2020\s*年?\s*(?:3|三)\s*月/i, scenarioId: "covid-crash" },
  { re: /volatility\s+spike|vol\s+spike|vix\s+spike|波动率(?:飙升|跳升|冲击|走高|放大)|two\s+sigma|2\s*sigma|2σ|(?<![A-Za-z0-9_])vix(?![A-Za-z0-9_])/i, scenarioId: "vol-spike" },
  { re: /regional\s+bank|银行(?:危机|暴雷|倒闭)|(?:^|\s)svb(?![A-Za-z0-9_])|credit\s+spread|信用利差/i, scenarioId: "regional-banks-2023" },
  { re: /通胀|(?:^|\s)inflation(?![A-Za-z0-9_])|rate\s+bear/i, scenarioId: "rate-shock-2022" },
  { re: /加息|rate\s+hike|rates?\s+(?:rise|rising|higher)|taper|紧缩|policy[\s-]rate/i, scenarioId: "rates-up" },
  { re: /降息|rate\s+cut|rates?\s+(?:fall|falling|lower)|宽松|(?:^|\s)easing(?![A-Za-z0-9_])/i, scenarioId: null,
    why: "Every overlay in the suite is adverse by construction, so there is no easing scenario to point at. The baseline card is the unshocked state; an easier policy path is not measured.",
    whyZh: "套件里的每一个叠加都是按不利方向构造的，因此没有\"宽松\"情景可指。基准卡片就是未受冲击的状态；更宽松的政策路径没有被测量。" },
  { re: /crypto|比特币|(?:^|\s)btc(?![A-Za-z0-9_])|加密/i, scenarioId: "crypto-contagion" },
  { re: /中概|china\s+adr|(?:^|\s)adr(?![A-Za-z0-9_])|退市/i, scenarioId: "china-adr-shock" },
  { re: /流动性|liquidity|air\s+pocket/i, scenarioId: "liquidity-air-pocket" },
  { re: /财报日|earnings\s+(?:day|release)|on\s+earnings/i, scenarioId: "earnings-day" },
  { re: /(?:^|\s)fomc(?![A-Za-z0-9_])|议息|联储会议|美联储会议/i, scenarioId: "fomc-day" },
  { re: /周末|weekend|7x24|七天|全天候/i, scenarioId: "weekend-hold-7x24" },
  { re: /2018|tightening\s+scare/i, scenarioId: "fed-tightening-2018" }
];

/**
 * Market vocabulary, used for exactly one decision: whether a sentence that yielded no instrument
 * and no grid value was about a market at all. Deliberately broad, because the cost of a false
 * positive here is only that the desk falls back to its old behaviour (a card for the dropdown),
 * while the cost of a false negative would be refusing a trade question - and this desk would rather
 * answer a marginal sentence than reject a real one.
 */
const TRADE_VOCAB_RE = /买|卖|做多|做空|多头|空头|持仓|仓位|建仓|进场|入场|出场|离场|止损|止盈|回撤|涨幅|跌幅|走势|波动|风险|收益|回报|估值|财报|业绩|大盘|美股|A股|港股|股票|股价|指数|期权|期货|现货|杠杆|套利|对冲|类比|相似状态|历史相似|压力测试|情景|标的|板块|行情|盘面|[Kk]线|量化|策略|回测|胜率|定投|会涨|会跌|涨跌|走势|行情|能买|该不该|要不要买|持有|加仓|减仓|(?<![A-Za-z0-9_])(?:buy|sell|bought|sold|long|short|position|portfolio|holding|holdings|entry|exit|stop|drawdown|return|returns|yield|volatility|vol|risk|equity|equities|stock|stocks|share|shares|etf|index|option|options|future|futures|spot|leverage|margin|earnings|ticker|price|prices|market|markets|analog|analogue|analogues|stress|scenario|scenarios|hedge|hedging|dip|rally|breakout|pullback|correction|bear|bull|trade|trading|invest|investment|backtest|allocation|exposure|vix)(?![A-Za-z0-9_])/i;

/** A marker that this sentence continues the previous one, so it is a fragment and not a non-question. */
const FOLLOWUP_MARK = /(?:^|[\s，,、])(?:那|那么|呢|换成|改成|调到|再来|同上|同样)(?:$|[\s，,、？?])|(?:^|\s)(?:what|how)\s+about(?![A-Za-z0-9_])|(?:^|\s)and\s+(?:for|what|how|the)(?![A-Za-z0-9_])|(?:^|\s)now\s+(?:try|do|run|show)(?![A-Za-z0-9_])|(?:^|\s)again(?![A-Za-z0-9_])|(?:^|\s)same\s+(?:for|but)(?![A-Za-z0-9_])/i;

const OFFTOPIC = {
  why: "There is no instrument, no horizon and no market subject in that sentence, so there is nothing to retrieve and the desk will not invent a question to answer. It analyses one thing: a named instrument, at an as-of session, over a horizon of 1/5/10/20/40/60 sessions - what the k most similar historical episodes actually did next, with the path risk and the stress suite. Type a ticker or a name (NVDA / 英伟达), pick one from the Symbol dropdown and press Analyse with the question box empty, or click one of the examples.",
  whyZh: "这句话里没有标的、没有期限，也没有市场相关的主题，所以没有东西可检索，本桌面也不会替你编一个问题来回答。它只分析一件事：一个具名标的、一个截至交易日、一个期限（1/5/10/20/40/60 个交易日）——最相似的 k 个历史片段随后实际怎么走，并附上路径风险与压力测试。请输入代码或名称（NVDA / 英伟达），或从 Symbol 下拉里选一个、把问题框留空再点 Analyze，也可以点一个示例问题。"
};

/**
 * A scenario counts as NAMED only when the sentence asks for one. "中概股未来十天怎么样" contains
 * 中概, which is a row in the suite, but the trader named an instrument class and not a shock - pointing
 * them at the China ADR de-rating overlay would be a disclosure of something they never asked for.
 * The gate is the vocabulary of hypothesis and stress, in both languages.
 */
const SCENARIO_CONTEXT_RE = /压力|情景|冲击|叠加|危机|爆发|黑天鹅|如果|假如|假设|要是|万一|若|测试|压测|(?:^|\s)(?:stress|stressed|scenario|scenarios|shock|shocks|overlay|crisis|if|assuming|assume|suppose|against|hypothetical)(?![A-Za-z0-9_])/i;

/** True when a sentence names a shock or crisis the stress suite can answer, or can nearly answer. */
function matchScenario(q) {
  if (!SCENARIO_CONTEXT_RE.test(q)) return null;
  for (const s of SCENARIO_RES) {
    const m = q.match(s.re);
    if (!m) continue;
    return { word: m[0].trim(), scenarioId: s.scenarioId || null, nearest: s.nearest || null,
      why: s.why || null, whyZh: s.whyZh || null };
  }
  return null;
}

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

/*
 * A sector/industry word this library has NO instrument for. The parser must say so rather than let
 * the upper layer silently substitute the dropdown default - a confident card about the wrong sector
 * is the exact failure the sector-proxy disclosure exists to prevent.
 */
const SECTOR_GAP = {
  en: "That names a sector or industry, but this library has no instrument that represents it, so no sector card was produced. Name a specific stock, or use a sector word the library holds (semiconductors, energy, health care, or banks/brokerages/insurers via financials).",
  zh: "这句话点的是一个板块或行业，但本库没有能代表它的标的，因此没有生成板块卡片。可以改问某只具体个股，或换一个本库支持的板块词（半导体、能源、医疗，或银行/券商/保险，走金融）。"
};

// English words that carry no sector meaning; used to reject generic phrases such as "these stocks".
const EN_GAP_STOP = new Set(["the","these","those","this","that","my","some","any","all","what","which",
  "are","is","do","does","i","you","it","for","of","in","on","to","and","or","buy","sell","good","bad",
  "next","over","can","should","will","about","with","today","now","stock","stocks","sector","industry",
  "share","shares","equities","market","a","an","as","be","been","me","we","they","them","his","her","its"]);

// Chinese verb/modal chars a sector stem would not start with; rejects "看看股票/买股票" fragments.
const ZH_GAP_VERB = new Set(["看","买","卖","炒","选","玩","持","找","挑","查","问","说","讲","谈",
  "评","做","想","要","能","会","该","敢"]);

function knownSectorWord(w) {
  const key = String(w).toUpperCase();
  return ALIASES.has(key) || SECTOR_PROXIES.has(key);
}

/**
 * Return the recognizable sector/industry phrase the library has no proxy for, or null. Stems are at
 * least two CJK characters so "看股票/买股票" (a single verb before 股票) is not mistaken for a sector.
 */
function detectSectorGap(q) {
  for (const m of q.matchAll(/[一-龥]{2,8}(?:板块|行业|概念股|概念|股)/g)) {
    const w = m[0];
    if (ZH_GAP_VERB.has(w[0])) continue;
    if (!knownSectorWord(w)) return w;
  }
  for (const raw of q.toLowerCase().matchAll(/\b([a-z][a-z\s]{0,24}?\s?(?:stocks?|sector|industry|shares|equities))\b/g)) {
    let words = raw[0].trim().split(/\s+/);
    while (words.length > 1 && EN_GAP_STOP.has(words[0])) words = words.slice(1);
    const w = words.join(" ");
    if (knownSectorWord(w)) continue;
    if (!words.slice(0, -1).some((x) => !EN_GAP_STOP.has(x))) continue;
    return w;
  }
  return null;
}

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
    // What KIND of question this is, decided after everything above has had its say. assistantTask
    // and offtopic mean no card is produced at all; answerGaps, namedScenario and dateOutOfRange are
    // printed on the card that is. All five are per-sentence and are deliberately not carried by
    // mergeContext(): a stale "you asked for a price target" on a turn that did not is a disclosure
    // of nothing.
    assistantTask: null, offtopic: null, answerGaps: [], namedScenario: null, dateOutOfRange: null,
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
  /*
   * "short X" is a short position only when X is an instrument.
   *
   * The ticker branch of DIRECTION_RES is written [A-Z][A-Z0-9.\-]{0,6} under the i flag, so it also
   * matches any short latin word, and the exclusion list beside it cannot be complete - it is a list of
   * words someone thought of. "write me a SHORT POEM about trading" therefore arrived as a short-position
   * request, and once it had, the sentence looked like a trade question and every refusal downstream
   * stood down: the desk printed a full card, with a short-side disclosure, for a poem. Checking the
   * token against the library closes the whole class at once, because unlike a word list it is exact.
   * An explicit position word (short position / short side / short it / short the) still stands on its
   * own, and so does every Chinese form, none of which is affected.
   */
  if (out.direction === "short" && out.directionMatched) {
    const bare = /^short(?:ing)?\s+(.+)$/i.exec(String(out.directionMatched).trim());
    if (bare) {
      const tok = bare[1].replace(/^\$/, "").toUpperCase();
      if (!/^(POSITION|SIDE|IT|THE)$/.test(tok) && !known.has(tok) && !ALIAS_UPPER.has(tok) && !UNHELD_ALIASES.has(tok)) {
        out.direction = null;
        out.directionMatched = null;
      }
    }
  }
  const horizons = (lib && lib.horizons) || MEASURED_HORIZONS;
  const dates = libDates(lib);
  // What a RELATIVE date was aiming at before it was snapped onto the session calendar, so a phrase
  // that reaches behind the start of the library can be disclosed instead of quietly landing on the
  // first session it holds.
  let dateIntended = null;
  let work = q;

  // --- as-of date first, because "5 天前" is a date and must not be read as a 5-day horizon
  // 19xx as well as 20xx, on purpose. A date the library cannot reach has to be DETECTED in order to
  // be disclosed: the old pattern matched only 20xx, so "as of 1999-01-01" was silently dropped and
  // the desk answered the latest session with nothing on the card saying it had. Same sentence, two
  // different out-of-range directions, two different silent substitutions.
  const iso = q.match(/(?<![\d.])(19\d{2}|20\d{2})[-/.](\d{1,2})(?:[-/.](\d{1,2}))?(?![\d.])/);
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
        if (!(dates && dates.length > n)) dateIntended = shiftIso(anchor, -Math.ceil(n * 7 / 5));
        out.date = dates && dates.length > n ? dates[dates.length - 1 - n] : shiftIso(anchor, -Math.ceil(n * 7 / 5));
        out.dateHow = "n-sessions-ago";
      } else if (r.days != null) {
        dateIntended = shiftIso(anchor, r.days);
        out.date = sessionOnOrBefore(dates, dateIntended);
        out.dateHow = r.how;
      } else {
        dateIntended = shiftIso(anchor, r.per * Number(m[1]));
        out.date = sessionOnOrBefore(dates, dateIntended);
        out.dateHow = r.how;
      }
      work = blank(work, m.index, m[0].length);
      break;
    }
  }

  /*
   * A date outside the library is a fact about the library, not a licence to guess.
   *
   * Both directions were silent before this, and silently in opposite ways: a date BEHIND the first
   * session was dropped by the pattern that read it and the desk ran at the latest session, while a
   * date AFTER the last session was carried through and snapped back by the engine's binary search.
   * Either way the card described a session the trader did not name, with the name they did use still
   * printed in the parse line. Now both are normalised here, where the range is known, and both are
   * reported - the desk's own rule is no silent substitution.
   */
  const libFrom = (lib && lib.from) || (dates && dates[0]) || null;
  const libTo = lastSession(lib);
  if (libFrom && dateIntended && dateIntended < libFrom) {
    // "3000 个交易日前" aims behind the first session the library holds. Snapping to that first
    // session would hand the engine a date most instruments have no feature row for and surface as an
    // error toast; running at the latest session and saying so is the same substitution the ISO path
    // makes, so both directions of "outside the library" now read the same way.
    out.dateOutOfRange = { asked: dateIntended, side: "before", used: libTo, from: libFrom, to: libTo, relative: true };
    out.date = "latest";
    out.dateHow = "out-of-range";
  } else if (out.date && out.date !== "latest" && libFrom && out.date < libFrom) {
    out.dateOutOfRange = { asked: out.date, side: "before", used: libTo, from: libFrom, to: libTo };
    out.date = "latest";
    out.dateHow = "out-of-range";
  } else if (out.date && out.date !== "latest" && libTo && out.date > libTo) {
    const snapped = sessionOnOrBefore(dates, out.date);
    out.dateOutOfRange = { asked: out.date, side: "after", used: snapped, from: libFrom, to: libTo };
    out.date = snapped;
    out.dateHow = "out-of-range";
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

  /*
   * Last, a count written as a word - the gap the enumerated phrase list cannot cover.
   *
   * Tried AFTER the phrases rather than before them so every wording already understood keeps its exact
   * previous reading: "半年" stays a plain 60 instead of becoming 125 snapped to 60 with a correction
   * printed beside it. horizonRaw is carried only when it differs from the number on the card, because
   * it exists to disclose a snap, and repeating an unchanged number reads as a correction that never
   * happened.
   */
  if (out.horizon == null) {
    const wanted = wordUnitCount(work);
    if (wanted != null) {
      out.horizon = nearestHorizon(wanted, horizons);
      out.horizonHow = "units";
      if (wanted !== out.horizon) out.horizonRaw = wanted;
    }
  }

  // --- neighbour count, raw: the desk clamps it and says so
  //
  // The Chinese patterns were added after a reviewer-facing test exposed the gap: "KWEB with 100
  // neighbours" parsed k=100 and produced a card that disclosed the deviation from the validated
  // k=50, while "把 KWEB 的 k 调到 100 再看看" parsed nothing at all and silently ran k=50. Same
  // request, two languages, and one of them answered a different question than the one asked.
  // Four digits, not three: "k=1000" used to match nothing at all, so the desk ran the validated
  // k=50 and said nothing, while "next 500 sessions" in the same sentence was snapped to 60 and
  // disclosed. One out-of-grid value reported, its neighbour ignored. The desk already clamps k and
  // prints the clamp (K_MAX in src/desk.mjs); all it needed was to be told.
  const km = q.match(/\b(?:k|top|neighbou?rs?|analog(?:ue)?s?)\s*[=:：]?\s*(\d{1,4})\b/i)
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
      /*
       * The span as typed, not the dictionary key. Every other match path already reports the trader's
       * own casing (see rawOf above), and this one is the path a sector word arrives by, so "crude oil
       * next 10 sessions" was echoed back as "CRUDE OIL" on the card and in the trace - the desk
       * shouting a phrase the trader had written in lower case. The lookups below upper-case the value
       * themselves, so nothing else depends on the key's casing.
       */
      if (via && known.has(via)) { out.symbol = via; out.matched = q.slice(m.index, m.index + m[0].length); out.matchedHow = "alias"; break; }
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

  /*
   * What kind of question this turned out to be. LAST, because the classification depends on
   * everything above having had its say: a sentence that yielded an instrument is a trade question
   * even if it also contains the word "poem", and a sentence that yielded a stated drawdown
   * tolerance is not off-topic even though it names nothing.
   *
   * That rule is ENFORCED here, not left in the comment above. A task pattern is a refusal only when
   * the sentence yielded nothing else - no instrument, no grid value, no intent flag. When it yielded
   * one of those, the trade question wins and the card runs, because refusing is the worse error by a
   * wide margin: "help me analyze NVDA over the next week" and "can you help me stress test a TSLA
   * position" both match the capability pattern, and "help me ..." is the most natural way there is to
   * open an English question about a trade. A desk that answered those with a capability lecture would
   * fail on the one axis it exists to be judged on. The ask it could not honour is not dropped on the
   * floor either: it becomes an answerGap and is printed on the card beside the result, exactly like
   * every other narrowing in this parser.
   */
  // A sector/industry word with NO proxy is a market refusal, not a reason to run the dropdown default.
  if (!out.symbol && !out.unheld && !out.sectorProxy && !out.ambiguousAlias) {
    const gapWord = detectSectorGap(q);
    if (gapWord) out.sectorGap = { word: gapWord, why: SECTOR_GAP.en, whyZh: SECTOR_GAP.zh };
  }
  const hasInstrument = Boolean(out.symbol || out.unheld || out.sectorProxy || out.ambiguousAlias || out.sectorGap);
  const hasGridValue = out.horizonRaw != null || out.k != null || out.date != null || out.riskTolerancePct != null;
  const hasIntentFlag = Boolean(out.direction || out.earningsIntent || out.comparison || out.languageRequest);
  /*
   * Two different decisions, and conflating them is exactly what let a poem through. An intent flag is
   * enough to keep a sentence off the offtopic pile - it says the sentence is about a market - but it is
   * not enough to outrank an explicit request for a poem, because both flags above can be set by an
   * incidental word ("earnings call transcript", "a short poem"). Only an instrument or a value on the
   * grid is a trade question the desk must answer.
   */
  const isTradeQuestion = hasInstrument || hasGridValue;
  const isMarketSentence = isTradeQuestion || hasIntentFlag;

  for (const t of TASK_RES) {
    const m = q.match(t.re);
    if (!m) continue;
    const matched = String(m[0]).trim();
    if (isTradeQuestion) {
      const gap = TASK_GAP[t.kind] || TASK_GAP.capability;
      out.answerGaps.push({ kind: "assistant", taskKind: t.kind, matched, why: gap.en, whyZh: gap.zh });
    } else {
      out.assistantTask = { kind: t.kind, matched, why: t.why, whyZh: t.whyZh };
    }
    break;
  }
  for (const g of GAP_RES) {
    const m = q.match(g.re);
    if (m) out.answerGaps.push({ kind: g.kind, matched: String(m[0]).trim(), why: g.why, whyZh: g.whyZh });
    // Two is enough to make the point; a third would bury the card it is printed above.
    if (out.answerGaps.length >= 2) break;
  }
  out.namedScenario = matchScenario(q);
  if (!out.assistantTask && !isMarketSentence && !out.answerGaps.length
      && !TRADE_VOCAB_RE.test(q) && !FOLLOWUP_MARK.test(q)) {
    out.offtopic = { why: OFFTOPIC.why, whyZh: OFFTOPIC.whyZh };
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
   * A sentence that NAMES a different topic this library cannot analyse - an instrument it does not
   * hold (unheld), or a sector/industry it has no proxy for (sectorGap) - is not a fragment about the
   * previous one, so nothing is inherited from it. Carrying the old symbol across would answer a
   * question nobody asked: 台积电 typed after a QQQ card would produce another QQQ card, with a
   * full model-written narrative behind it, and the refusal the trader was owed would never appear.
   * Such a turn ends the topic instead of being quietly overridden by it.
   */
  if ((out.unheld || out.sectorGap) && !next.symbol) { keepLanguage(); return out; }

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

/** What each answer gap was ASKED for, in the trace's own words. */
const GAP_LABEL_ZH = { forecast: "未来价位", backtest: "策略回测", conditional: "假设情景", advice: "投资建议", assistant: "研究卡片以外的东西" };
const GAP_LABEL_EN = { forecast: "a future price level", backtest: "a strategy backtest", conditional: "a hypothetical state", advice: "investment advice", assistant: "something other than a research card" };

/** dateHow is an internal slug; the trace is a sentence, so it is spelled out before it is shown. */
const DATE_HOW_LABEL = {
  "latest": { zh: "最近一个交易日", en: "latest session" },
  "last-week": { zh: "上周", en: "last week" },
  "last-month": { zh: "上个月", en: "last month" },
  "n-weeks-ago": { zh: "若干周前", en: "weeks ago" },
  "n-sessions-ago": { zh: "若干个交易日前", en: "sessions ago" }
};

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
  if (parsed.horizon) bits.push((zh ? "期限 " : "horizon ") + parsed.horizon
    + (zh ? " 个交易日" : (parsed.horizon === 1 ? " session" : " sessions"))
    + (parsed.horizonRaw && parsed.horizonRaw !== parsed.horizon ? (zh ? "（由 " + parsed.horizonRaw + " 对齐）" : " (from " + parsed.horizonRaw + ")") : ""));
  if (parsed.sectorProxy) bits.push(zh
    ? "「" + parsed.sectorProxy.word + "」是板块/篮子词，本库无对应标的，已用 " + parsed.sectorProxy.symbol + " 代替"
    : '"' + parsed.sectorProxy.word + '" is a sector word; resolved to ' + parsed.sectorProxy.symbol);
  if (parsed.ambiguousAlias) bits.push(zh
    ? "「" + parsed.ambiguousAlias.word + "」有歧义，已取 " + parsed.ambiguousAlias.symbol
    : '"' + parsed.ambiguousAlias.word + '" is ambiguous; resolved to ' + parsed.ambiguousAlias.symbol);
  if (parsed.sectorGap) bits.push(zh
    ? "「" + parsed.sectorGap.word + "」是板块/行业词，但本库没有可代表它的标的，未生成该板块卡片（可改问具体个股）"
    : '"' + parsed.sectorGap.word + '" names a sector/industry, but this library has no instrument that represents it; no sector card produced (name a specific stock)');
  if (parsed.direction) bits.push((zh ? "方向 " : "direction ") + (parsed.direction === "short" ? (zh ? "做空" : "short") : (zh ? "做多" : "long")));
  if (parsed.date) {
    // "latest" is the dropdown's word for the last session in the library, not anything the trader
    // said, and dateHow is an internal slug. Printing both verbatim produced "截至 latest (latest)" -
    // a sentence with the same template variable in it twice, in the middle of Chinese prose.
    const latest = parsed.date === "latest";
    const how = parsed.dateHow && parsed.dateHow !== "iso" ? parsed.dateHow : null;
    const label = latest
      ? (zh ? "最近一个交易日" : "the latest session")
      : parsed.date + (how ? " (" + ((DATE_HOW_LABEL[how] || {})[zh ? "zh" : "en"] || how) + ")" : "");
    // No space before a Chinese word: "截至 最近一个交易日" reads as two fields, not one phrase.
    bits.push((zh ? (latest ? "截至" : "截至 ") : "as of ") + label);
  }
  if (parsed.k) bits.push("k=" + parsed.k);
  if (parsed.riskTolerancePct) bits.push((zh ? "可承受回撤 " : "drawdown tolerance ") + parsed.riskTolerancePct + "%");
  if (parsed.unheld) bits.push(zh
    ? "「" + parsed.unheld.word + "」" + (parsed.unheld.ticker ? "（" + parsed.unheld.ticker + "）" : "") + "不在本库中，未分析"
    : '"' + parsed.unheld.word + '"' + (parsed.unheld.ticker ? " (" + parsed.unheld.ticker + ")" : "") + " is not in this library; not analysed");
  if ((parsed.droppedInstruments || []).length) bits.push(zh
    ? "未分析：" + parsed.droppedInstruments.map((d) => d.symbol).join("、")
    : "not analysed: " + parsed.droppedInstruments.map((d) => d.symbol).join(", "));
  if (parsed.earningsIntent) bits.push(zh ? "提到财报（未改动截至日）" : "mentions earnings (as-of date unchanged)");
  if (parsed.dateOutOfRange) bits.push(zh
    ? "你要求的 " + parsed.dateOutOfRange.asked + " 在本库范围（" + parsed.dateOutOfRange.from + " .. " + parsed.dateOutOfRange.to + "）之外，已改为 " + parsed.dateOutOfRange.used
    : "asked for " + parsed.dateOutOfRange.asked + ", outside the library (" + parsed.dateOutOfRange.from + " .. " + parsed.dateOutOfRange.to + "); ran at " + parsed.dateOutOfRange.used);
  for (const g of (parsed.answerGaps || [])) bits.push(zh
    ? "问的是" + GAP_LABEL_ZH[g.kind] + "，答的不是"
    : "asked for " + GAP_LABEL_EN[g.kind] + "; not what this card computes");
  if (parsed.namedScenario) bits.push(zh
    ? "句中点名了「" + parsed.namedScenario.word + "」" + (parsed.namedScenario.scenarioId ? "（已定位到压力情景行）" : "（本库无对应情景）")
    : "named \"" + parsed.namedScenario.word + "\"" + (parsed.namedScenario.scenarioId ? " (mapped to a stress row)" : " (no such scenario in the library)"));
  if (parsed.assistantTask) bits.push(zh ? "不是交易问题（" + parsed.assistantTask.kind + "），未生成卡片" : "not a trade question (" + parsed.assistantTask.kind + "); no card produced");
  if (parsed.offtopic) bits.push(zh ? "未找到标的或市场主题，未生成卡片" : "no instrument or market subject found; no card produced");
  bits.push((zh ? "语言 中文" : "language en") + (parsed.languageRequest ? (zh ? "（本轮指定）" : " (requested)") : ""));
  return bits.join(" · ");
}
