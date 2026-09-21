/**
 * AnalogDesk - replay cache.
 *
 * A live model call costs latency, money and network reachability, none of which a judge reviewing
 * a static deployment has. So every successful generation is stored against a digest of the exact
 * card + prompt version + model that produced it, and can be replayed verbatim later. Replayed text
 * still goes through the numeric gate: a cache is not a licence to skip verification.
 *
 * Two stores, same interface:
 *   NodeStore    - JSON files under data-cache/llm-replay, used by server.mjs and the CLI
 *   MemoryStore  - a plain object, used by the browser bundle (seeded at build time)
 */

export function cardDigest(card, { model = "", promptVersion = "1" } = {}) {
  const canon = JSON.stringify(card, Object.keys(card || {}).sort());
  const key = `${promptVersion}|${model}|${canon}`;
  // FNV-1a 32-bit over the canonical string, then mixed with a length term. Deterministic, no deps.
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  h = (h ^ (key.length * 2654435761)) >>> 0;
  return h.toString(16).padStart(8, "0");
}

export class MemoryStore {
  constructor(seed = {}) { this.map = new Map(Object.entries(seed || {})); }
  async get(id) { return this.map.get(id) || null; }
  async set(id, rec) { this.map.set(id, rec); return id; }
  async list() { return [...this.map.keys()]; }
}

export function createNodeStore(dir) {
  const { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } = require_fs();
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = (id) => `${dir.replace(/[\\/]+$/, "")}/${id}.json`;
  return {
    dir,
    async get(id) {
      try { return JSON.parse(readFileSync(path(id), "utf8")); } catch { return null; }
    },
    async set(id, rec) {
      try { writeFileSync(path(id), JSON.stringify(rec, null, 2), "utf8"); } catch { /* read-only fs: replay simply won't persist */ }
      return id;
    },
    async list() {
      try { return readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")); } catch { return []; }
    }
  };
}

let _fs = null;
function require_fs() {
  if (_fs) return _fs;
  // Lazy, guarded: keeps this module importable in a browser bundle where node:fs does not exist.
  try {
    // eslint-disable-next-line no-undef
    _fs = globalThis.__analogdeskFs || null;
  } catch { _fs = null; }
  if (!_fs) throw new Error("node fs not registered - call registerNodeFs() or use MemoryStore");
  return _fs;
}

/** server.mjs calls this once at startup so this module stays browser-safe. */
export function registerNodeFs(fsModule) { _fs = fsModule; }