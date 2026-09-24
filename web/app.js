/**
 * AnalogDesk - desk UI.
 *
 * One file, no framework, no build step. It runs in two modes and says which one it is in:
 *
 *   SERVER  the page is served by server.mjs; numbers come from /api/analyze and the narrative can
 *           be LIVE (a real model call), REPLAY or TEMPLATE.
 *   BROWSER the static deployment; the full engine runs in this tab from window.__ANALOGDESK_DATA__
 *           and the narrative is REPLAY-or-TEMPLATE through the same numeric gate.
 *
 * Both modes render the same research card, so the two deployments cannot disagree about a figure.
 * Every chart here is hand-built SVG from card fields: there is no number in this UI that did not
 * come out of the engine payload.
 */

import { ALIASES } from "../src/data/universe.mjs";
import { parseIdea, mergeContext, followUpSuggestions, detectLang } from "../src/llm/lui.mjs";

/* ------------------------------ tiny helpers ------------------------------ */

const $ = (id) => document.getElementById(id);
const esc = (x) => String(x ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const isNum = (x) => x != null && Number.isFinite(Number(x));

function num(x, dp = 2) { return isNum(x) ? Number(x).toFixed(dp) : "\u2013"; }
function f(x, dp = 2) { return isNum(x) ? Number(x).toFixed(dp) : "\u2013"; }
/** Signed percentage, colour-coded. Input is already in percentage points. */
function pc(x, dp = 2) {
  if (!isNum(x)) return { text: "\u2013", cls: "" };
  const v = Number(x);
  return { text: `${v > 0 ? "+" : ""}${v.toFixed(dp)}%`, cls: v > 0 ? "pos" : v < 0 ? "neg" : "" };
}
function pcHtml(x, dp = 2) { const p = pc(x, dp); return `<span class="${p.cls}">${esc(p.text)}</span>`; }
function pctPlain(x, dp = 1) { return isNum(x) ? `${Number(x).toFixed(dp)}%` : "\u2013"; }

function stat(k, v, n = "", cls = "") {
  return `<div class="stat"><div class="k">${esc(k)}</div><div class="v ${cls}">${v}</div>${n ? `<div class="n">${esc(n)}</div>` : ""}</div>`;
}
function kv(rows) {
  return `<dl class="kv">${rows.filter(Boolean).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join("")}</dl>`;
}
function badge(cls, text, title = "") {
  return `<span class="badge ${cls}"${title ? ` title="${esc(title)}"` : ""}>${esc(text)}</span>`;
}
function toast(msg, kind = "bad", ms = 7000) {
  let el = $("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.style.cssText = "position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:99;max-width:min(760px,92vw);" +
      "padding:10px 15px;border-radius:8px;font-size:13px;border:1px solid var(--line);background:var(--panel);box-shadow:0 8px 30px rgba(0,0,0,.5)";
    document.body.appendChild(el);
  }
  el.className = `note ${kind}`;
  el.style.margin = "0";
  el.innerHTML = esc(msg);
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, ms);
}

/* --------------------------------- SVG ---------------------------------- */

function svgEl(w, h, inner) {
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" role="img">${inner}</svg>`;
}
function niceStep(range, target) {
  const raw = range / Math.max(1, target);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 2.5, 5, 10]) if (raw <= m * mag) return m * mag;
  return 10 * mag;
}
function ticks(lo, hi, target = 5) {
  if (!(hi > lo)) return [lo];
  const step = niceStep(hi - lo, target);
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Number(v.toFixed(10)));
  return out;
}

/** Histogram of the analog forward-return sample, in percentage points. */
function histogramSvg(bins, { height = 210, marks = [], xLabel = "forward return (%)" } = {}) {
  const W = 860, H = height, padL = 42, padR = 14, padT = 12, padB = 34;
  if (!bins || !bins.length) return `<div class="chart"><p class="small">No analog outcomes for this query.</p></div>`;
  const iw = W - padL - padR, ih = H - padT - padB;
  const xs = bins.map((b) => b.midpointPct);
  const half = bins.length > 1 ? Math.abs(xs[1] - xs[0]) / 2 : 1;
  const mk = marks.map((m) => m.x).filter(isNum);
  const bandMarks = marks.filter((m) => m.band);
  for (const m of bandMarks) { if (isNum(m.band.lo)) mk.push(m.band.lo); if (isNum(m.band.hi)) mk.push(m.band.hi); }
  const xLo = Math.min(xs[0] - half, ...mk);
  const xHi = Math.max(xs[xs.length - 1] + half, ...mk);
  const yHi = Math.max(...bins.map((b) => b.sharePct)) * 1.12 || 1;
  const sx = (v) => padL + ((v - xLo) / (xHi - xLo || 1)) * iw;
  const sy = (v) => padT + ih - (v / yHi) * ih;
  const bw = Math.max(1.2, (iw / bins.length) - 1.4);
  let g = "";
  for (const t of ticks(0, yHi, 4)) {
    g += `<line class="axis-line" x1="${padL}" y1="${sy(t).toFixed(1)}" x2="${W - padR}" y2="${sy(t).toFixed(1)}"/>`;
    g += `<text class="tick" x="${padL - 6}" y="${(sy(t) + 3).toFixed(1)}" text-anchor="end">${t.toFixed(t < 10 ? 1 : 0)}%</text>`;
  }
  for (const m of bandMarks) {
    g += `<rect class="conformal-band" x="${sx(m.band.lo).toFixed(1)}" y="${padT}" width="${Math.max(1, sx(m.band.hi) - sx(m.band.lo)).toFixed(1)}" height="${ih}"/>`;
  }
  for (const b of bins) {
    const x = sx(b.midpointPct) - bw / 2, y = sy(b.sharePct), h = Math.max(0, padT + ih - y);
    g += `<rect class="${b.midpointPct >= 0 ? "bar-pos" : "bar-neg"}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}"><title>${num(b.midpointPct)}% : ${num(b.sharePct, 1)}% of analogs</title></rect>`;
  }
  g += `<line class="axis-zero" x1="${sx(0).toFixed(1)}" y1="${padT}" x2="${sx(0).toFixed(1)}" y2="${padT + ih}"/>`;
  for (const m of marks.filter((x) => !x.band)) {
    if (!isNum(m.x)) continue;
    g += `<line class="${m.cls || "conformal-mark"}" x1="${sx(m.x).toFixed(1)}" y1="${padT}" x2="${sx(m.x).toFixed(1)}" y2="${padT + ih}"/>`;
    g += `<text class="tick" x="${(sx(m.x) + 3).toFixed(1)}" y="${padT + 9}" fill="${m.color || "#d29922"}">${esc(m.label || "")}</text>`;
  }
  for (const t of ticks(xLo, xHi, 7)) {
    g += `<text class="tick" x="${sx(t).toFixed(1)}" y="${H - padB + 15}" text-anchor="middle">${t.toFixed(Math.abs(xHi - xLo) < 12 ? 1 : 0)}%</text>`;
  }
  g += `<text class="tick" x="${padL + iw / 2}" y="${H - 5}" text-anchor="middle">${esc(xLabel)}</text>`;
  return `<div class="chart">${svgEl(W, H, g)}</div>`;
}

/**
 * Path fan: percentiles of the analog path at each session ahead, re-based to the query close.
 * `unit: "frac"` for engine output (fractions), `"pct"` for the card's stress fan (already in %).
 */
function fanSvg(fan, { height = 250, conformal = null, unit = "frac", label = "sessions ahead" } = {}) {
  const W = 860, H = height, padL = 48, padR = 16, padT = 16, padB = 34;
  const rows = (fan || []).filter((r) => r && (isNum(r.p50) || isNum(r.p50Pct)));
  if (rows.length < 2) return `<div class="chart"><p class="small">Path fan unavailable for this query.</p></div>`;
  const k = unit === "pct" ? 1 : 100;
  const g2 = (r, a, b) => { const v = r[a] != null ? r[a] : r[b]; return isNum(v) ? Number(v) * k : null; };
  const iw = W - padL - padR, ih = H - padT - padB;
  const pts = [{ t: 0, p10: 0, p25: 0, p50: 0, p75: 0, p90: 0 }, ...rows.map((r) => ({
    t: r.t ?? r.session, p10: g2(r, "p10", "p10Pct"), p25: g2(r, "p25", "p25Pct"),
    p50: g2(r, "p50", "p50Pct"), p75: g2(r, "p75", "p75Pct"), p90: g2(r, "p90", "p90Pct")
  }))];
  const tMax = pts[pts.length - 1].t || 1;
  const allP = pts.flatMap((p) => [p.p10, p.p90].filter(isNum));
  let yLo = Math.min(0, ...allP), yHi = Math.max(0, ...allP);
  if (conformal && isNum(conformal.lowerPct)) { yLo = Math.min(yLo, conformal.lowerPct); yHi = Math.max(yHi, conformal.upperPct); }
  const padY = (yHi - yLo) * 0.08 || 1; yLo -= padY; yHi += padY;
  const sx = (t) => padL + (t / tMax) * iw;
  const sy = (v) => padT + ih - ((v - yLo) / (yHi - yLo || 1)) * ih;
  const band = (hi, lo) => `${pts.map((p) => `${sx(p.t).toFixed(1)},${sy(p[hi] ?? 0).toFixed(1)}`).join(" ")} ${pts.slice().reverse().map((p) => `${sx(p.t).toFixed(1)},${sy(p[lo] ?? 0).toFixed(1)}`).join(" ")}`;
  let g = "";
  for (const t of ticks(yLo, yHi, 5)) {
    g += `<line class="axis-line" x1="${padL}" y1="${sy(t).toFixed(1)}" x2="${W - padR}" y2="${sy(t).toFixed(1)}"/>`;
    g += `<text class="tick" x="${padL - 6}" y="${(sy(t) + 3).toFixed(1)}" text-anchor="end">${t.toFixed(Math.abs(yHi - yLo) < 12 ? 1 : 0)}%</text>`;
  }
  if (conformal && isNum(conformal.lowerPct)) {
    const x = sx(tMax);
    g += `<rect class="conformal-band" x="${(x - 9).toFixed(1)}" y="${sy(conformal.upperPct).toFixed(1)}" width="9" height="${Math.max(1, sy(conformal.lowerPct) - sy(conformal.upperPct)).toFixed(1)}"/>`;
    g += `<line class="conformal-mark" x1="${padL}" y1="${sy(conformal.upperPct).toFixed(1)}" x2="${x.toFixed(1)}" y2="${sy(conformal.upperPct).toFixed(1)}"/>`;
    g += `<line class="conformal-mark" x1="${padL}" y1="${sy(conformal.lowerPct).toFixed(1)}" x2="${x.toFixed(1)}" y2="${sy(conformal.lowerPct).toFixed(1)}"/>`;
    g += `<text class="tick" x="${(x - 12).toFixed(1)}" y="${(sy(conformal.upperPct) - 4).toFixed(1)}" text-anchor="end" fill="#d29922">conformal ${pctPlain(conformal.coverageTargetPct, 0)}</text>`;
  }
  g += `<polygon class="fan-band-outer" points="${band("p90", "p10")}"/>`;
  g += `<polygon class="fan-band-inner" points="${band("p75", "p25")}"/>`;
  g += `<line class="fan-zero" x1="${padL}" y1="${sy(0).toFixed(1)}" x2="${W - padR}" y2="${sy(0).toFixed(1)}"/>`;
  g += `<polyline class="fan-median" points="${pts.map((p) => `${sx(p.t).toFixed(1)},${sy(p.p50 ?? 0).toFixed(1)}`).join(" ")}"/>`;
  for (const p of pts.slice(1)) g += `<circle cx="${sx(p.t).toFixed(1)}" cy="${sy(p.p50 ?? 0).toFixed(1)}" r="1.8" fill="#58a6ff"><title>t+${p.t}: median ${num(p.p50)}%, p10 ${num(p.p10)}%, p90 ${num(p.p90)}%</title></circle>`;
  for (const t of ticks(0, tMax, 8)) {
    if (t < 0 || t > tMax) continue;
    g += `<text class="tick" x="${sx(t).toFixed(1)}" y="${H - padB + 15}" text-anchor="middle">${Math.round(t)}</text>`;
  }
  g += `<text class="tick" x="${padL + iw / 2}" y="${H - 5}" text-anchor="middle">${esc(label)}</text>`
    + `<text class="tick" x="${padL + 4}" y="${padT - 4}" fill="#58a6ff">p10 / p25 / median / p75 / p90 of the analog paths</text>`;
  return `<div class="chart">${svgEl(W, H, g)}</div>`;
}

