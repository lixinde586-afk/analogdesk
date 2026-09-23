# AnalogDesk — data provenance

Every number AnalogDesk prints comes from `data-cache/dataset.json`. This document says exactly where that
file came from, what each source contributed, how sparse series were aligned, and what is **known to be
imperfect**. Nothing here is asserted from memory: the counts were recomputed from the dataset and the
reachability facts from `data-cache/network-probe.json`.

- Dataset: `data-cache/dataset.json`, **8.03 MB** (raw + adjusted closes for every symbol), built `2026-09-22T13:56:48.697Z` in ~9 s
- Trading calendar: **2016-09-20 .. 2026-09-18, 2513 sessions**
- Instruments: **71** (55 single names + 16 ETFs), all 71 with prices
- HTTP cache: `data-cache/raw/` — 225 files, 20.8 MB (regenerable, excluded from git)
- Build report with per-symbol row counts: `data-cache/build-report.md`
- Build log: `data-cache/build-log.txt`

Rebuild from scratch with `npm run build:data`. The build is idempotent against the raw cache: with a warm
cache it issues network requests only for what is missing (in the last run, only the new 6-K queries).

---

## 1. Sources actually used (all keyless)

| Source | Endpoint | Contributes | Records in the dataset |
|---|---|---|---|
| `api.stockanalysis.com` | `/api/symbol/s/{SYM}/history?range=10Y&period=Daily` | daily **raw OHLCV + adjusted close** for all 71 instruments (both bases carried per symbol) | 2513 sessions x 71 symbols (4 names shorter, see §4) |
| `fred.stlouisfed.org` | `/graph/fredgraph.csv?id={SERIES}&cosd=...` | 11 macro series | see §3 |
| `efts.sec.gov` (EDGAR full-text search) | `/LATEST/search-index?q="Item 2.02"&forms=8-K&ciks={CIK}` and the 6-K fallback in §2 | earnings announcement dates for 55 filers | **2680 events** |
| `www.federalreserve.gov` | `/monetarypolicy/fomccalendars.htm` + `fomc_historical.htm` | FOMC decision dates parsed from document URLs | **92 dates**, 2012-01-25 .. 2026-09-16 |
| `coins.llama.fi` | `/chart/coingecko:{id}?start=...&span=...&period=1d` | BTC and ETH daily history | BTC **3890** obs (2016-01-01 .. 2026-09-19), ETH **3883** obs |
| `api.alternative.me` | `/fng/?limit=...` | crypto fear & greed index | FNG **3149** obs, 2018-02-01 .. 2026-09-19 |

SEC EDGAR is accessed with a declared User-Agent contact string, as the SEC requires. EDGAR full-text search
occasionally returns HTTP 500 for a given query; the pipeline retries with exponential backoff and the raw
response is cached, so a transient 500 cannot silently change the dataset.

**Forward returns use the adjusted close**, never the raw close: `A[q+H] / A[q] - 1`. Splits and dividends are
therefore inside the outcome variable, which matters for names like NVDA and TSLA over a ten-year library.

**Path risk uses the raw session OHLC**, never the adjusted close: MAE / MFE / drawdown breach divide the raw
highs and lows by the **raw close of the decision session**, and `gap20` is abs(raw open[t] / raw close[t-1]
- 1). One price basis per ratio — the two bases never appear in the same division, because the adjusted
series is not a price anyone traded at in a past session. `build-dataset.mjs` carries both closes for every
symbol, `build-report.md` records the bases, and `features.mjs` refuses to build the matrix for a symbol
whose raw close is missing (hard error) rather than silently falling back to the adjusted one.

---

## 2. Earnings dates: the 8-K path and the 6-K fallback

Domestic filers announce results on **8-K Item 2.02**. Foreign private issuers — the six China ADRs in this
universe — do not file 8-K at all; they furnish **6-K**. Without a fallback those six names would carry no
earnings feature, and the `Earnings release day` stress scenario would silently skip them.

The fallback runs two full-text queries per ADR (`q="unaudited"` and `q="financial results"`, `forms=6-K`) and
clusters the resulting filing dates at **6 calendar days** to collapse the duplicate hits a single announcement
produces across the two queries.

| Symbol | Raw 6-K hits | Clustered events |
|---|---|---|
| BABA | 179 | 92 |
| BIDU | 167 | 81 |
| JD | 161 | 78 |
| NIO | 193 | 61 |
| LI | 175 | 56 |
| PDD | 74 | 34 |
| **Total** | **949** | **402** |

