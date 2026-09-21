# AnalogDesk

**Pre-trade decision stress testing for tokenised US equities in a 7x24 market.**

**Live demo (no login, no API key, no network):** https://lixinde586-afk.github.io/analogdesk/
**Source:** https://github.com/lixinde586-afk/analogdesk

Ask a trade idea in plain language. AnalogDesk retrieves the historical episodes whose market state
most resembles *right now*, shows the **realised** outcome distribution of those episodes, stress-tests
the idea against named crisis windows and shock overlays, and prints where every single number came from.

> Bitget AI Base Camp Hackathon S2 · Track 3 **AI Trading Desk** · sub-theme **Decision Stress Testing**

中文快速上手见文末 **[中文说明](#中文说明)**。

**Read this first.** AnalogDesk is a research instrument, not an alpha source and not investment advice.
Its own out-of-sample test says the interval is **not sharper** than a same-name unconditional band at
matched coverage (**10.29%** vs **9.48%**, i.e. 8.5% wider), its probability calibration **fails** a PIT
uniformity test (chi-square **212.5** vs a 5% critical value of **16.92**), and its directional hit rate is
**50.6%** — a coin toss. All three facts are shown in the product UI, in `research/VALIDATION.md`, and in
the run record. Nothing was tuned away to look better. See **[Honest results](#honest-results)**.

---

## Try it in 30 seconds — no API key, no server, no network

**Hosted:** https://lixinde586-afk.github.io/analogdesk/ — GitHub Pages, built from the `gh-pages` branch, whole engine running in your browser.

**Or locally:** `dist/` is a **fully static deployment**: the entire analog library (2513 sessions x 71 instruments), the
retrieval engine, the stress engine and the narrative renderer are compiled into one classic `<script>`
bundle that runs **in the browser** with **zero `fetch` calls**. Judges without a DashScope key get the
complete product.

```
# option A - literally open the file
start dist\index.html          # Windows
open dist/index.html           # macOS

# option B - any static host / local server
npx serve dist                 # or: python -m http.server -d dist 8080
```

`dist/` deploys as-is to GitHub Pages, Netlify, Vercel or any object store; this repo publishes it from the `gh-pages` branch. Rebuild it with `npm run compile`.

## The full desk (Node server, optional LLM)

```
npm start                      # zero dependencies; open http://127.0.0.1:3000
```

Optional: copy `.env.example` to `.env` and set `DASHSCOPE_API_KEY=...` to switch the narrative layer from
the deterministic template renderer to live **qwen-plus** via the OpenAI-compatible endpoint
`https://dashscope.aliyuncs.com/compatible-mode/v1`. **Without a key nothing is lost** — the app falls back
to cached generations and then to the template renderer, and every card states which mode produced it.

## The complete research task (submission run record)

```
npm run demo
```

writes three artefacts for one full research task (NVDA, latest session, H = 5 sessions, all 13 stress
scenarios):

| File | What it is |
|---|---|
| `demo/RUN-RECORD.md` | The human-readable record: task -> protocol -> distribution -> 13 stress scenarios -> 50 retrieved analogs -> narrative -> engine validation -> data provenance -> reproduction command |
| `demo/run-record.json` | The same run as machine-readable JSON (full card, full analog list, gate report, timings) |
| `demo/narrative.txt` | The narrative layer text only |

Every numeral in the narrative passes a **verification gate**: the renderer extracts each number and traces it
back to the engine payload. The last demo run passed **142/142**. A number the engine did not produce cannot
be printed.

---

## Reproduce everything

Node >= 20. **No `npm install` is required — the project has zero runtime dependencies.**

```
npm run build:data     # rebuild data-cache/dataset.json from the keyless sources (network)
npm run verify         # re-run the whole out-of-sample validation -> research/VALIDATION.md
npm run demo           # re-run the research task -> demo/RUN-RECORD.md
npm run check          # four gates: numeric gate, markup, bundle-in-a-DOM-stub, real headless browser
npm run check:live     # run the same browser checks against the deployed GitHub Pages site
npm run probe          # re-measure network reachability of every source -> data-cache/network-probe.json
npm run form:text      # regenerate the paste-ready form text from submission/SUBMISSION.md
npm start              # serve the desk on http://127.0.0.1:3000
npm run publish:github # publish HEAD through api.github.com (see the note below)
```

`npm run check` is four gates, and all four have to pass before anything is published:

- **`check:gate`** - the numeric gate smoke test: 144 template renders, and every numeral in every one of
  them has to be traceable to the engine payload.
- **`check:html`** - parses `web/index.html` and `dist/index.html` with an attribute-aware scanner, then
  cross-checks the element ids it finds against the ids `web/app.js` looks up and the `REQUIRED_IDS` list
  app.js asserts at boot. A regex cannot do this job: an id sitting inside another element's attribute
  value is still text in the file, but it is not an element.
- **`check:bundle`** - evaluates `dist/app.bundle.js` in Node against a DOM stub **seeded from the real
  `dist/index.html`**, so `getElementById` returns `null` for anything the markup does not actually
  contain. Then it asserts that boot completed, that the click and key handlers were attached, that all
  fifteen panels rendered, and that `fetch` was never called.
- **`check:browser`** - serves `dist/` on 127.0.0.1 and loads it in **real headless Chrome**: two auto-run
  deep links, a cold load, and an injected probe that types a question, presses Enter, clicks a tab,
  switches the symbol and clicks Analyze, then reports a machine-readable verdict. Needs Chrome or Edge;
  set `CHROME` to an executable path to override the default locations. `npm run check:live` runs the
  same page checks against the deployed site after a publish.

The last two gates exist because the first published version of this demo shipped broken. One mis-quoted
attribute in `web/index.html` - a `placeholder` opened with `'` and closed with `"` - never terminated, so
the HTML tokenizer absorbed the next 25 elements (the Analyze button, every `<select>`, the tab bar, all
five result panels) into that single attribute value. The page still looked like a page and did nothing at
all. The Node-side checks passed because their DOM stub invented an element for every id it was asked for,
and a regex over the source still found `id="tabs"` as text. A reviewer found it. `check:html` and
`check:browser` are the reason the same class of failure now stops the build instead of reaching a judge,
and `web/app.js` now renders an on-page banner naming the missing elements rather than failing quietly in a
console nobody is watching.

`npm run publish:github` exists because `github.com:443` is unreachable from the network this was built on
(a TCP connect timeout, while `api.github.com` answers 200 — the same selective blocking that resets every
`*.bitget.com` connection), so `git push` cannot be used here. The script uploads the blobs, trees and commit
of `HEAD` through the Git Data API and verifies every returned SHA against git's own, aborting on mismatch.

Because the first public commit was bootstrapped through the Contents API (an empty repository rejects
`git/blobs` with HTTP 409), GitHub stamped it with its own committer timestamp. The public history therefore
carries **different commit SHAs from this working copy while every tree is byte-identical** - the publisher
verifies that on every run (`tree remote ... vs local ... -> IDENTICAL`). If `github.com` ever becomes
reachable from here, `git push --force origin main` reconciles the two; until then `npm run publish:github`
is the release path and always parents on the remote HEAD.

`data-cache/` is committed so the demo and the validation are reproducible **without** network access.
`data-cache/raw/` (the HTTP cache, 225 files) and `research/validation-results.json` (20 MB) are regenerable
and excluded from git.

---

## How it works

```
plain-language idea  ->  LUI parser (zh + en, alias table)
                     ->  state vector: 28 features in 5 weighted groups
                     ->  analog retrieval: k = 50 nearest sessions by weighted z-score distance
                     ->  realised forward returns on the ADJUSTED close (embargoed)
                     ->  distribution + path risk (MAE / MFE / drawdown breach probabilities)
                     ->  frozen conformal multiplier -> calibrated interval
                     ->  13 stress scenarios (6 named crisis windows + 7 shock overlays)
                     ->  narrative layer (qwen-plus | replay cache | template) + numeric gate
                     ->  research card, charts, provenance panel
```

**Feature groups and weights** (`src/engine/features.mjs`): name 30%, market 20%, macro 20%, crypto 10%,
event 20%. 28 features are computed; **25** enter the distance metric — `dv20z`, `fng` and `hyChg20` are
excluded because they degraded retrieval, but they stay in the payload and are still displayed.

**Retrieval protocol** (`src/engine/analog.mjs`), frozen before any test-era number was inspected:

| Rule | Value |
|---|---|
| Neighbours | k = 50 |
| z-scores | expanding **point-in-time** window, winsorised at +/- 3 sigma |
| Anti-clustering | <= 2 analogs per calendar date |
| Same-symbol gap | >= 10 trading sessions |
| Embargo | candidate session `j` eligible only if `j + H <= q` (every analog return fully realised before the decision date) |
| Outcome | forward return on the **adjusted** close, `A[q+H] / A[q] - 1` |
| Calibration | 2019-01-01 .. 2022-12-31 (fit the conformal multiplier, then freeze it) |
| Test | 2023-01-01 .. 2026-09-18 (never used to fit anything deployable) |
| Queries | 2698 out-of-sample queries x 71 instruments |
| Coverage target | 80% |

---

## Honest results

Out of sample, H = 5 sessions, 2698 queries, coverage SEs clustered by query date (38 clusters).

| Predictor | Test coverage | Clustered SE | Test width | Width at matched 80% coverage |
|---|---|---|---|---|
| **Analog + frozen conformal (this project)** | **81.8%** | +/- 1.87 pp | **10.73%** | **10.29%** |
| Analog raw p10-p90 (uncalibrated) | 72.9% | +/- 2.44 pp | 8.88% | 10.42% |
| Same-name unconditional, point-in-time | 82.4% | +/- 2.21 pp | 10.12% | **9.48%** |
| Volatility harness (60d vol x sqrt H) | 77.4% | +/- 2.31 pp | 9.67% | 10.30% |
| Pooled unconditional (whole library) | 83.1% | +/- 1.80 pp | 10.53% | 9.46% |

Fitted analog multiplier **1.348** (calibration era, frozen).

**What the engine is good at.** It hits its coverage target out of sample (81.8% vs 80.0%), and it keeps
hitting it as the horizon lengthens — at H = 20 the analog interval covers 86.9% while the same-name
unconditional band collapses to 76.6%. Its width tracks each instrument's own realised volatility
(correlation 0.955). Retrieval costs **8.4 ms** per query averaged over the 2698-query validation sweep (**14.7 ms** in a dedicated 108-query cold harness; see `research/LIMITATIONS.md` §15).

**What it is not good at.** At matched coverage it is **8.5% wider** than a band that only knows the symbol's
own history. Matched-coverage gain is negative at H = 5/10/20/40 (-8.5% / -3.4% / -5.3% / -5.5%) and only
marginally positive at H = 1 (+0.4%). Probability calibration fails. Directional accuracy is a coin toss.
The engine's own verdict, printed on every card: *"a stress-testing and provenance instrument, not an alpha
source."* Full detail, including per-year / per-sector / per-symbol breakdowns, worst windows and what the
report does **not** show: `research/VALIDATION.md` and `research/LIMITATIONS.md`.

---

## Data and the network this was built on

Six keyless sources, all reachable from the build machine and all measured by `npm run probe`
(`data-cache/network-probe.json`, timestamps included):

`api.stockanalysis.com` (daily OHLCV + adjusted close, 71 instruments, 10y) · `fred.stlouisfed.org`
(11 macro series) · `efts.sec.gov` (EDGAR full-text search: 8-K Item 2.02, and a 6-K fallback for foreign
private issuers) · `federalreserve.gov` (92 FOMC decision dates) · `coins.llama.fi` (BTC/ETH) ·
`api.alternative.me` (fear & greed).

Library: **2513 sessions x 71 instruments** (55 single names + 16 ETFs), 2016-09-20 .. 2026-09-18.

Rejected or unused candidates are disclosed rather than silently dropped: Yahoo Finance responds **403** to
keyless programmatic access; Stooq is reachable but kept out so every source is one keyless endpoint with a
stable contract; CoinGecko, Kraken and Wikipedia time out from this machine.

### Bitget official MCP — degraded, disclosed

**0 of 3** Bitget endpoints (`agent.bitget.com/mcp`, `www.bitget.com`, `api.bitget.com`) are reachable from
the network this build ran on. Every attempt fails at the **TCP layer**: `connection-reset — TCP connection
reset by peer before any HTTP response`. AnalogDesk therefore ships **no Bitget-sourced figure**. The
connector is implemented (`src/data/bitget.mjs`), probes on start-up, classifies the transport error, and
renders the degradation in the provenance panel of every card instead of hiding it. The run record states
which probe run the evidence comes from.

---

## Repo layout

```
server.mjs                 zero-dependency node:http API + static server
web/                       the desk UI (index.html, styles.css, app.js)
dist/                      static deployment bundle (browser-side engine, zero fetch)
src/data/                  sources.mjs, build-dataset.mjs, universe.mjs, bitget.mjs
src/engine/                features, analog, distribution, stress, validation
src/llm/                   client, config, prompt, card, narrate, template, replay, verify-numbers
src/desk.mjs               the facade the UI and the demo both call
scripts/                   verify.mjs, run-demo.mjs, compile-bundle.mjs, probe-network.mjs,
                           check-{gate,html,bundle,browser}.mjs, publish-github.mjs
data-cache/                dataset.json (committed), network-probe.json, build-report.md, raw/ (git)
research/                  VALIDATION.md, THESIS.md, DATA-PROVENANCE.md, LIMITATIONS.md
demo/                      RUN-RECORD.md, run-record.json, narrative.txt
submission/                SUBMISSION.md (form text), PROJECT-DESCRIPTION-{EN,CN}.txt (paste-ready,
                           generated by `npm run form:text`), YOUR-THREE-TASKS.md
```

## 中文说明

AnalogDesk 是一台**决策压力测试台**：你用一句自然语言说出交易想法（中英皆可，如「英伟达财报前五天会不会被砸」），
它从 2016 年以来 2513 个交易日、71 个标的中检索出**市场状态最像当下**的 50 个历史片段，展示这些片段之后
5/10/20/40/60 个交易日**真实发生**的收益分布与路径风险（最大不利偏移、回撤击穿概率），再用 6 个命名危机窗口
和 7 个冲击叠加做压力测试，最后由 LLM 写成研究卡。**每一个数字都必须能追溯到引擎输出**，通不过校验就不渲染。

- 零依赖、零密钥即可运行：打开 `dist/index.html`，或 `npm start` 后访问 `http://127.0.0.1:3000`。
- 可选填 `DASHSCOPE_API_KEY` 启用 qwen-plus 实时叙述；没有密钥时自动回落到回放缓存/模板，并在卡片上标明模式。
- 诚实结论：区间**没有**比"同名无条件分布"更窄（同覆盖率下宽 8.5%），概率校准未通过 PIT 均匀性检验，
  方向命中率 50.6%。它是压力测试与溯源工具，**不是** alpha 来源，也不构成投资建议。
- Bitget 官方 MCP 在本构建网络下 TCP 层被重置（0/3 可达），已如实披露，产品中不含任何 Bitget 来源数字。

## Disclaimer

Research and engineering artefact for a hackathon. Historical, not predictive. Not investment advice.
No part of this repository executes orders or touches funds.