/** Horizontal bars: drawdown-breach probabilities, scenario deltas, analog counts. */
function barsSvg(rows, { unit = "%", vMax = null, diverging = false } = {}) {
  const items = rows.filter((r) => isNum(r.value));
  if (!items.length) return `<div class="chart"><p class="small">Nothing to plot.</p></div>`;
  const rowH = 22, padL = 182, padR = 62, padT = 8;
  const W = 860, H = padT * 2 + items.length * rowH;
  const iw = W - padL - padR;
  const mx = vMax != null ? vMax : (Math.max(...items.map((r) => Math.abs(Number(r.value)))) * 1.08 || 1);
  const zeroX = diverging ? padL + iw / 2 : padL;
  const halfW = diverging ? iw / 2 : iw;
  let g = `<line class="axis-line" x1="${zeroX}" y1="${padT}" x2="${zeroX}" y2="${H - padT}"/>`;
  items.forEach((r, i) => {
    const y = padT + i * rowH, v = Number(r.value);
    const w = Math.max(1, (Math.abs(v) / (mx || 1)) * halfW);
    const x = diverging ? (v < 0 ? zeroX - w : zeroX) : zeroX;
    const col = r.color || (v < 0 ? "#f85149" : "#3fb950");
    const tx = diverging && v < 0 ? x - 5 : x + w + 5;
    g += `<text class="tick" x="${padL - 8}" y="${y + 13}" text-anchor="end" fill="#9fb0c0" style="font-size:10.5px">${esc(r.label)}</text>`;
    g += `<rect x="${x.toFixed(1)}" y="${y + 3}" width="${w.toFixed(1)}" height="${rowH - 8}" rx="2" fill="${col}" opacity="0.72"><title>${esc(r.label)}: ${num(v)}${esc(unit)}</title></rect>`;
    g += `<text class="tick" x="${tx.toFixed(1)}" y="${y + 13}" text-anchor="${diverging && v < 0 ? "end" : "start"}" fill="#e6edf3" style="font-size:10.5px">${num(v)}${esc(unit)}</text>`;
  });
  return `<div class="chart">${svgEl(W, H, g)}</div>`;
}

/** Diverging z-score bar, clipped at the engine's +/-3 sigma winsorisation. */
function zBar(z, width = 92) {
  if (!isNum(z)) return `<span class="muted">\u2013</span>`;
  const v = Math.max(-3, Math.min(3, Number(z)));
  const p = (Math.abs(v) / 3) * 50;
  const left = v < 0 ? 50 - p : 50;
  return `<span style="position:relative;display:inline-block;width:${width}px;height:9px;background:var(--panel-2);border-radius:2px;vertical-align:middle">`
    + `<span style="position:absolute;left:50%;top:0;bottom:0;width:1px;background:var(--line)"></span>`
    + `<span style="position:absolute;left:${left}%;top:0;bottom:0;width:${p}%;background:${v < 0 ? "#f85149" : "#3fb950"};border-radius:2px"></span></span>`;
}

/* ------------------------------ NL parsing ------------------------------- */

/**
 * The parser is NOT in this file. It lives in src/llm/lui.mjs and is shared by the browser UI, the
 * HTTP API (server.mjs) and the MCP tool server (mcp-server.mjs), because a desk that understands a
 * sentence differently depending on which door you came in through is not a language interface - it is
 * three guesses wearing one label. scripts/check-lui.mjs is its contract: a table of
 * Chinese and English sentences, each with the exact interpretation the desk promises.
 *
 * What this file adds is only the adaptation to the controls: a field the sentence did not mention
 * falls back to the dropdown, and a partial follow-up inherits the previous request.
 */
function parseQuery(text, lib) { return parseIdea(text, lib || S.lib || {}); }

const SECTION_HEADINGS = [
  { key: "verdict", en: "Verdict", zh: "结论" },
  { key: "state", en: "Why these analogs", zh: "为什么是这些类比" },
  { key: "history", en: "What happened next", zh: "随后发生了什么" },
  { key: "tails", en: "Path risk, not just endpoint", zh: "路径风险，而不只是终点" },
  { key: "stress", en: "Stress scenarios", zh: "压力情景" },
  { key: "reasoning", en: "Which scenarios matter for this idea", zh: "哪些情景对这个想法真正重要" },
  { key: "limits", en: "What this does not tell you", zh: "这份分析没有告诉你什么" }
];

/* -------------------------------- runtimes ------------------------------- */

function apiRuntime() {
  const get = async (path) => {
    const r = await fetch(path, { headers: { Accept: "application/json" } });
    if (!r.ok) {
      let detail = "";
      try { detail = (await r.json())?.error || ""; } catch { /* not json */ }
      throw new Error(detail || `${path} -> HTTP ${r.status}`);
    }
    return r.json();
  };
  return {
    kind: "SERVER",
    async init() {
      const [lib, health, prov, scen] = await Promise.all([
        get("/api/library"), get("/api/health").catch(() => null),
        get("/api/provenance").catch(() => null), get("/api/scenarios").catch(() => null)
      ]);
      const l = { ...lib.library, horizons: lib.library.horizons || [1, 5, 10, 20, 40, 60], scenarios: scen?.scenarios || lib.library.scenarios || null };
      return { library: l, health, provenance: prov?.provenance || null, bitget: prov?.provenance?.bitget || null, wrapper: prov?.provenance?.wrapper || null };
    },
    async analyze(p) {
      const q = new URLSearchParams({ symbol: p.symbol, date: p.date || "latest", horizon: String(p.horizon), k: String(p.k), language: p.language || "auto" });
      if (p.question) q.set("question", p.question);
      if (p.includeStress === false) q.set("stress", "0");
      if (p.riskTolerancePct) q.set("risk", String(p.riskTolerancePct));
      return get(`/api/analyze?${q}`);
    },
    async bitget() { try { return (await get("/api/bitget-probe")).bitget; } catch { return null; } }
  };
}

function browserRuntime(mods) {
  const { createDesk } = mods.desk;
  const { renderTemplate } = mods.template;
  const { buildAllowlist, verifyNumbers, defaultAllowance } = mods.verify;
  const { MemoryStore, cardDigest } = mods.replay;
  let desk = null, store = null;

  /** REPLAY-then-TEMPLATE through the same numeric gate the server applies. Never invents a figure. */
  function narrateBrowser(card, question, language) {
    const lang = language && language !== "auto" ? language : detectLang(question);
    // Same helper the server uses, so the static build and server.mjs apply an identical gate.
    const allow = buildAllowlist(card, defaultAllowance(card));
    // Same key the server computes: provenance, clocks and timings are stripped inside cardDigest,
    // and the model is not part of it, so a record warmed with an API key is found here too.
    const id = cardDigest(card, { promptVersion: mods.PROMPT_VERSION || "1", language: lang });
    const warnings = [];
    const finish = (text, mode, model, extra = {}) => {
      const check = verifyNumbers(text, allow);
      if (!check.ok) warnings.push(`numeric gate rejected ${check.unsupportedCount} of ${check.total} numerals`);
      const keys = [...String(text).matchAll(/^\[([a-z]+)\]\s*$/gm)].map((x) => x[1]);
      const parts = String(text).split(/^\[[a-z]+\]\s*$/m);
      const sections = Object.fromEntries(keys.map((k, i) => [k, (parts[i + 1] || "").trim()]));
      return { text, sections, order: keys, mode, model: model || null, cardId: id, checks: { primary: check }, warnings, ...extra };
    };
    const rec = store?.map?.get(id);
    if (rec?.text) {
      const c = verifyNumbers(rec.text, allow);
      if (c.ok) return finish(rec.text, "REPLAY", rec.model, { storedAt: rec.storedAt });
      warnings.push("cached generation failed the numeric gate; using TEMPLATE");
    } else if (store) {
      warnings.push("no cached generation for this exact research card; using TEMPLATE (no API key is needed or used in the static build)");
    }
    return finish(renderTemplate(card, { language: lang }).text, "TEMPLATE", null, { warnings });
  }

  return {
    kind: "BROWSER",
    async init() {
      const t0 = performance.now();
      store = new MemoryStore(mods.replaySeed || {});
      desk = createDesk({
        dataset: mods.dataset, validationResults: mods.validationResults || null,
        provenance: mods.provenance || {}, config: mods.config || {},
        // Same committed measurement server.mjs loads from data-cache/wrapper-probe.json. If the two
        // runtimes disagreed here, the card would hash differently in the browser and every warmed
        // replay record would miss - the exact bug class scripts/check-replay.mjs exists to catch.
        wrapper: mods.wrapper || null,
        // The primary venue for the 7x24 layer, baked into the bundle for the same reason as the
        // Gate.io measurement: the static package makes no network call after load, and the browser
        // card has to hash identically to the server card or every warmed replay record would miss.
        bitget7x24: mods.bitget7x24 || null
      });
      const lib = desk.library();
      const full = { ...lib, horizons: desk.horizons, scenarios: desk.scenarios };
      return {
        library: full,
        health: {
          ok: true, engineInitMs: Math.round(performance.now() - t0),
          llm: { mode: "REPLAY/TEMPLATE", keyPresent: false, model: null },
          library: { symbols: lib.symbols.length, sessions: lib.sessions, from: lib.from, to: lib.to },
          validationHorizons: Object.keys(desk.allValidation() || {}).map(Number)
        },
        provenance: mods.provenance || null,
        bitget: (mods.provenance || {}).bitget || null,
        wrapper: desk.wrapper()
      };
    },
    async analyze(p) {
      const t0 = performance.now();
      const language = p.language && p.language !== "auto" ? p.language : detectLang(p.question || "");
      const a = desk.analyze({ symbol: p.symbol, date: p.date || "latest", horizon: p.horizon, k: p.k,
        includeStress: p.includeStress !== false, riskTolerancePct: p.riskTolerancePct || null });
      const prov = mods.provenance || {};
      a.card.provenance = { ...(a.card.provenance || {}), ...prov,
        bitget: prov.bitget || { reachable: false, summary: "not probed in the static build", endpoints: [], disclosure: prov.bitgetDisclosure || null },
        llm: { mode: "REPLAY/TEMPLATE", model: null, keyPresent: false, baseUrl: prov.llmBaseUrl || "https://hackathon.bitgetops.com/v1" },
        excludedFromDistance: prov.excludedFromDistance || ["dv20z", "fng", "hyChg20"] };
      const narrative = narrateBrowser(a.card, p.question || "", language);
      return { ok: true, question: p.question || "", language, card: a.card, detail: a.detail, narrative, wallMs: Math.round(performance.now() - t0) };
    },
    async bitget() { return (mods.provenance || {}).bitget || null; }
  };
}

/* --------------------------------- state --------------------------------- */

const S = { rt: null, boot: null, lib: null, last: null, lastParsed: null, busy: false, tab: "brief", started: false };

/* ------------------------------- chrome ---------------------------------- */

function setBadges() {
  const h = S.boot?.health;
  const isBrowser = S.rt.kind === "BROWSER";
  const br = $("badge-runtime");
  br.textContent = `runtime: ${isBrowser ? "in-browser engine" : "local server"}`;
  br.className = `badge ${isBrowser ? "info" : "ok"}`;
  br.title = isBrowser
    ? "The full retrieval, conformal calibration and stress engine is executing in this browser tab from the bundled analog library. No server and no API key."
    : "server.mjs runs the engine in Node; this page calls /api/analyze.";

  const llmMode = h?.llm?.mode || (isBrowser ? "REPLAY/TEMPLATE" : "TEMPLATE");
  const bm = $("badge-mode");
  bm.textContent = `narrative: ${llmMode}`;
  bm.className = `badge ${llmMode === "LIVE" ? "ok" : llmMode === "REPLAY" ? "info" : "warn"}`;
  bm.title = "How the prose was produced. TEMPLATE and REPLAY need no API key. Every figure is engine-computed in all three modes and re-checked against the research card.";

  const l = S.lib;
  const bl = $("badge-lib");
  bl.textContent = `library: ${l.symbols.length} x ${l.sessions}`;
  bl.className = "badge ok";
  bl.title = `${l.symbols.length} instruments, ${l.sessions} sessions, ${l.from} .. ${l.to}${h?.engineInitMs != null ? ` - engine ready in ${h.engineInitMs} ms` : ""}`;

  // One badge used to say "bitget mcp: unreachable", which read as "this project has no Bitget
  // integration". It has two, with opposite results on this network, and the badge now says both:
  // the market-data MCP resets at the TCP layer, while the Bitget-operated hackathon LLM gateway the
  // narrative layer calls is reachable. Collapsing them either way would misstate the integration.
  const bg = S.boot?.bitget || S.boot?.provenance?.bitget;
  const bb = $("badge-bitget");
  const narr = bg?.narrative;
  if (bg && bg.summary) {
    const md = bg.marketData?.reachable ?? bg.reachable;
    const gw = narr?.reachable ?? false;
    // The route is part of the claim, not a detail. A bare "reachable" would let a reviewer on a
    // plain network expect an answer this machine only obtains through a local proxy, and a bare
    // "unreachable" would understate an integration that does answer. So the badge names the route
    // whenever the direct connection was not what produced it, and the tooltip carries both counts.
    const direct = bg.marketData?.reachableDirectCount ?? bg.reachableDirectCount ?? null;
    const total = bg.marketData?.total ?? bg.total ?? null;
    const via = bg.proxy ? `${bg.proxy.host}:${bg.proxy.port}` : null;
    const routed = md && direct != null && total != null && direct < total;
    const routeNote = routed ? ` via ${via || "proxy"}` : "";
    bb.textContent = `bitget: data ${md ? "reachable" + routeNote : "unreachable"} \u00b7 gateway ${gw ? "reachable" : "unreachable"}`;
    bb.className = `badge ${md ? "ok" : gw ? "warn" : "bad"}`;
    bb.title = routed
      ? `${direct}/${total} Bitget market-data hosts answer on a direct connection; ${bg.marketData?.reachableCount ?? bg.reachableCount}/${total} answer through the local proxy at ${via}. \u2014 \u2014 ${bg.summary}`
      : bg.summary;
  } else {
    bb.textContent = "bitget: not probed";
    bb.className = "badge warn";
    bb.title = "Run node scripts/probe-network.mjs, or /api/bitget-probe on the server deployment.";
  }
}

