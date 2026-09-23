/**
 * AnalogDesk - local research desk server.
 * Zero runtime dependencies: node:http, node:fs, node:path, node:zlib only.
 *
 *   npm start           then open http://127.0.0.1:3000
 *   PORT=8080 npm start
 *
 * Everything the browser needs is served from here: the static UI under web/, the analog library as
 * JSON, and the analysis API. The narrative layer resolves to LIVE (a real call to the configured
 * OpenAI-compatible endpoint), REPLAY (a stored generation for this exact research card) or TEMPLATE
 * (the deterministic renderer) and always reports which one it used - see src/llm/narrate.mjs.
 *
 * If no LLM_API_KEY is present the server still works completely: retrieval, calibration, stress
 * scenarios and provenance are all computed by the engine, and the prose comes from the template.
 */

import http from "node:http";
import * as fs from "node:fs";
import { join, extname, normalize, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { resolveConfig, ROOT } from "./src/llm/config.mjs";
import { registerNodeFs, createNodeStore } from "./src/llm/replay.mjs";
import { narrate, detectLang, PROMPT_VERSION } from "./src/llm/narrate.mjs";
import { probeLlm } from "./src/llm/client.mjs";
// The routed probe measures every Bitget host on BOTH a direct connection and through a local
// proxy when one is present, and folds in the committed cross-check measurement. It lives in its own
// module because it needs node:net/node:tls, and src/data/bitget.mjs is in the browser module graph.
import { probeAllBitgetRouted } from "./src/data/bitget-routes.mjs";
import { createDesk, DEFAULT_HORIZON } from "./src/desk.mjs";
import { parseIdea, explain as explainIdea } from "./src/llm/lui.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, "web");
const CACHE = join(HERE, "data-cache");
const RESEARCH = join(HERE, "research");

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2", ".map": "application/json", ".md": "text/markdown; charset=utf-8"
};

const cfg = resolveConfig();
registerNodeFs(fs);
const store = createNodeStore(join(CACHE, "llm-replay"));

const log = (...a) => console.log("[analogdesk]", ...a);

/* ------------------------------- startup -------------------------------- */

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } }

const datasetPath = join(CACHE, "dataset.json");
if (!fs.existsSync(datasetPath)) {
  console.error("[analogdesk] data-cache/dataset.json is missing. Run: npm run build:data");
  process.exit(1);
}
const t0 = Date.now();
const dataset = readJson(datasetPath);
// research/validation-results.json (20 MB, regenerable, git-ignored) is the full audit dump; the
// committed dist/validation-summary.json is the same structure minus the per-query rows. A reviewer
// who clones the repo and runs `npm start` must still get the frozen conformal scale and the
// out-of-sample panel, so the server falls back to the committed summary instead of silently
// serving cards with no calibration on them.
const validationFull = readJson(join(RESEARCH, "validation-results.json"));
const validationSummary = readJson(join(HERE, "dist", "validation-summary.json"));
const validationResults = validationFull || validationSummary;
const validationSource = validationFull ? "research/validation-results.json" : (validationSummary ? "dist/validation-summary.json" : null);
const networkProbe = readJson(join(CACHE, "network-probe.json"));
// data-cache/wrapper-probe.json is the committed 7x24 wrapper-layer measurement written by
// scripts/measure-wrapper.mjs. It is read from disk, not fetched per request: a live order book
// changes every second, and a card whose numbers move between runs cannot be matched against the
// replay cache. Absent file -> wrapper block reports "not measured", and no figure is invented.
const wrapperProbe = readJson(join(CACHE, "wrapper-probe.json"));
const buildReport = fs.existsSync(join(CACHE, "build-report.md")) ? fs.readFileSync(join(CACHE, "build-report.md"), "utf8") : null;

