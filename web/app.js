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

const HORIZON_PATTERNS = [
  { h: 1, re: /(?:next|tomorrow)\s+(?:close|session|day)|overnight|1\s*(?:个)?\s*交易日|(?:明|次)\s*(?:日|天)/i },
  { h: 5, re: /(?:one|1|a|this|the|next)\s+(?:trading\s+)?week|5\s*(?:个)?\s*(?:sessions|days|交易日)|(?:一|1|本|下|这)\s*个?\s*(?:星期|周)/i },
  { h: 10, re: /(?:two|2|fortnight)\s*(?:trading\s+)?weeks?|10\s*(?:个)?\s*(?:sessions|days|交易日)|(?:两|二|2)\s*个?\s*(?:星期|周)/i },
  { h: 20, re: /(?:one|1|a|this|the|next)\s+(?:trading\s+)?month|20\s*(?:个)?\s*(?:sessions|days|交易日)|(?:一|1|个)\s*月/i },
  { h: 40, re: /(?:two|2)\s*(?:trading\s+)?months?|40\s*(?:个)?\s*(?:sessions|days|交易日)|(?:两|二|2)\s*个?\s*月/i },
  { h: 60, re: /(?:three|3)\s*(?:trading\s+)?months?|60\s*(?:个)?\s*(?:sessions|days|交易日)|(?:三|3)\s*个?\s*月/i }
];

/** Longest-first alias list so "Meta Platforms" beats "Meta" and 阿里巴巴 beats 阿里. */
const ALIAS_LIST = [...ALIASES.keys()].sort((a, b) => b.length - a.length);
const TOKEN_RE = /\$?\b[A-Z][A-Z0-9.\-]{0,6}\b/g;

/**
 * Parse a free-text trade idea into {symbol, horizon, date, k, matched}. Deliberately conservative:
 * a ticker is only accepted if the analog library actually contains it.
 */
function parseQuery(text, lib) {
  const q = String(text || "");
  const upper = q.toUpperCase();
  const known = new Set((lib?.symbols || []).map((s) => s.symbol));
  let symbol = null, matched = null;

  for (const tok of upper.match(TOKEN_RE) || []) {
    const clean = tok.replace(/^\$/, "");
    if (known.has(clean)) { symbol = clean; matched = tok; break; }
    const via = ALIASES.get(clean);
    if (via && known.has(via)) { symbol = via; matched = tok; break; }
  }
  if (!symbol) {
    for (const a of ALIAS_LIST) {
      if (a.length < 2) continue;
      if (!upper.includes(a)) continue;
      const via = ALIASES.get(a);
      if (via && known.has(via)) { symbol = via; matched = a; break; }
    }
  }

  let horizon = null;
  for (const p of HORIZON_PATTERNS) { if (p.re.test(q)) { horizon = p.h; break; } }
  const hm = q.match(/(\d{1,3})\s*(?:个)?\s*(?:交易日|sessions?|trading days?)/i);
  if (hm) {
    const want = Number(hm[1]);
    const allowed = lib?.horizons || [1, 5, 10, 20, 40, 60];
    horizon = allowed.reduce((a, b) => (Math.abs(b - want) < Math.abs(a - want) ? b : a), allowed[0]);
  }

  let date = null;
  const dm = q.match(/\b(20\d{2})[-/.](\d{1,2})(?:[-/.](\d{1,2}))?\b/);
  if (dm) date = `${dm[1]}-${dm[2].padStart(2, "0")}-${(dm[3] || "15").padStart(2, "0")}`;

  const km = q.match(/\b(?:k|top|neighbou?rs?|邻居|类比数)\s*[=:：]?\s*(\d{1,3})\b/i);
  const k = km ? Math.max(10, Math.min(200, Number(km[1]))) : null;

  return { symbol, horizon, date, k, matched };
}

function detectLang(text) {
  const s = String(text || "");
  const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length;
  return cjk > 0 && cjk / Math.max(1, s.length) > 0.12 ? "zh" : "en";
}

