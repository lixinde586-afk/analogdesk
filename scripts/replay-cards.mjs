/**
 * AnalogDesk - the canonical replay-card set.
 *
 * ONE list, read by both `scripts/warm-replay.mjs` (which fills the cache) and
 * `scripts/check-replay.mjs` (which refuses to publish without it). Two copies of this list would
 * eventually diverge, and a divergent warm set means the card a judge actually lands on is not the
 * card that was cached - the exact failure this file exists to prevent.
 *
 * The set is chosen to cover every entry point a reviewer reaches without typing anything:
 *   - the two auto-run deep links that `scripts/check-browser.mjs` loads in real headless Chrome;
 *   - the default card `npm run demo` writes into demo/RUN-RECORD.md;
 *   - the stated-drawdown-tolerance variant that `npm run check:lui` parses from "承受 10% 回撤";
 *   - one market-level (SPY) and one longer-horizon (TSLA H=20) card.
 *
 * The QUESTION TEXT is not part of the cache key - only the language is (see replay.mjs). So the
 * English and Chinese entries for one symbol/horizon are two records over the same card, and the
 * question here only decides what the model is asked to write about. Keep the NVDA English question
 * identical in spirit to DEFAULT_QUESTION in run-demo.mjs so the demo and the deep link share prose.
 *
 * A question marked required:true is one a reviewer reaches WITHOUT TYPING ANYTHING - the two
 * auto-run deep links that scripts/check-browser.mjs loads in real headless Chrome. check:replay
 * hard-fails on those and only warns on the rest, so the gate stays meaningful when the model budget
 * is small while still telling the truth about which cards fall back to TEMPLATE.
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createDesk } from "../src/desk.mjs";
import { cardDigest } from "../src/llm/replay.mjs";
import { PROMPT_VERSION } from "../src/llm/narrate.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, "..");
export const REPLAY_DIR = join(ROOT, "data-cache", "llm-replay");

export const CANONICAL_REQUESTS = [
  {
    id: "nvda-h5", symbol: "NVDA", date: "latest", horizon: 5, k: 50,
    label: "auto-run deep link #1, and the default card `npm run demo` writes",
    questions: [
      {
        language: "en", required: true,
        question: "NVDA is at its 52-week-high area after a strong run. Before I open a position, what did the " +
          "historical episodes that most resemble this state actually do over the next trading week, and " +
          "how bad does the path get in the scenarios I should be worried about?"
      },
      {
        language: "zh",
        question: "英伟达现在处在 52 周高点附近、前期涨幅很大。开仓之前，历史上和当前市场状态最像的那些片段，" +
          "在未来 5 个交易日里实际是怎么走的？我最该担心的那些情景下，路径最差会到什么程度？"
      }
    ]
  },
  {
    id: "kweb-h10", symbol: "KWEB", date: "latest", horizon: 10, k: 50,
    label: "auto-run deep link #2 (Chinese question)",
    questions: [
      { language: "zh", required: true, question: "KWEB 未来 10 个交易日，历史相似状态的分布和最大回撤" },
      { language: "en", question: "KWEB over the next 10 sessions: the distribution of the historical analogs and the worst drawdown" }
    ]
  },
  {
    id: "nvda-h5-risk10", symbol: "NVDA", date: "latest", horizon: 5, k: 50, riskTolerancePct: 10,
    label: "the stated-drawdown-tolerance card `npm run check:lui` parses from 承受 10% 回撤",
    questions: [
      { language: "zh", question: "英伟达未来 5 个交易日，我最多能承受 10% 回撤，历史上相似状态里这个止损会被打穿吗？" }
    ]
  },
  {
    id: "spy-h5", symbol: "SPY", date: "latest", horizon: 5, k: 50,
    label: "market-level card (the benchmark itself)",
    questions: [
      { language: "en", question: "SPY over the next 5 sessions: what did the states most like this one do, and how bad did the path get?" }
    ]
  },
  {
    id: "tsla-h20", symbol: "TSLA", date: "latest", horizon: 20, k: 50,
    label: "longer horizon, where the analog band holds coverage and the unconditional one collapses",
    questions: [
      { language: "en", question: "TSLA over the next 20 sessions: the realised distribution of the closest historical analogs, and the stress scenarios worth naming." }
    ]
  }
];

const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };

/**
 * Build every canonical card and its digest, exactly as a runtime would.
 * Returns one entry per (request, language) pair - that is one cache record each.
 */
export function buildCanonicalEntries() {
  const datasetPath = join(ROOT, "data-cache", "dataset.json");
  if (!existsSync(datasetPath)) {
    throw new Error("data-cache/dataset.json is missing - run: npm run build:data");
  }
  const dataset = readJson(datasetPath);
  const validationResults = readJson(join(ROOT, "research", "validation-results.json"));
  const desk = createDesk({ dataset, validationResults, provenance: {} });

  const entries = [];
  for (const spec of CANONICAL_REQUESTS) {
    const { card } = desk.analyze({
      symbol: spec.symbol, date: spec.date, horizon: spec.horizon, k: spec.k,
      includeStress: true, riskTolerancePct: spec.riskTolerancePct ?? null
    });
    for (const q of spec.questions) {
      entries.push({
        id: cardDigest(card, { promptVersion: PROMPT_VERSION, language: q.language }),
        card, language: q.language, question: q.question,
        key: `${spec.id}/${q.language}`, required: q.required === true,
        spec: { id: spec.id, label: spec.label, symbol: spec.symbol, horizon: spec.horizon, k: spec.k, date: spec.date, required: q.required === true }
      });
    }
  }
  return { desk, dataset, validationResults, entries };
}
