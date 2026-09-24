/**
 * AnalogDesk as an MCP tool server.
 *
 *   node mcp-server.mjs          (stdio transport; a host launches it, nobody types into it)
 *   npm run check:mcp            (spawns it, performs the handshake, calls every tool, asserts)
 *
 * WHY THIS EXISTS
 * A research desk that only a human can drive through a web page is half a product: the point of the
 * sub-theme is that an agent can stress-test a decision before it acts. This file exposes the same
 * engine, the same frozen conformal calibration and the same numeric gate as five Model Context
 * Protocol tools over newline-delimited JSON-RPC 2.0 on stdio, with zero dependencies, so any MCP
 * host - the Bitget AI agent runtime, Claude Desktop, Codex CLI, Cursor - can call the desk directly.
 * It is a client of exactly the same modules the UI and the HTTP server use (src/desk.mjs and
 * src/llm/lui.mjs), so there is one engine and one parser, reached three ways.
 *
 * INTEGRITY RULES, identical to the rest of the project
 *   - Every number in a tool result is computed by the engine at call time. Nothing is cached from a
 *     previous run and nothing is written by a language model.
 *   - analogdesk_analyze returns the narrative only after it has passed the numeric gate, and reports
 *     the gate verdict and the mode (LIVE / REPLAY / TEMPLATE) alongside it, so a host model cannot
 *     launder an invented figure through this tool without the caller seeing how the text was made.
 *   - A request the engine cannot answer returns isError with a message naming the fix.
 *   - The Bitget MCP toolkit answers on the local-proxy route from the network this was built on and on
 *     no direct connection. BOTH routes are measured, analogdesk_provenance names the one that produced
 *     each answer rather than printing the more flattering of the two, and no Bitget-sourced figure
 *     appears anywhere.
 *
 * Only JSON-RPC goes to stdout. Every log line goes to stderr, because a stray byte on stdout breaks
 * the framing for the host.
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveConfig } from "./src/llm/config.mjs";
import { registerNodeFs, createNodeStore } from "./src/llm/replay.mjs";
import { narrate, detectLang } from "./src/llm/narrate.mjs";
// The routed probe measures both a direct connection and a local proxy, and folds in the committed
// cross-check measurement. Node-only by design: src/data/bitget.mjs stays in the browser module graph.
import { probeAllBitgetRouted } from "./src/data/bitget-routes.mjs";
import { createDesk, DEFAULT_HORIZON } from "./src/desk.mjs";
import { parseIdea, explain as explainIdea } from "./src/llm/lui.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE = join(HERE, "data-cache");
const RESEARCH = join(HERE, "research");
const log = (...a) => console.error("[analogdesk-mcp]", ...a);

const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };

/* -------------------------------- bootstrap ------------------------------- */

const cfg = resolveConfig();
registerNodeFs(await import("node:fs"));
const store = createNodeStore(join(CACHE, "llm-replay"));

const datasetPath = join(CACHE, "dataset.json");
if (!existsSync(datasetPath)) {
  log("data-cache/dataset.json is missing. Run: npm run build:data");
  process.exit(1);
}
const t0 = Date.now();
const dataset = readJson(datasetPath);
// Full audit dump when it exists, otherwise the committed summary that ships in dist/. Either way the
// frozen conformal scale is present, so a host calling this on a fresh clone gets calibrated intervals.
const validationResults = readJson(join(RESEARCH, "validation-results.json"))
  || readJson(join(HERE, "dist", "validation-summary.json"));
const networkProbe = readJson(join(CACHE, "network-probe.json"));
// The committed 7x24 wrapper measurement, so an MCP client gets the same card the UI and the HTTP
// API produce. Loaded from disk, never fetched: the card has to hash identically everywhere or the
// replay cache misses.
const wrapperProbe = readJson(join(CACHE, "wrapper-probe.json"));
// The same 7x24 layer measured on Bitget's own venue (RWA perpetuals via the official MCP). It is the
// primary venue for that layer; wrapper-probe.json is the independent second one.
const bitget7x24Probe = readJson(join(CACHE, "bitget-7x24.json"));

const provenanceBase = {
  datasetBuiltAt: (dataset.meta && dataset.meta.builtAt) || null,
  sources: (dataset.meta && dataset.meta.sources) || {},
  notes: (dataset.meta && dataset.meta.notes) || [],
  networkProbe: networkProbe ? {
    generatedAt: networkProbe.generatedAt, summary: networkProbe.summary,
    usedSources: networkProbe.usedSources, unusedSources: networkProbe.unusedSources,
    rejectedSources: networkProbe.rejectedSources, bitget: networkProbe.bitget || null
  } : null,
  servedOver: "mcp-stdio"
};

