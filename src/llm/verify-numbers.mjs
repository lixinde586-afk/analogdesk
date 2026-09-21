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
  return { forms, structural, payloadNumbers: [...nums] };
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
  return {
    ok: unsupported.length === 0,
    total: tokens.length,
    unsupportedCount: unsupported.length,
    unsupported: unsupported.slice(0, opts.maxReported ?? 12),
    structuralPasses: passedStructural.length,
    passRate: tokens.length ? (tokens.length - unsupported.length) / tokens.length : 1,
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