**402 of 2680 earnings events (15.0%)** come through the 6-K path; the 8-K path contributed 2346 raw hits for
the other 49 filers.

**Known imperfection, disclosed.** Ten years of quarterly cadence is roughly 40 announcements. BABA (92),
BIDU (81) and JD (78) sit well above that, because 6-K full-text search also catches interim operating
updates and other furnished material that mentions unaudited results. The consequence is that `dte`
(sessions to next earnings) and `eventLoad5` are **noisier for these six names** than for domestic filers, and
the `Earnings release day` overlay fires more often for them. This was measured, judged preferable to the
alternative (six instruments with no event feature at all), and is listed in `research/LIMITATIONS.md` rather
than quietly corrected.

---

## 3. Macro series, as measured

All sparse series are mapped onto the trading calendar with **forward-fill** (`ffill` in
`src/engine/features.mjs`), so a holiday or a publication lag carries the last observation forward instead of
producing a hole.

| Series | Obs | Coverage | Note |
|---|---|---|---|
| `VIXCLS` | 2875 | 2015-06-01 .. 2026-09-17 | CBOE VIX close |
| `T10Y2Y` | 2827 | 2015-06-01 .. 2026-09-18 | curve slope |
| `T10YIE` | 2827 | 2015-06-01 .. 2026-09-18 | 10y breakeven inflation |
| `DGS10` | 2826 | 2015-06-01 .. 2026-09-17 | |
| `DGS3MO` | 2826 | 2015-06-01 .. 2026-09-17 | fixed this build: the id was `DGS3M`, which 404s |
| `DFEDTARU` | 4128 | 2015-06-01 .. 2026-09-18 | policy rate upper limit |
| `DTWEXBGS` | 2815 | 2015-06-01 .. **2026-09-11** | broad dollar index; last obs 5 sessions stale at build time |
| `DCOILWTICO` | 2827 | 2015-06-01 .. **2026-09-15** | WTI; 3 sessions stale |
| `BAMLH0A0HYM2` | **787** | **2023-09-19** .. 2026-09-17 | high-yield OAS — **no observations before 2023-09-19** |
| `CPIAUCSL` | 134 | 2015-06-01 .. 2026-08-01 | monthly; largest gap 23 sessions, by construction |
| `NASDAQCOM` | 2844 | 2015-06-01 .. 2026-09-18 | growth proxy |

Two of these shaped the engine design:

1. **`BAMLH0A0HYM2` does not exist before 2023-09-19.** The derived feature `hyChg20` is therefore empty for
   most of the library. It is still computed, still carried in the payload and still displayed, but it is
   **excluded from the distance metric** — a feature that is null for 70% of the analog library cannot
   participate in a nearest-neighbour search. This is a data-availability fact, not a tuning choice.
2. **`FNG` starts 2018-02-01**, so `fng` is null for the first ~16 months. It is excluded from the distance
   metric for the same reason. `dv20z` is excluded on retrieval-quality grounds (see `research/VALIDATION.md`
   §1). All three exclusions are stated on every card and in the UI.

**Publication lag.** Macro series end 1-5 sessions before the price calendar does. Forward-fill means the most
recent sessions carry a slightly stale macro state. The effect is identical for the query date and for every
historical analog date, so it does not create look-ahead — but it does mean the "current state" vector is
built from information that was genuinely available, which is the point.

---

## 4. Gaps and short histories

| Symbol | Rows | First session | Reason |
|---|---|---|---|
| PLTR | 1498 | 2020-10-01 | direct listing |
| LI | 1541 | 2020-07-31 | IPO |
| NIO | 2014 | 2018-09-13 | IPO |
| PDD | 2047 | 2018-07-27 | IPO |

The other 67 instruments have the full 2513 sessions. The 16 ETFs carry **0** earnings events by construction.
Rows before an instrument's first session are absent, not zero-filled: the analog engine only ever considers
sessions where the instrument actually traded, and the expanding point-in-time z-score window for a feature
only uses rows that exist.

---

## 5. Sources measured and **not** used

Reported as measured by `npm run probe` (`scripts/probe-network.mjs`), run at `2026-09-21T05:59:50.191Z` on
win32 / node v24.21.0:

| Candidate | Result | Decision |
|---|---|---|
| `query1.finance.yahoo.com` | reachable, **HTTP 403** | not used — keyless programmatic access is rejected (crumb + cookie required), so it would be a fragile dependency |
| `stooq.com` | reachable, **HTTP 200** | not used — kept out deliberately so every source in the pipeline is one keyless endpoint with a stable contract; adding a second price vendor would make price differences a data story instead of a market story |
| `api.coingecko.com` | **connect timeout** | not used — `coins.llama.fi` serves the same BTC/ETH history |
| `api.kraken.com` | **connect timeout** | not used — same |
| `en.wikipedia.org` | **connect timeout** | not used — no narrative depends on it |
| `api.github.com`, `registry.npmjs.org` | reachable, HTTP 200 | available; the project has zero runtime dependencies, so npm is tooling only |
| `api.gateio.ws` | reachable, **HTTP 200** keyless | **USED for measurement only** — Gate.io spot v4 supplies the tokenised-equity wrapper layer (tracking, premium, spread, depth, closed-hours movement) for `scripts/measure-wrapper.mjs`. It is never a price source for the analog library; see section 9 |
| `hackathon.bitgetops.com` | reachable, **HTTP 200** with the hackathon key | the endpoint the committed replay cache was generated from: model `qwen3.8-max` with `enable_thinking:false`, the only model this key admits (`qwen-plus` and `qwen3-max` return 403 `Model.AccessDenied`). Narrative text only - it never supplies a figure |
| `*.bitget.com`, re-tested | **connection-reset** on all three endpoints, from a second independent network | the 0/3 result in section 6 is not an artefact of one machine's network - it reproduces elsewhere, which is why no Bitget-sourced figure ships |

---

## 6. Bitget official MCP — degraded, and disclosed

`agent.bitget.com/mcp` (JSON-RPC `tools/list`), `www.bitget.com` and `api.bitget.com` were each probed 3 times.
**0 of 3 reachable.** Every attempt fails at the transport layer:

```
kind: connection-reset
detail: TCP connection reset by peer before any HTTP response
probedAt: 2026-09-21T06:00:38.530Z (agent.bitget.com/mcp: 1038 ms, www: 230 ms, api: 656 ms)
```

This is a TCP reset, not an HTTP error: no status code, no body, no application-layer response. The connector
is fully implemented in `src/data/bitget.mjs` — endpoint list, JSON-RPC handshake, timeout, and an error
classifier that walks the `cause` chain so `ECONNRESET` / `ETIMEDOUT` / `ENOTFOUND` / `ECONNREFUSED` /
`UND_ERR_CONNECT_TIMEOUT` are named precisely instead of collapsing into "fetch failed".

Consequences, stated plainly:

- AnalogDesk ships **no Bitget-sourced figure**. Every number comes from the six keyless sources above.
- The probe runs at start-up and its result is rendered in the provenance panel of every card and in
  `demo/RUN-RECORD.md` §8, with the probe timestamp and which probe run the classification came from.
- Where a run has no direct network egress (for example inside a sandbox), the live probe can only report a
  generic transport failure. In that case the run **falls back to the persisted, classified probe** in
  `data-cache/network-probe.json` and says so, rather than printing a vaguer error. See `bitgetProbeSource`
  in `demo/run-record.json`.
- The tokenised-equity framing of the thesis is therefore about the *market structure* Bitget is building
  (7x24 trading of US equity exposure), not about data taken from Bitget in this build.

---

## 7. Point-in-time discipline

Provenance is not only "where the data came from" but "what was knowable when":

- Feature z-scores use an **expanding window** up to the query session only (`robustStats` with a cutoff
  index). No future mean or standard deviation ever enters a historical query.
- The analog **embargo** requires `j + H <= q`: a candidate episode is eligible only if its forward return was
  fully realised before the decision date. Nothing partially overlapping the query window can be retrieved.
- The conformal multiplier is fitted on 2019-01-01 .. 2022-12-31 and **frozen**. The test era
  (2023-01-01 .. 2026-09-18) is never used to fit anything deployable.
- `scripts/verify.mjs` recomputes every published number from `data-cache/dataset.json` at run time; nothing
  in `research/VALIDATION.md` is hand-entered.

## 8. Trust boundaries

`api.stockanalysis.com` and `api.alternative.me` are free, keyless endpoints with no published SLA and no
contract guarantee. They were chosen because a judge can reproduce the build without registering for anything.
The cost is that a schema change upstream would break the build; the mitigation is the raw HTTP cache in
`data-cache/raw/`, which makes every committed dataset byte-for-byte reproducible offline, and the committed
`dataset.json` itself, which lets the demo, the validation and the static bundle run with no network at all.
---

## 9. The 7x24 wrapper-layer measurement