const desk = createDesk({ dataset, validationResults, provenance: provenanceBase, config: cfg, wrapper: wrapperProbe, bitget7x24: bitget7x24Probe });
const luiLib = (() => {
  const l = desk.library();
  return { symbols: l.symbols, dates: l.dates, from: l.from, to: l.to, horizons: l.horizons };
})();

let bitget = networkProbe && networkProbe.bitget
  ? Object.assign({}, networkProbe.bitget, { fromCache: true, cachedAt: networkProbe.generatedAt })
  : { reachable: false, summary: "not probed in this process", endpoints: [], disclosure: null, probedAt: null };
probeAllBitgetRouted({ timeoutMs: Number(cfg.bitget.probeTimeoutMs), model: cfg.llm.model })
  .then((r) => { bitget = r; log("Bitget toolkit probe: " + r.summary); })
  .catch((e) => { bitget = { reachable: false, summary: "probe failed: " + e.message, endpoints: [], disclosure: null, probedAt: new Date().toISOString() }; });

log("engine ready in " + (Date.now() - t0) + "ms - " + desk.engine.mx.nSym + " instruments x " + desk.engine.mx.nDates + " sessions");
log("narrative mode: " + (cfg.llm.enabled ? "LIVE (" + cfg.llm.model + ")" : "TEMPLATE (no LLM_API_KEY set)"));
/* -------------------------------- helpers -------------------------------- */

/** A tool result the engine could not produce is an error the host must see, not an empty string. */
class ToolError extends Error {}

const n = (x, dp = 2) => (Number.isFinite(Number(x)) ? Number(x).toFixed(dp) : "n/a");
const pc = (x, dp = 2) => (Number.isFinite(Number(x)) ? (Number(x) > 0 ? "+" : "") + Number(x).toFixed(dp) + "%" : "n/a");
const lines = (a) => a.filter((x) => x != null && x !== "").join("\n");

const text = (s) => ({ content: [{ type: "text", text: String(s) }] });

/**
 * The card as a compact brief. A host model gets the headline numbers, the verdict, the caveats and
 * the disclosure notes in text it can quote, and the whole card in structuredContent if it wants more.
 * The full narrative is opt-in: it is ~7k characters, and paying that on every call would crowd out
 * the reasoning the host is actually doing.
 */
