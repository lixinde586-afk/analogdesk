/**
 * AnalogDesk - static deployment check.
 *
 *   npm run compile && npm run check:bundle
 *
 * Evaluates dist/app.bundle.js the way a browser would - DOM stub, no server, and a fetch() that
 * throws - so the package is proven self-contained rather than assumed to be, then drives the
 * in-browser engine and asserts on what the UI actually rendered.
 *
 * THE STUB IS SEEDED FROM THE REAL dist/index.html, AND getElementById RETURNS null FOR ANYTHING
 * THAT IS NOT A REAL ELEMENT THERE. It used to auto-create every id it was asked for, which is how
 * a mis-quoted attribute that swallowed 25 elements from the markup reached production unnoticed:
 * the bundle booted happily against a DOM that no browser would ever build. A stub that cannot
 * represent a broken page cannot detect one. `npm run check:html` verifies the same markup without
 * executing anything, and `npm run check:browser` repeats this end to end in real headless Chrome.
 */
import { readFileSync } from "node:fs";
import { scanHtml } from "./check-html.mjs";

const HTML = readFileSync("dist/index.html", "utf8");
const PARSED = scanHtml(HTML).elements;
const byId = new Map();
for (const el of PARSED) { const id = el.attrs.get("id"); if (id && !byId.has(id)) byId.set(id, el); }
const withClass = (name) => PARSED.filter((e) => (e.attrs.get("class") || "").split(/\s+/).includes(name));
const TABS = withClass("tab");
const PANELS = withClass("panel");

const NODES = new Map();
let fetchCalls = 0;

