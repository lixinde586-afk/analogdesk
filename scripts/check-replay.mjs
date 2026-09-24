/**
 * AnalogDesk - replay-cache gate.
 *
 *   npm run check:replay
 *
 * This gate exists because the replay cache shipped EMPTY and stayed empty through a full
 * `npm run check` run: every other gate passed while the deployed site silently rendered the
 * template for every card, so a judge on the "AI Trading Desk" track never saw a model write a
 * sentence. Nothing failed, because nothing asserted that a keyless reviewer gets model prose.
 *
 * It also locks the digest contract that caused it. `cardDigest` used to fold in `generatedAt`
 * (a fresh clock reading), the whole `provenance` block (which the browser runtime rewrites before
 * narrating) and the model name (which the static bundle cannot know). Any one of those guarantees
 * a warmed record is never found again - and the failure is invisible, because TEMPLATE renders a
 * perfectly good card. So part 1 below re-derives those three mismatches and asserts they are gone.
 *
 * Part 2 asserts the cache is actually populated for every canonical card, that each stored record
 * still passes the numeric gate against the card it claims to describe, and that the ids are present
 * in the compiled bundle - i.e. that what a judge downloads contains the prose.
 *
 * Invariants (part 1) always hard-fail. Cache coverage (part 2) can be waived once, with
 * ANALOGDESK_ALLOW_EMPTY_REPLAY=1, for work-in-progress branches; a waiver prints loudly.
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { createDesk } from "../src/desk.mjs";
import { cardDigest, stableCardView, DIGEST_VOLATILE_KEYS } from "../src/llm/replay.mjs";
import { narrate, PROMPT_VERSION } from "../src/llm/narrate.mjs";
import { buildAllowlist, verifyNumbers, defaultAllowance } from "../src/llm/verify-numbers.mjs";
import { buildCanonicalEntries, REPLAY_DIR, ROOT } from "./replay-cards.mjs";

let failures = 0;
let warnings = 0;
const ok = (m) => console.log(`  ok   ${m}`);
const bad = (m) => { failures++; console.log(`  FAIL ${m}`); };
const warn = (m) => { warnings++; console.log(`  warn ${m}`); };
const section = (t) => console.log(`\n=== ${t} ===`);
const gateOf = (card, text) => verifyNumbers(text, buildAllowlist(card, defaultAllowance(card)));

const WAIVE = process.env.ANALOGDESK_ALLOW_EMPTY_REPLAY === "1";
const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };

/* --------------------- part 1: the digest contract --------------------- */

section("digest invariants: the three ways a warmed record used to become unreachable");

const { desk, dataset, validationResults, entries } = buildCanonicalEntries();
const baseReq = { symbol: "NVDA", date: "latest", horizon: 5, k: 50, includeStress: true };
const idOf = (card, language = "en") => cardDigest(card, { promptVersion: PROMPT_VERSION, language });

const runA = desk.analyze(baseReq).card;
await new Promise((r) => setTimeout(r, 1100));
const runB = desk.analyze(baseReq).card;
if (runA.generatedAt === runB.generatedAt) bad("probe is not testing anything: generatedAt did not advance between the two runs");
else ok(`generatedAt advanced (${runA.generatedAt} -> ${runB.generatedAt}) and is excluded from the key`);
if (idOf(runA) === idOf(runB)) ok(`1. clock: two identical requests 1.1s apart hash to the same id (${idOf(runA)})`);
else bad(`1. clock: identical requests hashed differently (${idOf(runA)} vs ${idOf(runB)}) - a cached record can never be found again`);