function analyzeText(card, narrative, parsed, opts = {}) {
  const d = card.distribution, c = card.conformal, x = card.excursion, r = card.retrieval, v = card.validation;
  const out = [];
  out.push("AnalogDesk research card - " + card.idea.symbol + " (" + card.idea.name + "), as of " + card.idea.asOfSession + ", " + card.idea.horizonLabel);
  if (card.idea.referenceClose != null) out.push("Reference adjusted close (return basis): " + n(card.idea.referenceClose, 4));
  if (card.idea.referenceCloseRaw != null) out.push("Reference raw session close (path-risk basis; MAE/MFE are measured from it): " + n(card.idea.referenceCloseRaw, 4));
  out.push("");
  out.push("RETRIEVAL  " + r.kReturned + " analogs across " + r.distinctSessions + " distinct sessions and " + r.distinctSymbols + " instruments, " + r.embargoSessions + "-session embargo, closest z-distance " + n(r.closestDistance, 4) + ", median " + n(r.medianDistance, 4) + ".");
  if (d) {
    out.push("OUTCOMES   median " + pc(d.medianPct) + ", mean " + pc(d.meanPct) + ", sd " + n(d.sdPct) + "%, p10 " + pc(d.p10Pct) + ", p90 " + pc(d.p90Pct) + ", min " + pc(d.minPct) + ", max " + pc(d.maxPct) + " (n=" + d.n + ").");
    out.push("           P(below 0) " + n(d.probabilityBelowZeroPct, 1) + "%, P(loss > 5%) " + n((d.probabilityBelow || {}).minus5Pct, 1) + "%, P(loss > 10%) " + n((d.probabilityBelow || {}).minus10Pct, 1) + "%, VaR90 " + pc(d.valueAtRisk90Pct) + ", CVaR90 " + pc(d.conditionalVar90Pct) + ".");
  }
  if (x) out.push("PATH RISK  median max adverse excursion " + pc(x.maxAdverseMedianPct) + ", p10 " + pc(x.maxAdverseP10Pct) + "; median max favourable " + pc(x.maxFavourableMedianPct) + "; reward/risk " + n(x.rewardRiskRatio, 2) + ".");
  if (c) {
    out.push("CONFORMAL  " + pc(c.lowerPct) + " .. " + pc(c.upperPct) + " (" + n(c.widthPct) + "% wide) at a " + n(c.coverageTargetPct, 0) + "% target, frozen scale " + n(c.scale, 3) + " fitted on " + c.fittedOn + ".");
    out.push("           Out of sample on " + c.testEra + ": coverage " + n(c.outOfSampleCoveragePct, 1) + "% +/- " + n(c.outOfSampleSEPp, 2) + " pp over " + n(c.testQueries, 0) + " queries.");
  } else {
    out.push("CONFORMAL  not available for this request (either no scale is frozen for this horizon, or fewer than 10 completed analog outcomes were retrieved).");
  }
  if (Array.isArray(card.stress) && card.stress.length) {
    const rows = card.stress.filter((s) => !s.skipped && s.medianForwardPct != null);
    const worst = rows.slice().sort((a, b) => (a.deltaMedianVsBaselinePct ?? 0) - (b.deltaMedianVsBaselinePct ?? 0)).slice(0, 3);
    out.push("STRESS     " + rows.length + " of " + card.stress.length + " scenarios ran. Worst three by shift in the median:");
    for (const s of worst) out.push("           - " + s.label + ": median " + pc(s.medianForwardPct) + " (" + (s.deltaMedianVsBaselinePct > 0 ? "+" : "") + n(s.deltaMedianVsBaselinePct, 2) + " pp vs baseline), n=" + s.analogsUsed + ". " + s.caveat);
  }
  if (card.personalization) {
    const p = card.personalization;
    out.push("YOUR CONSTRAINT  stated tolerance " + n(p.tolerancePct, 0) + "% drawdown, measured on " + p.measuredOn + " analog paths: " + n(p.breachedSharePct, 1) + "% traded through that level inside the horizon. " + p.verdict);
    out.push("                 " + p.caveat);
  }
  if (r.notes && r.notes.length) {
    out.push("");
    out.push("REQUEST ADJUSTED BEFORE IT RAN (disclosed, not silent):");
    for (const s of r.notes) out.push("  - " + s);
  }
  if (v && v.honestVerdict) {
    out.push("");
    out.push("VERDICT    " + v.honestVerdict);
  }
  const gate = narrative && narrative.checks && narrative.checks.primary;
  out.push("");
  out.push("PROVENANCE narrative mode " + ((narrative && narrative.mode) || "n/a") + "; numeric gate " + (gate ? (gate.ok ? "PASS " + (gate.total - gate.unsupportedCount) + "/" + gate.total + " numerals traced to the card" : "FAILED " + gate.unsupportedCount + "/" + gate.total) : "not run") + "; library " + card.provenance.sessions + " sessions x " + card.provenance.symbols + " instruments (" + card.provenance.from + " .. " + card.provenance.to + ").");
  if (parsed) out.push("UNDERSTOOD " + explainIdea(parsed, { language: (narrative && narrative.language) || parsed.language }));
  if (narrative && narrative.warnings && narrative.warnings.length) out.push("WARNINGS   " + narrative.warnings.join(" | "));
  if (opts.fullNarrative && narrative && narrative.text) {
    out.push("");
    out.push("FULL NARRATIVE");
    out.push(narrative.text);
  } else if (narrative && narrative.sections) {
    const keep = ["verdict", "limits"];
    for (const key of keep) if (narrative.sections[key]) { out.push(""); out.push(key.toUpperCase() + ": " + narrative.sections[key]); }
    out.push("");
    out.push("(full narrative omitted; call with fullNarrative=true for all six sections)");
  }
  out.push("");
  out.push("Not investment advice and not a prediction: a documented description of what happened next in the historical episodes that most resemble this state.");
  return lines(out);
}
/* ------------------------------ request parsing ----------------------------- */

/**
 * One resolution path for every tool: explicit arguments win, the sentence fills whatever they left
 * out, and the desk (src/desk.mjs) is the only place that snaps a horizon or clamps k - so an agent
 * host gets the same disclosure notes a human gets in the browser.
 */
