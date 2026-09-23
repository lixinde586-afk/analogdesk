/**
 * AnalogDesk - MCP tool-server gate.
 *
 *   npm run check:mcp
 *
 * WHY THIS EXISTS
 * mcp-server.mjs is a protocol server: if the handshake is wrong, nothing else about it matters, and
 * the failure is invisible from the inside because the process looks alive. So this spawns the real
 * server over stdio, performs exactly the handshake a host performs, calls every tool it advertises,
 * and asserts on what comes back - including the two properties the rest of this project is built on:
 * a number in a tool result is engine-computed (the numeric gate verdict travels with the narrative),
 * and a request that had to be adjusted says so instead of answering a different question quietly.
 * It also asserts stdout purity: one diagnostic byte on stdout breaks framing for every host.
 */
import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0, checks = 0;
const ok = (m) => { checks++; console.log("  ok   " + m); };
const bad = (m) => { checks++; failures++; console.log("  FAIL " + m); };
const assert = (c, good, badMsg) => (c ? ok(good) : bad(badMsg));
const fmt = (v) => (typeof v === "string" ? JSON.stringify(v.length > 90 ? v.slice(0, 90) + "..." : v) : JSON.stringify(v));

const child = spawn(process.execPath, [resolve(ROOT, "mcp-server.mjs")], { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] });
let buf = "", stderrText = "";
const pending = new Map();
const unparsed = [];
const unsolicited = [];

child.stdout.on("data", (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { unparsed.push(line); continue; }
    const p = pending.get(msg.id);
    if (p) { pending.delete(msg.id); p(msg); } else unsolicited.push(msg);
  }
});
child.stderr.on("data", (d) => { stderrText += d.toString(); });
child.on("exit", (code) => { if (code !== 0 && code !== null) console.log("  note: server exited with code " + code); });