// The browser runtime rewrites card.provenance before narrating, and the compiled bundle carries a
// TRIMMED validation payload (per-query `rows` dropped, `rowsOmitted` added) plus machine-dependent
// timings from a locally regenerated research/validation-results.json. All three must be irrelevant.
const browserProvenance = {
  llmBaseUrl: "https://example.invalid/v1", excludedFromDistance: ["dv20z", "fng", "hyChg20"],
  networkProbe: { generatedAt: "1999-01-01T00:00:00.000Z", summary: "a different network entirely" }
};
const perturbed = validationResults ? JSON.parse(JSON.stringify(validationResults)) : null;
if (perturbed) {
  for (const run of Object.values(perturbed.runs || {})) {
    const nRows = Array.isArray(run.rows) ? run.rows.length : 0;
    delete run.rows; run.rowsOmitted = nRows;
    run.timing = { ...(run.timing || {}), meanQueryMs: 999.9, coldQueryMs: 1234.5 };
  }
}
// The browser gets the TRIMMED copy the bundle ships, so this mirrors compile-bundle.mjs exactly:
// a field the card reads must never be trimmed away, or the two runtimes would hash differently and
// every warmed replay record would miss on the static site.
const browserBitget7x24 = (() => {
  const full = readJson(join(ROOT, "data-cache", "bitget-7x24.json"));
  if (!full) return null;
  const { observedTickerFields, catalog, ...rest } = full;
  return { ...rest, catalog: catalog ? { rows: catalog.rows, rwaFlagged: catalog.rwaFlagged, exchangesReported: catalog.exchangesReported, note: catalog.note } : null };
})();
const browserDesk = createDesk({ dataset, validationResults: perturbed, provenance: browserProvenance, wrapper: readJson(join(ROOT, "data-cache", "wrapper-probe.json")), bitget7x24: browserBitget7x24 });
const runC = browserDesk.analyze(baseReq).card;
runC.provenance = {
  ...(runC.provenance || {}), ...browserProvenance,
  bitget: { reachable: false, summary: "not probed in the static build", endpoints: [] },
  llm: { mode: "REPLAY/TEMPLATE", model: null, keyPresent: false }
};
if (idOf(runA) === idOf(runC)) ok(`2. runtime: a Node card and a browser-runtime card (rewritten provenance, trimmed validation, different timings) hash identically`);
else bad(`2. runtime: Node ${idOf(runA)} != browser ${idOf(runC)} - anything warmed with an API key is invisible to the keyless static bundle`);

const withModel = cardDigest(runA, { promptVersion: PROMPT_VERSION, language: "en", model: "qwen-plus" });
if (withModel === idOf(runA)) ok(`3. model: the model name is no longer part of the key, so a qwen-plus record is found by a bundle that cannot know the model`);
else bad(`3. model: passing a model still changes the id (${withModel} vs ${idOf(runA)})`);

if (idOf(runA, "zh") !== idOf(runA, "en")) ok(`4. language: en ${idOf(runA, "en")} != zh ${idOf(runA, "zh")} - one card cannot serve both languages from one slot`);
else bad(`4. language: en and zh collide on one id, so a judge would be answered in the wrong language`);

if (cardDigest(runA, { promptVersion: "999", language: "en" }) !== idOf(runA)) ok(`5. promptVersion: bumping PROMPT_VERSION invalidates the cache`);
else bad(`5. promptVersion: a prompt change would silently reuse old prose`);

const view = stableCardView(runA);
for (const k of ["generatedAt", "provenance"]) {
  if (!(k in view)) ok(`6. stable view omits "${k}"`);
  else bad(`6. stable view still contains "${k}"`);
}
for (const k of ["generatedAt", "provenance", "meanRetrievalMs"]) {
  if (DIGEST_VOLATILE_KEYS.includes(k)) ok(`7. DIGEST_VOLATILE_KEYS still lists "${k}"`);
  else bad(`7. DIGEST_VOLATILE_KEYS no longer lists "${k}" - a volatile field is back in the key`);
}
if (idOf(desk.analyze({ ...baseReq, symbol: "TSLA" }).card) !== idOf(runA)) ok(`8. a different symbol still produces a different id`);
else bad(`8. different symbols collide - the key is too coarse`);
if (idOf(desk.analyze({ ...baseReq, horizon: 20 }).card) !== idOf(runA)) ok(`9. a different horizon still produces a different id`);
else bad(`9. different horizons collide - the key is too coarse`);

/* --------------------- part 2: is the cache actually populated --------------------- */

section("canonical replay records: what a judge with no API key will read");