function fillControls() {
  const l = S.lib;
  const groups = new Map();
  for (const s of l.symbols) {
    const g = s.etf ? "ETF / index" : (s.sector || "Other");
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(s);
  }
  const order = [...groups.keys()].sort((a, b) => (a === "ETF / index" ? 1 : b === "ETF / index" ? -1 : a.localeCompare(b)));
  $("symbol").innerHTML = order.map((g) => `<optgroup label="${esc(g)}">${groups.get(g).sort((a, b) => a.symbol.localeCompare(b.symbol))
    .map((s) => `<option value="${esc(s.symbol)}">${esc(s.symbol)} \u00b7 ${esc(s.name)}</option>`).join("")}</optgroup>`).join("");
  $("symbol").value = [...$("symbol").options].some((o) => o.value === "NVDA") ? "NVDA" : l.symbols[0].symbol;
  $("horizon").innerHTML = (l.horizons || [1, 5, 10, 20, 40, 60]).map((h) =>
    `<option value="${h}"${h === 5 ? " selected" : ""}>${h} session${h === 1 ? "" : "s"}${h === 5 ? " \u00b7 1 week" : h === 20 ? " \u00b7 1 month" : h === 10 ? " \u00b7 2 weeks" : ""}</option>`).join("");
  $("date").min = l.from; $("date").max = l.to; $("date").value = "";
  $("date").title = `Empty = latest session (${l.to})`;
  $("k").value = 50;
}

const EXAMPLES = [
  { label: "NVDA \u00b7 one week", q: "NVDA \u73b0\u5728\u8fd9\u4e2a\u4f4d\u7f6e\u8fdb\u573a\uff0c\u672a\u6765\u4e00\u5468\u5386\u53f2\u4e0a\u76f8\u4f3c\u7684\u8d70\u52bf\u662f\u4ec0\u4e48\u6837\u7684\uff1f" },
  { label: "BABA \u00b7 into earnings", q: "Should I buy BABA into earnings this week? What did similar states do next?" },
  { label: "TSLA \u00b7 one month", q: "\u7279\u65af\u62c9\u672a\u6765\u4e00\u4e2a\u6708\uff0c\u7c7b\u6bd4\u5386\u53f2\u4e0a\u76f8\u4f3c\u72b6\u6001\u7684\u5206\u5e03\uff0c\u6700\u5927\u56de\u64a4\u6709\u591a\u6df1\uff1f" },
  { label: "KWEB \u00b7 tariff window", q: "KWEB over the next 10 sessions, stress-tested against the 2025 tariff shock" },
  { label: "SPY \u00b7 2020-03-16", q: "What does the analog set say about SPY as of 2020-03-16 over 5 sessions?" },
  { label: "QQQ \u00b7 vol spike", q: "QQQ next week if volatility spikes two sigma - how un-holdable does the path get?" }
];

function fillChips() {
  $("chips").innerHTML = EXAMPLES.map((e, i) => `<button class="chip" data-i="${i}" title="${esc(e.q)}">${esc(e.label)}</button>`).join("");
  $("chips").querySelectorAll(".chip").forEach((b) => b.addEventListener("click", () => {
    $("q").value = EXAMPLES[Number(b.dataset.i)].q; run();
  }));
}

function tabs() {
  $("tabs").querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => show(b.dataset.tab)));
  show("brief");
}
function show(name) {
  S.tab = name;
  $("tabs").querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.id === `panel-${name}`));
}

/* ------------------------------ result views ----------------------------- */

function kpi(k, v, n = "", cls = "") {
  return `<div class="kpi"><div class="k">${esc(k)}</div><div class="v ${cls}">${v}</div>${n ? `<div class="n">${esc(n)}</div>` : ""}</div>`;
}

function renderCardbar(card, detail) {
  const i = card.idea, d = card.distribution, c = card.conformal, e = card.excursion, w = card.wrapper;
  const med = pc(d?.medianPct), p10 = pc(d?.p10Pct), p90 = pc(d?.p90Pct);
  $("cardbar").innerHTML = `
    <div class="headline">
      <h2>${esc(i.name)} <span class="dim mono" style="font-size:14px">${esc(i.symbol)}</span></h2>
      <div class="meta">as of ${esc(i.asOfSession)} &middot; adj close ${f(i.referenceClose, 4)} &middot; raw close ${f(i.referenceCloseRaw, 4)} &middot; ${esc(i.horizonLabel)} &middot; ${d?.n ?? 0} analogs &middot; retrieval ${num(detail?.timing?.retrievalMs, 0)} ms</div>
    </div>
    ${kpi("median fwd", `<span class="${med.cls}">${esc(med.text)}</span>`, i.horizonLabel)}
    ${kpi("middle 80%", `${esc(p10.text)} / ${esc(p90.text)}`, "raw p10 to p90")}
    ${c ? kpi(`conformal ${pctPlain(c.coverageTargetPct, 0)}`, `${esc(pc(c.lowerPct).text)} / ${esc(pc(c.upperPct).text)}`, `width ${pctPlain(c.widthPct)}`) : ""}
    ${kpi("P(below start)", pctPlain(d?.probabilityBelowZeroPct), `${d?.n ?? 0} episodes`)}
    ${kpi("P(loss > 10%)", pctPlain(d?.probabilityBelow?.minus10Pct), "at the endpoint", (d?.probabilityBelow?.minus10Pct ?? 0) > 20 ? "neg" : "")}
    ${e ? kpi("median MAE", esc(pc(e.maxAdverseMedianPct).text), "worst intra-path print", "neg") : ""}
    ${w?.sevenByTwentyFour?.closedMoveSharePct != null
      ? kpi("moved while cash shut", pctPlain(w.sevenByTwentyFour.closedMoveSharePct), `${esc(w.instrument || "")} wrapper`, "neg")
      : (w?.referenceMarket?.closedSharePct != null ? kpi("week cash-shut", pctPlain(w.referenceMarket.closedSharePct), "reference market, no verified wrapper") : "")}`;
}

function renderNarrative(narr) {
  const box = $("narrative");
  if (!narr) { box.innerHTML = `<p class="small">No narrative returned by this deployment.</p>`; return; }
  const zh = detectLang(narr.text || "") === "zh";
  const gate = narr.checks?.primary;
  const modeCls = narr.mode === "LIVE" ? "ok" : narr.mode === "REPLAY" ? "info" : "warn";
  const traced = gate ? gate.total - (gate.unsupportedCount || 0) : null;
  const bits = [
    badge(modeCls, `mode: ${narr.mode}`, "LIVE = a real model call, REPLAY = a stored generation for this exact research card, TEMPLATE = the deterministic renderer."),
    narr.model ? badge("", `model: ${narr.model}`) : null,
    gate ? badge(gate.ok ? "ok" : "bad", `numeric gate: ${traced}/${gate.total} numerals traced to the card`,
      "Every numeral in the prose must appear in the engine research card. A draft that cites anything else is rejected after one corrective retry and the template is shown instead.") : null,
    isNum(narr.latencyMs) ? badge("", `${Math.round(narr.latencyMs)} ms model latency`) : null,
    narr.cardId ? badge("", `card ${narr.cardId}`, "Digest of the exact research card this prose was generated from.") : null
  ].filter(Boolean).join("");
  const warns = (narr.warnings || []).map((w) => `<div class="note">${esc(w)}</div>`).join("");
  const body = SECTION_HEADINGS.map((s, idx) => {
    const t = narr.sections?.[s.key];
    if (!t) return "";
    return `<div class="nsection${s.key === "limits" ? " limits" : ""}"><h4><span class="idx">${idx + 1}</span>${esc(zh ? s.zh : s.en)}</h4><div class="body">${esc(t)}</div></div>`;
  }).join("");
  box.innerHTML = `<div class="modebar">${bits}<button id="copy-narr" style="margin-left:auto;padding:4px 10px;font-size:11.5px">${zh ? "\u590d\u5236\u5168\u6587" : "Copy"}</button></div>${warns}${body || `<div class="nsection"><div class="body">${esc(narr.text || "")}</div></div>`}`;
  $("copy-narr")?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(narr.text || "");
      toast(zh ? "\u5df2\u590d\u5236\u5230\u526a\u8d34\u677f" : "Copied to clipboard", "info", 2200);
    } catch { toast("Clipboard blocked by the browser - select the text manually.", "info"); }
  });
}

function renderState(card) {
  const cs = card.currentState || {};
  const notable = cs.notable || [];
  const rows = notable.map((x) => {
    const v = Number(x.value);
    return `<tr><td>${esc(x.label)}<div class="muted mono" style="font-size:10px">${esc(x.feature)} &middot; ${esc(x.unit)}</div></td>
      <td class="num">${isNum(v) ? f(v, Math.abs(v) < 10 ? 3 : 2) : "\u2013"}</td>
      <td class="num">${num(x.z, 2)}</td><td style="width:100px">${zBar(x.z)}</td></tr>`;
  }).join("");
  const groups = (cs.groups || []).map((g) => `<span class="tag" title="${esc((g.features || []).join(", "))}">${esc(g.group)} ${g.weightPct}%</span>`).join("");
  const excluded = card.provenance?.excludedFromDistance || ["dv20z", "fng", "hyChg20"];
  $("state").innerHTML = `
    <p class="small" style="margin-bottom:8px">Features ranked by |z| against the point-in-time distribution of the whole library. z is winsorised at &plusmn;3&sigma; and built from an expanding window, so a z-score means the same thing in 2017 and in 2026.</p>
    <div class="scroll" style="max-height:300px"><table><thead><tr><th>feature</th><th class="num">value</th><th class="num">z</th><th>direction</th></tr></thead><tbody>${rows || `<tr><td colspan="4" class="small">No notable features.</td></tr>`}</tbody></table></div>
    <div style="margin-top:9px">${groups}</div>
    <p class="small" style="margin-top:8px">Carried for display but <b>excluded from the distance metric</b>: <code>${esc(excluded.join(", "))}</code>. Each group keeps its full weight, redistributed over that group's usable features, and features missing on either side are dropped with the distance renormalised - a candidate is never rewarded for having holes.</p>`;
}

/**
 * Disclose every adjustment the desk made to the request before it ran.
 *
 * A snapped horizon or a clamped k does not make the card wrong - the numbers are exactly what the
 * engine computed - but it does change what they describe, because the frozen conformal scale and
 * every published out-of-sample figure belong to k=50. That has to sit on screen next to the result,
 * not only in the JSON payload where a reviewer will never look for it.
 */
function renderRequestNotes(card) {
  const box = $("request-notes");
  const notes = card?.retrieval?.notes || [];
  if (!notes.length) { box.hidden = true; box.innerHTML = ""; return; }
  box.innerHTML = `<b>This request was adjusted before it ran</b><ul>${notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>`;
  box.hidden = false;
}
/**
 * The stated-constraint panel, and the only personalisation this desk does: the person asking said
 * how much drawdown they can hold, and the card answers that question out of the same analog sample
 * as everything else on it. Nothing is inferred about the user, nothing is remembered between
 * requests, and the panel is absent entirely when no tolerance was stated - a default card looks
 * exactly like it did before this existed.
 */
function renderPersonal(card) {
  const box = $("personal");
  const pz = card && card.personalization;
  if (!pz) { box.innerHTML = ""; return; }
  const breach = pz.breachedSharePct;
  const cls = breach == null ? "" : breach >= 50 ? "bad" : "info";
  box.innerHTML = `
    <h3>Your stated constraint</h3>
    <div class="note ${cls}" style="margin:0">
      ${kv([
        ["you said you can hold", `${num(pz.tolerancePct, 0)}% drawdown`],
        ["measured on", `${num(pz.measuredOn, 0)} analog paths over ${esc(card.idea.horizonLabel)}`],
        ["traded through that level", `${pctPlain(breach)} <span class="muted">(${num(pz.breachedCount, 0)} of ${num(pz.measuredOn, 0)})</span>`],
        ["never went that far", pctPlain(pz.heldSharePct)]
      ])}
      <p class="verdict">${esc(pz.verdict)}</p>
      <p class="small" style="margin-top:8px;margin-bottom:0">${esc(pz.caveat)}</p>
    </div>`;
}