const provenanceBase = {
  datasetBuiltAt: dataset.meta?.builtAt || null,
  sources: dataset.meta?.sources || {},
  notes: dataset.meta?.notes || [],
    // The per-host table is part of the provenance story, so it ships in the card rather than only
  // in /api/provenance: a static deployment has no second endpoint to ask.
  networkProbe: networkProbe ? {
    generatedAt: networkProbe.generatedAt, summary: networkProbe.summary, host: networkProbe.host, node: networkProbe.node,
    usedSources: networkProbe.usedSources, unusedSources: networkProbe.unusedSources, rejectedSources: networkProbe.rejectedSources,
    targets: (networkProbe.targets || []).map((x) => ({ name: x.name, role: x.role, ok: x.ok, status: x.status, kind: x.kind, detail: x.detail, latencyMs: x.latencyMs })),
    bitget: networkProbe.bitget || null
  } : null,
  validationGeneratedAt: validationResults?.generatedAt || null,
  buildReportPresent: Boolean(buildReport)
};

// The wrapper audit block. Deliberately NOT in provenanceBase: provenanceBase is spread into the
// research card, and the card is the payload the model is billed to read. The card already carries
// its own per-symbol wrapper block, so the audit detail belongs on /api/provenance and /api/wrapper.
const wrapperAudit = wrapperProbe ? {
  generatedAt: wrapperProbe.generatedAt, venue: wrapperProbe.venue?.name || null, role: wrapperProbe.venue?.role || null,
  reachable: Boolean(wrapperProbe.probe?.ok), degraded: wrapperProbe.degradation || null,
  summary: wrapperProbe.summary, referenceMarket: wrapperProbe.referenceMarket, thresholds: wrapperProbe.thresholds,
  verifiedWrappers: Object.keys(wrapperProbe.bySymbol || {}).length, rejectedCandidates: (wrapperProbe.rejected || []).length
} : null;

const desk = createDesk({ dataset, validationResults, provenance: provenanceBase, config: cfg, wrapper: wrapperProbe });

// The library view handed to the shared parser: symbols, the session calendar (so "10 个交易日前"
// resolves to a real session rather than an approximate calendar day) and the measured horizon grid.
const luiLib = (() => {
  const l = desk.library();
  return { symbols: l.symbols, dates: l.dates, from: l.from, to: l.to, horizons: l.horizons };
})();
log(`engine ready in ${Date.now() - t0}ms - ${desk.engine.mx.nSym} instruments x ${desk.engine.mx.nDates} sessions (${dataset.meta?.from} .. ${dataset.meta?.to})`);
log(`narrative mode: ${cfg.llm.enabled ? `LIVE (${cfg.llm.model} @ ${cfg.llm.baseUrl})` : "TEMPLATE (no LLM_API_KEY set - engine numbers are unaffected)"}`);
log(`validation loaded for horizons: ${Object.keys(desk.allValidation()).join(", ") || "none - run node scripts/verify.mjs"}${validationSource ? ` (from ${validationSource})` : ""}`);
{
  const w = desk.wrapper();
  log(w.degraded
    ? `7x24 wrapper layer: NOT MEASURED on this build (${w.venueName}) - the card says so and no wrapper figure is estimated`
    : w.available
      ? `7x24 wrapper layer: ${w.verified} verified wrapper(s) on ${w.venueName}, measured ${w.measuredAt}; reference market closed ${w.referenceMarket?.closedSharePct}% of the week`
      : `7x24 wrapper layer: no data-cache/wrapper-probe.json - run node scripts/measure-wrapper.mjs`);
}

// Seed from the persisted probe so the very first request already carries an accurate Bitget
// disclosure instead of "pending": the live probe is asynchronous and can take several seconds,
// and a card built before it settles would understate what we know. The live probe then replaces it.
let bitget = networkProbe?.bitget
  ? { ...networkProbe.bitget, fromCache: true, cachedAt: networkProbe.generatedAt }
  : { reachable: false, summary: "probe pending", endpoints: [], disclosure: null, probedAt: null, pending: true };
probeAllBitgetRouted({ timeoutMs: Number(cfg.bitget.probeTimeoutMs), model: cfg.llm.model }).then((r) => {
  bitget = r;
  log(`Bitget toolkit probe: ${r.summary}`);
}).catch((e) => { bitget = { reachable: false, summary: `probe failed: ${e.message}`, endpoints: [], disclosure: null, probedAt: new Date().toISOString() }; });

let llmProbe = null;
if (cfg.llm.enabled) {
  probeLlm(cfg.llm, 10000).then((r) => { llmProbe = r; log(`LLM endpoint probe: ${r.ok ? "ok" : `failed (${r.reason})`} in ${r.latencyMs}ms`); });
}

