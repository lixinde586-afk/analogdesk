/**
 * AnalogDesk - numeric provenance gate for generated prose.
 *
 * The desk's one hard rule: a language model may phrase the research, it may not invent a number.
 * Every numeral that reaches the UI must be traceable to the engine payload that was handed to the
 * model. This module enforces that after generation rather than trusting the prompt.
 *
 * Method
 *   1. Walk the payload and materialise every finite number into a set of canonical surface forms:
 *      the raw value, its 0/1/2/3-decimal roundings, and each of those times 100 (because the
 *      payload stores returns as fractions and prose says "percent").
 *   2. Tokenise the generated text for numerals, ignoring ones inside dates, times and code spans.
 *   3. A token passes if it matches a canonical form exactly, or falls within `relTol` of one.
 *      A small structural allowlist (the horizon, k, the coverage target, years inside the library
 *      date range, and enumeration ordinals the template itself emitted) also passes, and is
 *      recorded so the gate stays auditable.
 *   4. Anything else is returned as `unsupported` with surrounding context, so the caller can retry
 *      with the offending list, or fall back to the deterministic template.
 *
 * The gate is deliberately strict about *invented precision*: a payload containing 0.1073 permits
 * "10.7%", "10.73%" and "0.107" but not "11%" presented as if measured, and not "10.5%".
 */

const NUM_TOKEN = /(?<![\w.:/-])(-?\d{1,3}(?:,\d{3})*(?:\.\d+)?|-?\d+(?:\.\d+)?)(?![\w])/g;

/** Surface forms a payload number is allowed to appear as in prose. */
export function surfaceForms(x, decimals = [0, 1, 2, 3]) {
  const out = new Set();
  const push = (v) => {
    if (!Number.isFinite(v)) return;
    out.add(String(v));
    for (const d of decimals) out.add(v.toFixed(d));
    const r = Math.round(v);
    if (Math.abs(r) < 1e15) { out.add(String(r)); if (r >= 0) out.add(String(r).replace(/^-/, "")); }
  };
  push(x);
  if (Math.abs(x) <= 1.0001) push(x * 100);      // fraction -> percent
  push(x * 100);                                  // explicit percent fields
  if (Math.abs(x) >= 1) push(x / 100);            // percent -> fraction
  return [...out];
}

/** Recursively harvest every finite number in the payload. */
export function collectNumbers(node, acc = new Set(), depth = 0) {
  if (depth > 12 || node == null) return acc;
  if (typeof node === "number") { if (Number.isFinite(node)) acc.add(node); return acc; }
  if (typeof node === "string") {
    // Date-like strings contribute their year, so "2020-03-23" can be cited as 2020.
    const m = node.match(/^(\d{4})-\d{2}-\d{2}/);
    if (m) acc.add(Number(m[1]));
    return acc;
  }
  if (Array.isArray(node)) { for (const v of node) collectNumbers(v, acc, depth + 1); return acc; }
  if (typeof node === "object") { for (const v of Object.values(node)) collectNumbers(v, acc, depth + 1); return acc; }
  return acc;
}

/**
 * The `extra` block every AnalogDesk caller passes to buildAllowlist for a research card.
 *
 * These are structural facts of the analysis rather than performance claims: the retrieval settings
 * the engine actually used, the coverage target, the library span, and the integers embedded in the
 * card's own protocol sentence (query counts, instrument counts). They live here so server.mjs and
 * the browser bundle build the identical gate - two copies of this list would eventually diverge,
 * and a divergent gate is worse than no gate because it looks like a control.
 */
/**
 * Integers that appear in the card's own human-readable labels and sentences.
 *
 * "52" in "distance from 52-week high", "90" in VaR90, "500" in "S&P 500", "5" in "5-session
 * return" are feature NAMES, not claims about the trade. The prose has to be able to say the name
 * of the thing it is reporting, so these are structure. They are collected from the payload rather
 * than hardcoded: if a label changes, the gate follows it, and a number can never be smuggled in
 * here that the engine did not itself put into the card.
 */