/**
 * The next four questions, phrased so the shared parser understands them, offered as chips. Every
 * suggestion this generates is asserted by scripts/check-lui.mjs to parse back into a real request,
 * so a chip can never offer a sentence the desk would then fail on.
 */
function renderFollowups(card, p) {
  const box = $("followups");
  if (!card || !p) { box.hidden = true; box.innerHTML = ""; return; }
  const zh = (p.language || "en") === "zh";
  const sym = card.idea ? card.idea.symbol : null;
  const bench = S.lib && S.lib.benchSym;
  const sug = followUpSuggestions(
    { symbol: sym, horizon: card.idea ? card.idea.horizonSessions : null, riskTolerancePct: p.riskTolerancePct },
    { language: zh ? "zh" : "en", horizons: (S.lib && S.lib.horizons) || null,
      fallbackSymbol: bench || "SPY", alternateSymbol: bench && bench !== sym ? bench : null });
  if (!sug.length) { box.hidden = true; box.innerHTML = ""; return; }
  box.innerHTML = `<span class="lbl">${zh ? "接着问" : "ask next"}</span>`
    + sug.map((s, i) => `<button type="button" data-i="${i}" title="${esc(s.q)}">${esc(s.label)}</button>`).join("");
  box.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
    const s = sug[Number(b.dataset.i)];
    if (!s) return;
    $("q").value = s.q;
    showParsed(readParams(true));
    run();
  }));
  box.hidden = false;
}


function renderConformal(card) {
  const c = card.conformal, d = card.distribution;
  const box = $("conformal");
  if (!c) {
    // Two different causes, and they call for different fixes: either no scale was ever fitted for
    // this horizon, or this particular query retrieved too few completed outcomes to spread one over.
    const n = d?.n ?? 0;
    box.innerHTML = n < 10
      ? `<div class="note">Only ${num(n, 0)} completed analog outcomes behind this card, and the interval needs at least 10 to have a spread worth calibrating. Widen the neighbour count, lengthen the horizon, or move the as-of date earlier.</div>`
      : `<div class="note">No frozen conformal scale is loaded for a ${esc(card.idea.horizonLabel)} horizon. Run <code>node scripts/verify.mjs</code> to calibrate one, or pick a horizon that appears in <code>research/validation-results.json</code>.</div>`;
    return;
  }
  const lo = Math.min(c.lowerPct, d?.p10Pct ?? c.lowerPct);
  const hi = Math.max(c.upperPct, d?.p90Pct ?? c.upperPct);
  const span = (hi - lo) || 1, pad = span * 0.14;
  const x = (v) => ((v - (lo - pad)) / (span + pad * 2)) * 100;
  const zeroIn = 0 >= lo - pad && 0 <= hi + pad;
  box.innerHTML = `
    <div class="band"><span class="${pc(c.lowerPct).cls}">${esc(pc(c.lowerPct).text)}</span> <span class="dim">to</span> <span class="${pc(c.upperPct).cls}">${esc(pc(c.upperPct).text)}</span></div>
    <div class="axis">
      <div class="track"></div>
      <div class="fill" style="left:${x(c.lowerPct).toFixed(2)}%;width:${Math.max(0.5, x(c.upperPct) - x(c.lowerPct)).toFixed(2)}%"></div>
      ${zeroIn ? `<div class="zero" style="left:${x(0).toFixed(2)}%"></div>` : ""}
      <span class="lbl" style="left:${Math.max(6, x(c.lowerPct)).toFixed(2)}%">${num(c.lowerPct)}%</span>
      <span class="lbl" style="left:${Math.min(94, x(c.upperPct)).toFixed(2)}%">${num(c.upperPct)}%</span>
    </div>
    ${kv([
      ["target coverage", pctPlain(c.coverageTargetPct, 0)],
      ["fitted scale", num(c.scale, 3)],
      ["interval width", pctPlain(c.widthPct)],
      ["analog median / sd", `${num(c.medianPct ?? d?.medianPct)}% / ${num(c.analogSdPct ?? d?.sdPct)}%`],
      ["fitted on", esc(c.fittedOn || "\u2013")],
      ["out-of-sample coverage", `${pctPlain(c.outOfSampleCoveragePct)} <span class="muted">&plusmn;${num(c.outOfSampleSEPp, 1)} pp SE</span>`],
      ["test era", esc(c.testEra || "\u2013")],
      ["oos queries", num(c.testQueries, 0)]
    ])}
    <p class="small" style="margin-top:9px">${esc(c.interpretation || "")}</p>
    <div class="note info" style="margin-bottom:0">One global multiplier, fitted on ${esc(c.fittedOn || "the calibration era")} and then frozen. Nothing about the session being queried is used to choose it, which is what makes the coverage figure below it an out-of-sample measurement rather than a restatement.</div>`;
}

function renderDist(card, detail) {
  const d = card.distribution;
  $("dist-sub").textContent = d ? `${d.n} analog outcomes over ${card.idea.horizonLabel}` : "";
  const marks = [];
  if (d) marks.push({ x: d.medianPct, label: "median", color: "#58a6ff" });
  if (card.conformal) marks.push({ band: { lo: card.conformal.lowerPct, hi: card.conformal.upperPct } });
  $("hist").innerHTML = histogramSvg(d?.histogram, { marks });

  $("diststats").innerHTML = d ? [
    stat("n", num(d.n, 0), "analog outcomes"),
    stat("median", pcHtml(d.medianPct), "the number to anchor on"),
    stat("mean", pcHtml(d.meanPct), "dragged by the tails"),
    stat("sd", `${num(d.sdPct)}%`, "of the sample"),
    stat("p10 / p90", `${esc(pc(d.p10Pct).text)} / ${esc(pc(d.p90Pct).text)}`, "middle 80%"),
    stat("p25 / p75", `${esc(pc(d.p25Pct).text)} / ${esc(pc(d.p75Pct).text)}`, "middle 50%"),
    stat("min / max", `${esc(pc(d.minPct).text)} / ${esc(pc(d.maxPct).text)}`, "the two extremes"),
    stat("skew", num(d.skew, 2), d.skew < -0.3 ? "left tail heavier" : d.skew > 0.3 ? "right tail heavier" : "roughly symmetric"),
    stat("P(below start)", pctPlain(d.probabilityBelowZeroPct), `${d.n} episodes`),
    stat("VaR90", `${num(d.valueAtRisk90Pct)}%`, "1-in-10 endpoint loss"),
    stat("CVaR90", `${num(d.conditionalVar90Pct)}%`, "mean of the worst decile"),
    stat("P(loss > 5%)", pctPlain(d.probabilityBelow?.minus5Pct), ""),
    stat("P(loss > 10%)", pctPlain(d.probabilityBelow?.minus10Pct), ""),
    stat("P(loss > 20%)", pctPlain(d.probabilityBelow?.minus20Pct), "")
  ].join("") : `<p class="small">No distribution for this query.</p>`;

  const fan = detail?.stressFan || detail?.baselineFan;
  $("fan").innerHTML = fanSvg(fan, { unit: "frac", conformal: card.conformal, label: "sessions ahead from the query close" })
    + `<div class="note info" style="margin-top:8px">A fan of <b>historical paths</b> re-based to the query close, not a forecast. The percentiles are not predictive probabilities: they describe what the ${d?.n ?? 0} retrieved episodes actually did next. The dashed amber lines are the frozen conformal band evaluated at the horizon.</div>`;

  const e = card.excursion;
  if (!e) { $("excursion").innerHTML = `<p class="small">No excursion data for this query.</p>`; return; }
  const breach = Object.entries(e.probabilityOfBreaching || {}).map(([k2, v]) => ({
    label: `${String(k2).replace("PctDrawdown", "")}% drawdown`, value: Number(v), color: "#f85149"
  }));
  $("excursion").innerHTML = `
    <div class="grid2">
      <div>
        ${kv([
          ["median max adverse excursion", pcHtml(e.maxAdverseMedianPct)],
          ["MAE p10 (worst tenth)", pcHtml(e.maxAdverseP10Pct)],
          ["MAE p25", pcHtml(e.maxAdverseP25Pct)],
          ["median max favourable excursion", pcHtml(e.maxFavourableMedianPct)],
          ["MFE p75", pcHtml(e.maxFavourableP75Pct)],
          ["MFE p90", pcHtml(e.maxFavourableP90Pct)],
          ["reward / risk (MFE med : |MAE med|)", num(e.rewardRiskRatio, 2)]
        ])}
        <div class="note" style="margin-bottom:0">An episode can finish near flat and still have been un-holdable. MAE is the lowest intra-path print and MFE the highest, both measured over the ${esc(card.idea.horizonLabel)}. Excursions are raw-basis: the raw session low/high against the raw close of the decision session, one price scale throughout. Forward returns sit on a separate basis (adjusted close) and are never divided into a raw low or high.</div>
      </div>
      <div><h3 style="margin-top:0">Share of analogs that breached a drawdown</h3>${barsSvg(breach, { unit: "%", vMax: 100 })}</div>
    </div>`;
}

/**
 * The 7x24 wrapper panel - the measured answer to the one claim the desk could previously only assert.
 *
 * Everything on it comes from data-cache/wrapper-probe.json, written by scripts/measure-wrapper.mjs
 * and attached to the card by desk.mjs. Three states are rendered and all three are honest:
 * a verified wrapper with its own tracking, premium, liquidity and closed-hours figures; a symbol
 * with NO verified wrapper, which says so rather than borrowing a sibling's numbers; and a build on
 * which the venue was unreachable, which shows the degradation block. A missing measurement is never
 * filled in with an estimate.
 */
/**
 * The Bitget venue block, rendered FIRST because it is the primary measurement of the 7x24 layer:
 * Bitget's own RWA perpetuals, fetched from the official Bitget MCP with the exchange pinned to
 * bitget. Everything the block quotes carries its instrument class and its route, because a perpetual
 * is not a redeemable spot token and a proxied answer is not a direct one.
 */