function resolveRequest(args = {}) {
  const question = String(args.question ?? args.q ?? "").trim();
  const parsed = question ? parseIdea(question, luiLib) : null;
  const symbol = String(args.symbol || (parsed && parsed.symbol) || "").trim().toUpperCase();
  if (!symbol) {
    throw new ToolError(question
      ? "no instrument recognised in \"" + question.slice(0, 80) + "\". Name one of the " + luiLib.symbols.length + " library instruments (a ticker such as NVDA, or a name such as 英伟达), or pass symbol explicitly. analogdesk_library lists them."
      : "give a symbol, or a question that names one. analogdesk_library lists the " + luiLib.symbols.length + " instruments.");
  }
  const asNum = (v, fb) => { const x = Number(v); return Number.isFinite(x) ? x : fb; };
  const risk = asNum(args.riskTolerancePct ?? args.risk, parsed && parsed.riskTolerancePct != null ? parsed.riskTolerancePct : NaN);
  return {
    question, parsed, symbol,
    date: args.date && args.date !== "latest" ? String(args.date) : ((parsed && parsed.date) || "latest"),
    horizon: asNum(args.horizon, parsed && parsed.horizon != null ? parsed.horizon : DEFAULT_HORIZON),
    k: asNum(args.k, parsed && parsed.k != null ? parsed.k : 50),
    riskTolerancePct: Number.isFinite(risk) && risk > 0 ? risk : null,
    language: args.language || (question ? detectLang(question) : "en")
  };
}

function stampProvenance(card) {
  card.provenance = Object.assign({}, card.provenance, {
    bitget: { reachable: Boolean(bitget.reachable), summary: bitget.summary || null, endpoints: bitget.endpoints || [], disclosure: bitget.disclosure || null },
    llm: { mode: cfg.llm.enabled ? "LIVE" : "TEMPLATE", model: cfg.llm.model, keyPresent: Boolean(cfg.llm.enabled), baseUrl: cfg.llm.baseUrl }
  });
  return card;
}

/* --------------------------------- tools ---------------------------------- */

async function toolAnalyze(args) {
  const req = resolveRequest(args);
  let a;
  try {
    a = desk.analyze({ symbol: req.symbol, date: req.date, horizon: req.horizon, k: req.k,
      includeStress: args.includeStress !== false, riskTolerancePct: req.riskTolerancePct });
  } catch (e) { throw new ToolError((e && e.message) || String(e)); }
  stampProvenance(a.card);
  const narrative = await narrate({ card: a.card, question: req.question, language: req.language, llm: cfg.llm, store });
  const gate = narrative && narrative.checks && narrative.checks.primary;
  return {
    content: [{ type: "text", text: analyzeText(a.card, narrative, req.parsed, { fullNarrative: args.fullNarrative === true }) }],
    structuredContent: {
      understood: req.parsed ? Object.assign({}, req.parsed, { explain: explainIdea(req.parsed, { language: req.language }) }) : null,
      card: a.card,
      narrative: { mode: narrative.mode, model: narrative.model, language: req.language,
        numericGate: gate ? { ok: gate.ok, total: gate.total, unsupported: gate.unsupportedCount } : null,
        warnings: narrative.warnings || [] }
    }
  };
}

async function toolLibrary() {
  const l = desk.library();
  const t = lines([
    "AnalogDesk analog library",
    l.symbols.length + " instruments x " + l.sessions + " sessions, " + l.from + " .. " + l.to + ".",
    "Benchmark: " + l.benchSym + ". Features: " + l.nFeatures + " in " + l.groups.length + " weighted groups (" + l.groups.map((g) => g.group + " " + g.weightPct + "%").join(", ") + ").",
    "Measured horizons (trading sessions): " + l.horizons.join(", ") + ". Neighbour count 10..200, validated at k=50.",
    "Computed but excluded from the distance metric: " + l.excludedFromDistance.join(", ") + " (they degraded retrieval; they are still displayed).",
    "Instruments: " + l.symbols.map((s) => s.symbol).join(", "),
    "",
    "Call analogdesk_analyze with a question (English or Chinese) or a symbol to retrieve the analogs for one state."
  ]);
  return {
    content: [{ type: "text", text: t }],
    structuredContent: { symbols: l.symbols, sessions: l.sessions, from: l.from, to: l.to, horizons: l.horizons,
      nFeatures: l.nFeatures, features: l.features, groups: l.groups, excludedFromDistance: l.excludedFromDistance, benchSym: l.benchSym }
  };
}

