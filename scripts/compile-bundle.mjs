/**
 * AnalogDesk - static deployment bundler.
 *
 *   npm run compile        writes dist/ (index.html + app.bundle.js) and prints sizes
 *
 * WHY THIS EXISTS
 * A judge reviewing the submission may have no API key, no Node and no willingness to run a server.
 * The static package therefore has to execute the FULL engine in the browser - retrieval, expanding
 * point-in-time z-scores, conformal calibration, the whole stress suite - not replay canned answers.
 * A screenshot demo would be dishonest about what the project does; this is the same code path as
 * server.mjs, with the same numeric gate on the narrative.
 *
 * HOW IT WORKS
 * The project has zero dependencies, so there is no esbuild/rollup to lean on and no reason to add
 * one. This is a small CommonJS-shim bundler: every ES module in the browser graph is wrapped in a
 * factory whose imports arrive as parameters and whose exports are exposed through getters, so live
 * bindings and hoisted function declarations keep working exactly as they do under Node. The module
 * graph is resolved statically, checked for cycles and checked for node: builtins - if a Node-only
 * module (src/llm/client.mjs, config.mjs, narrate.mjs, anything under src/data/ that fetches) ever
 * leaks into the graph, the build fails loudly instead of producing a package that breaks at runtime.
 *
 * The analog library and the frozen validation run are inlined. validation-results.json is 20MB
 * because it keeps every scored row for audit; only the summaries the desk renders are shipped, and
 * the trimmed payload is written to dist/ so the full figures remain inspectable.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve, relative, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const DIST = join(ROOT, "dist");
const rel = (p) => relative(ROOT, p).replace(/\\/g, "/");
const log = (...a) => console.log("[compile]", ...a);
const fail = (m) => { console.error("[compile] FATAL:", m); process.exit(1); };

/* ------------------------------ graph walk ------------------------------- */

const IMPORT_STATIC = /(?:^|\n)[ \t]*(?:export[ \t]+)?import\s+([\s\S]*?)[ \t]*from[ \t]*["']([^"']+)["'][ \t]*(?:\n|;|$)/g;
const IMPORT_BARE = /(?:^|\n)[ \t]*import[ \t]*["']([^"']+)["'][ \t]*(?:\n|;|$)/g;
const IMPORT_DYNAMIC = /\bimport[ \t]*\([ \t]*["']([^"']+)["'][ \t]*\)/g;

function specifiersOf(clause) {
  const c = String(clause || "").trim();
  const out = { default: null, namespace: null, named: [] };
  if (!c) return out;
  let rest = c;
  const brace = rest.indexOf("{");
  let head = brace >= 0 ? rest.slice(0, brace) : rest;
  if (brace >= 0) {
    const end = rest.indexOf("}");
    const inner = rest.slice(brace + 1, end < 0 ? rest.length : end);
    for (const part of inner.split(",")) {
      const s = part.trim(); if (!s) continue;
      const m = s.match(/^([\w$]+)(?:\s+as\s+([\w$]+))?$/);
      if (m) out.named.push({ imported: m[1], local: m[2] || m[1] });
    }
    rest = rest.slice(brace + (rest.indexOf("}") - brace) + 1);
    void rest;
  }
  head = head.replace(/,/g, " ").trim();
  for (const tok of head.split(/\s+/)) {
    if (!tok) continue;
    if (tok.startsWith("*")) { const m = tok.match(/^\*\s*as\s*([\w$]+)$/) || head.match(/^\*\s*as\s*([\w$]+)/); if (m) out.namespace = m[1]; }
    else if (/^[\w$]+$/.test(tok) && !out.default) out.default = tok;
  }
  return out;
}

function parseImports(src) {
  const found = [];
  for (const m of src.matchAll(IMPORT_STATIC)) found.push({ spec: m[2], clause: m[1], dynamic: false });
  for (const m of src.matchAll(IMPORT_BARE)) found.push({ spec: m[1], clause: "", dynamic: false });
  for (const m of src.matchAll(IMPORT_DYNAMIC)) found.push({ spec: m[1], clause: "", dynamic: true });
  return found;
}