function renderBitgetVenue(bg, cross, w) {
  if (!bg) return "";
  if (bg.status === "not-measured") {
    return `<div class="note warn" style="margin-top:10px"><b>Bitget venue not measured on this run.</b> ${esc(bg.caveatNote || "")}
      <div class="mono small" style="margin-top:6px">${esc(bg.venueName || "")} &middot; ${esc(bg.route || "no route")} &middot; ${esc(bg.degradation?.kind || "")}</div></div>`;
  }
  if (bg.status === "no-verified-instrument") {
    const refs = bg.refusals || [];
    return `<div class="note warn" style="margin-top:10px"><b>No verified Bitget instrument for ${esc(bg.symbol)}.</b> ${esc(bg.reason || "")}
      ${refs.length ? `<div class="small" style="margin-top:6px">${refs.map((x) => `<code>${esc(x.pair)}</code> refused at the ${esc(x.stage)} stage: ${esc(x.reason)}`).join("<br>")}</div>` : ""}
      <div class="small" style="margin-top:6px">${esc(bg.caveatNote || "")}</div></div>`;
  }
  const t = bg.tracking || {}, pr = bg.premium || {}, lq = bg.liquidity || {}, s24 = bg.sevenByTwentyFour || {}, cr = bg.closedSessionReturns || {};
  const wd = cr.weekendReturnDistribution, mae = cr.weekendMaeDistribution, pw = cr.pooledWeekendReturnDistribution, pm = cr.pooledWeekendMaeDistribution;
  const tierCls = t.tier === "tight" ? "ok" : t.tier === "fair" ? "info" : "warn";
  const cv = cross ? `
    <h3 style="margin-top:14px">Cross-venue <span class="sub">one underlying, two venues, two instrument classes, one shared session convention</span></h3>
    ${kpi("closed-move share, Bitget vs Gate.io", `${pctPlain(cross.closedMoveSharePct?.bitget)} <span class="muted">vs</span> ${pctPlain(cross.closedMoveSharePct?.gateio)}`, "same underlying, same convention")}
    ${kpi("return correlation, Bitget vs Gate.io", `${num(cross.returnCorrelation?.bitget, 3)} <span class="muted">vs</span> ${num(cross.returnCorrelation?.gateio, 3)}`, "daily returns against the same raw closes")}
    ${kpi("spread, Bitget vs Gate.io", `${num(cross.spreadBps?.bitget, 2)} <span class="muted">vs</span> ${num(cross.spreadBps?.gateio, 2)} bp`, "order-book snapshot, both sides")}
    ${kpi("weekend median return, Bitget vs Gate.io", `${pctPlain(cross.weekendMedianReturnPct?.bitget)} <span class="muted">vs</span> ${pctPlain(cross.weekendMedianReturnPct?.gateio)}`, "entry-to-exit across the closed block")}
    <p class="small" style="margin-top:6px">${esc(cross.note || "")}</p>
    ${cross.windowHours ? `<div class="note info" style="margin-top:6px"><b>Window, stated because the venues differ:</b> median ${num(cross.windowHours.bitgetMedian, 0)} hourly buckets observed on Bitget against ${num(cross.windowHours.gateioMedian, 0)} on Gate.io. ${esc(cross.windowHours.note || "")}</div>` : ""}` : "";
  return `
    <div class="headline" style="margin-bottom:8px;margin-top:12px">
      <h3 style="margin:0">${esc(bg.instrument || "")} <span class="dim mono" style="font-size:13px">Bitget RWA perpetual, a 7x24 proxy for ${esc(bg.symbol)}</span></h3>
      <div class="meta">${esc(bg.venueName || "")} &middot; ${esc(bg.route || "")} &middot; snapshot ${esc(bg.measuredAt || "")} &middot; no API key</div>
    </div>
    ${badge("ok", "primary venue")}
    ${badge(tierCls, esc(t.tierLabel || t.tier || "unknown"))}
    ${badge("info", esc(bg.instrumentClass || "perpetual"))}
    ${badge(bg.intervalEchoed === "1h" && bg.exchangeEchoed === bg.exchangePinned ? "ok" : "bad", `echo checked: interval ${esc(bg.intervalEchoed || "?")} / exchange ${esc(bg.exchangeEchoed || "?")}`)}
    <p class="small" style="margin-top:6px">${esc(w?.venueNote || "")}</p>

    <h3 style="margin-top:14px">The measured 7x24 part, on Bitget data <span class="sub">how much of the instrument's own movement lands in the hours the cash market is shut</span></h3>
    ${kpi("movement outside cash hours", pctPlain(s24.closedMoveSharePct), "of realised hourly moves", (s24.closedMoveSharePct ?? 0) > 50 ? "neg" : "")}
    ${kpi("hours outside session", pctPlain(s24.closedHoursSharePct), `${num(s24.hoursObserved, 0)} hourly buckets observed`)}
    ${kpi("traded outside session", pctPlain(s24.tradedOutsideSessionPct), "share of closed hours with a print")}
    ${kpi("return correlation", num(t.returnCorrelation, 4), `${num(t.trackingErrorBpPerDay, 0)} bp/day tracking error`)}
    ${kpi("spread", num(lq.spreadBps, 2), `${num(lq.depthWithin50BpsUsdt, 0)} USDT within 50bp`)}
    <p class="small" style="margin-top:6px">${esc(s24.note || "")}</p>

    <h3 style="margin-top:14px">The return layer, on Bitget data <span class="sub">what the instrument actually did while the cash market was shut</span></h3>
    ${kpi("median weekend return", pctPlain(wd?.medianPct ?? pw?.medianPct), `${num(cr.weekendBlocks ?? pw?.n, 0)} closed-market block(s)`, Math.abs(wd?.medianPct ?? 0) < 0.5 ? "" : "neg")}
    ${kpi("p10 weekend return", pctPlain(wd?.p10Pct ?? pw?.p10Pct), "the bad tail of those weekends", "neg")}
    ${kpi("median intra-weekend MAE", pctPlain(mae?.medianPct ?? pm?.medianPct), "worst point inside the block", "neg")}
    ${kpi("closed-hour vs open-hour vol", `${num(cr.hourlyStdRatioOutsideOverInside, 2)}<span class="muted">x</span>`, "hourly sd outside / inside")}
    ${pw ? `<p class="small" style="margin-top:6px">Pooled across ${num(cr.pooledInstruments, 0)} Bitget instruments: ${num(pw.n, 0)} weekend blocks over ${num(cr.pooledDistinctWeekendStarts, 0)} distinct weekend(s), median ${pctPlain(pw.medianPct)}, p10 ${pctPlain(pw.p10Pct)}, sd ${pctPlain(pw.stdPct)}, median MAE ${pctPlain(pm?.medianPct)}, ${pctPlain(cr.pooledWeekendShareBreached5PctDrawdownPct)} of weekends breaching ${num(cr.weekendDrawdownThresholdPct, 0)}% intra-block.</p>` : ""}
    <p class="small" style="margin-top:6px">${esc(cr.note || "")}</p>
    ${cr.caveatNote ? `<div class="note warn" style="margin-top:6px"><b>What this pooled figure is not:</b> ${esc(cr.caveatNote)}</div>` : ""}
    ${cv}
    <div class="note info" style="margin-top:8px"><b>Instrument class and route, stated rather than implied:</b> ${esc(bg.caveat || "")}</div>`;
}

