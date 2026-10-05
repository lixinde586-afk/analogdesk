/**
 * AnalogDesk - collect the market signals snapshot (news / sentiment / macro).
 *
 *   node scripts/collect-signals.mjs        writes data-cache/signals.json and prints what answered
 *
 * The isomorphic fetchers live in src/data/signals.mjs (browser-safe); this runner only adds the
 * Node-side write. The committed snapshot is what the static bundle bakes and what server.mjs reads,
 * so a keyless reviewer still sees the current backdrop with every source stated.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collectSignals } from "../src/data/signals.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

const s = await collectSignals();
mkdirSync(resolve(ROOT, "data-cache"), { recursive: true });
writeFileSync(resolve(ROOT, "data-cache", "signals.json"), JSON.stringify(s, null, 2), "utf8");

console.log("[signals] fetchedAt", s.fetchedAt);
console.log("[signals] MCP reachable:", s.mcp.reachable,
  "| news:", s.mcp.returnedNews, "| sentiment:", s.mcp.returnedSentiment, "| macro:", s.mcp.returnedMacro);
console.log(`[signals] news: ${s.news.items.length} headline(s) - ${s.news.source || "none"}`);
console.log(`[signals] sentiment: F&G ${s.sentiment.fearGreed ?? "n/a"} (${s.sentiment.band}) - ${s.sentiment.source || "none"}`);
console.log(`[signals] macro: ${s.macro.items.length} level(s) from MCP - ${s.macro.source || "none"}`);
for (const g of s.gaps) console.log("[signals] gap:", g);
console.log("[signals] wrote data-cache/signals.json");
