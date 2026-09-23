/**
 * AnalogDesk - warm the replay cache with REAL model output.
 *
 *   npm run replay:warm                  every canonical card, in every canonical language
 *   node scripts/warm-replay.mjs --only nvda-h5,kweb-h10
 *   node scripts/warm-replay.mjs --dry-run
 *
 * WHY THIS EXISTS
 * The static deployment is what a judge without a DashScope key sees, and its narrative comes from
 * `replaySeed` - the contents of data-cache/llm-replay baked into dist/app.bundle.js by
 * `npm run compile`. If that directory is empty, every card on the deployed site renders in TEMPLATE
 * mode and the "AI Trading Desk" track never sees a model write a sentence. This script fills it.
 *
 * It calls the live model, and stores ONLY prose that passed the numeric gate: narrate() refuses to
 * cache a draft whose numerals are not traceable to the card, so a warmed record is by construction
 * a verified one. Each record is then re-read from disk and re-gated here, because a cache that is
 * trusted rather than checked is how an unsupported number reaches a judge.
 *
 * Records are keyed by the stable digest in src/llm/replay.mjs, so one warm run serves BOTH runtimes:
 * server.mjs with a key, and the keyless browser bundle. Re-warm after `npm run build:data`: a card
 * computed from different data is a different question and must not reuse old prose, and `date:
 * "latest"` moves with the library. `npm run verify` does NOT invalidate the cache - machine
 * timings are excluded from the key, and every other validation figure is deterministic.
 * `npm run check:replay` fails if the cache has drifted from the current dataset.
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as fs from "node:fs";

import { resolveConfig } from "../src/llm/config.mjs";
import { registerNodeFs, createNodeStore } from "../src/llm/replay.mjs";
import { narrate } from "../src/llm/narrate.mjs";
import { buildAllowlist, verifyNumbers, defaultAllowance } from "../src/llm/verify-numbers.mjs";
import { buildCanonicalEntries, REPLAY_DIR, CANONICAL_REQUESTS } from "./replay-cards.mjs";

const log = (...a) => console.log("[warm]", ...a);

function parseArgs(argv) {
  const out = { only: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--only") out.only = String(argv[++i] || "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (a.startsWith("--only=")) out.only = a.slice(7).split(",").map((s) => s.trim()).filter(Boolean);
  }
  return out;
}

const gate = (card, text) => verifyNumbers(text, buildAllowlist(card, defaultAllowance(card)));

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = resolveConfig();

  log(`building the canonical card set ...`);
  const { entries } = buildCanonicalEntries();
  const wanted = args.only
    ? entries.filter((e) => args.only.includes(e.spec.id) || args.only.includes(e.key))
    : entries;
  if (!wanted.length) {
    console.error(`[warm] --only matched nothing. Known ids: ${CANONICAL_REQUESTS.map((r) => r.id).join(", ")}`);
    process.exit(1);
  }
  log(`${wanted.length} of ${entries.length} canonical records to warm`);

  if (args.dryRun) {
    for (const e of wanted) log(`  would warm ${e.key.padEnd(20)} -> ${e.id}  (${e.spec.symbol} H=${e.spec.horizon} k=${e.spec.k})`);
    log(`dry run: nothing written. Re-run without --dry-run and an API key configured.`);
    return;
  }

  if (!cfg.llm.enabled) {
    console.error([
      `[warm] no API key configured, so there is nothing to warm the cache WITH.`,
      ``,
      `  Warming the replay cache is the whole point of this script: it stores REAL model prose so a`,
      `  judge without a key still sees a model-written narrative instead of the template renderer.`,
      `  A template cannot be "warmed" - it is already deterministic, and pretending otherwise would`,
      `  mean labelling engine prose as model prose.`,
      ``,
      `  Copy .env.example to .env and set ONE of:`,
      `    LLM_API_KEY=sk-...            (with LLM_BASE_URL / LLM_MODEL, defaults to DashScope qwen-plus)`,
      `    DASHSCOPE_API_KEY=sk-...`,
      `  or export it for one run:`,
      `    $env:LLM_API_KEY="sk-..." ; npm run replay:warm        (PowerShell)`,
      `    LLM_API_KEY=sk-... npm run replay:warm                 (bash)`,
      ``,
      `  Endpoint ${cfg.llm.baseUrl} model ${cfg.llm.model}. Any OpenAI-compatible endpoint works`,
      `  (SiliconFlow / ModelScope are listed in .env.example).`,
      ``,
      `  Then: npm run replay:warm  &&  npm run compile  &&  npm run check:replay`
    ].join("\n"));
    process.exit(1);
  }

  registerNodeFs(fs);
  const store = createNodeStore(REPLAY_DIR);
  log(`endpoint ${cfg.llm.baseUrl}  model ${cfg.llm.model}  ->  ${REPLAY_DIR}`);

  const results = [];
  for (const e of wanted) {
    const t0 = Date.now();
    process.stdout.write(`[warm] ${e.key.padEnd(20)} ${e.id} ... `);
    let narr;
    try {
      narr = await narrate({ card: e.card, question: e.question, language: e.language, llm: cfg.llm, store, forceMode: "LIVE", persist: true });
    } catch (err) {
      console.log(`ERROR ${err.message}`);
      results.push({ ...e, ok: false, reason: `threw: ${err.message}` });
      continue;
    }
    const ms = Date.now() - t0;
    // Re-read from disk: what ships is the FILE, not the in-memory result.
    const recPath = join(REPLAY_DIR, `${e.id}.json`);
    const onDisk = existsSync(recPath) ? (JSON.parse(readFileSync(recPath, "utf8") || "null")) : null;
    const recheck = onDisk?.text ? gate(e.card, onDisk.text) : null;
    const ok = narr.mode === "LIVE" && Boolean(onDisk?.text) && Boolean(recheck?.ok);
    console.log(`${ok ? "OK  " : "FAIL"} ${narr.mode} in ${ms} ms` +
      (onDisk?.text ? `, ${recheck.total - recheck.unsupportedCount}/${recheck.total} numerals traced, ${onDisk.text.length} chars` : `, nothing stored`));
    for (const w of narr.warnings || []) console.log(`         warning: ${w}`);
    results.push({ ...e, ok, mode: narr.mode, ms, storedChars: onDisk?.text?.length || 0, reason: ok ? null : (narr.mode !== "LIVE" ? `mode was ${narr.mode}` : !onDisk?.text ? "no record on disk" : "record failed the numeric gate on re-read") });
  }

  const good = results.filter((r) => r.ok);
  log(``);
  log(`warmed ${good.length}/${results.length} canonical records`);
  const files = existsSync(REPLAY_DIR) ? readdirSync(REPLAY_DIR).filter((f) => f.endsWith(".json")) : [];
  log(`data-cache/llm-replay now holds ${files.length} record(s)`);

  if (good.length < results.length) {
    for (const r of results.filter((x) => !x.ok)) console.error(`[warm] FAILED ${r.key} (${r.id}): ${r.reason}`);
    console.error(`[warm] a partial cache still helps, but npm run check:replay will fail until every canonical record exists.`);
  }

  log(``);
  log(`next: npm run compile      (bakes these records into dist/app.bundle.js as replaySeed)`);
  log(`      npm run check:replay (proves a keyless judge now gets REPLAY, not TEMPLATE)`);
  log(`      npm run publish:github`);

  if (!good.length) process.exit(1);
}

main().catch((e) => { console.error(`[warm] ${e.stack || e.message}`); process.exit(1); });
