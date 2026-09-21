/**
 * AnalogDesk - runtime configuration.
 * Zero dependencies. Node only (reads process.env and .env); the browser bundle gets the same
 * shape from window.__ANALOGDESK_CONFIG__ injected by server.mjs, or from build-time defaults.
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, "..", "..");

/** Minimal .env reader: KEY=VALUE per line, `#` comments, optional surrounding quotes. */
export function parseEnv(text) {
  const out = {};
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (k) out[k] = v;
  }
  return out;
}

export function loadDotEnv(root = ROOT) {
  const p = join(root, ".env");
  if (!existsSync(p)) return {};
  try { return parseEnv(readFileSync(p, "utf8")); } catch { return {}; }
}

export const LLM_DEFAULTS = {
  baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  model: "qwen-plus",
  timeoutMs: 45000,
  maxTokens: 1400,
  temperature: 0.2
};

export function resolveConfig(env = {}) {
  const file = loadDotEnv();
  const get = (k, d) => {
    const v = env[k] ?? process.env[k] ?? file[k];
    return v == null || v === "" ? d : String(v);
  };
  const apiKey = get("LLM_API_KEY", "") || get("DASHSCOPE_API_KEY", "");
  return {
    llm: {
      baseUrl: get("LLM_BASE_URL", LLM_DEFAULTS.baseUrl).replace(/\/+$/, ""),
      apiKey,
      model: get("LLM_MODEL", LLM_DEFAULTS.model),
      timeoutMs: Number(get("LLM_TIMEOUT_MS", LLM_DEFAULTS.timeoutMs)),
      maxTokens: Number(get("LLM_MAX_TOKENS", LLM_DEFAULTS.maxTokens)),
      temperature: Number(get("LLM_TEMPERATURE", LLM_DEFAULTS.temperature)),
      enabled: Boolean(apiKey)
    },
    server: { port: Number(get("PORT", 3000)), host: get("HOST", "127.0.0.1") },
    bitget: { mcpUrl: get("BITGET_MCP_URL", "https://agent.bitget.com/mcp"), probeTimeoutMs: Number(get("BITGET_PROBE_TIMEOUT_MS", 6000)) },
    paths: { root: ROOT, cache: join(ROOT, "data-cache"), replay: join(ROOT, "data-cache", "llm-replay") },
    modes: {
      /** LIVE = real model call; REPLAY = cached model output; TEMPLATE = deterministic engine-only prose. */
      llm: apiKey ? "LIVE" : (get("ANALOGDESK_FORCE_MODE", "") === "REPLAY" ? "REPLAY" : "TEMPLATE")
    }
  };
}