async function toolStress(args) {
  const req = resolveRequest(args);
  let a;
  try { a = desk.analyze({ symbol: req.symbol, date: req.date, horizon: req.horizon, k: req.k, includeStress: true, riskTolerancePct: req.riskTolerancePct }); }
  catch (e) { throw new ToolError((e && e.message) || String(e)); }
  stampProvenance(a.card);
  const card = a.card, d = card.distribution, rows = card.stress || [];
  const out = [];
  out.push("AnalogDesk stress suite - " + card.idea.symbol + " as of " + card.idea.asOfSession + ", " + card.idea.horizonLabel);
  out.push("BASELINE (no overlay): median " + pc(d && d.medianPct) + ", p10 " + pc(d && d.p10Pct) + ", p90 " + pc(d && d.p90Pct) + ", n=" + card.retrieval.kReturned + ".");
  out.push("");
  out.push("scenario | kind | n | median | p10 | p90 | delta vs baseline | P(loss>10%) | P(breach 10% drawdown)");
  for (const s of rows) {
    const cells = [s.label, s.kind, s.analogsUsed == null ? "-" : s.analogsUsed, pc(s.medianForwardPct), pc(s.p10ForwardPct), pc(s.p90ForwardPct),
      s.deltaMedianVsBaselinePct == null ? "n/a" : (s.deltaMedianVsBaselinePct > 0 ? "+" : "") + n(s.deltaMedianVsBaselinePct, 2) + " pp",
      n(s.probabilityBelowMinus10Pct, 1) + "%", n(s.probabilityOfBreaching10PctDrawdown, 1) + "%"];
    out.push(cells.join(" | "));
  }
  out.push("");
  out.push("CAVEATS (written by the engine, attached to every scenario, not optional):");
  for (const s of rows) if (s.caveat) out.push("  - " + s.label + ": " + s.caveat);
  if (card.retrieval.notes && card.retrieval.notes.length) {
    out.push("");
    out.push("REQUEST ADJUSTED BEFORE IT RAN:");
    for (const s of card.retrieval.notes) out.push("  - " + s);
  }
  out.push("");
  out.push("Every scenario re-runs the same retrieval with the same settings, so rows are directly comparable to the baseline. Window scenarios pin the library to a named historical episode; shock scenarios move the query state in z-space and re-retrieve across the whole library.");
  return { content: [{ type: "text", text: lines(out) }], structuredContent: { baseline: d, scenarios: rows, notes: card.retrieval.notes || [] } };
}

async function toolValidation(args) {
  const all = desk.allValidation();
  const keys = Object.keys(all).map(Number).sort((a, b) => a - b);
  const H = Number.isFinite(Number(args && args.horizon)) ? Number(args.horizon) : 5;
  const v = all[H];
  if (!v) throw new ToolError("no frozen validation for horizon " + H + " sessions. Available horizons: " + keys.join(", ") + ".");
  const cf = desk.conformal(H);
  const out = [];
  out.push("AnalogDesk frozen out-of-sample validation, H=" + H + " sessions");
  out.push("Protocol: " + v.protocol + ".");
  out.push("Target coverage " + n(v.targetCoveragePct, 0) + "%.");
  out.push("Analog + frozen conformal: coverage " + n(v.analog.coveragePct, 1) + "% (+/- " + n(v.analog.coverageSEPp, 2) + " pp clustered SE), width " + n(v.analog.widthPct, 2) + "%, width at matched coverage " + n(v.analog.matchedCoverageWidthPct, 2) + "%, fitted scale " + n(v.analog.fittedScale, 3) + ".");
  for (const [name, b] of Object.entries(v.benchmarks)) out.push("Benchmark " + name + ": coverage " + n(b.coveragePct, 1) + "%, width " + n(b.widthPct, 2) + "%, width at matched coverage " + n(b.matchedCoverageWidthPct, 2) + "%.");
  out.push("Sharpness versus the same-name band at matched coverage: " + n(v.matchedCoverageSharpnessVsSameNamePct, 1) + "% (negative means WIDER, i.e. worse).");
  out.push("Per-symbol coverage dispersion (pp): analog " + n(v.perSymbolCoverageSdPp.analogConformal, 1) + ", same-name " + n(v.perSymbolCoverageSdPp.uncondNamePIT, 1) + ", pooled " + n(v.perSymbolCoverageSdPp.pooledUncond, 1) + ".");
  out.push("PIT chi-square " + n(v.pitChiSquare, 1) + " against a 5% critical value of " + n(v.pitChiSquareCritical5Pct, 2) + " - probability calibration " + (v.pitChiSquare > v.pitChiSquareCritical5Pct ? "FAILS" : "passes") + ".");
  out.push("Directional hit rate of the analog median: " + n(v.directionalHitRatePct, 1) + "% (a coin toss, stated rather than hidden).");
  out.push("Mean retrieval: " + n(v.meanRetrievalMs, 1) + " ms per query.");
  if (cf) out.push("This horizon carries a frozen scale of " + n(cf.scale, 3) + " fitted on " + cf.fittedOn + " and never re-fitted at request time.");
  out.push("");
  out.push("VERDICT: " + v.honestVerdict);
  return { content: [{ type: "text", text: lines(out) }], structuredContent: { horizon: H, summary: v, conformal: cf } };
}

