/**
 * AnalogDesk - static deployment check.
 *
 *   npm run compile && node scripts/check-bundle.mjs
 *
 * Evaluates dist/app.bundle.js the way a browser would - DOM stub, no server, and a fetch() that
 * throws - so the package is proven to be genuinely self-contained rather than assumed to be. Then
 * it drives the in-browser engine directly and prints, per query, the analyze latency, the analog
 * count, the conformal interval, the scenario count and the numeric-gate result, followed by the
 * rendered size of every UI panel. A regression in the module transform (an export, a live binding,
 * an import) fails here instead of producing a blank page in front of a reviewer.
 */
import { readFileSync } from "node:fs";

const NODES = new Map();
function mkEl(id) {
  const e = {
    id, textContent: "", className: "", title: "", value: "", hidden: false, checked: true,
    style: { cssText: "" }, dataset: {}, listeners: {}, _html: "",
    _options: [],
    get options() { return this._options; },
    set innerHTML(v) {
      this._html = String(v);
      if (/<option\b/i.test(this._html)) {
        this._options = [...this._html.matchAll(/<option value="([^"]*)"/g)].map((m) => ({ value: m[1] }));
      }
    },
    get innerHTML() { return this._html; },
    addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); },
    appendChild(c) { return c; },
    querySelectorAll() { return []; }, querySelector() { return null; }, scrollIntoView() {}
  };
  return e;
}
globalThis.document = {
  getElementById: (id) => { if (!NODES.has(id)) NODES.set(id, mkEl(id)); return NODES.get(id); },
  createElement: (t) => mkEl(t), querySelectorAll: () => [], body: mkEl("body")
};
Object.defineProperty(globalThis, "navigator", { value: { clipboard: { writeText: async () => {} } }, configurable: true });
globalThis.location = { href: "file:///dist/index.html?symbol=NVDA&horizon=5&k=50&q=NVDA%20%E7%8E%B0%E5%9C%A8%E8%BF%9B%E5%9C%BA%EF%BC%8C%E6%9C%AA%E6%9D%A5%E4%B8%80%E5%91%A8%E5%8E%86%E5%8F%B2%E4%B8%8A%E7%9B%B8%E4%BC%BC%E7%9A%84%E8%B5%B0%E5%8A%BF%EF%BC%9F&run=1" };
globalThis.performance ||= { now: () => Date.now() };
globalThis.window = globalThis;
// No server, no network: any fetch means the static build is not self-contained.
let fetchCalls = 0;
globalThis.fetch = async (u) => { fetchCalls++; throw new Error("static build must not fetch: " + u); };

const bundle = readFileSync("dist/app.bundle.js", "utf8");
const t0 = Date.now();
(0, eval)(bundle);
await new Promise((r) => setTimeout(r, 12000));
console.log(`bundle evaluated in ${Date.now() - t0} ms; fetch calls = ${fetchCalls}`);

const AD = globalThis.AnalogDesk;
if (!AD) { console.log("FAIL: window.AnalogDesk not set"); process.exit(1); }
console.log("AnalogDesk keys:", Object.keys(AD).join(", "));
console.log("dataset symbols:", (AD.dataset?.meta?.universe || []).length, "sessions:", AD.dataset?.dates?.length);
console.log("validation horizons:", Object.keys(AD.validationResults?.runs || {}).join(", "));
console.log("desk.createDesk is fn:", typeof AD.desk?.createDesk === "function");
console.log("template.renderTemplate is fn:", typeof AD.template?.renderTemplate === "function");
console.log("verify.buildAllowlist/defaultAllowance:", typeof AD.verify?.buildAllowlist, typeof AD.verify?.defaultAllowance);
console.log("replay.MemoryStore:", typeof AD.replay?.MemoryStore);
console.log("ALIASES size:", AD.ALIASES?.size);

// Drive the in-browser engine directly through the same desk the UI uses.
const t1 = Date.now();
const desk = AD.desk.createDesk({ dataset: AD.dataset, validationResults: AD.validationResults, provenance: AD.provenance, config: {} });
console.log(`\nengine init in-browser: ${Date.now() - t1} ms; ${desk.engine.mx.nSym} instruments x ${desk.engine.mx.nDates} sessions`);
for (const [sym, H] of [["NVDA", 5], ["BABA", 20], ["SPY", 1], ["KWEB", 10]]) {
  const t2 = Date.now();
  const { card, detail } = desk.analyze({ symbol: sym, date: "latest", horizon: H, k: 50 });
  const allow = AD.verify.buildAllowlist(card, AD.verify.defaultAllowance(card));
  const tmpl = AD.template.renderTemplate(card, { language: "en" });
  const gate = AD.verify.verifyNumbers(tmpl.text, allow);
  console.log(`  ${sym.padEnd(5)} H=${String(H).padEnd(3)} analyze=${String(Date.now() - t2).padStart(4)}ms n=${card.distribution.n} median=${card.distribution.medianPct}% conf=${card.conformal.lowerPct}..${card.conformal.upperPct} scen=${card.stress.length} gate=${gate.ok}(${gate.unsupportedCount}/${gate.total})`);
}
console.log(`\nUI panels rendered by the bundle's own app.js:`);
for (const id of ["cardbar", "narrative", "state", "conformal", "hist", "fan", "excursion", "stresstable", "stressdetail", "analogtable", "validation", "sources", "network", "bitget", "llmpanel"]) {
  const n = NODES.get(id);
  console.log(`  ${String(n ? n.innerHTML.length : -1).padStart(7)}  #${id}`);
}
console.log(`\nfetch calls total: ${fetchCalls}`);