/* -------------------------------- helpers -------------------------------- */

function sendJson(res, obj, status = 200) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  send(res, status, body, "application/json; charset=utf-8");
}
function send(res, status, body, type) {
  const accept = String(res.req?.headers?.["accept-encoding"] || "");
  const gzippable = body.length > 2048 && /\bgzip\b/.test(accept);
  const out = gzippable ? gzipSync(body) : body;
  res.writeHead(status, {
    "Content-Type": type,
    "Content-Length": out.length,
    "Cache-Control": "no-store",
    "X-AnalogDesk-Mode": cfg.llm.enabled ? "LIVE" : "TEMPLATE",
    ...(gzippable ? { "Content-Encoding": "gzip", Vary: "Accept-Encoding" } : {})
  });
  res.end(out);
}
function sendText(res, status, text, type = "text/plain; charset=utf-8") {
  send(res, status, Buffer.from(text, "utf8"), type);
}
function notFound(res, msg) { sendJson(res, { ok: false, error: msg }, 404); }
function badRequest(res, msg) { sendJson(res, { ok: false, error: msg }, 400); }
function serverError(res, e) { sendJson(res, { ok: false, error: e?.message || String(e), stack: process.env.ANALOGDESK_DEBUG ? e?.stack : undefined }, 500); }

async function readBody(req, limitBytes = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limitBytes) throw new Error("request body too large");
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("request body is not valid JSON"); }
}

/**
 * Static files. Everything lives under web/ except the few isomorphic ES modules the page imports
 * directly (web/app.js does `import { ALIASES } from "../src/data/universe.mjs"`), which are served
 * read-only from src/. Only .mjs and .json are reachable there, and only inside the project root,
 * so the desk never exposes .env or anything outside those two directories.
 */
const SRC_ROOT = resolve(join(HERE, "src"));
const WEB_ROOT = resolve(WEB);
const PROJECT_ROOT = resolve(HERE);

function serveStatic(res, urlPath) {
  const raw = decodeURIComponent(String(urlPath).split("?")[0]);
  // Reject any traversal outright rather than trying to sanitise it: the two roots we serve are flat
  // enough that a legitimate request never needs a "..".
  if (/(^|[/\\])\.\.($|[/\\])/.test(raw)) return notFound(res, "outside web root");
  const isSrc = /^\/src\//.test(raw);
  // "/" has to resolve to the desk itself: serveStatic would otherwise stat the web/ directory and
  // 404, while the startup banner advertises GET / as the UI.
  const rel = normalize(raw).replace(/^[/\\]+/, "") || "index.html";
  const full = resolve(isSrc ? join(HERE, rel) : join(WEB, rel));
  const inside = isSrc ? full.startsWith(SRC_ROOT) : full.startsWith(WEB_ROOT);
  // Only ES modules and JSON are reachable from src/, so config.mjs's neighbours stay private and
  // .env, data-cache/ and research/ are not static-served at all (they have explicit API routes).
  if (!inside || (isSrc && !/\.(mjs|json)$/i.test(full))) return notFound(res, "outside web root");
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return notFound(res, `no such file: ${raw}`);
  send(res, 200, fs.readFileSync(full), MIME[extname(full).toLowerCase()] || "application/octet-stream");
}

/* ------------------------------ analysis -------------------------------- */

function provenance() {
  return {
    ...provenanceBase,
    bitget: bitget ? {
      status: bitget.reachable ? "reachable-not-consumed" : "degraded", summary: bitget.summary, disclosure: bitget.disclosure,
      endpoints: bitget.endpoints, probedAt: bitget.probedAt, configuredUrl: cfg.bitget.mcpUrl,
      // Reported separately, because the two Bitget integrations have opposite results on this
      // network and one badge for both would be wrong whichever way it pointed.
      marketData: bitget.marketData || null, narrative: bitget.narrative || null,
      // The route that produced each answer, and the committed measurement that route paid for.
      reachableDirectCount: bitget.reachableDirectCount ?? null, proxy: bitget.proxy || null,
      measurement: bitget.measurement || null, measurementSummary: bitget.measurementSummary || null
    } : null,
    wrapper: desk.wrapper(),
    wrapperMeasurement: wrapperAudit,
    llm: {
      mode: cfg.llm.enabled ? "LIVE" : "TEMPLATE", model: cfg.llm.model, baseUrl: cfg.llm.baseUrl,
      keyPresent: cfg.llm.enabled, probe: llmProbe, promptVersion: PROMPT_VERSION,
      note: cfg.llm.enabled ? "Narrative is generated by the configured model and then checked by the numeric gate." : "No LLM_API_KEY. The narrative is the deterministic template. Every number still comes from the engine."
    },
    library: desk.library(),
    replayEntries: null
  };
}