Sections 1–8 describe the data the **analog library** is built from. This section describes the only data in
the project that comes from a trading venue, and it is kept separate on purpose: it is a *measurement of the
instrument layer*, and no retrieval, conformal or validation figure uses any of it. Adding a venue must not be
able to move a published number, so it cannot.

**Why it exists.** The thesis is about a market that never closes, but every price above is a US daily
session. `research/LIMITATIONS.md` §9 used to state that plainly: nothing in the repo measured a weekend. That
gap is now closed for the instrument layer.

**Venue.** `api.gateio.ws` — Gate.io spot v4, public and keyless (`/spot/currency_pairs`, `/spot/tickers`,
`/spot/order_book`, `/spot/candlesticks`). Chosen because it is reachable from this network and lists
tokenised US equities against USDT; the Bitget market-data endpoints are not (§6). Reachability is measured
by `npm run probe` alongside every other host and recorded in `data-cache/network-probe.json`.

**Connector.** `src/data/xstocks.mjs` — URL builders, the two verification tests, the pure statistics, a
reachability probe symmetric with the Bitget one, and a `venueDegradation()` block so an unreachable venue
produces a disclosure rather than a number.

**Runner.** `scripts/measure-wrapper.mjs` → `data-cache/wrapper-probe.json` (committed, ~129 KB, snapshot
`2026-09-23T10:51:11Z`). Read as *data* by `server.mjs`, `mcp-server.mjs`, `scripts/run-demo.mjs`,
`scripts/replay-cards.mjs` and the compiled bundle — never fetched at request time, because a live order book
changes every second and a card whose numbers move between runs cannot be matched against the replay cache.

**Verification — two independent tests, both required.**

1. **Price.** The wrapper's last traded price must sit within +/-7% of the underlying's last **raw** session
   close (`prices[sym].c`). Never the dividend-adjusted close (`prices[sym].a`), which sits below it by the
   cumulative dividend factor — comparing across bases would fail every dividend payer.
2. **Correlation.** Daily returns must correlate >= 0.5 with the underlying's over >= 20 overlapping library
   sessions. Tracking error (sd of the daily return difference, bp/day) is reported next to it and the pair is
   tiered `tight` / `fair` / `loose`; the tier is always shown with the number.

Test 1 alone is not evidence and was caught being not evidence: **LINK (Chainlink) trades near LI Auto's share
price**, so a price-only rule would have "verified" a crypto token as a tokenised Chinese EV maker. It is
refused by test 2 at correlation 0.227. `scripts/check-wrapper.mjs` asserts that specific rejection by name,
so loosening the correlation floor fails the build.

**Discovery is deliberately permissive, verification is not.** Any base starting with the underlying's ticker
and quoted in USDT, with up to three extra characters, is a candidate — Gate.io lists the same underlying from
more than one issuer (`G` 27, `X` 17, `ON` 20 candidates). Of **256** candidates, **33** were accepted and
**192** refused; every refusal is stored in `wrapper-probe.json` with the stage and reason that refused it
(`price` 160, `correlation` 1, `duplicate` 31). Nothing is dropped silently. Where several wrappers verify
against one underlying, the canonical one reported is the verified pair with the highest 24h quote volume.

**The closed-hours figure, and its convention.** US cash regular trading hours are 13:30–20:00 UTC in daylight
time and 14:30–21:00 UTC in standard time. The measurement counts every Monday–Friday hourly candle bucket
from 13:00 to 20:59 UTC as "reference session open" — 40 hours a week against the real 32.5. The convention is
**deliberately generous to the cash session**, so the resulting closed-hours movement share is biased
*downward*: it understates how much of the wrapper's movement lands while the reference market is shut rather
than overstating it. The convention string is stored in the file and rendered on the card.

The reference-market closed share itself (**81.4%** of the week, 136.67h of 168h) needs no venue at all: it
is derived from the library's own session calendar (2513 sessions over 521.4 weeks = 4.819 sessions/week x
6.5h = 31.33h open), so it is reported even for the 38 instruments that have no verified wrapper.

**Trust boundary.** Gate.io is a free keyless endpoint with no SLA, and tokenised-equity listings change: a
pair can be delisted, reissued under a new suffix, or start trading at a level that fails the price test. The
committed snapshot is what every card reports, and it is timestamped; re-running `npm run measure:wrapper`
produces a new snapshot and `npm run check:wrapper` re-verifies every acceptance rule against it. A card
never shows a wrapper figure without the timestamp it was measured at.