const SECTION_HEADINGS = [
  { key: "verdict", en: "Verdict", zh: "结论" },
  { key: "state", en: "Why these analogs", zh: "为什么是这些类比" },
  { key: "history", en: "What happened next", zh: "随后发生了什么" },
  { key: "tails", en: "Path risk, not just endpoint", zh: "路径风险，而不只是终点" },
  { key: "stress", en: "Stress scenarios", zh: "压力情景" },
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
      return { library: l, health, provenance: prov?.provenance || null, bitget: prov?.provenance?.bitget || null };
    },
    async analyze(p) {
      const q = new URLSearchParams({ symbol: p.symbol, date: p.date || "latest", horizon: String(p.horizon), k: String(p.k), language: p.language || "auto" });
      if (p.question) q.set("question", p.question);
      if (p.includeStress === false) q.set("stress", "0");
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
    const id = cardDigest(card, { model: "", promptVersion: mods.PROMPT_VERSION || "1" });
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
        provenance: mods.provenance || {}, config: mods.config || {}
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
        bitget: (mods.provenance || {}).bitget || null
      };
    },
    async analyze(p) {
      const t0 = performance.now();
      const language = p.language && p.language !== "auto" ? p.language : detectLang(p.question || "");
      const a = desk.analyze({ symbol: p.symbol, date: p.date || "latest", horizon: p.horizon, k: p.k, includeStress: p.includeStress !== false });
      const prov = mods.provenance || {};
      a.card.provenance = { ...(a.card.provenance || {}), ...prov,
        bitget: prov.bitget || { reachable: false, summary: "not probed in the static build", endpoints: [], disclosure: prov.bitgetDisclosure || null },
        llm: { mode: "REPLAY/TEMPLATE", model: null, keyPresent: false, baseUrl: prov.llmBaseUrl || "https://dashscope.aliyuncs.com/compatible-mode/v1" },
        excludedFromDistance: prov.excludedFromDistance || ["dv20z", "fng", "hyChg20"] };
      const narrative = narrateBrowser(a.card, p.question || "", language);
      return { ok: true, question: p.question || "", language, card: a.card, detail: a.detail, narrative, wallMs: Math.round(performance.now() - t0) };
    },
    async bitget() { return (mods.provenance || {}).bitget || null; }
  };
}

/* --------------------------------- state --------------------------------- */