async function toolProvenance() {
  const src = (dataset.meta && dataset.meta.sources) || {};
  const out = [];
  out.push("AnalogDesk data provenance and integration status");
  out.push("Dataset built " + ((dataset.meta && dataset.meta.builtAt) || "unknown") + ": " + desk.engine.mx.nDates + " sessions x " + desk.engine.mx.nSym + " instruments, " + dataset.meta.from + " .. " + dataset.meta.to + ".");
  out.push("");
  out.push("SOURCES (all keyless):");
  for (const [role, ref] of Object.entries(src)) out.push("  - " + role + ": " + (typeof ref === "string" ? ref : JSON.stringify(ref)));
  if (networkProbe) {
    out.push("");
    out.push("NETWORK PROBE (" + networkProbe.generatedAt + "): " + networkProbe.summary);
    for (const t of networkProbe.targets || []) out.push("  - " + t.name + " [" + t.role + "]: " + (t.ok ? "reachable" : "unreachable") + " - " + (t.status || "") + (t.detail ? " (" + t.detail + ")" : "") + (t.latencyMs != null ? " " + t.latencyMs + "ms" : ""));
  }
  out.push("");
  out.push("BITGET OFFICIAL MCP: " + (bitget.reachable
    ? "reachable - " + bitget.reachableCount + "/" + bitget.total + " market-data endpoints answered, " + (bitget.reachableDirectCount ?? 0) + "/" + bitget.total + " of them on a direct connection" + (bitget.proxy ? ", the rest via " + bitget.proxy.host + ":" + bitget.proxy.port : "")
    : "UNREACHABLE on both routes - " + (bitget.summary || "no summary")));
  if (bitget.measurementSummary) out.push("  " + bitget.measurementSummary);
  for (const e of bitget.endpoints || []) out.push("  - " + (e.url || e.name || "endpoint") + ": " + (e.ok ? "ok" + (e.answeredOn ? " via " + e.answeredOn : "") : (e.kind || "error") + " - " + (e.detail || "")));
  out.push("  No Bitget-sourced figure enters the retrieval features, the frozen conformal scale or any validated number. The connector is implemented (src/data/bitget.mjs), both routes are probed on start-up (src/data/bitget-routes.mjs over the CONNECT tunnel in src/data/proxy.mjs), the transport error is classified precisely, and what the official MCP returned - with the route that produced it - is committed in data-cache/bitget-probe.json as a cross-check against this project's own keyless data.");
  out.push("  " + (bitget7x24Probe && bitget7x24Probe.summary && !bitget7x24Probe.degradation
    ? "The 7x24 closed-session layer IS measured on Bitget data, and it is the primary venue for that layer: " + bitget7x24Probe.summary.instrumentsVerified + " Bitget RWA perpetuals verified against " + bitget7x24Probe.summary.underlyingSymbolsCovered + " of " + bitget7x24Probe.summary.universeSymbols + " library instruments (" + bitget7x24Probe.summary.coveragePct + "%), exchange pinned to bitget, fetched on the " + (bitget7x24Probe.venue && bitget7x24Probe.venue.route) + " route through " + (bitget7x24Probe.summary.server || "the official MCP") + ". " + bitget7x24Probe.summary.weekendBlocksObserved + " weekend blocks over " + bitget7x24Probe.summary.distinctWeekendStarts + " distinct weekend(s), pooled median weekend return " + bitget7x24Probe.summary.pooledWeekendMedianReturnPct + "% (p10 " + bitget7x24Probe.summary.pooledWeekendP10ReturnPct + "%), median intra-weekend MAE " + bitget7x24Probe.summary.pooledWeekendMedianMaePct + "%, closed-hour volatility " + bitget7x24Probe.summary.medianHourlyStdRatioOutsideOverInside + "x the open-hour level; cross-venue against the Gate.io spot wrappers on " + (bitget7x24Probe.summary.crossVenueCompared || 0) + " symbol(s). Written by scripts/measure-bitget-7x24.mjs to data-cache/bitget-7x24.json."
    : "The 7x24 closed-session layer was NOT measured on Bitget data on this build: the card says so, falls back to the Gate.io spot-wrapper measurement, and no Bitget figure is estimated."));
  out.push("  The distinction that matters: Bitget data feeds the 7x24 INSTRUMENT layer and nothing else. No retrieval feature, no conformal scale and no validation figure uses it, so a venue adopted after the validation was frozen cannot move a number a reviewer already read. A perpetual is also not a redeemable spot token - it carries funding and a basis - so every figure is labelled with its instrument class.");
  out.push("");
  out.push("NARRATIVE LAYER: " + (cfg.llm.enabled ? "LIVE via " + cfg.llm.baseUrl + " model " + cfg.llm.model : "TEMPLATE (no LLM_API_KEY set; every figure is engine-computed either way)") + ". Every numeral in generated prose is re-checked against the research card by src/llm/verify-numbers.mjs, and the render falls back to the deterministic template if any numeral cannot be traced.");
  out.push("");
  out.push("Nothing here is investment advice. Historical, not predictive.");
  return { content: [{ type: "text", text: lines(out) }], structuredContent: { sources: src, networkProbe, bitget, llm: { enabled: Boolean(cfg.llm.enabled), model: cfg.llm.model, baseUrl: cfg.llm.baseUrl } } };
}
/* ------------------------------ tool manifests ----------------------------- */