function mkEl(tag, id = "", attrs = new Map()) {
  const e = {
    tagName: String(tag).toUpperCase(), id, textContent: "", title: attrs.get("title") || "",
    value: attrs.get("value") || "", hidden: attrs.has("hidden"), checked: attrs.has("checked"),
    style: { cssText: "" }, listeners: {}, _html: "", _classes: new Set((attrs.get("class") || "").split(/\s+/).filter(Boolean)),
    dataset: Object.fromEntries([...attrs].filter(([k]) => k.startsWith("data-")).map(([k, v]) => [k.slice(5), v])),
    get className() { return [...this._classes].join(" "); },
    set className(v) { this._classes = new Set(String(v).split(/\s+/).filter(Boolean)); },
    classList: {
      toggle: (c, on) => { const has = e._classes.has(c); const want = on === undefined ? !has : !!on; if (want) e._classes.add(c); else e._classes.delete(c); return want; },
      add: (c) => e._classes.add(c), remove: (c) => e._classes.delete(c), contains: (c) => e._classes.has(c)
    },
    get options() { return [...this._html.matchAll(/<option value="([^"]*)"/g)].map((m) => ({ value: m[1] })); },
    set innerHTML(v) { this._html = String(v); },
    get innerHTML() { return this._html; },
    addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); },
    appendChild(c) { return c; },
    setAttribute(k, v) { if (k === "id") this.id = v; },
    scrollIntoView() {},
    /** Only the selectors app.js actually uses. Anything else is a stub gap, not a pass. */
    querySelectorAll(sel) {
      if (sel === ".tab") return TABS.map((t) => node(t.attrs.get("id") || "", "button", t.attrs));
      if (sel === ".chip") return [...this._html.matchAll(/<button class="chip" data-i="(\d+)"/g)].map((m) => { const a = new Map([["data-i", m[1]]]); return node("", "button", a); });
      if (sel === "tbody tr[data-id]") return [...this._html.matchAll(/data-id="([^"]+)"/g)].map((m) => { const a = new Map([["data-id", m[1]]]); return node("", "tr", a); });
      // renderFollowups wires its suggestion buttons through this selector. It was missing, so the stub
      // threw inside run(), run()'s catch swallowed it into a console.error, and every panel assertion
      // below then measured a page that had stopped rendering two steps early. A stub gap that fails
      // loudly is fine; one that fails quietly is how a broken demo ships.
      if (sel === "button") return [...this._html.matchAll(/<button([^>]*)>/g)].map((m) => node("", "button",
        new Map([...m[1].matchAll(/([\w-]+)="([^"]*)"/g)].map((x) => [x[1], x[2]]))));
      throw new Error(`check-bundle stub: unsupported selector ${JSON.stringify(sel)} - teach the stub, do not return []`);
    },
    querySelector() { return null; }
  };
  return e;
}

function node(id, tag = "div", attrs = new Map()) {
  if (id && NODES.has(id)) return NODES.get(id);
  const e = mkEl(tag, id, attrs);
  if (id) NODES.set(id, e);
  return e;
}
for (const [id, el] of byId) NODES.set(id, mkEl(el.tag, id, el.attrs));

globalThis.document = {
  getElementById: (id) => NODES.get(id) || null,
  createElement: (t) => mkEl(t),
  querySelectorAll(sel) {
    if (sel === ".panel") return PANELS.map((p) => node(p.attrs.get("id") || "", p.tag, p.attrs));
    throw new Error(`check-bundle stub: unsupported document selector ${JSON.stringify(sel)}`);
  },
  documentElement: mkEl("html"),
  body: node("body", "body")
};
Object.defineProperty(globalThis, "navigator", { value: { clipboard: { writeText: async () => {} } }, configurable: true });
globalThis.location = { href: "file:///dist/index.html?symbol=NVDA&horizon=5&k=50&q=NVDA%20%E7%8E%B0%E5%9C%A8%E8%BF%9B%E5%9C%BA%EF%BC%8C%E6%9C%AA%E6%9D%A5%E4%B8%80%E5%91%A8%E5%8E%86%E5%8F%B2%E4%B8%8A%E7%9B%B8%E4%BC%BC%E7%9A%84%E8%B5%B0%E5%8A%BF%EF%BC%9F&run=1" };
globalThis.performance ||= { now: () => Date.now() };
globalThis.window = globalThis;
globalThis.fetch = async (u) => { fetchCalls++; throw new Error("static build must not fetch: " + u); };

let unhandled = null;
process.on("unhandledRejection", (r) => { unhandled = r; });

/* ------------------------------- assertions ------------------------------ */

let failures = 0;
const fail = (m) => { failures++; console.error("  FAIL " + m); };
const ok = (m) => console.log("  ok   " + m);
const assert = (cond, goodMsg, badMsg) => (cond ? ok(goodMsg) : fail(badMsg));

const PANELS_TO_RENDER = ["cardbar", "narrative", "state", "conformal", "hist", "diststats", "fan",
  "excursion", "stresstable", "stressdetail", "wrapper", "analogtable", "validation", "sources", "network",
  "bitget", "wrapperprov", "llmpanel"];

const bundle = readFileSync("dist/app.bundle.js", "utf8");
const t0 = Date.now();
(0, eval)(bundle);

// Poll instead of sleeping a fixed 12s: boot is done once the results container is unhidden.
const deadline = Date.now() + 90000;
// Stop as soon as boot either succeeded (results unhidden) or gave up (fatal banner rendered).
while (Date.now() < deadline && NODES.get("results")?.hidden !== false && !NODES.get("fatal")) {
  await new Promise((r) => setTimeout(r, 250));
}
const bootMs = Date.now() - t0;
console.log(`\nbundle evaluated and booted in ${bootMs} ms; fetch calls = ${fetchCalls}`);

console.log("\nboot");
assert(!unhandled, "no unhandled rejection", `unhandled rejection: ${unhandled && (unhandled.stack || unhandled.message || unhandled)}`);
const fatalEl = NODES.get("fatal");
assert(!fatalEl, "no on-page fatal banner", `fatal banner rendered: ${fatalEl?.textContent}`);
const emptyHtml = NODES.get("empty")?.innerHTML || "";
assert(!emptyHtml.includes("did not start"), "empty state not replaced by the failure panel", `failure panel shown: ${emptyHtml.slice(0, 200)}`);
assert(NODES.get("results")?.hidden === false, "results container visible", "results container still hidden - boot never completed");
const clicked = NODES.get("go")?.listeners?.click?.length || 0;
assert(clicked >= 1, `#go has ${clicked} click handler(s)`, "#go has no click handler - the Analyze button would do nothing");
const keyed = NODES.get("q")?.listeners?.keydown?.length || 0;
assert(keyed >= 1, `#q has ${keyed} keydown handler(s)`, "#q has no keydown handler - Enter would do nothing");

console.log("\nbadges");
for (const id of ["badge-mode", "badge-runtime", "badge-lib", "badge-bitget"]) {
  const t = NODES.get(id)?.textContent || "";
  assert(t && !/loading|probing/i.test(t), `#${id}: ${t}`, `#${id} stuck at ${JSON.stringify(t)}`);
}

console.log("\ncontrols");
const syms = NODES.get("symbol")?.options || [];
assert(syms.length >= 50, `#symbol has ${syms.length} options`, `#symbol has only ${syms.length} options - the library did not load`);
const hzs = NODES.get("horizon")?.options || [];
assert(hzs.length >= 1, `#horizon has ${hzs.length} options`, "#horizon has no options");
assert((NODES.get("chips")?.innerHTML.match(/class="chip"/g) || []).length >= 4, "example chips rendered", "example chips missing");

console.log("\nrendered panels");
for (const id of PANELS_TO_RENDER) {
  const n = NODES.get(id);
  const len = n ? n.innerHTML.length : -1;
  assert(len > 0, `${String(len).padStart(7)} bytes  #${id}`, `#${id} rendered nothing (${len})`);
}

console.log("\nthe auto-run actually finished");
{
  // run() catches its own errors, paints "failed" into #cardbar and leaves every earlier panel filled,
  // so a throw halfway through used to look like a pass. Assert the end state instead of trusting it.
  const cb = NODES.get("cardbar")?.innerHTML || "";
  assert(cb.includes("analog") && !/>failed</.test(cb), "#cardbar holds the completed headline, not run()'s failure markup", "#cardbar holds the failure markup - the auto-run threw part-way and every panel above is half-rendered");
  const fu = NODES.get("followups");
  assert(!!fu && fu.innerHTML.includes("<button") && fu.hidden === false, "#followups rendered its suggestion buttons and is visible", "#followups is empty or hidden - renderFollowups did not complete");
}

console.log("\nrendered text hygiene");
const all = PANELS_TO_RENDER.map((id) => NODES.get(id)?.innerHTML || "").join("\n");
assert(!/\bundefined\b/.test(all), "no literal 'undefined' in any panel", `literal 'undefined' found: ${all.match(/.{0,60}\bundefined\b.{0,60}/)?.[0]}`);
assert(!/\bNaN\b/.test(all), "no literal 'NaN' in any panel", `literal 'NaN' found: ${all.match(/.{0,60}\bNaN\b.{0,60}/)?.[0]}`);
assert(fetchCalls === 0, "zero fetch calls - the static build is self-contained", `${fetchCalls} fetch call(s) - the static build tried to reach a server`);

console.log("\nin-browser engine, driven directly");
const AD = globalThis.AnalogDesk;
assert(!!AD, "window.AnalogDesk exposed", "window.AnalogDesk not set");
if (AD) {
  const t1 = Date.now();
  assert(!!AD.wrapper, "wrapper measurement baked into the bundle", "window.AnalogDesk.wrapper is missing - the static build would render cards with no 7x24 block while the server renders one, and the two would hash differently");
  const desk = AD.desk.createDesk({ dataset: AD.dataset, validationResults: AD.validationResults, provenance: AD.provenance, config: {}, wrapper: AD.wrapper || null });
  ok(`engine init in ${Date.now() - t1} ms; ${desk.engine.mx.nSym} instruments x ${desk.engine.mx.nDates} sessions`);
  for (const [sym, H] of [["NVDA", 5], ["BABA", 20], ["SPY", 1], ["KWEB", 10]]) {
    const t2 = Date.now();
    const { card } = desk.analyze({ symbol: sym, date: "latest", horizon: H, k: 50 });
    const allow = AD.verify.buildAllowlist(card, AD.verify.defaultAllowance(card));
    const tmpl = AD.template.renderTemplate(card, { language: "en" });
    const gate = AD.verify.verifyNumbers(tmpl.text, allow);
    const line = `${sym.padEnd(5)} H=${String(H).padEnd(3)} analyze=${String(Date.now() - t2).padStart(4)}ms n=${card.distribution.n} median=${card.distribution.medianPct}% conf=${card.conformal.lowerPct}..${card.conformal.upperPct} scen=${card.stress.length} gate=${gate.ok}(${gate.unsupportedCount}/${gate.total})`;
    assert(gate.ok && card.distribution.n > 0, "  " + line, "  " + line);
    const w = card.wrapper;
    assert(!!w && typeof w.status === "string" && w.referenceMarket?.closedSharePct != null,
      `  ${sym.padEnd(5)} wrapper block present (status ${w?.status}, reference market closed ${w?.referenceMarket?.closedSharePct}%)`,
      `  ${sym} has no usable wrapper block - the card would silently drop the measured 7x24 figure`);
  }
}

console.log(failures ? `\ncheck:bundle FAILED (${failures})` : "\ncheck:bundle passed");
process.exit(failures ? 1 : 0);