function parseExports(src) {
  const names = [];
  let hasDefault = false;
  for (const m of src.matchAll(/(?:^|\n)\s*export\s+(default\b|const\b|let\b|var\b|function\b|async\s+function\b|class\b|\{)/g)) {
    const kind = m[1];
    if (kind.startsWith("default")) { hasDefault = true; continue; }
    if (kind === "{") {
      const end = src.indexOf("}", m.index);
      const inner = src.slice(m.index + m[0].length, end < 0 ? src.length : end);
      if (!/^\s*[\w$\s,as]*$/.test(inner)) continue;           // `export { x } from "y"` is a re-export
      for (const part of inner.split(",")) {
        const s = part.trim(); if (!s) continue;
        const mm = s.match(/^([\w$]+)(?:\s+as\s+([\w$]+))?$/);
        if (mm) names.push({ local: mm[1], exported: mm[2] || mm[1] });
      }
      continue;
    }
    const tail = src.slice(m.index + m[0].length);
    const nm = tail.match(/^\s*(?:async\s+function\s+)?\*?\s*([\w$]+)/);
    if (nm) names.push({ local: nm[1], exported: nm[1] });
  }
  return { names, hasDefault };
}

/* ------------------------------- transform ------------------------------- */

const RUNTIME = `
var __adModules = Object.create(null), __adCache = Object.create(null), __adArgs = Object.create(null);
function __adRequire(id) {
  if (id in __adCache) return __adCache[id];
  var factory = __adModules[id];
  if (!factory) throw new Error("AnalogDesk bundle: unknown module " + id);
  var exports = {};
  __adCache[id] = exports;
  var extra = __adArgs[id] || [];
  return factory.apply(null, [__adRequire, exports].concat(extra)) || exports;
}
`;

function transformModule(key, src) {
  const imports = parseImports(src);
  const { names, hasDefault } = parseExports(src);
  const importArgs = ["__adRequire", "exports"];
  const importVals = ["__adRequire", "exports"];
  const seenLocal = new Set();
  const pushPair = (arg, val) => {
    if (seenLocal.has(arg)) return;
    seenLocal.add(arg); importArgs.push(arg); importVals.push(val);
  };
  for (const imp of imports) {
    if (imp.dynamic) continue;
    const depKey = resolveDep(key, imp.spec);
    const { default: d, namespace, named } = specifiersOf(imp.clause);
    if (namespace) pushPair(namespace, `__adRequire(${JSON.stringify(depKey)})`);
    if (d) pushPair(d, `__adRequire(${JSON.stringify(depKey)}).default`);
    for (const n of named) pushPair(n.local, `__adRequire(${JSON.stringify(depKey)})[${JSON.stringify(n.imported)}]`);
  }

  let body = src;
  // Strip static import statements; their bindings now arrive as factory parameters.
  body = body.replace(IMPORT_STATIC, (m) => (m.startsWith("\n") ? "\n" : ""));
  body = body.replace(IMPORT_BARE, (m) => (m.startsWith("\n") ? "\n" : ""));
  // Dynamic import() becomes a resolved promise over the same registry, so the shim entry can
  // require web/app.js after window.AnalogDesk has been populated.
  body = body.replace(IMPORT_DYNAMIC, (m, spec) => `Promise.resolve().then(function () { return __adRequire(${JSON.stringify(resolveDep(key, spec))}); })`);

  const exportDecls = [];
  body = body.replace(/(^|\n)([ \t]*)export[ \t]+default[ \t]+/, (m, nl, ind) => {
    exportDecls.push("default");
    return `${nl}${ind}exports.default = `;
  });
  body = body.replace(/(^|\n)([ \t]*)export[ \t]+(?=(?:const|let|var|function|async[ \t]+function|class)[ \t\n])/g, (m, nl, ind) => {
    return `${nl}${ind}`;
  });
  // `export { a, b as c };` (no `from`) is a plain re-export of locals: drop the statement.
  body = body.replace(/(^|\n)[ \t]*export[ \t]*\{[^}]*\}[ \t]*;?[ \t]*(?=\n|$)/g, (m) => (m.startsWith("\n") ? "\n" : ""));

  const getters = [];
  const exported = new Map();
  for (const n of names) exported.set(n.exported, n.local);
  // Anything declared with `export` above had the keyword stripped, so recover the local names.
  for (const m of src.matchAll(/(?:^|\n)\s*export\s+(?:const|let|var|function|async\s+function|class)\s+([\w$]+)/g)) {
    exported.set(m[1], m[1]);
  }
  if (exportDecls.includes("default")) exported.set("default", null);
  // These MUST be accessor descriptors. Passing a bare function to Object.defineProperties defines
  // the property with value undefined, which silently turns every cross-module import into undefined.
  // Getters (rather than a snapshot object) are what preserve ESM live bindings and hoisted
  // function declarations, e.g. replay.mjs's reassignable `_fs` behind registerNodeFs().
  for (const [exportedName, localName] of exported) {
    getters.push(localName == null
      ? `  ${JSON.stringify(exportedName)}: { enumerable: true, configurable: true, get: function () { return exports[${JSON.stringify(exportedName)}]; } }`
      : `  ${JSON.stringify(exportedName)}: { enumerable: true, configurable: true, get: function () { return ${localName}; } }`);
  }

  return {
    key, importArgs, importVals,
    code: `(function (${importArgs.join(", ")}) {\n${body}\nreturn Object.defineProperties(exports, {\n${getters.join(",\n")}\n});\n})`
  };
}