const onDiskIds = new Set(existsSync(REPLAY_DIR) ? readdirSync(REPLAY_DIR).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")) : []);
let cached = 0, optionalMissing = 0;
const requiredEntries = entries.filter((e) => e.required);
console.log("  (" + requiredEntries.length + " required: the auto-run deep links a reviewer reaches without typing, plus every example chip a reviewer clicks; " + (entries.length - requiredEntries.length) + " optional)");
for (const e of entries) {
  const rec = readJson(join(REPLAY_DIR, `${e.id}.json`));
  const label = `${e.key.padEnd(20)} ${e.id}  (${e.spec.symbol} H=${e.spec.horizon})`;
  if (!rec?.text) {
    if (e.required) bad(label + " -> REQUIRED card has no record; a keyless judge gets TEMPLATE on an auto-run deep link");
    else { optionalMissing++; warn(label + " -> no record (optional); this card falls back to TEMPLATE"); }
    continue;
  }
  const check = gateOf(e.card, rec.text);
  if (!check.ok) { bad(`${label} -> record fails the numeric gate (${check.unsupportedCount} of ${check.total} unsupported); it would be rejected and fall back to TEMPLATE`); continue; }
  if (rec.language && rec.language !== e.language) { bad(`${label} -> record was written for language "${rec.language}", not "${e.language}"`); continue; }
  if (rec.promptVersion && rec.promptVersion !== PROMPT_VERSION) { bad(`${label} -> record is promptVersion "${rec.promptVersion}", current is "${PROMPT_VERSION}"`); continue; }
  cached++;
  ok(`${label} -> REPLAY, model ${rec.model || "?"}, ${check.total - check.unsupportedCount}/${check.total} numerals traced, ${rec.text.length} chars`);
}

section("the compiled bundle a judge actually downloads");
const bundlePath = join(ROOT, "dist", "app.bundle.js");
if (!existsSync(bundlePath)) {
  warn("dist/app.bundle.js is missing - run: npm run compile");
} else {
  const bundle = readFileSync(bundlePath, "utf8");
  const seedMatch = bundle.match(/AnalogDesk\.replaySeed\s*=\s*(\{[\s\S]*?\});/);
  let seeded = 0;
  if (seedMatch) { try { seeded = Object.keys(JSON.parse(seedMatch[1])).length; } catch { seeded = -1; } }
  if (seeded === 0) bad("dist/app.bundle.js ships replaySeed = {} - the static site cannot show model prose at all");
  else if (seeded > 0) ok(`replaySeed carries ${seeded} record(s)`);
  else warn("could not parse replaySeed out of the bundle");
  for (const e of entries) {
    if (bundle.includes(`"${e.id}"`)) ok(`  bundle contains ${e.key} (${e.id})`);
    else if (onDiskIds.has(e.id)) bad(`  ${e.key} (${e.id}) is cached on disk but NOT in the bundle - run: npm run compile`);
  }
}

/* ------------------------------- verdict ------------------------------- */

console.log("");
if (WAIVE && failures > 0) {
  console.log(`check:replay: ${failures} failure(s) WAIVED by ANALOGDESK_ALLOW_EMPTY_REPLAY=1, ${warnings} warning(s).`);
  console.log(`  This waiver exists for work-in-progress branches. Do NOT publish with it set: the deployed`);
  console.log(`  site will render the template renderer for every card and the AI layer will be invisible.`);
  console.log(`  Fill the cache with: npm run replay:warm  (needs LLM_API_KEY), then npm run compile.`);
} else if (failures > 0) {
  console.log(`check:replay FAILED: ${failures} failure(s), ${warnings} warning(s).`);
  console.log(`  ${cached}/${entries.length} canonical records cached.`);
  console.log(`  Fill the cache with: npm run replay:warm   (requires LLM_API_KEY / DASHSCOPE_API_KEY)`);
  console.log(`  Then recompile so it ships: npm run compile`);
  process.exit(1);
} else {
  console.log("check:replay passed - all " + requiredEntries.length + " required records cached and gated, " + cached + "/" + entries.length + " canonical records total, " + warnings + " warning(s).");
}