let nextId = 1;
function rpc(method, params, timeoutMs = 120000) {
  const id = nextId++;
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((res, rej) => {
    const t = setTimeout(() => { pending.delete(id); rej(new Error("timeout after " + timeoutMs + "ms waiting for " + method)); }, timeoutMs);
    pending.set(id, (msg) => { clearTimeout(t); res(msg); });
  });
}
const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
const textOf = (r) => ((r && r.result && r.result.content) || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
const sc = (r) => (r && r.result && r.result.structuredContent) || null;

try {
  console.log("=== MCP handshake ===");
  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "check-mcp", version: "1.0.0" } });
  assert(init.result && init.result.protocolVersion === "2025-06-18", "initialize negotiated protocol 2025-06-18", "protocolVersion: " + fmt(init.result && init.result.protocolVersion));
  assert(init.result && init.result.serverInfo && init.result.serverInfo.name === "analogdesk", "serverInfo.name = analogdesk", "serverInfo: " + fmt(init.result && init.result.serverInfo));
  assert(init.result && init.result.capabilities && init.result.capabilities.tools, "advertises the tools capability", "capabilities: " + fmt(init.result && init.result.capabilities));
  assert(/not investment advice/i.test(String(init.result && init.result.instructions)), "instructions carry the not-investment-advice line", "instructions: " + fmt(init.result && init.result.instructions));
  notify("notifications/initialized", {});
  const ping = await rpc("ping", {});
  assert(ping.result && !ping.error, "ping answered", "ping: " + fmt(ping.error || ping.result));

  console.log("\n=== tools/list ===");
  const list = await rpc("tools/list", {});
  const tools = (list.result && list.result.tools) || [];
  const names = tools.map((t) => t.name).sort();
  const want = ["analogdesk_analyze", "analogdesk_library", "analogdesk_provenance", "analogdesk_stress", "analogdesk_validation"];
  assert(names.join(",") === want.join(","), tools.length + " tools: " + names.join(", "), "tool names: " + fmt(names));
  for (const t of tools) {
    assert(t.inputSchema && t.inputSchema.type === "object", t.name + " has an object inputSchema", t.name + " inputSchema: " + fmt(t.inputSchema));
    assert(String(t.description || "").length > 80, t.name + " describes itself in " + String(t.description || "").length + " chars", t.name + " description too short");
  }
  const analyzeSchema = (tools.find((t) => t.name === "analogdesk_analyze") || {}).inputSchema || {};
  for (const p of ["question", "symbol", "horizon", "k", "riskTolerancePct", "fullNarrative"]) {
    assert(Boolean(analyzeSchema.properties && analyzeSchema.properties[p]), "analyze accepts " + p, "analyze inputSchema lacks " + p);
  }
  console.log("\n=== tools/call: analogdesk_library ===");
  const lib = await rpc("tools/call", { name: "analogdesk_library", arguments: {} });
  const libText = textOf(lib);
  const libSc = sc(lib);
  assert(!lib.result.isError, "library call succeeded", "library error: " + fmt(libText));
  const nSym = (libSc && libSc.symbols || []).length;
  const nSes = libSc && libSc.sessions;
  assert(nSym >= 50, nSym + " instruments advertised", "instrument count: " + nSym);
  assert(nSes >= 2000, nSes + " sessions advertised", "session count: " + nSes);
  assert(libText.includes(nSym + " instruments") && libText.includes(nSes + " sessions"), "the text states the same counts as the payload", "library text head: " + fmt(libText.slice(0, 120)));
  assert(/1, 5, 10, 20, 40, 60/.test(libText), "the measured horizon grid is stated", "horizons missing from library text");
  assert(/dv20z/.test(libText), "the distance-metric exclusions are disclosed", "exclusions missing from library text");

  console.log("\n=== tools/call: analogdesk_analyze, driven by one Chinese sentence ===");
  const an = await rpc("tools/call", { name: "analogdesk_analyze", arguments: { question: "英伟达 未来 5 个交易日，我能承受 10% 的回撤吗" } });
  const anText = textOf(an);
  const anSc = sc(an);
  assert(!an.result.isError, "analyze call succeeded", "analyze error: " + fmt(anText));
  assert(anSc && anSc.understood && anSc.understood.symbol === "NVDA", "the sentence resolved to NVDA", "understood: " + fmt(anSc && anSc.understood));
  assert(anSc && anSc.understood && anSc.understood.horizon === 5, "the sentence resolved to a 5-session horizon", "horizon: " + fmt(anSc && anSc.understood && anSc.understood.horizon));
  assert(anSc && anSc.understood && anSc.understood.riskTolerancePct === 10, "the stated drawdown tolerance was parsed", "risk: " + fmt(anSc && anSc.understood && anSc.understood.riskTolerancePct));
  const card = (anSc && anSc.card) || {};
  const dist = card.distribution || {};
  assert(dist.n > 0, "distribution covers " + dist.n + " analogs", "distribution.n: " + fmt(dist.n));
  assert(card.conformal && Number.isFinite(card.conformal.lowerPct), "a conformal interval came back (" + (card.conformal ? card.conformal.lowerPct + ".." + card.conformal.upperPct : "none") + ")", "conformal missing");
  assert(card.personalization && card.personalization.tolerancePct === 10, "the personalisation panel answers the stated tolerance", "personalization: " + fmt(card.personalization));
  assert(/YOUR CONSTRAINT/.test(anText), "the tolerance is answered in the tool text", "no constraint block in text");
  assert(/CONFORMAL/.test(anText), "the interval is in the tool text", "no conformal block in text");
  assert(/numeric gate PASS \d+\/\d+/.test(anText), "the numeric gate verdict travels with the narrative", "gate verdict missing: " + fmt(anText.slice(-260)));
  assert(anSc.narrative && anSc.narrative.numericGate && anSc.narrative.numericGate.ok === true, "structured gate verdict ok=true", "structured gate: " + fmt(anSc.narrative && anSc.narrative.numericGate));
  assert(/not investment advice/i.test(anText), "the disclaimer is in every analyze result", "disclaimer missing");

  console.log("\n=== tools/call: an out-of-range request must be adjusted AND disclosed ===");
  const cl = await rpc("tools/call", { name: "analogdesk_analyze", arguments: { symbol: "NVDA", horizon: 7, k: 999, includeStress: false } });
  const clText = textOf(cl);
  const clSc = sc(cl);
  const clCard = (clSc && clSc.card) || {};
  assert(!cl.result.isError, "the clamped request still produced a card", "clamped call error: " + fmt(clText));
  assert(clCard.idea && clCard.idea.horizonSessions === 5, "horizon 7 was snapped to 5", "horizon: " + fmt(clCard.idea && clCard.idea.horizonSessions));
  assert(clCard.retrieval && clCard.retrieval.kRequested === 200, "k 999 was clamped to 200", "kRequested: " + fmt(clCard.retrieval && clCard.retrieval.kRequested));
  assert((clCard.retrieval.notes || []).length >= 2, (clCard.retrieval.notes || []).length + " disclosure notes attached", "notes: " + fmt(clCard.retrieval.notes));
  assert(/REQUEST ADJUSTED BEFORE IT RAN/.test(clText), "the adjustment is stated in the tool text", "no adjustment block in text");
  assert(/validated k=50/.test(clText), "the text says which k the validation belongs to", "no validated-k disclosure");

  console.log("\n=== tools/call: a request that cannot be answered ===");
  const zz = await rpc("tools/call", { name: "analogdesk_analyze", arguments: { symbol: "ZZZZ" } });
  assert(zz.result && zz.result.isError === true, "an unknown instrument is an isError result, not an empty card", "isError: " + fmt(zz.result && zz.result.isError));
  assert(/not in analog library/.test(textOf(zz)), "the error names the cause", "error text: " + fmt(textOf(zz)));
  assert(/analogdesk_library|dropdown|library instruments/.test(textOf(zz)), "the error names the way out", "error text: " + fmt(textOf(zz)));
  const noSym = await rpc("tools/call", { name: "analogdesk_analyze", arguments: { question: "how does the market feel today" } });
  assert(noSym.result && noSym.result.isError === true, "a sentence with no instrument is an error", "isError: " + fmt(noSym.result && noSym.result.isError));

  console.log("\n=== tools/call: analogdesk_stress ===");
  const st = await rpc("tools/call", { name: "analogdesk_stress", arguments: { symbol: "SPY", horizon: 5 } });
  const stText = textOf(st);
  const stSc = sc(st);
  assert(!st.result.isError, "stress call succeeded", "stress error: " + fmt(stText));
  const scen = (stSc && stSc.scenarios) || [];
  assert(scen.length === 13, scen.length + " scenarios returned", "scenario count: " + scen.length);
  assert(/AnalogDesk stress suite/.test(stText), "the stress text is headed", "stress head missing");
  assert(/CAVEATS/.test(stText), "every scenario caveat is printed", "caveats missing");
  const ran = scen.filter((s) => !s.skipped).length;
  assert(ran >= 10, ran + " of " + scen.length + " scenarios actually ran", "too few scenarios ran: " + ran);

  console.log("\n=== tools/call: analogdesk_validation ===");
  const va = await rpc("tools/call", { name: "analogdesk_validation", arguments: { horizon: 5 } });
  const vaText = textOf(va);
  const vaSc = sc(va);
  assert(!va.result.isError, "validation call succeeded", "validation error: " + fmt(vaText));
  const cov = vaSc && vaSc.summary && vaSc.summary.analog && vaSc.summary.analog.coveragePct;
  assert(Number.isFinite(cov) && cov > 70 && cov < 95, "out-of-sample coverage " + cov + "% is inside a believable range", "coverage: " + fmt(cov));
  assert(/VERDICT/.test(vaText) && /NOT sharper|not an alpha source/i.test(vaText), "the honest verdict is returned with the numbers", "verdict missing from validation text");
  const badH = await rpc("tools/call", { name: "analogdesk_validation", arguments: { horizon: 7 } });
  assert(badH.result && badH.result.isError === true, "an unmeasured horizon is refused", "isError: " + fmt(badH.result && badH.result.isError));
  assert(/Available horizons/.test(textOf(badH)), "the refusal lists what is available", "refusal text: " + fmt(textOf(badH)));

  console.log("\n=== tools/call: analogdesk_provenance ===");
  const pr = await rpc("tools/call", { name: "analogdesk_provenance", arguments: {} });
  const prText = textOf(pr);
  const prSc = sc(pr);
  assert(!pr.result.isError, "provenance call succeeded", "provenance error: " + fmt(prText));
  assert(/stockanalysis/.test(prText), "the price source is named", "price source missing");
  const bgLine = (prText.match(/BITGET OFFICIAL MCP:[^\n]*/) || [""])[0];
  const bgReachable = /^BITGET OFFICIAL MCP: reachable/.test(bgLine);
  assert(/BITGET OFFICIAL MCP: (reachable|UNREACHABLE on both routes)/.test(bgLine), "the Bitget status is stated, not hidden", "bitget line: " + fmt(bgLine));
  // Both routes are measured, so a "reachable" line that does not say how many endpoints answered on a
  // DIRECT connection is exactly the overstatement this disclosure exists to prevent.
  assert(!bgReachable || /direct connection/.test(bgLine), "a reachable Bitget line names the direct-route count", "bitget line: " + fmt(bgLine));
  assert(prSc && prSc.bitget && typeof prSc.bitget.reachable === "boolean", "the structured payload carries a Bitget verdict", "structured bitget: " + fmt(prSc && prSc.bitget && prSc.bitget.reachable));
  assert(prSc.bitget.reachable === bgReachable, "the structured payload agrees with the text", "text reachable: " + fmt(bgReachable) + ", structured: " + fmt(prSc.bitget.reachable));
  if (prSc.bitget.reachable) {
    assert(Number.isInteger(prSc.bitget.reachableCount) && prSc.bitget.reachableCount > 0, "reachable endpoints are counted", "reachableCount: " + fmt(prSc.bitget.reachableCount));
    assert(Number.isInteger(prSc.bitget.reachableDirectCount), "the direct-route count travels next to it", "reachableDirectCount: " + fmt(prSc.bitget.reachableDirectCount));
    assert(Boolean(prSc.bitget.measurement && prSc.bitget.measurement.summary), "what the official MCP actually returned is folded in", "measurement: " + fmt(Boolean(prSc.bitget.measurement)));
  }
  assert(/No Bitget-sourced figure/.test(prText), "it states that no Bitget figure is used", "no-figure statement missing");

  console.log("\n=== protocol hygiene ===");
  const unk = await rpc("tools/call", { name: "analogdesk_nope", arguments: {} });
  assert(unk.result && unk.result.isError === true, "an unknown tool is an isError result", "isError: " + fmt(unk.result && unk.result.isError));
  const noMethod = await rpc("tools/whatever", {});
  assert(noMethod.error && noMethod.error.code === -32601, "an unknown method returns JSON-RPC -32601", "error: " + fmt(noMethod.error));
  assert(unparsed.length === 0, "stdout carried nothing but parseable JSON-RPC", "non-JSON on stdout: " + fmt(unparsed.slice(0, 2)));
  assert(/engine ready/.test(stderrText), "diagnostics went to stderr", "stderr head: " + fmt(stderrText.slice(0, 120)));
} catch (e) {
  bad("gate threw: " + ((e && e.stack) || e));
} finally {
  try { child.stdin.end(); } catch { /* already closed */ }
  await new Promise((r) => setTimeout(r, 400));
  try { child.kill(); } catch { /* already gone */ }
}

console.log("\n" + checks + " assertions against a live MCP server process");
console.log(failures ? "\ncheck:mcp FAILED (" + failures + ")" : "\ncheck:mcp passed");
process.exit(failures ? 1 : 0);