export function labelNumbers(card) {
  const out = new Set();
  const take = (s) => { for (const m of String(s ?? "").matchAll(/\d+(?:\.\d+)?/g)) out.add(Number(m[0])); };
  const walk = (node, depth = 0) => {
    if (depth > 8 || node == null) return;
    if (Array.isArray(node)) { for (const v of node) walk(v, depth + 1); return; }
    if (typeof node !== "object") return;
    for (const [k, v] of Object.entries(node)) {
      if (/label|name|tags|protocol|interpretation|honestVerdict|caveat|why|horizonLabel|note|notes/i.test(k)) take(v);
      else if (v && typeof v === "object") walk(v, depth + 1);
    }
  };
  walk(card);
  return [...out];
}

export function defaultAllowance(card, overrides = {}) {
  const protocolInts = [...String(card?.validation?.protocol || "").matchAll(/\d+/g)].map((m) => Number(m[0]));
  return {
    horizon: card?.idea?.horizonSessions,
    k: card?.retrieval?.kReturned,
    coverageTargetPct: card?.conformal?.coverageTargetPct ?? card?.validation?.targetCoveragePct,
    coverageTarget: card?.validation ? card.validation.targetCoveragePct / 100 : null,
    libraryFrom: card?.provenance?.from,
    libraryTo: card?.provenance?.to,
    extraNumbers: {
      sessions: card?.provenance?.sessions,
      symbols: card?.provenance?.symbols,
      instruments: card?.provenance?.symbols,
      nFeatures: card?.currentState?.allFeatures?.length ?? card?.provenance?.nFeatures,
      metricFeatures: card?.provenance?.metricFeatures,
      clip: card?.provenance?.zClip ?? 3,
      maxPerDate: card?.provenance?.maxPerCalendarDate ?? 2,
      minGap: card?.provenance?.minSameSymbolGap ?? 10,
      embargo: card?.retrieval?.embargoSessions,
      distinctSessions: card?.retrieval?.distinctSessions,
      distinctSymbols: card?.retrieval?.distinctSymbols,
      ...protocolInts.reduce((a, v, i) => ({ ...a, [`protocol${i}`]: v }), {})
    },
    templateNumbers: labelNumbers(card),
    ...overrides
  };
}

export function buildAllowlist(payload, extra = {}) {
  const nums = collectNumbers(payload);
  const forms = new Set();
  for (const n of nums) for (const s of surfaceForms(n)) forms.add(s);

  const structural = new Set();
  const add = (v) => { if (v == null) return; for (const s of surfaceForms(Number(v), [0, 1, 2])) structural.add(s); };
  add(extra.horizon); add(extra.k); add(extra.coverageTargetPct); add(extra.coverageTarget);
  for (const v of Object.values(extra.extraNumbers || {})) add(v);
  const from = String(extra.libraryFrom || ""), to = String(extra.libraryTo || "");
  if (/^\d{4}/.test(from) && /^\d{4}/.test(to)) {
    for (let y = Number(from.slice(0, 4)); y <= Number(to.slice(0, 4)); y++) structural.add(String(y));
  }
  for (const n of extra.templateNumbers || []) add(n);
  // News headlines are carried verbatim under card.signals.news (equity items + per-symbol + a
  // separate crypto list), each with a named source, so a numeral a sentence quotes from one
  // ("...may hit $600K this cycle") is an attributed quotation of a headline the card itself carries,
  // not an invented figure. Only the titles are harvested, so a model cannot use this to quote a
  // number from a story the card did not include.
  const newsItems = [
    ...(payload?.signals?.news?.items || []),
    ...(payload?.signals?.news?.cryptoItems || [])
  ];
  for (const it of newsItems) {
    for (const m of String(it.title ?? "").matchAll(/\d+(?:,\d{3})*(?:\.\d+)?/g)) add(m[0]);
  }

  // Every YYYY-MM-DD the payload carries - analog sessions, the as-of date, stress windows, earnings,
  // and ISO datetimes such as a headline's publishedAt. A cited date has to be one of these: the gate
  // used to mask dates out entirely (maskNonClaims), so a model could attach a real-looking date that
  // belonged to a different episode and nothing checked it.
  const dateForms = collectPayloadDates(payload);
  // The analog rows the model is allowed to cite, projected as (symbol, session, distance, ret/mae/mfe).
  // Pair validation (verifyDatePairs) proves a cited date keeps the distance and return of THAT row.
  const analogRows = (payload?.retrieval?.top || []).map((e) => ({
    symbol: e.symbol, session: e.session, distance: e.distance,
    ret: e.forwardReturnPct, mae: e.maxAdverseExcursionPct, mfe: e.maxFavourableExcursionPct
  })).filter((e) => e.session);
  return { forms, structural, payloadNumbers: [...nums], dateForms, analogRows };
}

