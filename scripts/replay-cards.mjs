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
    label: "longer horizon, where the analog band holds coverage and the unconditional one collapses; also example chip #3",
    questions: [
      { language: "en", question: "TSLA over the next 20 sessions: the realised distribution of the closest historical analogs, and the stress scenarios worth naming." },
      {
        language: "zh", required: true,
        question: "特斯拉未来一个月，类比历史上相似状态的分布，最大回撤有多深？"
      }
    ]
  },
  /*
   * The remaining example chips. web/app.js offers six one-click questions, and a click is the first
   * thing a reviewer does on a static demo with no key: if the card behind a chip is not cached, that
   * reviewer's first contact with the "AI Trading Desk" track is the template renderer saying model
   * reasoning is unavailable. So every chip is a canonical card, and check:replay fails the build
   * rather than let one of them quietly degrade to TEMPLATE. The question text is copied verbatim from
   * EXAMPLES in web/app.js; only the parsed spec and the language enter the digest.
   */
  {
    id: "baba-h5", symbol: "BABA", date: "latest", horizon: 5, k: 50,
    label: "example chip #2 (an earnings-week question on a China ADR, where the 6-K fallback is what makes the event feature exist)",
    questions: [
      {
        language: "en", required: true,
        question: "Should I buy BABA into earnings this week? What did similar states do next?"
      }
    ]
  },
  {
    id: "spy-h5-2020-03-16", symbol: "SPY", date: "2020-03-16", horizon: 5, k: 50,
    label: "example chip #5 (an as-of date inside the worst window in the library, so the card describes a known crash rather than forecasting one)",
    questions: [
      {
        language: "en", required: true,
        question: "What does the analog set say about SPY as of 2020-03-16 over 5 sessions?"
      }
    ]
  },
  {
    id: "qqq-h5", symbol: "QQQ", date: "latest", horizon: 5, k: 50,
    label: "example chip #6 (an index card no verified 7x24 venue lists, so the venue overlay is skipped and the suite says why)",
    questions: [
      {
        language: "en", required: true,
        question: "QQQ next week if volatility spikes two sigma - how un-holdable does the path get?"
      }
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
  // The committed 7x24 wrapper measurement MUST be loaded here. card.wrapper is part of the card and
  // therefore part of the digest, so a canonical card built without it hashes to an id no runtime will
  // ever compute - the exact failure mode scripts/check-replay.mjs was written to catch, arriving from
  // a new direction. server.mjs and the compiled bundle both read the same file.
  const wrapper = readJson(join(ROOT, "data-cache", "wrapper-probe.json"));
  if (!wrapper) console.warn("  warn  data-cache/wrapper-probe.json is missing - canonical cards will carry no wrapper block and will not match a card built where it exists. Run: node scripts/measure-wrapper.mjs");
  // data-cache/bitget-7x24.json is the PRIMARY venue of the same 7x24 layer, and card.wrapper names which
  // venue headed the card. A canonical card built without it therefore hashes to the Gate.io-headed id
  // while the compiled bundle and server.mjs hash to the Bitget-headed one, and every warmed record
  // misses in one runtime or the other - the digest drift check:replay exists to catch, arriving from
  // the venue direction. Trimmed exactly as scripts/compile-bundle.mjs trims it: the two dropped fields
  // are the only ones no card ever reads, so all three runtimes still hash to one id.
  const bitget7x24Full = readJson(join(ROOT, "data-cache", "bitget-7x24.json"));
  const bitget7x24 = bitget7x24Full ? (() => {
    const { observedTickerFields, catalog, ...rest } = bitget7x24Full;
    return { ...rest, catalog: catalog ? { rows: catalog.rows, rwaFlagged: catalog.rwaFlagged, exchangesReported: catalog.exchangesReported, note: catalog.note } : null };
  })() : null;
  if (!bitget7x24) console.warn("  warn  data-cache/bitget-7x24.json is missing - canonical cards head the Gate.io second venue and will not match a bundle built where the primary venue exists. Run: node scripts/measure-bitget-7x24.mjs");
  const desk = createDesk({ dataset, validationResults, provenance: {}, wrapper, bitget7x24 });

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