function renderWrapper(card) {
  const box = $("wrapper");
  const w = card.wrapper;
  if (!w) {
    box.innerHTML = `<div class="note">This card carries no wrapper-layer block. It is attached by <code>desk.mjs</code> from <code>data-cache/wrapper-probe.json</code>; run <code>node scripts/measure-wrapper.mjs</code> to produce it.</div>`;
    return;
  }
  const ref = w.referenceMarket;
  const refBlock = ref ? `
    <h3>The reference market is shut for most of the week <span class="sub">derived from the library's own session calendar - no venue needed</span></h3>
    ${kpi("week closed", pctPlain(ref.closedSharePct), `${num(ref.closedHoursPerWeek, 1)}h of ${num(ref.weekHours, 0)}h`)}
    ${kpi("cash hours / week", num(ref.cashOpenHoursPerWeek, 1), `${num(ref.sessionsPerWeek, 2)} sessions x 6.5h`)}
    ${kpi("sessions measured", num(ref.sessions, 0), `${esc(ref.from || "")} .. ${esc(ref.to || "")}`)}
    <p class="small" style="margin-top:6px">${esc(ref.note || "")}</p>` : "";
  // The primary venue is rendered first whatever its status: a Bitget block that says "not measured"
  // is more useful than a card that silently falls back to the second venue without saying so.
  const bitgetBlock = renderBitgetVenue(w.bitget, w.crossVenue, w);

  if (w.status === "not-measured") {
    box.innerHTML = `${refBlock}${bitgetBlock}
      <div class="note bad" style="margin-top:10px"><b>Wrapper layer not measured on this build.</b> ${esc(w.degradation?.disclosure || w.caveatNote || "")}
      <div class="mono small" style="margin-top:6px">${esc(w.venueName || "")} &middot; ${esc(w.degradation?.kind || "")} &middot; ${esc(w.degradation?.detail || "")} &middot; probed ${esc(w.degradation?.probedAt || "")}</div></div>`;
    return;
  }

  if (w.status === "no-verified-wrapper") {
    box.innerHTML = `${refBlock}${bitgetBlock}
      <div class="note warn" style="margin-top:10px"><b>No verified tokenised wrapper for ${esc(w.symbol)}.</b> ${esc(w.reason || "")}
      <div class="small" style="margin-top:6px">${num(w.candidatesTested, 0)} candidate listing(s) on ${esc(w.venueName || "")} were tested and rejected; every rejection and its reason is in <code>data-cache/wrapper-probe.json</code> and served by <code>/api/wrapper</code>. Measured ${esc(w.measuredAt || "")}.</div>
      <div class="small" style="margin-top:6px">${esc(w.caveatNote || "")}</div></div>`;
    return;
  }

  const t = w.tracking || {}, pr = w.premium || {}, lq = w.liquidity || {}, s24 = w.sevenByTwentyFour || {};
  const tierCls = t.tier === "tight" ? "ok" : t.tier === "fair" ? "info" : "warn";
  box.innerHTML = `
    <div class="headline" style="margin-bottom:8px">
      <h3 style="margin:0">${esc(w.instrument || "")} <span class="dim mono" style="font-size:13px">as a wrapper for ${esc(w.symbol)}</span></h3>
      <div class="meta">${esc(w.venueName || "")} &middot; snapshot ${esc(w.measuredAt || "")} &middot; issuer suffix ${esc(w.issuerSuffix || "")}</div>
    </div>
    ${badge(tierCls, esc(t.tierLabel || t.tier || "unknown"))}
    ${refBlock}
    ${bitgetBlock}
    ${w.primaryVenue === "bitget" ? `<h3 style="margin-top:18px">Second venue <span class="sub">an independent measurement of the same claim, on a different instrument class</span></h3>` : ""}

    <h3 style="margin-top:14px">The measured 7x24 part <span class="sub">how much of the wrapper's own movement lands in the hours the cash market is shut</span></h3>
    ${kpi("movement outside cash hours", pctPlain(s24.closedMoveSharePct), `of realised hourly moves`, (s24.closedMoveSharePct ?? 0) > 50 ? "neg" : "")}
    ${kpi("hours outside session", pctPlain(s24.closedHoursSharePct), `${num(s24.hoursObserved, 0)} hourly buckets observed`)}
    ${kpi("traded outside session", pctPlain(s24.tradedOutsideSessionPct), "share of closed hours with a print")}
    <p class="small" style="margin-top:6px">${esc(s24.note || "")}</p>
    ${s24.conventionNote ? `<div class="note info" style="margin-top:6px"><b>Convention, stated so the figure can be checked:</b> ${esc(s24.conventionNote)}</div>` : ""}

    ${(() => {
      const cr = w.closedSessionReturns;
      if (!cr) return `<h3 style="margin-top:14px">The return layer <span class="sub">what the wrapper actually did while the cash market was shut</span></h3>
        <div class="note warn">No closed-session return measurement on this card. The block above is a share of absolute movement, which cannot be sized; run <code>node scripts/measure-wrapper.mjs</code> to produce the distribution.</div>`;
      const wd = cr.weekendReturnDistribution, mae = cr.weekendMaeDistribution, pw = cr.pooledWeekendReturnDistribution, pm = cr.pooledWeekendMaeDistribution;
      const rows = [];
      if (wd) {
        rows.push(["weekend blocks observed", num(cr.weekendBlocks, 0)]);
        rows.push(["median weekend return", pctPlain(wd.medianPct)]);
        rows.push(["p10 / p90", `${pctPlain(wd.p10Pct)} / ${pctPlain(wd.p90Pct)}`]);
        rows.push(["sd / n", `${pctPlain(wd.stdPct)} <span class="muted">over</span> ${num(wd.n, 0)}`]);
        rows.push(["share negative", pctPlain(wd.shareNegativePct)]);
      }
      if (mae) rows.push(["median intra-weekend MAE", pctPlain(mae.medianPct)]);
      if (cr.weekendShareBreached5PctDrawdownPct != null) rows.push(["weekends breaching -5% intra-block", pctPlain(cr.weekendShareBreached5PctDrawdownPct)]);
      if (cr.hourlyStdRatioOutsideOverInside != null) rows.push(["closed-hour vs open-hour volatility", `${num(cr.hourlyStdRatioOutsideOverInside, 2)}<span class="muted">x</span>`]);
      if (cr.hourlyOutsideSession) rows.push(["hourly return sd, outside vs inside session", `${pctPlain(cr.hourlyOutsideSession.stdPct)} <span class="muted">vs</span> ${pctPlain(cr.hourlyInsideSession?.stdPct)}`]);
      const pooled = pw ? [["pooled across wrappers", `${num(pw.n, 0)} weekend blocks \u00b7 ${num(cr.pooledPairs, 0)} wrappers \u00b7 ${num(cr.pooledDistinctWeekendStarts, 0)} distinct weekends`],
        ["pooled median / p10 / sd", `${pctPlain(pw.medianPct)} / ${pctPlain(pw.p10Pct)} / ${pctPlain(pw.stdPct)}`],
        ["pooled median MAE", pctPlain(pm?.medianPct)],
        ["pooled weekends breaching -5% / -10%", `${pctPlain(cr.pooledWeekendShareBreached5PctDrawdownPct)} / ${pctPlain(cr.pooledWeekendShareBreached10PctDrawdownPct)}`]] : [];
      return `
    <h3 style="margin-top:14px">The return layer <span class="sub">what the wrapper actually did while the cash market was shut</span></h3>
    ${kpi("median weekend return", pctPlain(wd?.medianPct ?? pw?.medianPct), `${num(cr.weekendBlocks ?? pw?.n, 0)} closed-market block(s)`, Math.abs(wd?.medianPct ?? 0) < 0.5 ? "" : "neg")}
    ${kpi("p10 weekend return", pctPlain(wd?.p10Pct ?? pw?.p10Pct), "the bad tail of those weekends", "neg")}
    ${kpi("median intra-weekend MAE", pctPlain(mae?.medianPct ?? pm?.medianPct), "worst point inside the block", "neg")}
    ${kv(rows)}
    <p class="small" style="margin-top:6px">${esc(cr.note || "")}</p>
    ${pooled.length ? `<h4 style="margin:12px 0 4px">Pooled across every verified wrapper</h4>${kv(pooled)}` : ""}
    ${cr.conventionNote ? `<div class="note info" style="margin-top:6px"><b>How a block is defined:</b> ${esc(cr.conventionNote)}</div>` : ""}
    ${cr.caveatNote ? `<div class="note warn" style="margin-top:6px"><b>What this is not:</b> ${esc(cr.caveatNote)}</div>` : ""}`;
    })()}

    <h3 style="margin-top:14px">Tracking quality <span class="sub">wrapper daily returns against the underlying's raw session closes</span></h3>
    ${kv([
      ["return correlation", num(t.returnCorrelation, 4)],
      ["tracking error", `${num(t.trackingErrorBpPerDay, 0)} <span class="muted">bp / day</span>`],
      ["tier", `${badge(tierCls, esc(t.tierLabel || t.tier || "unknown"))}`],
      ["overlap", `${num(t.overlapSessions, 0)} sessions (${esc(t.from || "")} .. ${esc(t.to || "")})`]
    ])}
    <p class="small">${esc(t.note || "")}</p>

    <h3 style="margin-top:14px">Premium to the underlying <span class="sub">traded wrapper price against the traded raw close</span></h3>
    ${kv([
      ["median premium", pctPlain(pr.medianPct)],
      ["p10 / p90 band", `${pctPlain(pr.p10Pct)} / ${pctPlain(pr.p90Pct)}`],
      ["last deviation", pctPlain(pr.priceDeviationPct)],
      ["wrapper last / raw close", `${num(pr.wrapperLast, 4)} / ${num(pr.lastRawClose, 4)} <span class="muted">(${esc(pr.lastRawCloseDate || "")})</span>`]
    ])}
    <p class="small">${esc(pr.note || "")}</p>

    <h3 style="margin-top:14px">Liquidity at the snapshot <span class="sub">what an exit would actually run into</span></h3>
    ${kv([
      ["spread", isNum(lq.spreadBps) ? `${num(lq.spreadBps)} <span class="muted">bp</span>` : "\u2013"],
      ["touch", isNum(lq.bestBid) ? `${num(lq.bestBid, 4)} / ${num(lq.bestAsk, 4)}` : "\u2013"],
      ["top of book", isNum(lq.topOfBookUsdt) ? `${num(lq.topOfBookUsdt, 0)} <span class="muted">USDT</span>` : "\u2013"],
      ["depth within 50 bp", isNum(lq.depthWithin50BpsUsdt) ? `${num(lq.depthWithin50BpsUsdt, 0)} <span class="muted">USDT</span>` : "\u2013"],
      ["depth within 200 bp", isNum(lq.depthWithin200BpsUsdt) ? `${num(lq.depthWithin200BpsUsdt, 0)} <span class="muted">USDT</span>` : "\u2013"],
      ["quote volume, 24h", isNum(lq.quoteVolume24hUsdt) ? `${num(lq.quoteVolume24hUsdt, 0)} <span class="muted">USDT</span>` : "\u2013"],
      ["median daily quote volume", isNum(lq.medianDailyQuoteVolumeUsdt) ? `${num(lq.medianDailyQuoteVolumeUsdt, 0)} <span class="muted">USDT</span>` : "\u2013"]
    ])}
    <p class="small">${esc(lq.note || "")}</p>

    <div class="note info" style="margin-top:10px">${esc(w.interpretation || "")}</div>
    <div class="caveat"><b>Caveat, carried verbatim:</b> ${esc(w.caveat || "")}</div>`;
}
function renderStress(card) {
  const rows = card.stress || [];
  if (!rows.length) {
    $("stresstable").innerHTML = `<div class="note">The stress suite was not run for this query - untick "run stress suite" to skip it, or the engine found no eligible analogs for any scenario.</div>`;
    $("stressdetail").innerHTML = ""; return;
  }
  const head = `<thead><tr><th>scenario</th><th>kind</th><th class="num">analogs</th><th class="num">median fwd</th>
    <th class="num">&Delta; vs baseline</th><th class="num">p10</th><th class="num">p90</th><th class="num">P(loss&gt;10%)</th>
    <th class="num">median MAE</th><th class="num">P(10% dd)</th><th class="num">held within 10% dd</th></tr></thead>`;
  const body = rows.map((r) => {
    if (r.skipped) return `<tr data-id="${esc(r.id)}" style="opacity:.6"><td><b>${esc(r.label)}</b><div class="muted mono" style="font-size:10px">${esc(r.id)}</div></td>
      <td><span class="tag kind-${esc(r.kind)}">${esc(r.kind)}</span></td>
      <td class="num" colspan="9"><span class="tag">skipped: ${esc(r.skipped)}</span></td></tr>`;
    return `<tr data-id="${esc(r.id)}" style="cursor:pointer" title="click to jump to this scenario's detail and path fan">
      <td><b>${esc(r.label)}</b><div class="muted mono" style="font-size:10px">${esc(r.id)}</div><div style="margin-top:3px">${(r.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</div></td>
      <td><span class="tag kind-${esc(r.kind)}">${esc(r.kind)}</span></td>
      <td class="num">${num(r.analogsUsed, 0)}</td>
      <td class="num">${pcHtml(r.medianForwardPct)}</td>
      <td class="num">${r.id === "baseline" ? `<span class="muted">base</span>` : pcHtml(r.deltaMedianVsBaselinePct)}</td>
      <td class="num">${pcHtml(r.p10ForwardPct)}</td><td class="num">${pcHtml(r.p90ForwardPct)}</td>
      <td class="num">${pctPlain(r.probabilityBelowMinus10Pct)}</td>
      <td class="num">${pcHtml(r.maxAdverseMedianPct)}</td>
      <td class="num">${pctPlain(r.probabilityOfBreaching10PctDrawdown)}</td>
      <td class="num">${pctPlain(r.heldWithin10PctDrawdownPct)}</td></tr>`;
  }).join("");
  $("stresstable").innerHTML = `<div class="scroll" style="max-height:none"><table>${head}<tbody>${body}</tbody></table></div>`;

  const deltas = rows.filter((r) => !r.skipped && r.id !== "baseline" && isNum(r.deltaMedianVsBaselinePct))
    .sort((a, b) => a.deltaMedianVsBaselinePct - b.deltaMedianVsBaselinePct)
    .map((r) => ({ label: r.label.length > 32 ? r.label.slice(0, 31) + "\u2026" : r.label, value: r.deltaMedianVsBaselinePct }));

  $("stressdetail").innerHTML = `
    <h3>Change in median forward return vs the baseline, by scenario</h3>
    ${barsSvg(deltas, { unit: " pp", diverging: true })}
    <div class="scen-detail">${rows.map((r) => `
      <div class="card" id="sc-${esc(r.id)}">
        <h4>${esc(r.label)} <span class="tag kind-${esc(r.kind)}">${esc(r.kind)}</span>${r.skipped ? ` <span class="tag">skipped: ${esc(r.skipped)}</span>` : ""}</h4>
        <p class="why">${esc(r.why || "")}</p>
        ${r.skipped ? "" : kv([
          ["analogs used", num(r.analogsUsed, 0)],
          ["median / p10 / p90 forward", `${pcHtml(r.medianForwardPct)} / ${pcHtml(r.p10ForwardPct)} / ${pcHtml(r.p90ForwardPct)}`],
          ["&Delta; median vs baseline", `${pcHtml(r.deltaMedianVsBaselinePct)} <span class="muted">percentage points</span>`],
          ["median max adverse excursion", pcHtml(r.maxAdverseMedianPct)],
          ["P(breaching a 10% drawdown)", pctPlain(r.probabilityOfBreaching10PctDrawdown)],
          ["share holdable within 10% drawdown", pctPlain(r.heldWithin10PctDrawdownPct)],
          ...(r.venueMeta ? [["composed with", `<b>${esc(r.venueMeta.instrument)}</b> &middot; ${esc(r.venueMeta.venueName)} &middot; ${esc(r.venueMeta.instrumentClass)}`],
            ["measured closed-market blocks", `${num(r.venueMeta.blocksUsed, 0)} weekend block(s) over ${num(r.venueMeta.distinctWeekendStarts, 0)} distinct weekend start(s)${isNum(r.venueMeta.pooledWeekendN) ? ` <span class="muted">&middot; venue-wide pooled ${num(r.venueMeta.pooledWeekendN, 0)}</span>` : ""}`],
            ["fetched on", esc(r.venueMeta.route ? `the ${r.venueMeta.route} route` : "a direct keyless route")]] : [])
        ])}
        ${r.fan && r.fan.length ? `<div style="margin-top:8px">${fanSvg(r.fan, { unit: "pct", height: 190, label: "sessions ahead" })}</div>` : ""}
        <div class="caveat"><b>Engine caveat, carried verbatim:</b> ${esc(r.caveat || "")}</div>
      </div>`).join("")}
    </div>`;

  $("stresstable").querySelectorAll("tbody tr[data-id]").forEach((tr) =>
    tr.addEventListener("click", () => document.getElementById(`sc-${tr.dataset.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" })));
}

function renderAnalogs(card, detail) {
  const r = card.retrieval || {};
  const A = detail?.analogs || [];
  const H = card.idea.horizonSessions;
  $("analog-note").innerHTML = `Requested ${num(r.kRequested, 0)} neighbours, ${num(r.kReturned, 0)} returned after the anti-clustering constraints:
    at most 2 per calendar date and at least 10 trading days between two analogs of the same instrument. Without those, the top-50 collapses onto one week of one crash
    and the "distribution" is really a single event. ${num(r.distinctSessions, 0)} distinct sessions across ${num(r.distinctSymbols, 0)} instruments, of which
    ${num(r.sameSymbolCount, 0)} are ${esc(card.idea.symbol)} itself. Embargo: a candidate at session <i>j</i> is eligible only when <i>j</i> + ${num(r.embargoSessions, 0)} &le; the query session,
    so every forward return below was fully realised before the decision date. Scan: ${num(detail?.scan?.scanned, 0)} candidate rows, ${num(detail?.scan?.eligible, 0)} eligible
    (${num(detail?.scan?.from, 0) && ""}${esc(detail?.scan?.from || "")} .. ${esc(detail?.scan?.to || "")}).`;
  const bySector = Object.entries(r.bySector || {}).sort((a, b) => b[1] - a[1]);
  const byYear = Object.entries(r.byYear || {}).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  const rows = A.map((a, i) => `<tr>
    <td class="num muted">${i + 1}</td>
    <td class="sym">${esc(a.sym)}${a.sameName ? ` <span class="tag">same name</span>` : ""}</td>
    <td>${esc(a.name || "")}</td><td class="muted">${esc(a.sector || "")}</td>
    <td class="mono">${esc(a.date)}</td>
    <td class="num">${num(a.dist, 4)}</td>
    <td class="num">${pcHtml(a.fwd?.[H] == null ? null : Number(a.fwd[H]) * 100)}</td>
    <td class="num">${pcHtml(a.mae == null ? null : Number(a.mae) * 100)}</td>
    <td class="num">${pcHtml(a.mfe == null ? null : Number(a.mfe) * 100)}</td></tr>`).join("");
  const maxSec = bySector.length ? Math.max(...bySector.map((x) => x[1])) * 1.18 : 1;
  const maxYr = byYear.length ? Math.max(...byYear.map((x) => x[1])) * 1.18 : 1;
  $("analogtable").innerHTML = `
    <div class="grid2" style="margin-bottom:14px">
      <div><h3 style="margin-top:0">Analog count by sector</h3>${barsSvg(bySector.map(([k2, v]) => ({ label: k2, value: v, color: "#58a6ff" })), { unit: " analogs", vMax: maxSec })}</div>
      <div><h3 style="margin-top:0">Analog count by year of the analog session</h3>${barsSvg(byYear.map(([k2, v]) => ({ label: k2, value: v, color: "#8b949e" })), { unit: " analogs", vMax: maxYr })}</div>
    </div>
    <div class="note info">Closest distance ${num(r.closestDistance, 4)}, median distance ${num(r.medianDistance, 4)} in group-weighted z-space.
      Distance is a similarity measure over standardised features, not a price level - two analogs can be a decade apart and still be neighbours.</div>
    <div class="scroll"><table><thead><tr><th class="num">#</th><th>symbol</th><th>name</th><th>sector</th><th>session</th>
      <th class="num">distance</th><th class="num">fwd ${H}s</th><th class="num">MAE</th><th class="num">MFE</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="9" class="small">No analogs returned.</td></tr>`}</tbody></table></div>`;
}

function renderProv(card) {
  const v = card.validation, p = card.provenance || {};
  if (v) {
    const bm = v.benchmarks || {};
    // The path-risk probabilities the stress table prints are themselves scored out of sample; the
    // panel says so, with the paired interval rather than the point estimate carrying the comparison.
    const prk = v.pathRisk || null;
    const prPair = prk?.pairedBrierVs?.volReflection || null;
    const prVerdict = prPair
      ? (prPair.ci95High < 0 ? "the date-clustered interval resolves in favour of the analog excursion share"
        : (prPair.ci95Low > 0 ? "the date-clustered interval resolves in favour of the volatility benchmark"
          : "the date-clustered interval does not separate the two"))
      : "";
    const rows = [
      ["analog + frozen conformal scale", v.analog?.coveragePct, v.analog?.widthPct, v.analog?.matchedCoverageWidthPct, true],
      ["analog raw percentiles (uncalibrated)", bm.analogRaw?.coveragePct, bm.analogRaw?.widthPct, bm.analogRaw?.matchedCoverageWidthPct],
      ["same-name unconditional, point-in-time", bm.uncondNamePIT?.coveragePct, bm.uncondNamePIT?.widthPct, bm.uncondNamePIT?.matchedCoverageWidthPct],
      ["own-volatility harness", bm.volHarness?.coveragePct, bm.volHarness?.widthPct, bm.volHarness?.matchedCoverageWidthPct],
      ["pooled unconditional (all instruments)", bm.pooledUncond?.coveragePct, bm.pooledUncond?.widthPct, bm.pooledUncond?.matchedCoverageWidthPct]
    ];
    $("validation").innerHTML = `
      <div class="scroll" style="max-height:none"><table>
        <thead><tr><th>predictive band</th><th class="num">coverage (test era)</th><th class="num">mean width</th><th class="num">width at matched coverage</th></tr></thead>
        <tbody>${rows.map(([n, c, w, mw, hi]) => `<tr${hi ? ` style="background:rgba(88,166,255,.07)"` : ""}>
          <td>${esc(n)}${hi ? ` <span class="tag">this desk</span>` : ""}</td>
          <td class="num">${pctPlain(c)}${hi && isNum(v.analog?.coverageSEPp) ? ` <span class="muted">&plusmn;${num(v.analog.coverageSEPp, 1)}</span>` : ""}</td>
          <td class="num">${pctPlain(w)}</td><td class="num">${pctPlain(mw)}</td></tr>`).join("")}</tbody></table></div>
      ${kv([
        ["protocol", esc(v.protocol)],
        ["target coverage", pctPlain(v.targetCoveragePct, 0)],
        ["fitted scale", num(v.analog?.fittedScale, 3)],
        ["sharpness vs the same-name band", `${pcHtml(v.matchedCoverageSharpnessVsSameNamePct)} <span class="muted">negative = the analog band is wider</span>`],
        ["per-symbol coverage sd", `analog ${num(v.perSymbolCoverageSdPp?.analogConformal, 1)} pp &middot; same-name ${num(v.perSymbolCoverageSdPp?.uncondNamePIT, 1)} pp &middot; pooled ${num(v.perSymbolCoverageSdPp?.pooledUncond, 1)} pp`],
        ["PIT uniformity \u03c7\u00b2", `${num(v.pitChiSquare, 1)} <span class="muted">vs 5% critical ${num(v.pitChiSquareCritical5Pct, 1)} \u2014 ${v.pitChiSquare > v.pitChiSquareCritical5Pct ? "FAILS" : "passes"}</span>`],
        ["directional hit rate", pctPlain(v.directionalHitRatePct)],
        ["mean retrieval", `${num(v.meanRetrievalMs, 1)} ms`]
      ])}
      ${prk ? `<div class="note info" style="margin:10px 0 0"><b>Path risk, scored out of sample.</b> At the ${num(prk.levelPct, 0)}% drawdown level over ${num(prk.testQueries, 0)} test queries on ${num(prk.dateClusters, 0)} distinct sessions, ${pctPlain(prk.realisedBreachPct)} actually breached against a mean predicted ${pctPlain(prk.meanPredictedPct)} by the analog excursion share (gap ${num(prk.calibrationGapPp, 2)} pp &plusmn; ${num(prk.calibrationGapSEPp, 2)}). Brier, lower is better: analog ${num(prk.brier?.analogMae, 4)} &middot; reflection principle on 60-session vol ${num(prk.brier?.volReflection, 4)} &middot; same-name frozen rate ${num(prk.brier?.sameNameCalib, 4)} &middot; pooled frozen rate ${num(prk.brier?.pooledCalib, 4)}. Discrimination AUC: ${num(prk.auc?.analogMae, 3)} analog vs ${num(prk.auc?.volReflection, 3)} volatility vs ${num(prk.auc?.pooledCalib, 3)} for a constant.${prPair ? ` Paired Brier difference against the volatility benchmark ${num(prPair.deltaBrier, 4)}, 95% CI ${num(prPair.ci95Low, 4)} to ${num(prPair.ci95High, 4)} - ${prVerdict}.` : ""}</div>` : ""}
      <div class="note bad" style="margin-bottom:0"><b>The engine's own verdict, unedited:</b> ${esc(v.honestVerdict || "")}</div>`;
  } else {
    $("validation").innerHTML = `<div class="note">No frozen validation summary is loaded for this horizon. Run <code>node scripts/verify.mjs</code>; it writes <code>research/VALIDATION.md</code> and <code>research/validation-results.json</code>.</div>`;
  }

  const src = p.sources || {};
  const srcRows = Object.entries(src).map(([k2, v2]) => [k2, esc(typeof v2 === "string" ? v2 : JSON.stringify(v2))]);
  $("sources").innerHTML = `
    ${srcRows.length ? kv(srcRows) : `<p class="small">See <code>research/DATA-PROVENANCE.md</code>.</p>`}
    ${kv([
      ["library span", `${esc(p.from || "\u2013")} .. ${esc(p.to || "\u2013")} (${num(p.sessions, 0)} sessions)`],
      ["instruments", num(p.symbols, 0)],
      ["dataset built at", esc(p.datasetBuiltAt || "\u2013")],
      ["prices", esc(p.priceSource || "\u2013")],
      ["earnings dates", esc(p.earningsSource || "\u2013")],
      ["return basis", "adjusted close for every forward return: A[q+H]/A[q] - 1"],
      ["path-risk basis", "raw session OHLC for MAE/MFE (raw low/high over the raw close of the decision session) and for gap20 (raw open[t] / raw close[t-1] - 1); the two bases are never divided by each other"]
    ])}
    ${(p.notes || []).map((n) => `<div class="note" style="margin-top:8px">${esc(n)}</div>`).join("")}`;

  const np = p.networkProbe;
  $("network").innerHTML = np ? `
    <p class="small" style="margin-bottom:6px">Measured by <code>scripts/probe-network.mjs</code> on the build machine at ${esc(np.generatedAt || "\u2013")}. ${esc(np.summary || "")}</p>
    <div class="scroll" style="max-height:270px"><table><thead><tr><th>host</th><th class="num">status</th><th>reachability</th><th>role in this project</th></tr></thead><tbody>
    ${(np.targets || []).map((t) => `<tr><td class="mono">${esc(t.name)}</td>
      <td class="num">${t.status ?? "\u2013"}</td>
      <td>${t.ok ? `<span class="tag">reachable</span>` : `<span class="tag" style="color:#f3a49f;border-color:#5a2320">${esc(t.kind)}</span>`}</td>
      <td class="small">${esc(t.role)}</td></tr>`).join("")}</tbody></table></div>`
    : `<div class="note">No network probe on record. Run <code>node scripts/probe-network.mjs</code>; it writes <code>data-cache/network-probe.json</code> and this panel reports the measured result.</div>`;

  const bg = p.bitget || np?.bitget;
  const md = bg?.marketData || null, narr = bg?.narrative || null;
  const epRow = (e) => `<div class="mono small" style="margin-bottom:3px">${e.ok ? "\u2713" : "\u2717"} ${esc(e.name)} <span class="muted">${esc(e.url)} &middot; ${esc(e.kind || "")}${e.detail ? " &middot; " + esc(e.detail) : ""}${e.latencyMs != null ? " &middot; " + num(e.latencyMs, 0) + "ms" : ""}</span></div>`;
  $("bitget").innerHTML = bg ? `
    <p class="small" style="margin-bottom:8px">Three things are reported separately, because they have different results and a single badge for all of them would misstate whichever way it pointed: the official market-data toolkit, the Bitget-operated LLM gateway the narrative layer calls, and what the toolkit actually returned when it was reached.</p>
    <h4 style="margin:6px 0 4px">1. Market data \u2014 the official MCP toolkit</h4>
    ${badge((md?.reachable ?? bg.reachable) ? "ok" : "bad", (md?.reachable ?? bg.reachable) ? "connected" : "degraded")}
    <p class="small" style="margin-top:6px">${esc(md?.summary || bg.summary || "")}</p>
    ${(md?.endpoints || bg.endpoints || []).map(epRow).join("")}
    <h4 style="margin:12px 0 4px">2. Narrative \u2014 the Bitget-operated hackathon LLM gateway</h4>
    ${narr ? badge(narr.reachable ? "ok" : "bad", narr.reachable ? "reachable" : "unreachable") : badge("warn", "not probed")}
    ${narr?.endpoint ? epRow(narr.endpoint) : ""}
    ${narr?.summary ? `<p class="small" style="margin-top:6px">${esc(narr.summary)}</p>` : ""}
    ${(() => {
      const m = bg.measurement || null;
      if (!m) return bg.disclosure ? `<div class="note ${(bg.marketData?.reachable ?? bg.reachable) ? "info" : "bad"}" style="margin-top:10px">${esc(bg.disclosure)}</div>` : "";
      const fg = m.fearGreedCrossCheck || null, ec = m.earningsCrossCheck || null, q = m.quotes || null, pr = m.profiles || null, wm = m.wholeMarketSentiment || null;
      const rows = [];
      if (m.server) rows.push(["server", `<span class="mono small">${esc(m.server.name || "")}@${esc(m.server.version || "")}</span>`]);
      if (m.summary) {
        if (m.summary.catalogEntries != null) rows.push(["catalog", `${num(m.summary.catalogEntries, 0)} entries in ${num(m.summary.catalogCategories, 0)} categories`]);
        if (m.summary.quotesAnswered) rows.push(["live equity quotes answered", esc(String(m.summary.quotesAnswered))]);
        if (m.summary.profilesAnswered) rows.push(["company profiles answered", esc(String(m.summary.profilesAnswered))]);
      }
      if (m.route) rows.push(["fetched on", `<span class="mono small">${esc(String(m.route))}</span>`]);
      if (fg) rows.push(["fear &amp; greed cross-check", `${num(fg.exactMatches, 0)}/${num(fg.overlappingDates, 0)} daily readings <b>identical</b> to this project's own api.alternative.me series (mean absolute difference ${num(fg.meanAbsDifference, 4)})`]);
      if (ec) rows.push(["earnings-date cross-check", `${num(ec.matchedDates, 0)} disclosure dates vs the EDGAR-derived calendar: ${pctPlain(ec.exactSameDayPct)} same day, ${pctPlain(ec.within3DaysPct)} within 3 days, ${pctPlain(ec.within7DaysPct)} within 7`]);
      if (q?.stalenessVsSnapshot) rows.push(["snapshot staleness", `median ${pctPlain(q.stalenessVsSnapshot.medianAbsDriftPct)} drift between the frozen ${esc(q.stalenessVsSnapshot.snapshotDate || "")} close and Bitget's live quote, over ${num(q.stalenessVsSnapshot.comparedSymbols, 0)} symbols`]);
      if (wm?.reading) rows.push(["Bitget whole-market sentiment", `score ${num(wm.reading.score, 1)} (${esc(wm.reading.rating || "")}) at ${esc(wm.reading.timestamp || "")} \u2014 recorded, <b>not</b> consumed by the engine`]);
      return `
    <h4 style="margin:12px 0 4px">3. What the official MCP actually returned \u2014 measured, cross-checked, and kept out of the engine</h4>
    ${badge("ok", "measured")}
    ${kv(rows)}
    ${fg?.verdict ? `<p class="small" style="margin-top:6px"><b>Fear &amp; greed:</b> ${esc(fg.verdict)}. ${esc(fg.note || "")}</p>` : ""}
    ${ec?.note ? `<p class="small"><b>Earnings dates:</b> ${esc(ec.note)}</p>` : ""}
    ${q?.stalenessVsSnapshot?.note ? `<p class="small"><b>Quotes:</b> ${esc(q.stalenessVsSnapshot.note)}</p>` : ""}
    ${wm?.note ? `<p class="small"><b>Sentiment:</b> ${esc(wm.note)}</p>` : ""}
    ${(m.measuredEmpty?.entries || []).length ? `<div class="note warn" style="margin-top:8px"><b>Entries that answered with an empty body:</b> ${esc(m.measuredEmpty.entries.map((e) => e.entryId).join(", "))}. ${esc(m.measuredEmpty.note || "")}</div>` : ""}
    ${bg.disclosure ? `<div class="note info" style="margin-top:10px">${esc(bg.disclosure)}</div>` : ""}`;
    })()}`
    : `<p class="small">Not probed in this build.</p>`;

  const wp = p.wrapper || p.wrapperMeasurement;
  $("wrapperprov").innerHTML = wp ? `
    ${badge(wp.degraded ? "bad" : wp.available || wp.verifiedWrappers ? "ok" : "warn", wp.degraded ? "not measured" : "measured")}
    <p class="small" style="margin-top:8px">${esc(wp.summary || "")}</p>
    ${kv([
      ["venue", `<span class="mono small">${esc(wp.venueName || wp.venue || "")}</span>`],
      ["measured at", esc(wp.measuredAt || wp.generatedAt || "")],
      ["verified wrappers", num(wp.verified ?? wp.verifiedWrappers, 0)],
      ["reference market closed", pctPlain(wp.referenceMarket?.closedSharePct)],
      ["weekend return blocks", num(wp.closedSessionReturns?.pooled?.weekendReturnDistribution?.n, 0)],
      ["pooled median weekend return", pctPlain(wp.closedSessionReturns?.pooled?.weekendReturnDistribution?.medianPct)],
      ["pooled median intra-weekend MAE", pctPlain(wp.closedSessionReturns?.pooled?.weekendMaeDistribution?.medianPct)],
      ["role", `<span class="small">${esc(wp.role || "measurement of the tokenised-equity wrapper layer; NOT a price source for the analog library")}</span>`]
    ])}
    <p class="small" style="margin-bottom:0">Written by <code>scripts/measure-wrapper.mjs</code> into <code>data-cache/wrapper-probe.json</code>, committed, and read as data by both runtimes. Rejections and the reason for each are in that file and at <code>/api/wrapper</code>.</p>`
    : `<div class="note">No wrapper measurement on record. Run <code>node scripts/measure-wrapper.mjs</code>.</div>`;

  const llm = p.llm || {};
  $("llmpanel").innerHTML = `
    ${kv([
      ["mode", esc(llm.mode || (S.rt.kind === "BROWSER" ? "REPLAY/TEMPLATE" : "TEMPLATE"))],
      ["model", esc(llm.model || "none configured")],
      ["endpoint", `<span class="mono small">${esc(llm.baseUrl || "https://hackathon.bitgetops.com/v1")}</span>`],
      ["api key present", llm.keyPresent ? "yes" : "no"]
    ])}
    <p class="small">The model receives the research card and nothing else. Every numeral it writes is checked against that card by
      <code>src/llm/verify-numbers.mjs</code>; a draft citing an unsupported figure is rejected after one corrective retry and the deterministic
      template is shown instead, with the rejection recorded above. Numbers therefore originate in the engine in all three modes.</p>
    <div class="note info" style="margin-bottom:0">This deployment is running in <b>${esc(S.rt.kind)}</b> mode. ${S.rt.kind === "BROWSER"
      ? "The whole engine - retrieval, conformal calibration and the stress suite - executes in this browser tab from the bundled analog library. No server, no API key, no network call after the page loads."
      : "server.mjs runs the engine in Node and this page calls /api/analyze. Set LLM_API_KEY in .env to move the narrative from TEMPLATE to LIVE."}</div>`;
}

/* --------------------------------- run ---------------------------------- */

function readParams(inherit = false) {
  const q = $("q").value.trim();
  // A follow-up is usually a fragment ("那 20 天呢"). Inheriting the rest of the previous request is
  // what makes it a conversation; only run() asks for that, and every inherited field is reported.
  // An EMPTY question box is not a fragment: it means the dropdowns are the whole request, so nothing
  // is inherited. Without this, clearing the question and picking a different symbol re-ran the
  // previous symbol, because the carried-over context outranked the dropdown the user just changed.
  const parsed = inherit && q ? mergeContext(S.lastParsed, parseQuery(q, S.lib)) : parseQuery(q, S.lib);
  return {
    question: q,
    symbol: parsed.symbol || $("symbol").value,
    horizon: parsed.horizon || Number($("horizon").value),
    date: parsed.date || $("date").value || "latest",
    k: parsed.k || Number($("k").value) || 50,
    riskTolerancePct: parsed.riskTolerancePct || null,
    language: $("lang").value === "auto" ? detectLang(q) : $("lang").value,
    includeStress: $("stress").checked,
    parsed
  };
}

function showParsed(p) {
  const pd = p.parsed || {};
  const inh = (pd.inherited || []).length ? ` <span class="muted">carried over: ${esc((pd.inherited || []).join(", "))}</span>` : "";
  const bits = [];
  if (pd.symbol) {
    const from = pd.matchedHow === "fuzzy"
      ? ` <span class="muted">typo repaired from "${esc(pd.matched)}"</span>`
      : pd.matched && String(pd.matched).toUpperCase() !== pd.symbol
        ? ` <span class="muted">from "${esc(pd.matched)}"</span>` : "";
    bits.push(`symbol <b>${esc(p.symbol)}</b>${from}${inh}`);
  } else {
    bits.push(`symbol <b>${esc(p.symbol)}</b> <span class="muted">from the dropdown</span>${inh}`);
  }
  bits.push(`horizon <b>${p.horizon}s</b>` + (pd.horizon
    ? (pd.horizonRaw && pd.horizonRaw !== pd.horizon ? ` <span class="muted">asked for ${pd.horizonRaw}</span>` : "")
    : ` <span class="muted">dropdown</span>`));
  bits.push(`as of <b>${esc(p.date === "latest" ? `${p.date} (${esc(S.lib?.to || "")})` : p.date)}</b>`
    + (pd.dateHow && pd.dateHow !== "iso" && pd.dateHow !== "latest" ? ` <span class="muted">${esc(pd.dateHow)}</span>` : ""));
  bits.push(`k=<b>${p.k}</b>`);
  if (p.riskTolerancePct) bits.push(`drawdown tolerance <b>${num(p.riskTolerancePct, 0)}%</b>`);
  bits.push(`lang <b>${esc(p.language)}</b>`);
  if (!p.includeStress) bits.push(`<span class="muted">stress suite off</span>`);
  $("parsed").innerHTML = bits.join(" &middot; ");
}

async function run() {
  if (!S.rt || S.busy) return;
  const p = readParams(true);
  showParsed(p);
  S.lastParsed = p.parsed;
  if (!p.symbol) { toast("No instrument recognised. Pick one from the Symbol dropdown, or type a ticker that is in the library.", "bad"); return; }
  S.busy = true;
  const btn = $("go"), prev = btn.innerHTML;
  btn.disabled = true; btn.innerHTML = `<span class="spin"></span>Analysing`;
  $("empty").hidden = true; $("results").hidden = false;
  $("request-notes").hidden = true; $("request-notes").innerHTML = "";
  renderPersonal(null); $("followups").hidden = true;
  $("cardbar").innerHTML = `<div class="headline"><h2>${esc(p.symbol)}</h2><div class="meta">retrieving analogs${p.includeStress ? " and running the stress suite" : ""}&hellip;</div></div>`;
  try {
    const r = await S.rt.analyze(p);
    if (!r || !r.card) throw new Error(r?.error || "the engine returned no research card");
    S.last = r;
    renderCardbar(r.card, r.detail);
    renderRequestNotes(r.card);
    renderPersonal(r.card);
    renderNarrative(r.narrative);
    renderState(r.card);
    renderConformal(r.card);
    renderDist(r.card, r.detail);
    renderStress(r.card);
    renderWrapper(r.card);
    renderAnalogs(r.card, r.detail);
    renderProv(r.card);
    renderFollowups(r.card, p);
    setBadges();
  } catch (e) {
    console.error(e);
    renderPersonal(null);
    $("followups").hidden = true;
    toast(`Analysis failed: ${e.message || e}`, "bad", 14000);
    $("cardbar").innerHTML = `<div class="headline"><h2>${esc(p.symbol)}</h2><div class="meta" style="color:var(--neg)">failed</div></div>`;
  } finally {
    S.busy = false; btn.disabled = false; btn.innerHTML = prev;
  }
}

/* --------------------------------- boot ---------------------------------- */

/**
 * Every element id this file reads, in one place.
 *
 * Why this list exists: one unterminated attribute in index.html is enough to swallow every element
 * after it into that attribute's value. The page still renders - header, input box - while every
 * handler silently fails to attach, so a reviewer gets a desk that does nothing and no explanation.
 * A DOM stub that auto-creates elements cannot catch that either; only a check against the real
 * parsed markup can. So the markup is asserted before anything is wired, and the failure is written
 * onto the page rather than into a console nobody is watching.
 */
const REQUIRED_IDS = [
  "q", "go", "symbol", "date", "horizon", "k", "lang", "stress", "chips", "parsed",
  "status", "badge-mode", "badge-runtime", "badge-lib", "badge-bitget",
  "main", "empty", "results", "request-notes", "cardbar", "tabs", "followups",
  "panel-brief", "panel-dist", "panel-stress", "panel-wrap", "panel-analogs", "panel-prov",
  "narrative", "state", "conformal", "personal", "dist-sub", "hist", "diststats", "fan", "excursion",
  "stresstable", "stressdetail", "wrapper", "analog-note", "analogtable",
  "wrapperprov",
  "validation", "sources", "network", "bitget", "llmpanel"
];

/** On-page fatal banner. The desk must never die quietly. */
function fatal(e) {
  const msg = String((e && (e.message || e)) || "unknown error");
  try { console.error("[AnalogDesk] did not start:", msg); } catch { /* no console */ }
  try {
    let box = document.getElementById("fatal");
    if (!box) {
      box = document.createElement("div");
      box.id = "fatal";
      if (box.setAttribute) box.setAttribute("role", "alert");
      box.style.cssText = "position:fixed;left:50%;top:18px;transform:translateX(-50%);z-index:200;"
        + "max-width:min(860px,94vw);padding:12px 16px;border-radius:8px;white-space:pre-wrap;"
        + "font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#ffdcd9;"
        + "background:#3b1418;border:1px solid #a1303a;box-shadow:0 10px 34px rgba(0,0,0,.55)";
      (document.body || document.documentElement).appendChild(box);
    }
    box.textContent = `AnalogDesk did not start.\n${msg}`;
  } catch { /* nowhere to put it */ }
}

/** Name the missing elements, so the cause is legible without a debugger. */
function assertDom() {
  const missing = REQUIRED_IDS.filter((id) => !document.getElementById(id));
  if (!missing.length) return;
  throw new Error(`index.html is missing ${missing.length} of ${REQUIRED_IDS.length} elements this desk needs: `
    + missing.map((id) => `#${id}`).join(", ")
    + ". One unterminated attribute can absorb every element after it."
    + " Rebuild with `npm run compile`, then re-check with `npm run check:html` and `npm run check:browser`.");
}