async function handleAnalyze(params, res) {
  const question = String(params.question ?? params.q ?? "").trim();
  // The same parser the browser uses, so a sentence means the same thing over HTTP as it does in the
  // UI, and an agent host calling this endpoint gets its question understood rather than rejected.
  const parsed = question ? parseIdea(question, luiLib) : null;
  const symbol = String(params.symbol || params.sym || (parsed && parsed.symbol) || "").trim().toUpperCase();
  if (!symbol) {
    return badRequest(res, question
      ? `no instrument recognised in "${question.slice(0, 80)}". Name one of the ${luiLib.symbols.length} library instruments (a ticker such as NVDA, or a name such as 英伟达), or pass symbol= explicitly.`
      : "symbol is required - or send question= and let the parser find the instrument");
  }
  // Explicit parameters win; the sentence fills whatever they left out. The UI resolves its own
  // controls before it calls, so what arrives here is already the user's intent.
  const asNum = (v, fb) => { const n = Number(v); return Number.isFinite(n) ? n : fb; };
  const horizon = asNum(params.horizon, parsed && parsed.horizon != null ? parsed.horizon : DEFAULT_HORIZON);
  const k = asNum(params.k, parsed && parsed.k != null ? parsed.k : 50);
  const date = params.date && params.date !== "latest" ? String(params.date) : ((parsed && parsed.date) || "latest");
  const riskRaw = asNum(params.risk ?? params.riskTolerance, parsed && parsed.riskTolerancePct != null ? parsed.riskTolerancePct : NaN);
  const riskTolerancePct = Number.isFinite(riskRaw) && riskRaw > 0 ? riskRaw : null;
  const language = params.language || params.lang || (question ? detectLang(question) : "en");
  const mode = params.mode === "TEMPLATE" || params.mode === "REPLAY" ? params.mode : null;
  const withNarrative = String(params.narrative ?? "1") !== "0";

  let analysis;
  const includeStress = String(params.stress ?? params.scenarios ?? "1") !== "0";
  try { analysis = desk.analyze({ symbol, date, horizon, k, includeStress, riskTolerancePct }); }
  catch (e) { return badRequest(res, e.message); }

  const prov = { ...provenanceBase, bitget: provenance().bitget, llm: provenance().llm };
  analysis.card.provenance = { ...analysis.card.provenance, ...prov,
    priceSource: dataset.meta?.sources?.prices || null,
    bitgetMcp: { status: bitget?.reachable ? "reachable-not-consumed" : "degraded", reason: bitget?.reachable ? null : (bitget?.endpoints?.[0] ? `${bitget.endpoints[0].kind}: ${bitget.endpoints[0].detail}` : "not probed") } };

  let narrative = null;
  if (withNarrative) {
    try {
      narrative = await narrate({ card: analysis.card, question, language, llm: cfg.llm, store, forceMode: mode });
    } catch (e) {
      narrative = { text: null, sections: {}, mode: "ERROR", warnings: [e.message] };
    }
  }
  sendJson(res, { ok: true, question, language,
    // What the desk understood, and how it said so in one line: the caller can check the reading
    // instead of trusting it, which is the whole posture of this project.
    parsed: parsed ? { ...parsed, explain: explainIdea(parsed, { language }) } : null,
    card: analysis.card, detail: analysis.detail, narrative });
}

/* -------------------------------- router --------------------------------- */

