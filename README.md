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
matched coverage (**10.20%** vs **9.48%**, i.e. 7.6% wider), its probability calibration **fails** a PIT
uniformity test (chi-square **208.6** vs a 5% critical value of **16.92**), and its directional hit rate is
**50.1%** — a coin toss. All three facts are shown in the product UI, in `research/VALIDATION.md`, and in
the run record. Nothing was tuned away to look better. See **[Honest results](#honest-results)**.

---

## Try it in 30 seconds — no API key, no server, no network

**Hosted:** https://lixinde586-afk.github.io/analogdesk/ — GitHub Pages, built from the `gh-pages` branch, whole engine running in your browser.

**Or locally:** `dist/` is a **fully static deployment**: the entire analog library (2513 sessions x 71 instruments), the
retrieval engine, the stress engine and the narrative renderer are compiled into one classic `<script>`
bundle that runs **in the browser** with **zero `fetch` calls**. Judges without any API key get the complete
product, model-written narrative included: seven canonical research cards ship with cached `qwen3.8-max`
generations baked into that bundle, so the language layer is visible with no key, no server and no network.

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

`node mcp-server.mjs` exposes the same desk as an **MCP tool server** over stdio (JSON-RPC 2.0, zero
dependencies): an agent host gets the identical engine, the identical numeric gate and the identical
request-normalisation disclosures as the browser UI.

Optional: copy `.env.example` to `.env` and set `LLM_API_KEY=...` to switch the narrative layer from cached
generations to a live model call. The shipped cache was generated against the Bitget hackathon gateway
`https://hackathon.bitgetops.com/v1`, model `qwen3.8-max`, with `LLM_ENABLE_THINKING=false` — that model
reasons before it writes, and with reasoning on the gateway ran 244s and returned **HTTP 504** before emitting
a word of content, while the same call answered in 2.1s with reasoning off. DashScope
(`https://dashscope.aliyuncs.com/compatible-mode/v1`, `qwen-plus`) and any other OpenAI-compatible endpoint
work by changing `LLM_BASE_URL` / `LLM_MODEL`; no code path differs. **Without a key nothing is lost** — the
app falls back to cached generations and then to the template renderer, and every card states which mode
produced it.

The cached generations are what make that sentence true, and they are produced by `npm run replay:warm`:
it runs the canonical card set through the live model, stores **only** prose that passed the numeric gate
under `data-cache/llm-replay/`, and `npm run compile` bakes those records into the static bundle as
`replaySeed`. `npm run check:replay` fails the build if that cache is empty or has drifted from the
current dataset, so the deployed site cannot silently regress to template-only prose. Records are keyed by
a digest that excludes clocks, provenance and machine timings (see `src/llm/replay.mjs`), so one warm run
serves both the keyed server and the keyless browser bundle.

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
back to the engine payload. The last demo run passed **168/168**. A number the engine did not produce cannot
be printed.

---

## Reproduce everything

Node >= 20. **No `npm install` is required — the project has zero runtime dependencies.**

```
npm run build:data     # rebuild data-cache/dataset.json from the keyless sources (network)
npm run verify         # re-run the whole out-of-sample validation -> research/VALIDATION.md
npm run measure:wrapper# re-measure the 7x24 wrapper layer -> data-cache/wrapper-probe.json
npm run measure:bitget # re-measure the official Bitget MCP on both routes -> data-cache/bitget-probe.json
npm run demo           # re-run the research task -> demo/RUN-RECORD.md
npm run replay:warm    # author-side: fill data-cache/llm-replay with real model prose (needs a key)
npm run check          # ten gates: numeric grid, LUI, markup, bundle-in-a-DOM-stub, wrapper
                       # measurement, Bitget cross-check, replay cache, MCP, server, real headless Chrome
npm run check:live     # run the same browser checks against the deployed GitHub Pages site
npm run probe          # re-measure network reachability of every source -> data-cache/network-probe.json
npm run form:text      # author-side: regenerate the paste-ready hackathon form text
npm run xpost          # author-side: regenerate the X post copy, and fail if any block exceeds
                       # 280 weighted units or drops #BitgetHackathon / @Bitget_AI
                       # both read and write submission/, which is gitignored: the hackathon form
                       # kit is logistics, not a project artefact, so it does not ship and these
                       # two commands (plus video:probe / video:link) need the author's machine
npm start              # serve the desk on http://127.0.0.1:3000
node mcp-server.mjs    # the same desk as an MCP tool server (stdio JSON-RPC 2.0) for agent hosts
npm run publish:github # publish HEAD through api.github.com (see the note below)
```

`npm run check` is ten gates (it recompiles `dist/` first), and all ten have to pass before anything
is published:

- **`check:gate`** - the numeric gate smoke test: 144 template renders, and every numeral in every one of
  them has to be traceable to the engine payload.
- **`check:lui`** - the language-understanding contract: every sentence a reviewer might type (zh + en)
  goes through the same parser the UI, the HTTP API and the MCP server share; a symbol is only resolved
  if the library really contains it, a horizon only if the engine measures it, and a fuzzy typo repair is
  reported as a repair instead of being silently applied.
- **`check:html`** - parses `web/index.html` and `dist/index.html` with an attribute-aware scanner, then
  cross-checks the element ids it finds against the ids `web/app.js` looks up and the `REQUIRED_IDS` list
  app.js asserts at boot. A regex cannot do this job: an id sitting inside another element's attribute
  value is still text in the file, but it is not an element.
- **`check:bundle`** - evaluates `dist/app.bundle.js` in Node against a DOM stub **seeded from the real
  `dist/index.html`**, so `getElementById` returns `null` for anything the markup does not actually
  contain. Then it asserts that boot completed, that the click and key handlers were attached, that all
  fifteen panels rendered, and that `fetch` was never called.
- **`check:wrapper`** - "trades 7x24" was the one claim in this project asserted rather than measured, so
  `scripts/measure-wrapper.mjs` measures it against a real venue and this gate stops the measurement from
  quietly rotting. It re-derives the acceptance rules from the file's own thresholds and refuses to publish a
  wrapper that did not pass them, a rejection that was dropped instead of recorded, or a closed-session return
  block that cannot be recomputed from its own entry and exit prices. It also locks the motivating bug by name:
  LINK (Chainlink) trades near LI Auto's share price, so a price-proximity test on its own "verifies" a crypto
  token as a tokenised Chinese EV maker. A degraded measurement is a PASS, provided it degrades loudly.
- **`check:bitget`** - the Bitget disclosure has already been wrong once, in the safe direction, so it is
  gated. Asserts that BOTH routes were measured and that the route which produced each answer is named; that
  the server identifies itself as `bitget-mcp-server` and advertises a US-equity catalog; that the
  fear-&-greed cross-check overlaps on at least 30 dates and agrees exactly, because a drift means one side
  changed meaning; that the earnings-date cross-check reports a distribution and *fails* if the same-day rate
  ever exceeds 90%, since a near-perfect match would mean the two derivations stopped being independent; that
  the empty-upstream entries stay on the record so a future run cannot quietly claim a price cross-check the
  upstream does not serve; that the whole-market sentiment reading is explicitly not consumed by the engine;
  and that the committed file contains no credential.
- **`check:replay`** - asserts the replay-cache contract twice over. First the digest invariants: two
  identical requests must hash to the same id even though `buildCard()` stamps a fresh `generatedAt`, a
  Node-side card and a browser-runtime card (rewritten provenance, trimmed validation, different timings)
  must hash identically, the model name must NOT be part of the key while the language must be, and a
  different symbol or horizon must still produce a different id. Then the cache itself: every canonical
  card must have a stored generation that still passes the numeric gate, and that id must be present in
  the compiled bundle. This gate exists because the cache shipped empty once and all seven of the other
  gates passed while the deployed site rendered the template for every card - a keyless reviewer on an AI
  track never saw a model write a sentence, and nothing failed. Waive once on a WIP branch with
  `ANALOGDESK_ALLOW_EMPTY_REPLAY=1`; never publish with it set.
- **`check:mcp`** - spawns the real `mcp-server.mjs` over stdio, performs the handshake a host performs,
  calls every tool it advertises, and asserts stdout purity, engine-computed numbers, and that a request
  which had to be adjusted says so instead of quietly answering a different question.
- **`check:server`** - spawns the real `server.mjs` and asserts its HTTP contract: the routes that must
  exist, the status codes they must return, the sentence-driven analyze call, the clamping disclosure,
  and the paths that must never be reachable.
- **`check:browser`** - serves `dist/` on 127.0.0.1 and loads it in **real headless Chrome**: two auto-run
  deep links, a cold load, and an injected probe that types a question, presses Enter, clicks a tab,
  switches the symbol and clicks Analyze, then reports a machine-readable verdict. Needs Chrome or Edge;
  set `CHROME` to an executable path to override the default locations. `npm run check:live` runs the
  same page checks against the deployed site after a publish.

The markup and browser gates exist because the first published version of this demo shipped broken. One mis-quoted
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
                     ->  distribution + path risk (MAE / MFE / drawdown breach) on RAW session OHLC
                     ->  frozen conformal multiplier -> calibrated interval
                     ->  13 stress scenarios (6 named crisis windows + 7 shock overlays)
                     ->  narrative layer (qwen3.8-max | replay cache | template) + numeric gate
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
| Path risk | MAE / MFE / drawdown breach on **raw** session OHLC against the **raw** close at the decision session; `gap20` = abs(raw open[t] / raw close[t-1] - 1). One price basis per ratio - the two are never mixed |
| Calibration | 2019-01-01 .. 2022-12-31 (fit the conformal multiplier, then freeze it) |
| Test | 2023-01-01 .. 2026-09-18 (never used to fit anything deployable) |
| Queries | 2698 out-of-sample queries x 71 instruments |
| Coverage target | 80% |

**Requests are normalised, and every normalisation is disclosed.** The desk runs on a closed grid: a horizon
outside the measured set is snapped to the nearest one, and a neighbour count outside `10..200` is clamped into
it. Any card **not** run at `k = 50` carries an on-page note saying that the frozen conformal scale and every
out-of-sample figure in the validation panel were fitted and measured at `k = 50`, so they describe that
configuration rather than the one in front of the reader. A request the engine cannot answer — unknown symbol,
a session before the library starts, too little history behind the query, no completed outcome at that horizon —
fails with a message that names the fix instead of returning a card full of en-dashes. The notes render as an
amber strip above the card, are returned by the API in `card.retrieval.notes`, and `npm run check:browser`
drives real headless Chrome through `k = 999` and back to `k = 50`, asserting the strip appears and then
disappears.

---

## Honest results

Out of sample, H = 5 sessions, 2698 queries, coverage SEs clustered by query date (38 clusters).

| Predictor | Test coverage | Clustered SE | Test width | Width at matched 80% coverage |
|---|---|---|---|---|
| **Analog + frozen conformal (this project)** | **80.8%** | +/- 1.95 pp | **10.40%** | **10.20%** |
| Analog raw p10-p90 (uncalibrated) | 73.1% | +/- 2.43 pp | 8.87% | 10.30% |
| Same-name unconditional, point-in-time | 82.4% | +/- 2.21 pp | 10.12% | **9.48%** |
| Volatility harness (60d vol x sqrt H) | 77.4% | +/- 2.31 pp | 9.67% | 10.30% |
| Pooled unconditional (whole library) | 83.1% | +/- 1.80 pp | 10.53% | 9.46% |

Fitted analog multiplier **1.310** (calibration era, frozen).

**What the engine is good at.** It hits its coverage target out of sample (80.8% vs 80.0%), and it keeps
hitting it as the horizon lengthens — at H = 20 the analog interval covers 87.4% while the same-name
unconditional band collapses to 76.6%. Its width tracks each instrument's own realised volatility
(correlation 0.960). Retrieval costs **8.5 ms** per query averaged over the 2698-query validation sweep (**14.7 ms** in a dedicated 108-query cold harness; see `research/LIMITATIONS.md` §15).

**What it is not good at.** At matched coverage it is **7.6% wider** than a band that only knows the symbol's
own history. Matched-coverage gain is negative at every measured horizon (H = 1 / 5 / 10 / 20 / 40 / 60:
-1.1% / -7.6% / -2.4% / -3.4% / -4.9% / -0.7%). Probability calibration fails. Directional accuracy is a
coin toss.
The engine's own verdict, printed on every card: *"a stress-testing and provenance instrument, not an alpha
source."* Full detail, including per-year / per-sector / per-symbol breakdowns, worst windows and what the
report does **not** show: `research/VALIDATION.md` and `research/LIMITATIONS.md`.

---

## Data and the network this was built on

Six keyless sources feed the analog library, all reachable from the build machine and all measured by
`npm run probe` (`data-cache/network-probe.json`, timestamps included). A seventh host, `api.gateio.ws`, is
used **only** to measure the tokenised-wrapper layer and never as a price source:

`api.stockanalysis.com` (daily raw OHLCV **+ adjusted close** - both bases carried per symbol, never
mixed in one ratio, 71 instruments, 10y) · `fred.stlouisfed.org`
(11 macro series) · `efts.sec.gov` (EDGAR full-text search: 8-K Item 2.02, and a 6-K fallback for foreign
private issuers) · `federalreserve.gov` (92 FOMC decision dates) · `coins.llama.fi` (BTC/ETH) ·
`api.alternative.me` (fear & greed).

Library: **2513 sessions x 71 instruments** (55 single names + 16 ETFs), 2016-09-20 .. 2026-09-18.

Rejected or unused candidates are disclosed rather than silently dropped: Yahoo Finance responds **403** to
keyless programmatic access; Stooq is reachable but kept out so every source is one keyless endpoint with a
stable contract; CoinGecko, Kraken and Wikipedia time out from this machine.

`api.gateio.ws` (Gate.io spot v4, keyless) supplies the **7x24 wrapper-layer measurement** only — tracking,
premium, spread, depth and closed-hours movement for tokenised US equities. It feeds nothing in the analog
library, the conformal scale or the validation, so adding a venue cannot move a published figure.



### Bitget — two integrations, three results, and the route each one needed

Bitget appears here twice, and the honest summary is neither "0 endpoints" nor "Bitget connected". It is also
not "Bitget works": the market-data result depends on the route, so the route is reported with it.

For the same reason `/api/provenance` reports `bitget.status` as `reachable-not-consumed` and not
`connected`: reaching the toolkit puts no Bitget figure into the engine, and a word that implied otherwise
would be exactly the overstatement this section exists to avoid. `degraded` is still the value when neither
route answers, and `narrativeStatus` stays `connected` because the narrative layer really does call that
gateway.

**Market data: 0 of 3 on a direct connection, 3 of 3 through a local proxy.** `agent.bitget.com/mcp`,
`www.bitget.com` and `api.bitget.com` all still fail at the **TCP layer** on a direct connection from the
network this build ran on (`connection-reset — TCP connection reset by peer before any HTTP response`,
reproduced from a second independent network). All three answer through a local HTTP proxy. `src/data/proxy.mjs`
implements that route as a zero-dependency CONNECT tunnel on `node:net` + `node:tls` — Node's `fetch` does not
honour a system proxy and undici's `ProxyAgent` is not importable — and `src/data/bitget-routes.mjs` probes
**both** routes and records which one produced each answer.

Through it, the official MCP completes a JSON-RPC handshake and identifies itself as
**`bitget-mcp-server@4.0.5`** with a **67-entry catalog in 5 categories** (crypto 39, **US equity 22**, ETF 3,
news 1, sentiment 2), no account and no API key. `scripts/measure-bitget.mjs` spends that session on
cross-checks against this project's own committed keyless data — not on demo calls — and commits the result to
`data-cache/bitget-probe.json`, gated by `npm run check:bitget`:

| entry | returned | checked against |
|---|---|---|
| `crypto_sentiment_crypto_fear_greed` | 400 daily readings | the `api.alternative.me` series already in the dataset — **396 overlapping dates, 396 identical, mean absolute difference 0** |
| `equity_calendar` | disclosure dates, 24 symbols | the calendar derived independently from EDGAR full-text search — **1,826 dates: 0.11% same day, 69.44% within 3 days, 70.1% within 7** |
| `equity_price_quote` | live quotes, **68 of 71** instruments | the frozen `2026-09-18` close, as **staleness** (median 1.49% drift), never as agreement |
| `equity_profile` | **24 of 24** profiles | ISIN, exchange, industry and listing date against the library's own universe metadata |
| `sentiment_market_fear_greed` | score 37.2 (`fear`) | nothing — no equivalent series here. **Recorded, not consumed** |

`equity_price_historical` and `etf_price_performance` complete the transport and return **HTTP 204 with an
empty body**. That is recorded rather than retried into a result, and it is the most consequential absence in
the file: a deep historical price cross-check against the 2,513-session library would have been the strongest
test available. `CAT`, `UUP` and `VIXY` return no quote row and are recorded as uncovered.

**The boundary is what makes this safe to add.** No Bitget figure enters the retrieval features, the frozen
conformal scale, or any number in `research/VALIDATION.md`. Those stay reproducible from keyless sources alone,
on any network, with no proxy: a reviewer who cannot reach Bitget loses the cross-check and nothing else.

**Narrative: reachable, and on the critical path.** The Bitget-operated hackathon LLM gateway
`https://hackathon.bitgetops.com/v1` answers an unauthenticated probe with HTTP 401 — reachable — and it is
the endpoint `src/llm/client.mjs` calls. Every LIVE-mode sentence, and **every generation in the committed
replay cache that a keyless reviewer reads**, was produced there with model `qwen3.8-max`. It supplies prose
and never a figure: the numeric gate rejects any numeral not present in the research card.

`probeAllBitgetRouted()` reports the two groups separately, and `reachable` keeps meaning *the market-data
toolkit is reachable*, so no panel can claim a Bitget data integration that does not exist. The header badge
reads `bitget: data reachable via 127.0.0.1:7890 · gateway reachable` on this machine and names the route
because the direct connection did not produce that answer — its tooltip carries `0/3 direct, 3/3 proxied`.
A green badge that does not say how it got there is worse than a red one. Full detail:
`research/DATA-PROVENANCE.md` §6 and §10, and `research/LIMITATIONS.md` §12.

### The 7x24 wrapper layer — measured, not asserted

The desk's headline premise is a market that never closes, but every price in the analog library is a US daily
session. That used to be the one claim with no number behind it, and `research/LIMITATIONS.md` §9 said so.
`scripts/measure-wrapper.mjs` now measures it against a venue that *is* reachable from this network — Gate.io
spot v4, public and keyless — and commits the result to `data-cache/wrapper-probe.json` (snapshot
2026-09-23T14:12:46Z). Every card carries it as `card.wrapper`, the UI has a `7x24 wrapper` tab, and
`npm run check:wrapper` gates it.

| measured | value |
|---|---|
| reference cash market closed | **81.4% of the week** (136.67h of 168h, from the library's own 2513-session calendar) |
| wrapper movement in those closed hours | **median 59.8%** of realised hourly moves (range 45.7% – 79.9%, 34 pairs x 720 hourly candles) |
| wrappers verified | **34** of 71 library instruments (**47.9%** coverage), from 256 candidates |
| candidates refused | **191**, each recorded with the test that refused it |
| tracking | median correlation **0.9543**, median tracking error **51 bp/day**, tiers 14 tight / 15 fair / 5 loose |
| premium to the raw close | median **0.08%**, worst p90 **4.09%** |
| liquidity at the snapshot | median spread **19.14 bp** (worst 175.85 bp), median **84,591 USDT** within 50 bp of the touch, median 24h quote volume **775,889 USDT** |

**The return layer.** A share of absolute movement cannot be sized, so the same 720 hourly candles per pair
also produce what the wrapper actually *returned* while the cash market was shut — the object every other part
of this desk reports:

| measured | value |
|---|---|
| weekend closed-market blocks | **136**, pooled over 34 wrappers, from **4 distinct weekends** |
| median weekend block return | **-0.002%** (p10 **-1.461%**, p90 **1.354%**, sd **1.2789%**), negative in **50%** of them |
| median intra-weekend adverse excursion | **-0.713%** (p10 **-2.9905%**, worst **-6.945%**) |
| weekends breaching -5% / -10% intra-block | **2.9%** / **0%** |
| closed-hour vs open-hour volatility | median **0.50x** per hour (range 0.229x – 2.071x) |
| overnight blocks (12h – 48h) | **612**, reported separately from the weekend ones |

Read together, the two tables say something more interesting than the headline: the movement share is large
because there are **far more** closed hours than open ones, not because each closed hour moves more — hour for
hour, closed-session price formation is **half** as volatile. The weekend tail is real but modest (p10
-1.461%, one block in 34 below -5%), and the binding limit is the sample: 720 hourly candles is roughly four
weekends, so the 136 pooled blocks are 34 wrappers over the *same* four weekends and are highly
cross-correlated. The distinct-weekend count is printed next to the pooled `n` everywhere it is quoted, and
every block recomputes from its own entry and exit prices under `check:wrapper`.

Two independent tests decide what counts as a wrapper: price within +/-7% of the underlying's **raw** session
close, *and* daily-return correlation >= 0.5 over >= 20 sessions. Price proximity alone is not evidence and
was caught being not evidence — **LINK trades near LI Auto's share price**, passes on price, and is refused on
correlation at 0.227. `check:wrapper` asserts that rejection by name.

It is a **measurement of the instrument layer, not a new price source**: nothing in retrieval, the conformal
scale or any validation figure uses it, so adding a venue cannot move a number a reviewer has already read.
The limits — one venue and not Bitget's, a conservative closed-hours convention that biases the 59.8%
*downward*, 37 instruments with no verified wrapper, a calm-market snapshot, and a return layer bounded by
four distinct weekends — are itemised in `research/LIMITATIONS.md` §9.

---

## Repo layout

```
server.mjs                 zero-dependency node:http API + static server
mcp-server.mjs             the same desk as an MCP tool server (stdio JSON-RPC 2.0, zero dependencies)
web/                       the desk UI (index.html, styles.css, app.js)
dist/                      static deployment bundle (browser-side engine, zero fetch)
src/data/                  sources.mjs, build-dataset.mjs, universe.mjs,
                           bitget.mjs (market-data MCP probe + honest degradation),
                           xstocks.mjs (tokenised-wrapper connector, verification tests, stats)
src/engine/                features, analog, distribution, stress, validation
src/llm/                   client, config, prompt, card, lui, narrate, template, replay, verify-numbers
src/desk.mjs               the facade the UI and the demo both call
scripts/                   verify.mjs, run-demo.mjs, compile-bundle.mjs, probe-network.mjs,
                           measure-wrapper.mjs (the 7x24 wrapper measurement),
                           check-{gate,lui,html,bundle,wrapper,replay,mcp,server,browser}.mjs,
                           replay-cards.mjs, warm-replay.mjs, publish-github.mjs
data-cache/                dataset.json (committed), llm-replay/ (committed),
                           network-probe.json + wrapper-probe.json (both committed measurements),
                           build-report.md, raw/ (gitignored)
research/                  VALIDATION.md, THESIS.md, DATA-PROVENANCE.md, LIMITATIONS.md
demo/                      RUN-RECORD.md, run-record.json, narrative.txt
```

## 中文说明

AnalogDesk 是一台**决策压力测试台**：你用一句自然语言说出交易想法（中英皆可，如「英伟达财报前五天会不会被砸」），
它从 2016 年以来 2513 个交易日、71 个标的中检索出**市场状态最像当下**的 50 个历史片段，展示这些片段之后
5/10/20/40/60 个交易日**真实发生**的收益分布与路径风险（最大不利偏移、回撤击穿概率），再用 6 个命名危机窗口
和 7 个冲击叠加做压力测试，最后由 LLM 写成研究卡。**每一个数字都必须能追溯到引擎输出**，通不过校验就不渲染。

- 零依赖、零密钥即可运行：打开 `dist/index.html`，或 `npm start` 后访问 `http://127.0.0.1:3000`。
- 可选填 `LLM_API_KEY` 启用实时叙述。已提交的回放缓存是用黑客松网关 `https://hackathon.bitgetops.com/v1`
  的 `qwen3.8-max` 生成的，且必须配 `LLM_ENABLE_THINKING=false`（该模型先推理再写作，开着推理时网关 244 秒后
  返回 HTTP 504，关掉后 2.1 秒返回）。7 张规范研究卡已全部预热并随包发布，**没有密钥也看得到模型写的文案**，
  卡片徽章显示 `mode: REPLAY` / `model: qwen3.8-max`；未预热的查询才回落到模板，并在卡片上标明模式。
- 诚实结论：区间**没有**比"同名无条件分布"更窄（同覆盖率下宽 7.6%），概率校准未通过 PIT 均匀性检验，
  方向命中率 50.1%。它是压力测试与溯源工具，**不是** alpha 来源，也不构成投资建议。
- 非法或越界请求会被规范化并**如实披露**：期限对齐到已测量档位（1/5/10/20/40/60），邻居数限制在 10..200；
  只要不是 k = 50，卡片上方就会出现琥珀色提示条，说明冻结的共形尺度与全部样本外指标都是在 k = 50 下拟合和测量的。
  无法回答的请求直接报错并指出怎么改，绝不返回一张空壳卡片。
- **「7x24」这句话现在是测出来的，不是喊出来的。** 类比库全部是美股日线，所以过去这是唯一一个没有数字支撑的
  主张。`scripts/measure-wrapper.mjs` 现在在本网络可达的 Gate.io 现货 v4（公开、免密钥）上测量代币化美股凭证层，
  结果提交在 `data-cache/wrapper-probe.json`，每张卡片带 `card.wrapper`，UI 有独立的「7x24 wrapper」标签页：
  参考现货市场每周有 **81.4%** 的时间休市（168 小时中的 136.67 小时，由库内 2513 个交易日的日历推出，不依赖任何交易场所）；
  34 个已验证凭证自身**已实现的小时级价格变动中，中位数 59.8% 发生在这些休市时段**（区间 45.7%–79.9%）；
  跟踪相关性中位数 0.9543，跟踪误差中位数 51 bp/日，溢价中位数 0.08%，点差中位数 19.14 bp。
  凭证必须同时通过**两道独立检验**（价格贴近原始收盘价 ±7%，且日收益相关性 ≥ 0.5）才会被采用：
  LINK 的价格接近理想汽车股价，只靠价格检验就会把一个加密代币"验证"成中概股，因此被相关性检验以 0.227 拒绝，
  `npm run check:wrapper` 会点名断言这条拒绝记录。256 个候选中 191 个被拒，**每一条拒绝及其原因都被记录**。
  - **「休市时段到底涨跌了多少」也测了，不只是「动了多少」。** 变动份额无法用来定仓位，所以同一批小时 K 线还给出了收益分布：
    **136 个周末闭市区块**（34 个凭证，但只覆盖 **4 个不同的周末**），中位收益 **-0.002%**、第 10 百分位 **-1.461%**、
    标准差 **1.2789%**、50% 为负；区块内中位最大不利偏移 **-0.713%**（第 10 百分位 -2.9905%），
    **2.9%** 的周末在区块内跌破 -5%，**0%** 跌破 -10%。按小时计，休市时段的价格形成波动只有开盘时段的 **0.50 倍**——
    也就是说变动份额之所以大，是因为休市小时数远多于开盘小时数，而不是因为每个休市小时波动更大。
    真正的约束是样本量：720 根小时线只够约四个周末，136 个区块是 34 个凭证落在**同样的四个周末**上、彼此高度相关，
    所以「不同周末数」永远和合并样本量并排印出。每个区块都能由自身的进出场价格重算，`check:wrapper` 断言这一点。
  它只是**工具层的测量**，不进入检索、共形尺度或任何验证指标，所以新增一个交易场所动不了已发布的数字。
- Bitget 有两处集成、三个结果，分开披露，并且**连同取得结果所用的路由一起披露**：**行情数据**在直连下 0/3 可达
  （`agent.bitget.com/mcp`、`www`、`api` 全部在 TCP 层被重置），但经本地 HTTP 代理 **3/3 可达**——官方 MCP 完成
  JSON-RPC 握手并自报为 `bitget-mcp-server@4.0.5`，目录含 **67 个条目 / 5 个类目**（其中**美股 22 个**），
  无需账号、无需 API Key。`src/data/proxy.mjs` 用 `node:net` + `node:tls` 零依赖实现 CONNECT 隧道，
  `scripts/measure-bitget.mjs` 把这条路由花在**与本项目自有数据的交叉验证**上而不是演示调用上：
  加密恐贪指数 **396 个重叠日期、396 个完全一致、平均绝对差 0**（对照库内 `api.alternative.me` 序列）；
  财报披露日 **1826 个**与本项目独立从 EDGAR 全文检索推出的日历相比，**同日 0.11%、3 日内 69.44%、7 日内 70.1%**；
  **68/71** 个标的取到实时报价（与冻结快照的偏离按**陈旧度**报告，中位 1.49%，绝不当作价格分歧）；
  **24/24** 份公司概况（含 ISIN）。`equity_price_historical` 与 `etf_price_performance` 返回 **HTTP 204 空体**，
  如实记录——本该最强的历史价格交叉验证因此缺席。**边界不变**：任何 Bitget 数字都不进入检索特征、冻结的共形尺度
  或 `research/VALIDATION.md` 中的任何指标；无法访问 Bitget 的评审只会失去这项交叉验证，不会失去任何已发布结论。
  **叙述层**走 Bitget 运营的黑客松网关 `https://hackathon.bitgetops.com/v1`，可达，且正是模型文案
  （含已提交的回放缓存）的实际来源。顶部徽章因此显示 `bitget: data reachable via 127.0.0.1:7890 · gateway reachable`，
  并在悬浮提示里同时给出 `0/3 direct, 3/3 proxied`——一个不说明自己怎么变绿的绿灯，比红灯更糟。

## Disclaimer

Research and engineering artefact for a hackathon. Historical, not predictive. Not investment advice.
No part of this repository executes orders or touches funds.