const HANDLERS = {
  analogdesk_analyze: toolAnalyze,
  analogdesk_library: toolLibrary,
  analogdesk_stress: toolStress,
  analogdesk_validation: toolValidation,
  analogdesk_provenance: toolProvenance
};

const REQUEST_SCHEMA = {
  question: { type: "string", description: "The trade idea as one sentence, in English or Chinese. Example: 英伟达 未来 5 个交易日，历史上相似状态后来怎么走. An instrument, a horizon, an as-of date, a neighbour count and a drawdown tolerance can all be stated here." },
  symbol: { type: "string", description: "Ticker from the 71-instrument library. Optional when the question names one. analogdesk_library lists them." },
  date: { type: "string", description: "As-of session, YYYY-MM-DD, or latest (default). A non-session date snaps back to the previous session; a date before the library starts is an error that says so." },
  horizon: { type: "integer", description: "Forward window in trading sessions: 1, 5, 10, 20, 40 or 60 (default 5). Any other value is snapped to the nearest measured horizon and the snap is disclosed in the result." },
  k: { type: "integer", description: "Neighbours to retrieve, 10..200 (default 50). Out-of-range values are clamped and disclosed. The frozen conformal scale and every published out-of-sample figure were fitted at k=50, so a result at another k says so on the card." },
  riskTolerancePct: { type: "number", description: "Optional personalisation: the drawdown the caller says it can hold, in percent (1..50). Answered from the maximum adverse excursion of each retrieved analog, never inferred." },
  language: { type: "string", enum: ["en", "zh"], description: "Narrative language. Detected from the question when omitted." }
};

const TOOLS = [
  {
    name: "analogdesk_analyze",
    title: "Stress-test a trade idea against historical analogs",
    description: "Retrieves the historical market states closest to this one and reports what actually happened next: the realised forward-return distribution, path risk (maximum adverse excursion, drawdown-breach probabilities), a frozen split-conformal interval with its out-of-sample coverage, and a 13-scenario stress suite. Every figure is engine-computed at call time and every numeral in the narrative has been re-checked against the card by the numeric gate, whose verdict is reported. Use this BEFORE acting on an idea, not to forecast: the verdict the engine itself prints is that this is a stress-testing and provenance instrument, not an alpha source.",
    inputSchema: { type: "object", properties: Object.assign({}, REQUEST_SCHEMA, {
      includeStress: { type: "boolean", description: "Run the 13-scenario stress suite (default true; turning it off roughly halves the latency)." },
      fullNarrative: { type: "boolean", description: "Return all six narrative sections instead of the verdict and the limits (default false). The full text is about 7000 characters." }
    }), required: [] }
  },
  {
    name: "analogdesk_library",
    title: "What the analog library covers",
    description: "Instruments, session range, feature groups and weights, the measured horizon grid, and which features are excluded from the distance metric and why. Call this first if you need a valid symbol.",
    inputSchema: { type: "object", properties: {}, required: [] }
  },
  {
    name: "analogdesk_stress",
    title: "The 13 named stress scenarios for one idea",
    description: "Re-runs the same retrieval under six named crisis windows drawn from the library own worst benchmark episodes and seven shock overlays, and returns each scenario median, tail, delta versus the baseline, loss and drawdown-breach probabilities, plus the caveat the engine attaches to it. Rows are directly comparable because the settings are identical.",
    inputSchema: { type: "object", properties: REQUEST_SCHEMA, required: [] }
  },
  {
    name: "analogdesk_validation",
    title: "Frozen out-of-sample validation for one horizon",
    description: "The honest scorecard: coverage against target with clustered standard errors, interval width, width at matched coverage versus four benchmarks, per-symbol dispersion, PIT calibration, directional hit rate and retrieval latency, plus the verdict the engine prints on every card. Fitted on 2019-2022, measured on 2023 onward, never re-fitted at request time.",
    inputSchema: { type: "object", properties: { horizon: { type: "integer", description: "1, 5, 10, 20, 40 or 60 sessions (default 5)." } }, required: [] }
  },
  {
    name: "analogdesk_provenance",
    title: "Data sources, network reachability and integration status",
    description: "Every data source and what it feeds, the measured network probe with transport-level error classification, the Bitget official MCP status on both a direct and a local-proxy route with the route that produced each answer named, the committed cross-check of what the toolkit actually returned, the fact that no Bitget-sourced figure is used anywhere, and how the narrative was produced.",
    inputSchema: { type: "object", properties: {}, required: [] }
  }
];

