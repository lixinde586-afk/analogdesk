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
import { probeAllBitget } from "./src/data/bitget.mjs";
import { createDesk, DEFAULT_HORIZON } from "./src/desk.mjs";

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
const validationResults = readJson(join(RESEARCH, "validation-results.json"));
const networkProbe = readJson(join(CACHE, "network-probe.json"));
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

const desk = createDesk({ dataset, validationResults, provenance: provenanceBase, config: cfg });
log(`engine ready in ${Date.now() - t0}ms - ${desk.engine.mx.nSym} instruments x ${desk.engine.mx.nDates} sessions (${dataset.meta?.from} .. ${dataset.meta?.to})`);
log(`narrative mode: ${cfg.llm.enabled ? `LIVE (${cfg.llm.model} @ ${cfg.llm.baseUrl})` : "TEMPLATE (no LLM_API_KEY set - engine numbers are unaffected)"}`);
log(`validation summary loaded for horizons: ${Object.keys(desk.allValidation()).join(", ") || "none - run node scripts/verify.mjs"}`);

// Seed from the persisted probe so the very first request already carries an accurate Bitget
// disclosure instead of "pending": the live probe is asynchronous and can take several seconds,
// and a card built before it settles would understate what we know. The live probe then replaces it.
let bitget = networkProbe?.bitget
  ? { ...networkProbe.bitget, fromCache: true, cachedAt: networkProbe.generatedAt }
  : { reachable: false, summary: "probe pending", endpoints: [], disclosure: null, probedAt: null, pending: true };
probeAllBitget({ timeoutMs: Number(cfg.bitget.probeTimeoutMs) }).then((r) => {
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
  const rel = normalize(raw).replace(/^[/\\]+/, "");
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
    bitget: bitget ? { status: bitget.reachable ? "connected" : "degraded", summary: bitget.summary, disclosure: bitget.disclosure, endpoints: bitget.endpoints, probedAt: bitget.probedAt, configuredUrl: cfg.bitget.mcpUrl } : null,
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
  const symbol = String(params.symbol || params.sym || "").trim().toUpperCase();
  if (!symbol) return badRequest(res, "symbol is required");
  const question = String(params.question ?? params.q ?? "").trim();
  const horizon = Number(params.horizon ?? DEFAULT_HORIZON);
  const k = Number(params.k ?? 50);
  const date = params.date && params.date !== "latest" ? String(params.date) : "latest";
  const language = params.language || params.lang || (question ? detectLang(question) : "en");
  const mode = params.mode === "TEMPLATE" || params.mode === "REPLAY" ? params.mode : null;
  const withNarrative = String(params.narrative ?? "1") !== "0";

  let analysis;
  const includeStress = String(params.stress ?? params.scenarios ?? "1") !== "0";
  try { analysis = desk.analyze({ symbol, date, horizon, k, includeStress }); }
  catch (e) { return badRequest(res, e.message); }

  const prov = { ...provenanceBase, bitget: provenance().bitget, llm: provenance().llm };
  analysis.card.provenance = { ...analysis.card.provenance, ...prov,
    priceSource: dataset.meta?.sources?.prices || null,
    bitgetMcp: { status: bitget?.reachable ? "connected" : "degraded", reason: bitget?.reachable ? null : (bitget?.endpoints?.[0] ? `${bitget.endpoints[0].kind}: ${bitget.endpoints[0].detail}` : "not probed") } };

  let narrative = null;
  if (withNarrative) {
    try {
      narrative = await narrate({ card: analysis.card, question, language, llm: cfg.llm, store, forceMode: mode });
    } catch (e) {
      narrative = { text: null, sections: {}, mode: "ERROR", warnings: [e.message] };
    }
  }
  sendJson(res, { ok: true, question, language, card: analysis.card, detail: analysis.detail, narrative });
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
          bitget: { status: bitget?.reachable ? "connected" : "degraded", summary: bitget?.summary || null },
          library: { symbols: desk.engine.mx.nSym, sessions: desk.engine.mx.nDates, from: desk.engine.mx.dates[0], to: desk.engine.mx.dates.at(-1) },
          validationHorizons: Object.keys(desk.allValidation()).map(Number)
        });
      }
      if (path === "/api/library") return sendJson(res, { ok: true, library: desk.library() });
      if (path === "/api/scenarios") return sendJson(res, { ok: true, scenarios: desk.scenarios });
      if (path === "/api/provenance") return sendJson(res, { ok: true, provenance: provenance() });
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
        bitget = await probeAllBitget({ timeoutMs: Number(cfg.bitget.probeTimeoutMs) });
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
  log(`  GET /api/analyze?symbol=NVDA&question=...   full research card + narrative`);
  log(`  GET /api/validation    frozen out-of-sample summary`);
  log(`  GET /api/provenance    data sources, network probe, Bitget status, LLM mode`);
  if (!cfg.llm.enabled) log(`  no LLM_API_KEY: narrative runs in TEMPLATE mode. Copy .env.example to .env and set LLM_API_KEY to enable ${cfg.llm.model}.`);
});