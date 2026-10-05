/**
 * AnalogDesk - collect the market signals snapshot and write data-cache/signals.json.
 *
 * Keyless and runnable on a fresh clone: `node scripts/collect-signals.mjs`. It fetches equity-market
 * and per-symbol news, the CNN equity Fear & Greed, the crypto Fear & Greed (labelled crypto-only) and
 * probes the official bitget-signal MCP; it also computes the dataset-derived EQUITY sentiment
 * (breadth / SPY trend / VIX) and injects it. Re-run any time to refresh; the committed snapshot lets
 * the static demo render without any network.
 */
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { collectSignals } from "../src/data/signals.mjs";
import { computeEquitySentiment } from "../src/data/equity-sentiment.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const OUT = join(ROOT, "data-cache", "signals.json");
const DATASET = join(ROOT, "data-cache", "dataset.json");

let equitySentiment = null;
if (existsSync(DATASET)) {
  try {
    equitySentiment = computeEquitySentiment(JSON.parse(readFileSync(DATASET, "utf8")));
    console.log(`equity sentiment: ${equitySentiment.score}/100 ${equitySentiment.band} (as of ${equitySentiment.asOf})`);
  } catch (e) {
    console.warn(`warn  could not compute equity sentiment: ${e.message}`);
  }
} else {
  console.warn("warn  data-cache/dataset.json missing - run: npm run build:data (equity sentiment omitted)");
}

const snapshot = await collectSignals({ equitySentiment });
writeFileSync(OUT, JSON.stringify(snapshot, null, 2));

const nEquity = snapshot.news.equity.length;
const nPer = Object.values(snapshot.news.perSymbol).reduce((a, v) => a + v.length, 0);
const nCrypto = snapshot.news.crypto.length;
console.log(`signals -> ${OUT}`);
console.log(`news: ${nEquity} equity-market + ${nPer} per-symbol, ${nCrypto} crypto (separate)`);
console.log(`sentiment: equity ${snapshot.sentiment.equity?.score ?? "n/a"}, CNN ${snapshot.sentiment.equityExternal?.score ?? "n/a"}, crypto F&G ${snapshot.sentiment.crypto?.fearGreed ?? "n/a"}`);
console.log(`macro items: ${snapshot.macro.items.length}; MCP reachable=${snapshot.mcp.reachable} news=${snapshot.mcp.returnedNews} sentiment=${snapshot.mcp.returnedSentiment} macro=${snapshot.mcp.returnedMacro}`);
if (snapshot.gaps.length) console.log("gaps:\n  - " + snapshot.gaps.join("\n  - "));