/* ------------------------------- transport -------------------------------- */

const SUPPORTED_PROTOCOLS = ["2024-11-05", "2025-03-26", "2025-06-18"];
const DEFAULT_PROTOCOL = "2025-06-18";

function send(msg) { process.stdout.write(JSON.stringify(msg) + "\n"); }
function reply(id, result) { send({ jsonrpc: "2.0", id: id === undefined ? null : id, result }); }
function rpcError(id, code, message) { send({ jsonrpc: "2.0", id: id === undefined ? null : id, error: { code, message } }); }

const INSTRUCTIONS = [
  "AnalogDesk is a pre-trade decision stress-testing desk, not a signal generator.",
  "Call analogdesk_analyze with the idea as a sentence (English or Chinese) to get the realised outcome distribution of the closest historical states, a frozen split-conformal interval, path risk and 13 stress scenarios.",
  "Every number in a result is engine-computed and traceable; the narrative reports its numeric-gate verdict, and any adjustment made to your request (snapped horizon, clamped k) is disclosed in the result text and in card.retrieval.notes.",
  "The verdict the engine itself prints: analog retrieval hits its 80% coverage target out of sample (80.8%) but is NOT sharper than a same-name unconditional band at matched coverage, and its probability calibration fails. Treat it as risk and provenance tooling, never as alpha. This is not investment advice."
].join(" ");

async function handle(msg) {
  if (!msg || typeof msg !== "object") return;
  const id = msg.id;
  const notify = id === undefined || id === null;
  const method = msg.method;
  const params = msg.params || {};
  try {
    if (method === "initialize") {
      const want = params.protocolVersion;
      return reply(id, {
        protocolVersion: SUPPORTED_PROTOCOLS.includes(want) ? want : DEFAULT_PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "analogdesk", title: "AnalogDesk - decision stress testing", version: "1.0.0" },
        instructions: INSTRUCTIONS
      });
    }
    if (method === "notifications/initialized" || method === "initialized" || method === "notifications/cancelled") return;
    if (method === "ping") return notify ? undefined : reply(id, {});
    if (method === "tools/list") return reply(id, { tools: TOOLS });
    if (method === "tools/call") {
      const handler = HANDLERS[params.name];
      if (!handler) {
        return reply(id, { content: [{ type: "text", text: "unknown tool: " + params.name + ". Available: " + Object.keys(HANDLERS).join(", ") + "." }], isError: true });
      }
      try {
        const started = Date.now();
        const result = await handler(params.arguments || {});
        log("tools/call " + params.name + " ok in " + (Date.now() - started) + "ms");
        return reply(id, result);
      } catch (e) {
        const message = (e && e.message) || String(e);
        log("tools/call " + params.name + " failed: " + message);
        return reply(id, { content: [{ type: "text", text: message }], isError: true });
      }
    }
    if (!notify) rpcError(id, -32601, "method not found: " + method);
  } catch (e) {
    log("handler error for " + method + ": " + ((e && e.stack) || e));
    if (!notify) rpcError(id, -32603, (e && e.message) || String(e));
  }
}

// Newline-delimited JSON-RPC on stdio: the MCP stdio transport. Only protocol messages go to stdout;
// every diagnostic goes to stderr, because one stray byte on stdout breaks framing for the host.
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); }
    catch (e) { rpcError(null, -32700, "parse error: " + e.message); continue; }
    handle(msg);
  }
});
process.stdin.on("end", () => { log("stdin closed; exiting"); process.exit(0); });
process.on("uncaughtException", (e) => log("uncaught: " + ((e && e.stack) || e)));
process.on("unhandledRejection", (e) => log("unhandled rejection: " + ((e && (e.reason || e.message)) || e)));

log("ready: " + TOOLS.length + " tools on stdio (protocol " + DEFAULT_PROTOCOL + "). Waiting for initialize.");
