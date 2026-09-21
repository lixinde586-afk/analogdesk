/**
 * AnalogDesk - OpenAI-compatible chat client.
 * Zero dependencies (global fetch, Node 18+ / any modern browser).
 *
 * Target: Alibaba Cloud Model Studio (DashScope) compatible-mode endpoint, model qwen-plus.
 * Any OpenAI-compatible base URL works by changing LLM_BASE_URL / LLM_MODEL, so the same code path
 * covers SiliconFlow and ModelScope from inside mainland China.
 *
 * This module never throws on a missing key or an unreachable endpoint: it returns a discriminated
 * result so the caller can degrade to replay/template instead of showing a stack trace to a judge.
 */

export class LlmResult {
  constructor({ ok, text = "", mode = "LIVE", model = "", error = null, usage = null, latencyMs = 0, attempts = 0 }) {
    this.ok = ok; this.text = text; this.mode = mode; this.model = model;
    this.error = error; this.usage = usage; this.latencyMs = latencyMs; this.attempts = attempts;
  }
}

export function buildEndpoint(baseUrl, path = "/chat/completions") {
  return `${String(baseUrl).replace(/\/+$/, "")}${path}`;
}

/**
 * @param {{baseUrl:string,apiKey:string,model:string,timeoutMs?:number,maxTokens?:number,temperature?:number}} cfg
 * @param {{role:string,content:string}[]} messages
 * @param {{retries?:number, json?:boolean, signal?:AbortSignal}} opts
 */
export async function chat(cfg, messages, opts = {}) {
  const t0 = Date.now();
  if (!cfg?.apiKey) return new LlmResult({ ok: false, mode: "LIVE", model: cfg?.model || "", error: "no api key configured" });
  if (typeof fetch !== "function") return new LlmResult({ ok: false, mode: "LIVE", error: "fetch unavailable in this runtime" });

  const retries = opts.retries ?? 1;
  const body = {
    model: cfg.model,
    messages,
    temperature: cfg.temperature ?? 0.2,
    max_tokens: cfg.maxTokens ?? 1400,
    stream: false
  };
  if (opts.json) body.response_format = { type: "json_object" };

  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await fetch(buildEndpoint(cfg.baseUrl), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify(body),
        signal: opts.signal ?? AbortSignal.timeout(cfg.timeoutMs ?? 45000)
      });
      const raw = await r.text();
      if (!r.ok) {
        lastErr = `HTTP ${r.status}: ${raw.slice(0, 220)}`;
        if (r.status === 429 || r.status >= 500) { await sleep(600 * (attempt + 1)); continue; }
        break;
      }
      const j = JSON.parse(raw);
      const text = j?.choices?.[0]?.message?.content ?? j?.output?.text ?? "";
      if (!text) { lastErr = "empty completion"; continue; }
      return new LlmResult({
        ok: true, mode: "LIVE", model: j?.model || cfg.model, text: String(text).trim(),
        usage: j?.usage || null, latencyMs: Date.now() - t0, attempts: attempt + 1
      });
    } catch (e) {
      lastErr = e?.cause?.code || e?.message || String(e);
      await sleep(500 * (attempt + 1));
    }
  }
  return new LlmResult({ ok: false, mode: "LIVE", model: cfg?.model || "", error: lastErr || "unknown", latencyMs: Date.now() - t0, attempts: retries + 1 });
}

/** Cheap reachability check used by the UI to show the real mode instead of guessing. */
export async function probeLlm(cfg, timeoutMs = 8000) {
  if (!cfg?.apiKey) return { ok: false, reason: "no-api-key", mode: cfg?.enabled ? "LIVE" : "TEMPLATE" };
  const t0 = Date.now();
  try {
    const r = await fetch(buildEndpoint(cfg.baseUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({ model: cfg.model, messages: [{ role: "user", content: "ping" }], max_tokens: 1, stream: false }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    return { ok: r.ok, status: r.status, latencyMs: Date.now() - t0, reason: r.ok ? null : `HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - t0, reason: e?.cause?.code || e?.message || String(e) };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));