/* --------------------------------- graph --------------------------------- */

const MODULES = new Map();
const ORDER = [];
const STACK = [];

function resolveDep(fromKey, spec) {
  if (!spec.startsWith(".")) fail(`${fromKey}: bare specifier "${spec}" - the browser graph must stay dependency-free`);
  if (spec.startsWith("node:")) fail(`${fromKey}: node builtin "${spec}" cannot be bundled for the browser`);
  const abs = resolve(dirname(resolve(ROOT, fromKey)), spec);
  const key = rel(abs);
  if (!existsSync(abs)) fail(`${fromKey}: cannot resolve "${spec}" (looked for ${key})`);
  return key;
}

function visit(key) {
  if (STACK.includes(key)) fail(`import cycle: ${[...STACK, key].join(" -> ")}`);
  if (MODULES.has(key)) return;
  const abs = resolve(ROOT, key);
  const src = readFileSync(abs, "utf8");
  if (/\bnode:/.test(src) && !/node fs not registered/.test(src)) {
    // replay.mjs mentions node:fs only inside a comment explaining why it stays browser-safe.
    for (const m of src.matchAll(/["'](node:[\w/]+)["']/g)) fail(`${key}: imports ${m[1]}, which does not exist in a browser`);
  }
  STACK.push(key);
  const deps = parseImports(src).map((i) => resolveDep(key, i.spec));
  MODULES.set(key, { key, src, deps });
  for (const d of deps) visit(d);
  STACK.pop();
  ORDER.push(key);
}

/* ------------------------------- shim entry ------------------------------ */

/**
 * The bundle's entry module. It is generated rather than committed so it can never drift from the
 * payload shape web/app.js expects, and so window.AnalogDesk is fully populated before app.js runs -
 * app.js calls boot() at import time, and boot() reads window.AnalogDesk to decide its mode.
 */
const SHIM_KEY = "__analogdesk-entry.js";
/**
 * The shim is emitted as raw factory code and is deliberately NOT routed through transformModule.
 * If the generic transform ever saw an `import` statement here it would hoist that require to the
 * top of the body - including web/app.js, which must be required LAST, after window.AnalogDesk has
 * been populated. So the shim's requires are written by hand, in factory-parameter order.
 */
function shimRequires(deps) {
  return deps.map((k, i) => `var __m${i} = __adRequire(${JSON.stringify(k)});`).join("\n");
}

/**
 * The four payload assignments are emitted as separate statements rather than interpolated into one
 * big template: the analog library alone is several megabytes, and rebuilding that string per field
 * would be both slow and a needless source of escaping bugs.
 */
function shimPayloadAssignments() {
  return [
    `globalThis.AnalogDesk.dataset = `,
    `globalThis.AnalogDesk.validationResults = `,
    `globalThis.AnalogDesk.replaySeed = `,
    `globalThis.AnalogDesk.provenance = `,
    `globalThis.AnalogDesk.wrapper = `
  ];
}

/* --------------------------------- build --------------------------------- */

/** The shim's own import list, kept in one place because both the graph walk and emit() need it. */
const shimSpecs = ["./src/desk.mjs", "./src/llm/template.mjs", "./src/llm/verify-numbers.mjs",
  "./src/llm/replay.mjs", "./src/data/universe.mjs", "./web/app.js"];

function trimmedValidation(V) {
  if (!V) return null;
  const out = { generatedAt: V.generatedAt, primaryHorizon: V.primaryHorizon, horizons: V.horizons, runs: {} };
  for (const [h, r] of Object.entries(V.runs || {})) {
    const { rows, ...rest } = r;                       // `rows` is ~3.4MB per horizon of audit detail
    out.runs[h] = { ...rest, rowsOmitted: Array.isArray(rows) ? rows.length : 0 };
  }
  out.rowsOmittedNote = "Per-query scored rows were omitted from the static package to keep it small; they remain in research/validation-results.json and are what VALIDATION.md reports from.";
  return out;
}

function readJsonOrNull(p) { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } }

function build() {
  const t0 = Date.now();
  const datasetPath = join(ROOT, "data-cache", "dataset.json");
  if (!existsSync(datasetPath)) fail("data-cache/dataset.json is missing - run: npm run build:data");
  const dataset = readJsonOrNull(datasetPath);
  if (!dataset) fail("data-cache/dataset.json did not parse");

  const validationFull = readJsonOrNull(join(ROOT, "research", "validation-results.json"));
  const validation = trimmedValidation(validationFull);
  const netProbe = readJsonOrNull(join(ROOT, "data-cache", "network-probe.json"));
  // The committed 7x24 wrapper measurement. Baked in rather than fetched: the static package makes no
  // network call after load, and a card whose wrapper numbers came from a live order book could never
  // match a warmed replay record. `pairs` is dropped because `bySymbol` holds the same objects -
  // every field desk.mjs actually reads is kept, so the browser card hashes identically to the server one.
  const wrapperFull = readJsonOrNull(join(ROOT, "data-cache", "wrapper-probe.json"));
  const wrapper = wrapperFull ? (({ pairs, ...rest }) => rest)(wrapperFull) : null;
  if (!wrapper) log("WARNING no data-cache/wrapper-probe.json - the static build ships no 7x24 wrapper block.");
  else log(`wrapper: ${Object.keys(wrapper.bySymbol || {}).length} verified wrapper(s), reference market closed ${wrapper.referenceMarket?.closedSharePct}% of the week, median closed-hours move ${wrapper.summary?.medianReferenceClosedMoveSharePct}%, ${wrapper.closedSessionReturns?.pooled?.weekendReturnDistribution?.n ?? 0} weekend return block(s)`);

  // The committed Bitget measurement, written by scripts/measure-bitget.mjs. Baked in for the same
  // reason as the wrapper probe: the static package makes no network call, and a keyless reviewer must
  // still be able to read what the official MCP returned and how it was cross-checked. The per-symbol
  // arrays are dropped - the full file is published next to the bundle as bitget-probe.json - so the
  // panel carries the cross-check totals without carrying 71 quote rows into every page load.
  const bitgetFull = readJsonOrNull(join(ROOT, "data-cache", "bitget-probe.json"));
  const stripPerSymbol = (o) => (o ? (({ perSymbol, ...rest }) => rest)(o) : null);
  const bitgetMeasurement = bitgetFull ? {
    generatedAt: bitgetFull.generatedAt || null,
    route: bitgetFull.summary?.route || null,
    server: bitgetFull.server?.serverInfo || null,
    summary: bitgetFull.summary || null,
    fearGreedCrossCheck: bitgetFull.fearGreedCrossCheck || null,
    earningsCrossCheck: stripPerSymbol(bitgetFull.earningsCrossCheck),
    quotes: stripPerSymbol(bitgetFull.quotes),
    profiles: stripPerSymbol(bitgetFull.profiles),
    wholeMarketSentiment: bitgetFull.wholeMarketSentiment || null,
    measuredEmpty: bitgetFull.measuredEmpty || null,
    disclosure: bitgetFull.disclosure || null
  } : null;
  if (!bitgetMeasurement) log("WARNING no data-cache/bitget-probe.json - the static build ships no Bitget cross-check block.");
  else log(`bitget: ${bitgetMeasurement.server?.name || "?"}@${bitgetMeasurement.server?.version || "?"} on the ${bitgetMeasurement.route} route; ${bitgetMeasurement.fearGreedCrossCheck?.exactMatches ?? 0}/${bitgetMeasurement.fearGreedCrossCheck?.overlappingDates ?? 0} fear-&-greed readings identical, ${bitgetMeasurement.earningsCrossCheck?.matchedDates ?? 0} earnings dates cross-checked`);

  // Replay cache: any generation already stored for an exact card ships with the package, so a
  // judge can see a real model-written narrative without needing a key. The template still renders
  // through the same gate when a card has no record, so an empty cache is not BROKEN - but it does
  // mean the deployed site never shows a model writing a sentence, which on an AI track is the
  // difference between a reviewer seeing the language layer and not seeing it. So it is counted out
  // loud here and gated by npm run check:replay rather than left to chance.
  const replayDir = join(ROOT, "data-cache", "llm-replay");
  const replaySeed = {};
  if (existsSync(replayDir)) {
    for (const f of readdirSync(replayDir).filter((x) => x.endsWith(".json"))) {
      const rec = readJsonOrNull(join(replayDir, f));
      if (rec?.text) replaySeed[f.replace(/\.json$/, "")] = rec;
    }
  }
  const replayCount = Object.keys(replaySeed).length;
  if (!replayCount) {
    log("WARNING replaySeed is EMPTY: data-cache/llm-replay holds no cached generation, so every card");
    log("        on the static site renders in TEMPLATE mode and a judge with no API key never sees");
    log("        model-written prose. Fix: npm run replay:warm, then re-run npm run compile.");
  } else {
    log(`replaySeed: ${replayCount} cached generation(s) baked into the bundle`);
  }

  const promptSrc = readFileSync(join(ROOT, "src", "llm", "narrate.mjs"), "utf8");
  const pv = promptSrc.match(/PROMPT_VERSION\s*=\s*"([^"]+)"/);
  const promptVersion = pv ? pv[1] : "1";

  const provenance = {
    sessions: dataset.dates?.length ?? null,
    symbols: (dataset.meta?.universe || []).length,
    from: dataset.meta?.from, to: dataset.meta?.to,
    datasetBuiltAt: dataset.meta?.builtAt || null,
    sources: dataset.meta?.sources || {},
    notes: dataset.meta?.notes || [],
    excludedFromDistance: ["dv20z", "fng", "hyChg20"],
    networkProbe: netProbe ? {
      generatedAt: netProbe.generatedAt, summary: netProbe.summary, host: netProbe.host, node: netProbe.node,
      usedSources: netProbe.usedSources, unusedSources: netProbe.unusedSources, rejectedSources: netProbe.rejectedSources,
      targets: (netProbe.targets || []).map((x) => ({ name: x.name, role: x.role, ok: x.ok, status: x.status, kind: x.kind, detail: x.detail, latencyMs: x.latencyMs }))
    } : null,
    // The committed probe result, plus the committed measurement that route paid for. Merged rather
    // than replaced: network-probe.json can be older than bitget-probe.json and neither should hide
    // the other.
    bitget: {
      ...(netProbe?.bitget || { reachable: false, summary: "not probed in the static build", endpoints: [], disclosure: null }),
      ...(bitgetMeasurement ? {
        measurement: bitgetMeasurement,
        measurementSummary: bitgetMeasurement.disclosure || null,
        reachable: netProbe?.bitget?.reachable ?? Boolean(bitgetMeasurement.summary?.measured),
        reachableDirectCount: netProbe?.bitget?.reachableDirectCount ?? null,
        proxy: netProbe?.bitget?.proxy || null
      } : {})
    },
    llm: {
      mode: Object.keys(replaySeed).length ? "REPLAY/TEMPLATE" : "TEMPLATE", model: null, keyPresent: false,
      // The endpoint the narrative layer is configured against. It is the Bitget-operated hackathon
      // gateway, not DashScope: the static build used to name a host this project never called, which
      // is a small inaccuracy in exactly the panel whose job is to be accurate.
      baseUrl: "https://hackathon.bitgetops.com/v1",
      note: "The static package ships no API key and makes no model call. The narrative is a stored generation for the exact research card if one is bundled, otherwise the deterministic template. Both pass the same numeric gate."
    },
    validationGeneratedAt: validationFull?.generatedAt || null,
    staticBuild: { generatedAt: new Date().toISOString(), node: process.version },
    // Same shape desk.wrapper() returns on the server, so the provenance panel renders identically in
    // both runtimes without having to know which one it is in.
    wrapper: wrapper ? {
      available: Boolean(wrapper.summary && !wrapper.degradation), degraded: Boolean(wrapper.degradation),
      measuredAt: wrapper.generatedAt || null, venueName: wrapper.venue?.name || null,
      summary: wrapper.summary || null, referenceMarket: wrapper.referenceMarket || null,
      verified: Object.keys(wrapper.bySymbol || {}).length,
      // The pooled return layer, so the keyless site can quote the weekend distribution the server
      // quotes. Per-pair blocks stay in bySymbol and are read from there by the card.
      closedSessionReturns: wrapper.closedSessionReturns
        ? { pairsWithReturnLayer: wrapper.closedSessionReturns.pairsWithReturnLayer, distinctWeekendStarts: wrapper.closedSessionReturns.distinctWeekendStarts, pooled: wrapper.closedSessionReturns.pooled, caveat: wrapper.closedSessionReturns.caveat, convention: wrapper.closedSessionReturns.convention }
        : null
    } : null
  };

  // Walking the shim's dependency list is what pulls the whole browser graph into MODULES/ORDER and
  // runs the cycle and node:-builtin checks over it. The shim itself is not a module: emit() writes
  // it by hand so that require order stays explicit.
  for (const spec of shimSpecs) visit(rel(resolve(ROOT, spec)));

  const transformed = ORDER.map((key) => {
    const mod = MODULES.get(key);
    return transformModule(key, mod.src);
  });

  return { dataset, validation, replaySeed, provenance, promptVersion, transformed, ms: Date.now() - t0, validationFull, netProbe, wrapper, wrapperFull, bitgetFull, bitgetMeasurement };
}

/* -------------------------------- assemble -------------------------------- */

function emit() {
  const b = build();
  mkdirSync(DIST, { recursive: true });

  const shimDeps = ["./src/desk.mjs", "./src/llm/template.mjs", "./src/llm/verify-numbers.mjs",
    "./src/llm/replay.mjs", "./src/data/universe.mjs", "./web/app.js"]
    .map((s) => rel(resolve(ROOT, s)));
  const shimArgs = ["__adRequire", "exports"];
  const A = shimPayloadAssignments();
  const shimBody = [
    // Only the first five: web/app.js (shimDeps[5]) is required explicitly at the very end.
    shimRequires(shimDeps.slice(0, 5)),
    `var createDesk = __m0.createDesk, DEFAULT_HORIZON = __m0.DEFAULT_HORIZON, DEFAULT_K = __m0.DEFAULT_K;`,
    `var template = __m1, verify = __m2, replay = __m3, ALIASES = __m4.ALIASES;`,
    `globalThis.AnalogDesk = { config: {} };`,
    `globalThis.AnalogDesk.desk = { createDesk: createDesk, DEFAULT_HORIZON: DEFAULT_HORIZON, DEFAULT_K: DEFAULT_K };`,
    `globalThis.AnalogDesk.template = template;`,
    `globalThis.AnalogDesk.verify = verify;`,
    `globalThis.AnalogDesk.replay = replay;`,
    `globalThis.AnalogDesk.ALIASES = ALIASES;`,
    `globalThis.AnalogDesk.PROMPT_VERSION = ${JSON.stringify(b.promptVersion)};`,
    `${A[0]}${JSON.stringify(b.dataset)};`,
    `${A[1]}${JSON.stringify(b.validation)};`,
    `${A[2]}${JSON.stringify(b.replaySeed)};`,
    `${A[3]}${JSON.stringify(b.provenance)};`,
    `${A[4]}${JSON.stringify(b.wrapper)};`,
    ``,
    `// app.js is required LAST and synchronously: it calls boot() at module scope and reads`,
    `// window.AnalogDesk there, so every field above must already be assigned. Requiring it earlier`,
    `// makes the bundle boot in SERVER mode and silently fetch a server that does not exist. A`,
    `// deferred require would be worse still - any failure becomes an unhandled rejection, i.e. a`,
    `// blank page with no explanation, which is the worst possible outcome for a reviewer.`,
    `__adRequire(${JSON.stringify(shimDeps[5])});`
  ].join("\n");

  const parts = [];
  parts.push(`/* AnalogDesk static deployment bundle.
 * Generated by scripts/compile-bundle.mjs - do not edit.
 * Built ${new Date().toISOString()} from ${b.transformed.length} ES modules.
 * The full retrieval, conformal-calibration and stress engine runs in this file. No server, no API
 * key, no network access after load. Narrative mode is REPLAY (if a stored generation for the exact
 * research card is bundled) or TEMPLATE, and both pass the same numeric gate as the server build. */`);
  parts.push(`(function (globalThis) {`);
  parts.push(`"use strict";`);
  parts.push(RUNTIME);
  for (const t of b.transformed) {
    if (t.key === SHIM_KEY) continue;
    // The factory's declared parameters are its import bindings, so the call site must supply them.
    // Emitting the code without importVals is what leaves every cross-module import undefined.
    const args = t.importVals.slice(2).join(", ");
    parts.push(`__adModules[${JSON.stringify(t.key)}] = ${t.code};`);
    parts.push(`__adArgs[${JSON.stringify(t.key)}] = [${args}];`);
  }
  parts.push(`__adModules[${JSON.stringify(SHIM_KEY)}] = (function (${shimArgs.join(", ")}) {\n${shimBody}\n});`);
  parts.push(`__adRequire(${JSON.stringify(SHIM_KEY)});`);
  parts.push(`})(typeof globalThis !== "undefined" ? globalThis : this);`);
  parts.push(``);

  const bundle = parts.join("\n");
  const bundlePath = join(DIST, "app.bundle.js");
  writeFileSync(bundlePath, bundle, "utf8");

  const html = readFileSync(join(ROOT, "web", "index.html"), "utf8")
    .replace(`<script type="module" src="./app.js"></script>`,
      `<script src="./app.bundle.js"></script>`)
    .replace(`<link rel="stylesheet" href="./styles.css">`,
      `<link rel="stylesheet" href="./styles.css">`)
    .replace(/<title>([^<]*)<\/title>/, `<title>$1 (static build)</title>`);
  writeFileSync(join(DIST, "index.html"), html, "utf8");
  writeFileSync(join(DIST, "styles.css"), readFileSync(join(ROOT, "web", "styles.css"), "utf8"), "utf8");

  // Keep the trimmed validation payload inspectable next to the bundle, so a reader can check the
  // figures the UI quotes without opening a 20MB file.
  writeFileSync(join(DIST, "validation-summary.json"), JSON.stringify(b.validation, null, 2), "utf8");
  if (b.netProbe) writeFileSync(join(DIST, "network-probe.json"), JSON.stringify(b.netProbe, null, 2), "utf8");
  // The full measurement, rejections included, next to the trimmed copy inside the bundle: a reviewer
  // reading the static site should be able to audit why a candidate was refused without cloning.
  if (b.wrapperFull) writeFileSync(join(DIST, "wrapper-probe.json"), JSON.stringify(b.wrapperFull, null, 2), "utf8");
  // Same reasoning, same treatment: the full Bitget measurement including all 71 per-symbol quote rows
  // and every earnings-date pairing, so the cross-check can be audited without cloning the repo.
  if (b.bitgetFull) writeFileSync(join(DIST, "bitget-probe.json"), JSON.stringify(b.bitgetFull, null, 2), "utf8");

  const size = (f) => statSync(join(DIST, f)).size;
  const mb = (n) => `${(n / 1048576).toFixed(2)} MB`;
  const gz = gzipSync(Buffer.from(bundle, "utf8")).length;
  log(`bundle: ${b.transformed.length} modules, ${mb(size("app.bundle.js"))} raw, ${mb(gz)} gzipped (build ${b.ms} ms)`);
  for (const f of ["index.html", "styles.css", "app.bundle.js", "validation-summary.json", "network-probe.json", "wrapper-probe.json", "bitget-probe.json"]) {
    if (existsSync(join(DIST, f))) log(`  dist/${f.padEnd(26)} ${mb(size(f))}`);
  }
  log(`payload: library ${b.provenance.sessions} sessions x ${b.provenance.symbols} instruments (${b.provenance.from} .. ${b.provenance.to});`
    + ` validation horizons ${Object.keys(b.validation?.runs || {}).join(", ") || "none"};`
    + ` replay entries ${Object.keys(b.replaySeed).length}`);
  log(`open dist/index.html directly in a browser - no server, no key, no network needed.`);
  return { bundlePath, modules: b.transformed.length, bytes: size("app.bundle.js"), gz };
}

emit();