/** Recursively gather every YYYY-MM-DD date literal (date part of ISO datetimes included). */
export function collectPayloadDates(node, acc = new Set(), depth = 0) {
  if (depth > 12 || node == null) return acc;
  if (typeof node === "string") {
    for (const m of node.matchAll(/(\d{4}-\d{2}-\d{2})/g)) acc.add(m[1]);
    return acc;
  }
  if (Array.isArray(node)) { for (const v of node) collectPayloadDates(v, acc, depth + 1); return acc; }
  if (typeof node === "object") { for (const v of Object.values(node)) collectPayloadDates(v, acc, depth + 1); return acc; }
  return acc;
}

const DATEISH = /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}:\d{2}(?::\d{2})?\b|\b\d{4}\/\d{1,2}\/\d{1,2}\b/g;
const CODEISH = /`[^`]*`/g;

/** Numbers inside code spans and date/time literals are quoted structure, not claims. */
export function maskNonClaims(text) {
  let out = String(text || "").replace(CODEISH, (m) => " ".repeat(m.length));
  out = out.replace(DATEISH, (m) => " ".repeat(m.length));
  return out;
}

export function extractNumerals(text) {
  const masked = maskNonClaims(text);
  const raw = String(text || "");
  const found = [];
  for (const m of masked.matchAll(NUM_TOKEN)) {
    const idx = m.index;
    found.push({
      value: m[0],
      normalised: m[0].replace(/,/g, ""),
      index: idx,
      context: raw.slice(Math.max(0, idx - 60), idx + m[0].length + 60).replace(/\s+/g, " ").trim(),
      hasPercent: /^\s*(%|percent|pp|percentage points)/i.test(raw.slice(idx + m[0].length, idx + m[0].length + 14))
    });
  }
  return found;
}

/* --------------------------- date / analog-pair gate --------------------------- */

const DATE_TOKEN_RE = /\d{4}-\d{2}-\d{2}/g;
// Sentence boundary. Includes an English sentence-ending period (". " + capital/quote) but NOT a bare
// ".", which would break on the decimal point in "4.15%"; Chinese full stop and ! ? always break.
const SENT_END_RE = /[。！？!?\n]|\.\s+(?=[A-Z"'(])/;
const DIST_KW_RE = /距离|distance/i;
const RET_KW_RE = /录得|forward\s*return|realised\s*return|realized\s*return|actual\s*return|returned|收益(?:为|是|达|\s*为|\s*是|\s*达)/i;
const MAE_KW_RE = /最大不利|max(?:imum)?\s*adverse|\bMAE\b/i;
const MFE_KW_RE = /最大有利|max(?:imum)?\s*favou?rable|\bMFE\b/i;
const NUM_FIRST_RE = /-?\d{1,3}(?:,\d{3})*(?:\.\d+)?|-?\d+(?:\.\d+)?/;
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** First numeral that follows a keyword inside a segment, with whether it is percent-suffixed. */
function firstNumberAfter(text, kwRe) {
  const m = kwRe.exec(text);
  if (!m) return null;
  const after = text.slice(m.index + m[0].length);
  // Non-global match so this always returns the FIRST number regardless of any earlier regex state
  // (a shared global regex keeps lastIndex across calls and used to skip to a later, wrong numeral).
  const n = after.match(NUM_FIRST_RE);
  if (!n || n.index == null) return null;
  const raw = n[0];
  const tail = after.slice(n.index + raw.length, n.index + raw.length + 12);
  const isPercent = /^\s*(%|percent|pp|个百分点)/i.test(tail);
  return { value: Number(raw.replace(/,/g, "")), raw, isPercent };
}

function fieldClose(rowVal, proseVal, tol) {
  if (rowVal == null || !Number.isFinite(rowVal) || proseVal == null || !Number.isFinite(proseVal)) return false;
  return Math.abs(rowVal - proseVal) <= tol;
}

/**
 * Date existence + analog-row co-occurrence.
 *
 * Every YYYY-MM-DD in prose must be a date the payload carries. Beyond that, when a date is cited as
 * an analog row and the clause names that row's distance / forward return / excursion, the whole
 * clause has to be explained by ONE retrieval.top entry with that session - the date cannot keep the
 * distance or return of a different episode. This is the check that catches a symbol/date/distance
 * splice that pure token-existence (each token individually real) would otherwise pass.
 */
export function verifyDatePairs(rawText, analogRows, dateForms) {
  const text = String(rawText || "").replace(CODEISH, (m) => " ".repeat(m.length));
  const violations = [];
  const sessions = new Set(analogRows.map((r) => r.session));
  const symbols = [...new Set(analogRows.map((r) => r.symbol))].filter(Boolean).sort((a, b) => b.length - a.length);
  const symRe = symbols.length
    ? new RegExp("(?<![A-Z0-9.])(" + symbols.map(escapeRe).join("|") + ")(?![A-Z])", "g")
    : null;

  const dates = [...text.matchAll(DATE_TOKEN_RE)];
  for (let i = 0; i < dates.length; i++) {
    const dm = dates[i];
    const D = dm[0];
    const pStart = dm.index, pEnd = dm.index + D.length;
    // Forward segment: up to the next date or a sentence boundary, capped.
    let fEnd = i + 1 < dates.length ? dates[i + 1].index : text.length;
    const sentM = SENT_END_RE.exec(text.slice(pEnd, fEnd));
    if (sentM) fEnd = pEnd + sentM.index;
    fEnd = Math.min(fEnd, pEnd + 140);
    const forward = text.slice(pEnd, fEnd);
    // Backward segment to the sentence start, capped, used to find the cited symbol.
    let bStart = Math.max(0, pStart - 80);
    const backSlice = text.slice(bStart, pStart);
    const bM = [...backSlice.matchAll(new RegExp(SENT_END_RE.source, "g"))];
    if (bM.length) bStart = bStart + bM[bM.length - 1].index + 1;
    const backward = text.slice(bStart, pStart);

    // Rule A - the date itself must be present in the payload.
    if (!dateForms.has(D)) {
      violations.push({ value: `date ${D}`, context: text.slice(bStart, fEnd).replace(/\s+/g, " ").trim().slice(0, 160) });
      continue;
    }

    const distA = firstNumberAfter(forward, DIST_KW_RE);
    const retA = firstNumberAfter(forward, RET_KW_RE);
    const maeA = firstNumberAfter(forward, MAE_KW_RE);
    const mfeA = firstNumberAfter(forward, MFE_KW_RE);
    // Only row citations with at least one anchored attribute are tuple-checked; a date cited with no
    // distance/return keyword (e.g. "the 2020 episodes") is covered by Rule A alone.
    if (!(distA || retA || maeA || mfeA) || !sessions.has(D)) continue;

    let sym = null;
    if (symRe) {
      const sm = [...backward.matchAll(symRe)];
      if (sm.length) sym = sm[sm.length - 1][1];
    }
    const candidates = analogRows.filter((r) => r.session === D && (!sym || r.symbol === sym));
    const explained = candidates.some((r) =>
      (!distA || fieldClose(r.distance, distA.value, 0.002)) &&
      (!retA || fieldClose(r.ret, retA.value, 0.03)) &&
      (!maeA || fieldClose(r.mae, maeA.value, 0.03)) &&
      (!mfeA || fieldClose(r.mfe, mfeA.value, 0.03)));
    if (!explained) {
      const want = [distA && `distance ${distA.raw}`, retA && `return ${retA.raw}%`, maeA && `MAE ${maeA.raw}%`, mfeA && `MFE ${mfeA.raw}%`].filter(Boolean).join(", ");
      violations.push({
        value: `analog pair ${sym ? sym + " " : ""}${D} -> ${want}`,
        context: text.slice(bStart, fEnd).replace(/\s+/g, " ").trim().slice(0, 200)
      });
    }
  }
  return violations;
}

function near(value, forms, relTol) {
  const v = Number(value);
  if (!Number.isFinite(v)) return false;
  if (forms.has(value)) return true;
  for (const s of forms) {
    const x = Number(s);
    if (!Number.isFinite(x)) continue;
    if (x === v) return true;
    const denom = Math.max(Math.abs(x), Math.abs(v), 1e-9);
    if (Math.abs(x - v) / denom <= relTol) return true;
  }
  return false;
}

/**
 * @param {string} text generated prose
 * @param {{forms:Set<string>,structural:Set<string>}} allow
 * @param {{relTol?:number, maxReported?:number}} opts
 */
export function verifyNumbers(text, allow, opts = {}) {
  const relTol = opts.relTol ?? 0.005;
  const tokens = extractNumerals(text);
  const unsupported = [], passedStructural = [];
  for (const t of tokens) {
    if (near(t.normalised, allow.forms, relTol)) continue;
    if (near(t.normalised, allow.structural, relTol)) { passedStructural.push(t); continue; }
    // A percent-suffixed token may match the fraction form of a payload number.
    if (t.hasPercent && near(String(Number(t.normalised) / 100), allow.forms, relTol)) continue;
    if (!t.hasPercent && near(String(Number(t.normalised) * 100), allow.forms, relTol)) continue;
    unsupported.push(t);
  }
  // Date existence + analog-row co-occurrence. The allowlist carries the payload dates and analog
  // rows; when an older caller did not build them the gate skips this layer rather than failing.
  let dateViolations = [];
  if (allow.dateForms && allow.analogRows) {
    dateViolations = verifyDatePairs(text, allow.analogRows, allow.dateForms);
    for (const v of dateViolations) unsupported.push(v);
  }
  return {
    ok: unsupported.length === 0,
    total: tokens.length,
    unsupportedCount: unsupported.length,
    unsupported: unsupported.slice(0, opts.maxReported ?? 12),
    structuralPasses: passedStructural.length,
    dateViolations: dateViolations.length,
    passRate: tokens.length ? (tokens.length - unsupported.length + dateViolations.length) / tokens.length : 1,
    relTol
  };
}

/** Human-readable instruction appended on a retry so the model can actually fix the failure. */
export function retryInstruction(check) {
  if (check.ok) return "";
  const list = check.unsupported.map((u) => `"${u.value}" (in: ...${u.context}...)`).join("\n  - ");
  return [
    "Your previous draft contained numbers that do not appear anywhere in the supplied engine payload:",
    `  - ${list}`,
    "Rewrite the draft so that every numeral is copied from the payload. Where the payload lacks a",
    "figure, describe the direction qualitatively instead of estimating a value. Do not introduce",
    "percentages, counts, dates or magnitudes that are not literally present in the payload."
  ].join("\n");
}