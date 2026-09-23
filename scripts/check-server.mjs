/**
 * AnalogDesk - HTTP contract gate.
 *
 *   npm run check:server
 *
 * WHY THIS EXISTS
 * The static bundle has a browser gate; the server deployment had none. server.mjs is the path a
 * reviewer takes when they clone the repo and run npm start, and it is also the surface an agent or a
 * script would call, so its contract is asserted here against a real spawned process: the routes that
 * must exist, the status codes they must return, the sentence-driven analyze call, the clamping
 * disclosure, and - because this server serves files - the paths that must never be reachable.
 */
import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 20000 + Math.floor(Math.random() * 20000);
const BASE = "http://127.0.0.1:" + PORT;

let failures = 0, checks = 0;
const ok = (m) => { checks++; console.log("  ok   " + m); };
const bad = (m) => { checks++; failures++; console.log("  FAIL " + m); };
const assert = (c, good, badMsg) => (c ? ok(good) : bad(badMsg));
const fmt = (v) => (typeof v === "string" ? JSON.stringify(v.length > 110 ? v.slice(0, 110) + "..." : v) : JSON.stringify(v));

const child = spawn(process.execPath, ["server.mjs"], {
  cwd: ROOT, env: Object.assign({}, process.env, { PORT: String(PORT) }), stdio: ["ignore", "pipe", "pipe"]
});
let out = "";
child.stdout.on("data", (d) => { out += d.toString(); });
child.stderr.on("data", (d) => { out += d.toString(); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitForBoot(timeoutMs = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (/serving http:/.test(out)) return true;
    if (/exited|Error:|missing/.test(out) && !/serving http:/.test(out) && Date.now() - t0 > 3000) return false;
    await sleep(200);
  }
  return false;
}

async function get(path, opts) {
  const r = await fetch(BASE + path, opts);
  const body = await r.text();
  let json = null;
  try { json = JSON.parse(body); } catch { /* not json */ }
  return { status: r.status, type: r.headers.get("content-type") || "", body, json };
}

try {
  const booted = await waitForBoot();
  assert(booted, "server booted and is serving on port " + PORT, "boot log: " + fmt(out.slice(0, 400)));
  if (!booted) throw new Error("server did not boot");

  console.log("\n=== health, library and the UI shell ===");
  const h = await get("/api/health");
  assert(h.status === 200 && h.json && h.json.ok === true, "GET /api/health -> 200 ok:true", "health: " + fmt(h.body));
  assert(h.json.library && h.json.library.symbols === 71 && h.json.library.sessions === 2513, "health reports 71 instruments x 2513 sessions", "library: " + fmt(h.json.library));
  assert(Array.isArray(h.json.validationHorizons) && h.json.validationHorizons.length === 6, "six validated horizons are loaded on a fresh clone (falls back to dist/validation-summary.json)", "validationHorizons: " + fmt(h.json.validationHorizons));
  // The status vocabulary is deliberately not "connected": reaching the toolkit does not put a single
  // Bitget figure into the engine, and a word that implied otherwise would be the overstatement the
  // whole disclosure exists to avoid. Reachable-without-consuming and degraded are both honest here;
  // silently absent is not.
  assert(h.json.bitget && ["reachable-not-consumed", "degraded"].includes(h.json.bitget.status), "Bitget is reported with an honest status, not silently absent", "bitget: " + fmt(h.json.bitget));

  const lib = await get("/api/library");
  assert(lib.status === 200 && lib.json.library.symbols.length === 71, "GET /api/library lists 71 instruments", "library symbols: " + fmt(lib.json.library && lib.json.library.symbols.length));
  assert(Array.isArray(lib.json.library.dates) && lib.json.library.dates.length === 2513, "the session calendar ships with the library, so relative dates resolve exactly", "dates: " + fmt(lib.json.library.dates && lib.json.library.dates.length));
  assert(String(lib.json.library.horizons) === "1,5,10,20,40,60", "the measured horizon grid is published", "horizons: " + fmt(lib.json.library.horizons));

  const idx = await get("/");
  assert(idx.status === 200 && /text\/html/.test(idx.type), "GET / serves the desk UI as HTML", "GET / -> " + idx.status + " " + idx.type);
  for (const id of ["request-notes", "personal", "followups", "go", "q"]) {
    assert(idx.body.includes("id=\"" + id + "\""), "the served markup contains #" + id, "#" + id + " missing from GET /");
  }
  const appjs = await get("/app.js");
  assert(appjs.status === 200 && /javascript/.test(appjs.type), "GET /app.js serves the UI module", "app.js -> " + appjs.status);
  const css = await get("/styles.css");
  assert(css.status === 200 && /css/.test(css.type), "GET /styles.css serves the stylesheet", "styles.css -> " + css.status);

  console.log("\n=== stress scenarios, provenance and the frozen validation ===");
  const sc = await get("/api/scenarios");
  assert(sc.status === 200 && Array.isArray(sc.json.scenarios) && sc.json.scenarios.length === 13,
    "GET /api/scenarios lists the 13 stress scenarios", "scenarios: " + fmt(sc.json.scenarios && sc.json.scenarios.length));
  assert((sc.json.scenarios || []).every((s) => s && s.why && s.caveat),
    "every scenario ships its own why and caveat, so the suite cannot be rendered without them", "a scenario is missing why/caveat");
  assert(String([...new Set((sc.json.scenarios || []).map((s) => s.kind))].sort()) === "shock,window",
    "scenario kinds are exactly the two documented lenses (shock, window)",
    "kinds: " + fmt([...new Set((sc.json.scenarios || []).map((s) => s.kind))]));

  const pv = await get("/api/provenance");
  const pvBg = pv.json.provenance.bitget;
  assert(pv.status === 200 && ["reachable-not-consumed", "degraded"].includes(pvBg.status),
    "GET /api/provenance reports the Bitget official MCP with an honest status rather than omitting it",
    "bitget: " + fmt(pvBg));
  if (pvBg.status === "reachable-not-consumed") {
    assert(Number.isInteger(pvBg.reachableDirectCount), "a reachable verdict carries the direct-route count next to it", "reachableDirectCount: " + fmt(pvBg.reachableDirectCount));
    assert(Boolean(pvBg.marketData && pvBg.marketData.summary), "the market-data summary is reported separately from the narrative gateway", "marketData: " + fmt(Boolean(pvBg.marketData)));
    assert(Boolean(pvBg.measurementSummary || pvBg.measurement), "what the toolkit actually returned travels with the reachable verdict", "measurement: " + fmt(Boolean(pvBg.measurement)));
    const bgWords = String(pvBg.measurementSummary || "") + " " + String(pvBg.disclosure || "") + " " + String(pvBg.summary || "");
    assert(/None of it feeds|No Bitget-sourced|no Bitget-sourced/.test(bgWords), "the reachable verdict still says no figure is consumed", "words: " + fmt(bgWords.slice(0, 120)));
  }
  assert(pv.json.provenance.library.symbols.length === 71, "provenance restates the 71-instrument library",
    "symbols: " + fmt(pv.json.provenance.library && pv.json.provenance.library.symbols.length));
  assert(["LIVE", "REPLAY", "TEMPLATE"].includes(pv.json.provenance.llm.mode),
    "provenance names the narrative mode the server is actually running in", "llm.mode: " + fmt(pv.json.provenance.llm.mode));

  const va = await get("/api/validation");
  assert(va.status === 200 && String(va.json.horizons) === "1,5,10,20,40,60",
    "GET /api/validation exposes all six validated horizons", "horizons: " + fmt(va.json.horizons));
  const v5 = await get("/api/validation?horizon=5");
  const s5 = v5.json.summary || {};
  assert(v5.status === 200 && s5.analog && Number.isFinite(s5.pitChiSquare),
    "GET /api/validation?horizon=5 returns the frozen summary, including the PIT statistic the engine fails",
    "summary keys: " + fmt(Object.keys(s5)));
  assert(typeof s5.honestVerdict === "string" && s5.honestVerdict.length > 20,
    "the summary carries the engine's own verdict instead of leaving the reader to infer one", "honestVerdict: " + fmt(s5.honestVerdict));

  console.log("\n=== the sentence-driven analyze call: one parser, three doors ===");
  const zh = await get("/api/analyze?question=" + encodeURIComponent("\u82f1\u4f1f\u8fbe \u672a\u6765 5 \u4e2a\u4ea4\u6613\u65e5\uff0c\u6211\u80fd\u627f\u53d7 10% \u7684\u56de\u64a4\u5417\uff1f") + "&stress=0");
  assert(zh.status === 200 && zh.json.ok === true, "GET /api/analyze answers a Chinese sentence with no explicit parameters",
    "status " + zh.status + " " + fmt(zh.body));
  assert(zh.json.parsed.symbol === "NVDA" && zh.json.parsed.horizon === 5 && zh.json.parsed.riskTolerancePct === 10,
    "that sentence yielded symbol NVDA, horizon 5 and a stated 10% drawdown tolerance", "parsed: " + fmt(zh.json.parsed));
  assert(typeof zh.json.parsed.explain === "string" && zh.json.parsed.explain.includes("NVDA"),
    "the response carries a one-line trace of what was understood, so the caller can check the reading",
    "explain: " + fmt(zh.json.parsed.explain));
  assert(zh.json.card.personalization && zh.json.card.personalization.tolerancePct === 10
    && Number.isFinite(zh.json.card.personalization.breachedSharePct) && zh.json.card.personalization.measuredOn === 50,
    "a stated tolerance comes back as a measurement over the 50 retrieved episodes, not as a stored profile",
    "personalization: " + fmt(zh.json.card.personalization));
  assert(zh.json.narrative && zh.json.narrative.checks.primary.ok === true,
    "the narrative returned over HTTP passed the numeric gate", "checks: " + fmt(zh.json.narrative && zh.json.narrative.checks));
  assert(["LIVE", "REPLAY", "TEMPLATE"].includes(zh.json.narrative.mode),
    "the narrative says which mode produced it (" + (zh.json.narrative && zh.json.narrative.mode) + ")",
    "mode: " + fmt(zh.json.narrative && zh.json.narrative.mode));
  assert(zh.json.card.retrieval.kReturned === 50 && (zh.json.card.retrieval.notes || []).length === 0,
    "an in-grid request carries no adjustment disclosure, so the amber bar only appears when something really moved",
    "notes: " + fmt(zh.json.card.retrieval.notes));

  const en = await get("/api/analyze?question=" + encodeURIComponent("Should I buy BABA into earnings over the next 20 sessions?") + "&stress=0");
  assert(en.status === 200 && en.json.parsed.symbol === "BABA" && en.json.parsed.horizon === 20,
    "an English sentence is understood by the same parser: BABA over 20 sessions", "parsed: " + fmt(en.json.parsed));
  const ty = await get("/api/analyze?question=" + encodeURIComponent("NVDIA next 5 days") + "&stress=0");
  assert(ty.status === 200 && ty.json.parsed.symbol === "NVDA" && ty.json.parsed.matchedHow === "fuzzy",
    "a one-letter typo is repaired and labelled fuzzy, never silently reinterpreted", "parsed: " + fmt(ty.json.parsed));

  console.log("\n=== explicit parameters win, and every adjustment is disclosed ===");
  const ex = await get("/api/analyze?question=" + encodeURIComponent("NVDA over the next 60 sessions") + "&symbol=AAPL&horizon=10&stress=0");
  assert(ex.status === 200 && ex.json.card.idea.symbol === "AAPL" && ex.json.card.idea.horizonSessions === 10,
    "explicit symbol= and horizon= override what the sentence said", "idea: " + fmt(ex.json.card && ex.json.card.idea));
  const h7 = await get("/api/analyze?symbol=NVDA&horizon=7&stress=0");
  assert(h7.status === 200 && h7.json.card.retrieval.horizonSnapped === true && h7.json.card.retrieval.horizonBeforeSnap === 7
    && h7.json.card.idea.horizonSessions === 5 && (h7.json.card.retrieval.notes || []).length >= 1,
    "horizon=7 is snapped onto the measured grid, run at 5, and the snap is disclosed on the card",
    "retrieval: " + fmt(h7.json.card && h7.json.card.retrieval));
  const k9 = await get("/api/analyze?symbol=NVDA&k=999&stress=0");
  assert(k9.status === 200 && k9.json.card.retrieval.kClamped === true && k9.json.card.retrieval.kBeforeClamp === 999
    && k9.json.card.retrieval.kReturned === 200,
    "k=999 is clamped to the 200-neighbour ceiling and the clamp is recorded",
    "retrieval: " + fmt(k9.json.card && k9.json.card.retrieval));
  assert((k9.json.card.retrieval.notes || []).some((n) => /not the validated k=50/.test(n)),
    "the k clamp discloses that the frozen conformal scale and every published figure describe k=50, not this k",
    "notes: " + fmt(k9.json.card.retrieval.notes));

  console.log("\n=== a request the desk cannot answer is an error, never an empty card ===");
  const ns = await get("/api/analyze?question=" + encodeURIComponent("hello there how are you"));
  assert(ns.status === 400 && ns.json.ok === false && /no instrument recognised/.test(ns.json.error),
    "a sentence with no instrument is a 400 that names the fix", "got: " + fmt(ns.body));
  const unk = await get("/api/analyze?symbol=ZZZZ");
  assert(unk.status === 400 && /not in analog library/.test(unk.json.error),
    "an unknown ticker is a 400 that says how large the library is", "got: " + fmt(unk.body));
  const early = await get("/api/analyze?symbol=NVDA&date=2016-09-20&horizon=5&stress=0");
  assert(early.status === 400 ? /feature row|first usable|library|earlier|start|date|session/i.test(early.json.error) : early.json.card.retrieval.kReturned > 0,
    "a date on the library's first session either errors with a reason or returns a real card - never a shell",
    "got " + early.status + " " + fmt(early.json && (early.json.error || early.json.card && early.json.card.retrieval)));

  console.log("\n=== this is also a file server: what must never be reachable ===");
  for (const p of ["/../.env", "/%2e%2e/.env", "/%2e%2e/%2e%2e/package.json", "/.env", "/data-cache/dataset.json", "/research/LIMITATIONS.md"]) {
    const r = await get(p);
    assert(r.status === 404, "GET " + p + " -> 404", "GET " + p + " -> " + r.status + " " + fmt(r.body.slice(0, 90)));
  }
  const cfg = await get("/src/llm/config.mjs");
  assert(cfg.status === 200 && !/sk-[A-Za-z0-9]{12}/.test(cfg.body),
    "GET /src/llm/config.mjs is served (the browser bundle needs the module graph) and holds no key literal",
    "status " + cfg.status);
  const dot = await get("/src/llm/.env");
  assert(dot.status === 404, "GET /src/llm/.env -> 404: only .mjs and .json are reachable under /src/", "got " + dot.status);
  const un2 = await get("/api/nope");
  assert(un2.status === 404 && un2.json.ok === false, "an unknown /api/ route is a 404, not a crash", "got: " + fmt(un2.body));
  const post = await fetch(BASE + "/", { method: "POST" });
  assert(post.status === 400, "POST / is refused with 400 rather than served as a file", "got " + post.status);
} catch (e) {
  bad("the contract run threw before finishing: " + (e && e.message));
} finally {
  child.kill();
  await sleep(300);
  console.log("\n" + (checks - failures) + " / " + checks + " assertions against a live server process on port " + PORT);
  if (failures) { console.log("\ncheck:server FAILED (" + failures + ")"); process.exit(1); }
  console.log("\ncheck:server passed");
}