const S = { rt: null, boot: null, lib: null, last: null, busy: false, tab: "brief" };

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

  const bg = S.boot?.bitget || S.boot?.provenance?.bitget;
  const bb = $("badge-bitget");
  if (bg && bg.summary) {
    bb.textContent = `bitget mcp: ${bg.reachable ? "reachable" : "unreachable"}`;
    bb.className = `badge ${bg.reachable ? "ok" : "bad"}`;
    bb.title = bg.summary;
  } else {
    bb.textContent = "bitget mcp: not probed";
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
  const i = card.idea, d = card.distribution, c = card.conformal, e = card.excursion;
  const med = pc(d?.medianPct), p10 = pc(d?.p10Pct), p90 = pc(d?.p90Pct);
  $("cardbar").innerHTML = `
    <div class="headline">
      <h2>${esc(i.name)} <span class="dim mono" style="font-size:14px">${esc(i.symbol)}</span></h2>
      <div class="meta">as of ${esc(i.asOfSession)} &middot; adj close ${f(i.referenceClose, 4)} &middot; ${esc(i.horizonLabel)} &middot; ${d?.n ?? 0} analogs &middot; retrieval ${num(detail?.timing?.retrievalMs, 0)} ms</div>
    </div>
    ${kpi("median fwd", `<span class="${med.cls}">${esc(med.text)}</span>`, i.horizonLabel)}
    ${kpi("middle 80%", `${esc(p10.text)} / ${esc(p90.text)}`, "raw p10 to p90")}
    ${c ? kpi(`conformal ${pctPlain(c.coverageTargetPct, 0)}`, `${esc(pc(c.lowerPct).text)} / ${esc(pc(c.upperPct).text)}`, `width ${pctPlain(c.widthPct)}`) : ""}
    ${kpi("P(below start)", pctPlain(d?.probabilityBelowZeroPct), `${d?.n ?? 0} episodes`)}
    ${kpi("P(loss > 10%)", pctPlain(d?.probabilityBelow?.minus10Pct), "at the endpoint", (d?.probabilityBelow?.minus10Pct ?? 0) > 20 ? "neg" : "")}
    ${e ? kpi("median MAE", esc(pc(e.maxAdverseMedianPct).text), "worst intra-path print", "neg") : ""}`;
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

function renderConformal(card) {
  const c = card.conformal, d = card.distribution;
  const box = $("conformal");
  if (!c) {
    box.innerHTML = `<div class="note">No frozen conformal scale is loaded for a ${esc(card.idea.horizonLabel)} horizon. Run <code>node scripts/verify.mjs</code> to calibrate one, or pick a horizon that appears in <code>research/validation-results.json</code>.</div>`;
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
      ["analog median / sd", `${num(c.medianPct)}% / ${num(c.analogSdPct)}%`],
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
        <div class="note" style="margin-bottom:0">An episode can finish near flat and still have been un-holdable. MAE is the lowest intra-path print (adjusted low against the query close) and MFE the highest, both measured over the ${esc(card.idea.horizonLabel)}.</div>
      </div>
      <div><h3 style="margin-top:0">Share of analogs that breached a drawdown</h3>${barsSvg(breach, { unit: "%", vMax: 100 })}</div>
    </div>`;
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
      <td class="num">${pctPlain(r.heldWithin10PctDrawdown)}</td></tr>`;
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
          ["share holdable within 10% drawdown", pctPlain(r.heldWithin10PctDrawdown)]
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
      ["return basis", "adjusted close for every return; unadjusted low/high only for excursion"]
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
  $("bitget").innerHTML = bg ? `
    ${badge(bg.reachable ? "ok" : "bad", bg.reachable ? "connected" : "degraded")}
    <p class="small" style="margin-top:8px">${esc(bg.summary || "")}</p>
    ${(bg.endpoints || []).map((e) => `<div class="mono small" style="margin-bottom:3px">${e.ok ? "\u2713" : "\u2717"} ${esc(e.name)} <span class="muted">${esc(e.url)} &middot; ${esc(e.kind || "")}${e.detail ? " &middot; " + esc(e.detail) : ""}</span></div>`).join("")}
    ${bg.disclosure ? `<div class="note bad" style="margin-top:8px">${esc(bg.disclosure)}</div>` : ""}`
    : `<p class="small">Not probed in this build.</p>`;

  const llm = p.llm || {};
  $("llmpanel").innerHTML = `
    ${kv([
      ["mode", esc(llm.mode || (S.rt.kind === "BROWSER" ? "REPLAY/TEMPLATE" : "TEMPLATE"))],
      ["model", esc(llm.model || "none configured")],
      ["endpoint", `<span class="mono small">${esc(llm.baseUrl || "https://dashscope.aliyuncs.com/compatible-mode/v1")}</span>`],
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

function readParams() {
  const q = $("q").value.trim();
  const parsed = parseQuery(q, S.lib);
  return {
    question: q,
    symbol: parsed.symbol || $("symbol").value,
    horizon: parsed.horizon || Number($("horizon").value),
    date: parsed.date || $("date").value || "latest",
    k: parsed.k || Number($("k").value) || 50,
    language: $("lang").value === "auto" ? detectLang(q) : $("lang").value,
    includeStress: $("stress").checked,
    parsed
  };
}

function showParsed(p) {
  const bits = [];
  bits.push(p.parsed.symbol
    ? `symbol <b>${esc(p.symbol)}</b>${p.parsed.matched ? ` <span class="muted">from "${esc(p.parsed.matched)}"</span>` : ""}`
    : `symbol <b>${esc(p.symbol)}</b> <span class="muted">from the dropdown</span>`);
  bits.push(`horizon <b>${p.horizon}s</b>${p.parsed.horizon ? "" : ` <span class="muted">dropdown</span>`}`);
  bits.push(`as of <b>${esc(p.date === "latest" ? `${p.date} (${esc(S.lib?.to || "")})` : p.date)}</b>`);
  bits.push(`k=<b>${p.k}</b>`);
  bits.push(`lang <b>${esc(p.language)}</b>`);
  if (!p.includeStress) bits.push(`<span class="muted">stress suite off</span>`);
  $("parsed").innerHTML = bits.join(" &middot; ");
}

async function run() {
  if (!S.rt || S.busy) return;
  const p = readParams();
  showParsed(p);
  if (!p.symbol) { toast("No instrument recognised. Pick one from the Symbol dropdown, or type a ticker that is in the library.", "bad"); return; }
  S.busy = true;
  const btn = $("go"), prev = btn.innerHTML;
  btn.disabled = true; btn.innerHTML = `<span class="spin"></span>Analysing`;
  $("empty").hidden = true; $("results").hidden = false;
  $("cardbar").innerHTML = `<div class="headline"><h2>${esc(p.symbol)}</h2><div class="meta">retrieving analogs${p.includeStress ? " and running the stress suite" : ""}&hellip;</div></div>`;
  try {
    const r = await S.rt.analyze(p);
    if (!r || !r.card) throw new Error(r?.error || "the engine returned no research card");
    S.last = r;
    renderCardbar(r.card, r.detail);
    renderNarrative(r.narrative);
    renderState(r.card);
    renderConformal(r.card);
    renderDist(r.card, r.detail);
    renderStress(r.card);
    renderAnalogs(r.card, r.detail);
    renderProv(r.card);
    setBadges();
  } catch (e) {
    console.error(e);
    toast(`Analysis failed: ${e.message || e}`, "bad", 14000);
    $("cardbar").innerHTML = `<div class="headline"><h2>${esc(p.symbol)}</h2><div class="meta" style="color:var(--neg)">failed</div></div>`;
  } finally {
    S.busy = false; btn.disabled = false; btn.innerHTML = prev;
  }
}

/* --------------------------------- boot ---------------------------------- */

async function boot() {
  tabs(); fillChips();
  $("go").addEventListener("click", run);
  $("q").addEventListener("keydown", (e) => { if (e.key === "Enter") run(); });
  for (const id of ["symbol", "horizon", "date", "k", "lang", "stress"]) {
    $(id).addEventListener("change", () => { if (S.lib) showParsed(readParams()); });
  }

  const mods = window.AnalogDesk;
  try {
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
  } catch (e) {
    console.error(e);
    const br = $("badge-runtime");
    br.textContent = "runtime: failed"; br.className = "badge bad";
    $("empty").hidden = false;
    $("empty").innerHTML = `<h2>The desk did not start</h2><p class="small" style="color:var(--neg)">${esc(e.message || String(e))}</p>
      <p class="small">Server deployment: run <code>npm start</code> from the project root and open <code>http://127.0.0.1:3000</code>.<br>
      Static deployment: open <code>dist/index.html</code> (built by <code>npm run compile</code>), which bundles the engine and the analog library and needs no key and no network.</p>`;
  }
}

boot();