const server = http.createServer(async (req, res) => {
  res.req = req;
  const u = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const path = u.pathname;
  try {
    if (path.startsWith("/api/")) {
      if (req.method === "OPTIONS") { res.writeHead(204, { Allow: "GET,POST,OPTIONS" }); return res.end(); }

      if (path === "/api/health") {
        return sendJson(res, {
          ok: true, uptimeS: Math.round(process.uptime()), engineInitMs: desk.initMs,
          rssMb: Math.round(process.memoryUsage().rss / 1e6), node: process.version,
          llm: { mode: cfg.llm.enabled ? "LIVE" : "TEMPLATE", model: cfg.llm.model, keyPresent: cfg.llm.enabled, probe: llmProbe },
          bitget: { status: bitget?.reachable ? "reachable-not-consumed" : "degraded", summary: bitget?.summary || null,
            marketData: bitget?.marketData?.summary || null, narrative: bitget?.narrative?.summary || null },
          wrapper: desk.wrapper(),
          library: { symbols: desk.engine.mx.nSym, sessions: desk.engine.mx.nDates, from: desk.engine.mx.dates[0], to: desk.engine.mx.dates.at(-1) },
          validationHorizons: Object.keys(desk.allValidation()).map(Number)
        });
      }
      if (path === "/api/library") return sendJson(res, { ok: true, library: desk.library() });
      if (path === "/api/scenarios") return sendJson(res, { ok: true, scenarios: desk.scenarios });
      if (path === "/api/provenance") return sendJson(res, { ok: true, provenance: provenance() });
      // The whole committed wrapper measurement, including every rejected candidate and the reason
      // it was rejected. A reviewer should be able to audit the verification rather than trust it.
      if (path === "/api/wrapper") {
        if (!wrapperProbe) return notFound(res, "no wrapper measurement on record - run: node scripts/measure-wrapper.mjs");
        return sendJson(res, { ok: true, summary: desk.wrapper(), measurement: wrapperProbe });
      }
      if (path === "/api/build-report") return buildReport ? sendText(res, 200, buildReport, "text/markdown; charset=utf-8") : notFound(res, "no build report");
      if (path === "/api/validation") {
        const H = Number(u.searchParams.get("horizon") || 0);
        return sendJson(res, { ok: true, horizons: Object.keys(desk.allValidation()).map(Number),
          summary: H ? desk.validation(H) : null, all: H ? null : desk.allValidation(),
          generatedAt: validationResults?.generatedAt || null,
          full: u.searchParams.get("full") === "1" ? validationResults : null });
      }
      if (path === "/api/dataset") return send(res, 200, fs.readFileSync(datasetPath), "application/json; charset=utf-8");
      if (path === "/api/bitget-probe") {
        bitget = await probeAllBitgetRouted({ timeoutMs: Number(cfg.bitget.probeTimeoutMs), model: cfg.llm.model });
        return sendJson(res, { ok: true, bitget });
      }
      if (path === "/api/analyze") {
        if (req.method === "POST") return handleAnalyze(await readBody(req), res);
        return handleAnalyze(Object.fromEntries(u.searchParams.entries()), res);
      }
      return notFound(res, `unknown api route ${path}`);
    }
    if (req.method !== "GET" && req.method !== "HEAD") return badRequest(res, "method not allowed");
    return serveStatic(res, req.url);
  } catch (e) { return serverError(res, e); }
});

const port = cfg.server.port, host = cfg.server.host;
server.listen(port, host, () => {
  log(`serving http://${host}:${port}  (Ctrl-C to stop)`);
  log(`  GET /                  research desk UI`);
  log(`  GET /api/health        status`);
  log(`  GET /api/library       ${desk.engine.mx.nSym} instruments, ${desk.engine.mx.nDates} sessions`);
  log(`  GET /api/analyze?question=英伟达 未来 5 个交易日   sentence only - the parser finds the instrument`);
  log(`  GET /api/analyze?symbol=NVDA&horizon=5&k=50       explicit parameters win over the sentence`);
  log(`  GET /api/validation    frozen out-of-sample summary`);
  log(`  GET /api/provenance    data sources, network probe, Bitget status, LLM mode`);
  log(`  GET /api/wrapper       the committed 7x24 wrapper-layer measurement, rejections included`);
  if (!cfg.llm.enabled) log(`  no LLM_API_KEY: narrative runs in TEMPLATE mode. Copy .env.example to .env and set LLM_API_KEY to enable ${cfg.llm.model}.`);
});