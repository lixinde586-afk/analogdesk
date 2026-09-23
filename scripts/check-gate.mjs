/**
 * AnalogDesk - numeric gate smoke test.
 *
 *   node scripts/check-gate.mjs
 *
 * Renders the deterministic template for every symbol/horizon/language combination below and asserts
 * that verify-numbers.mjs traces EVERY numeral in the prose back to the research card. This is the
 * test that keeps the central claim of the narrative layer honest: the model writes the sentences,
 * the engine owns the numbers. A gate that passes for one lucky query is not a control, so it is
 * run across the grid, and any unsupported numeral is printed with its value so it can be traced.
 */
import { readFileSync } from "node:fs";
import { createDesk } from "../src/desk.mjs";
import { renderTemplate } from "../src/llm/template.mjs";
import { buildAllowlist, verifyNumbers, defaultAllowance } from "../src/llm/verify-numbers.mjs";

const dataset = JSON.parse(readFileSync("data-cache/dataset.json", "utf8"));
const V = JSON.parse(readFileSync("research/validation-results.json", "utf8"));
// The wrapper block is part of the card, so the gate grid has to run WITH it: that is the only way
// to prove the template can quote the measured 7x24 figures without the numeric gate rejecting them.
const W = (() => { try { return JSON.parse(readFileSync("data-cache/wrapper-probe.json", "utf8")); } catch { return null; } })();
const prov = { sessions: 2513, symbols: 71, from: dataset.meta.from, to: dataset.meta.to };
const desk = createDesk({ dataset, validationResults: V, provenance: prov, wrapper: W });
if (!W) console.log("  note  data-cache/wrapper-probe.json is missing, so this grid does not exercise the wrapper block");

const syms = ["NVDA", "BABA", "SPY", "TSLA", "KWEB", "JPM", "GLD", "PDD", "NIO", "QQQ", "XOM", "UNH"];
const horizons = [1, 5, 10, 20, 40, 60];
let pass = 0, fail = 0, errs = [];
for (const s of syms) for (const H of horizons) for (const lang of ["en", "zh"]) {
  try {
    const { card } = desk.analyze({ symbol: s, date: "latest", horizon: H, k: 50, includeStress: H === 5 });
    const allow = buildAllowlist(card, defaultAllowance(card));
    const c = verifyNumbers(renderTemplate(card, { language: lang }).text, allow);
    if (c.ok) pass++; else { fail++; errs.push(`${s} H=${H} ${lang}: ${c.unsupportedCount} unsupported -> ${c.unsupported.map(u => `"${u.value}"`).join(", ")}`); }
  } catch (e) { fail++; errs.push(`${s} H=${H} ${lang}: THREW ${e.message}`); }
}
console.log(`gate smoke: ${pass} pass / ${fail} fail over ${syms.length * horizons.length * 2} renders`);
for (const e of errs.slice(0, 25)) console.log("  " + e);