async function boot() {
  try {
    const mods = window.AnalogDesk;
    assertDom();
    tabs(); fillChips();
    $("go").addEventListener("click", run);
    $("q").addEventListener("keydown", (e) => { if (e.key === "Enter") run(); });
    for (const id of ["symbol", "horizon", "date", "k", "lang", "stress"]) {
      $(id).addEventListener("change", () => { if (S.lib) showParsed(readParams()); });
    }

    S.rt = mods?.dataset ? browserRuntime(mods) : apiRuntime();
    const br = $("badge-runtime");
    br.className = "badge warn";
    br.textContent = S.rt.kind === "BROWSER" ? "runtime: starting in-browser engine" : "runtime: connecting";
    S.boot = await S.rt.init();
    S.lib = S.boot.library;
    fillControls();
    setBadges();

    // Deep link: ?symbol=NVDA&horizon=5&date=2020-03-16&q=...&run=1
    const u = new URL(location.href);
    const hasParams = u.searchParams.get("symbol") || u.searchParams.get("q");
    if (hasParams) {
      if (u.searchParams.get("q")) $("q").value = u.searchParams.get("q");
      const p = parseQuery($("q").value, S.lib);
      const want = u.searchParams.get("symbol") || p.symbol;
      if (want && [...$("symbol").options].some((o) => o.value === want)) $("symbol").value = want;
      if (u.searchParams.get("horizon")) $("horizon").value = u.searchParams.get("horizon");
      if (u.searchParams.get("date")) $("date").value = u.searchParams.get("date");
      if (u.searchParams.get("k")) $("k").value = u.searchParams.get("k");
      if (u.searchParams.get("run") !== "0") await run(); else showParsed(readParams());
    } else {
      showParsed(readParams());
    }
    S.started = true;
  } catch (e) {
    console.error(e);
    fatal(e);
    const br = $("badge-runtime");
    if (br) { br.textContent = "runtime: failed"; br.className = "badge bad"; }
    const em = $("empty");
    if (em) {
      em.hidden = false;
      em.innerHTML = `<h2>The desk did not start</h2><p class="small" style="color:var(--neg)">${esc(e.message || String(e))}</p>
        <p class="small">Server deployment: run <code>npm start</code> from the project root and open <code>http://127.0.0.1:3000</code>.<br>
        Static deployment: open <code>dist/index.html</code> (built by <code>npm run compile</code>), which bundles the engine and the analog library and needs no key and no network.</p>`;
    }
  }
}

// Last resort: anything thrown outside boot() still has to be visible on the page.
if (typeof window !== "undefined" && window.addEventListener) {
  window.addEventListener("error", (ev) => { if (!S.started) fatal(ev.error || ev.message); });
  window.addEventListener("unhandledrejection", (ev) => { if (!S.started) fatal(ev.reason); });
}

boot().catch(fatal);