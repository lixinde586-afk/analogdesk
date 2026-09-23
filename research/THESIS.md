# AnalogDesk — thesis

## The claim, in one paragraph

When a market runs 7x24, the bottleneck stops being *getting a view* and becomes *knowing whether the view
survives contact with history*. Tokenised US equity exposure lets a self-directed trader act on a Saturday
night with no research desk open, no analyst on the phone, no broker to sanity-check the size, and — critically
— no way to distinguish "this setup is unusual" from "this setup is Tuesday". AnalogDesk's thesis is that the
useful pre-trade artefact is not a forecast but a **stress-tested, fully sourced distribution of what actually
happened next in the historical episodes that most resemble this one**, delivered in the time it takes to read
a card. Forecasts are unverifiable until it is too late. Episode-conditioned distributions are auditable
*before* the trade, and they are the only form of evidence that lets a non-professional say "I looked at the
path risk and I still want this position, at this size".

## 1. The pain point

Three concrete failure modes, in the order they hurt:

**(a) A point estimate is not a decision object.** Every mainstream retail-facing signal — price target,
"buy/sell/hold", a percentage call, an LLM's confident paragraph — collapses a distribution into one number.
A trader cannot size a position from a median. What actually determines whether the position is survivable is
the left tail and the *path*: how far underwater it goes before it recovers, and whether that drawdown would
have forced you out. AnalogDesk reports median, p10/p90, VaR90/CVaR90, median and p10 **maximum adverse
excursion**, and the probability of breaching 5%/10%/20% drawdown *intra-path*. A trade can finish flat and
still have been un-holdable; the endpoint-only view hides exactly that.

**(b) The hours moved, the information did not.** A 7x24 venue relocates decision time away from the hours
when primary-market information, liquidity and human oversight are present. The trader is left with the same
instruments and less context. What is missing is not another feed — it is a way to ask "has the market been
here before, and what happened" at 3am without an institutional stack.

**(c) Provenance is the first thing an AI research tool loses.** The moment an LLM writes the sentence, the
number in it becomes unverifiable by the reader. This is the failure mode that makes AI research tools
actively dangerous rather than merely wrong: the prose is fluent, the confidence is uniform, and the reader
has no way to tell a computed figure from an invented one.

## 2. Why existing solutions fall short

| What exists | What it gives you | Why it is not enough for a pre-trade decision |
|---|---|---|
| Analyst price targets | A single number, 12 months out | Unconditional on the current state; no distribution; no path risk; the horizon is not the trade's horizon |
| Screeners / technical indicators | "Now looks like X" flags | Binary and stateless: they never show the *sample* of past episodes, so you cannot inspect what "like X" meant |
| Backtesting frameworks | A return curve for a rule | Answers "would this rule have made money", not "what happens to *this* position entered *today*"; typically fit on the era it is scored on |
| Broker VaR / risk engines | A regulatory capital number | Model-based (usually Gaussian or historical on the whole book), portfolio-level, and opaque; not built to be *read* by the person taking the trade |
| Signal services and "AI trading bots" | An instruction | No provenance, no falsifiable claim, no way to audit, and an incentive to hide drawdowns |
| A general-purpose LLM with market data | Fluent prose | Hallucinated or unverifiable numerals; no embargo discipline; no out-of-sample evidence that any of it is calibrated |

The gap is not analytical horsepower. It is a **verifiable, state-conditioned, pre-trade artefact** that a
non-professional can read, distrust productively, and reproduce.

## 3. The object AnalogDesk produces

A **research card**: one page, one trade idea, six parts.

1. **State** — the 28-feature description of today, in 5 weighted groups (name 30%, market 20%, macro 20%,
   crypto 10%, event 20%), each z-scored on an expanding point-in-time window so nothing from the future
   leaks into the description of the past.
2. **Analogs** — the k = 50 historical sessions whose weighted z-distance to today is smallest, subject to
   <= 2 per calendar date, >= 10 sessions between two uses of the same symbol, and the embargo `j + H <= q`.
   Each is listed with its date, symbol, distance and realised outcome. You can go and look at every one.
3. **Distribution** — what actually happened next over H = 1/5/10/20/40/60 sessions: forward returns on the
   **adjusted** close, tail statistics and path risk (MAE / MFE / drawdown breach) on **raw** session OHLC.
4. **Calibrated interval** — median +/- a conformal multiplier fitted on 2019-2022 only and **frozen**,
   reported with its out-of-sample coverage and standard error.
5. **Stress** — 13 scenarios: 6 named crisis windows drawn from the library's own worst benchmark windows
   (2020-02/03 liquidity crash, 2018-Q4 tightening scare, 2022 inflation/rate bear, 2023-03 regional bank
   stress, 2024-08-05 carry unwind, 2025-04 tariff shock) plus 7 shock overlays (+2 sigma VIX, policy-rate
   re-pricing, liquidity air pocket, earnings day, FOMC day, crypto drawdown contagion, China ADR
   de-rating). Each prints how many analogs backed it, so a 26-analog scenario is visibly weaker than a
   50-analog one.
6. **Provenance and verdict** — sources, timestamps, what was excluded and why, network reality including the
   Bitget degradation, and the engine's own honest verdict.

## 4. Design principles, and what each one cost

- **Pre-registration.** k, the +/-3 sigma winsorisation, the exclusion set (`dv20z`, `fng`, `hyChg20`), the
  group weights, the anti-clustering rules, the calibration/test split and the 80% target were fixed before
  any test-era number was inspected. Cost: the engine could not be tuned into looking better, and it does not
  look better — see `research/LIMITATIONS.md` §1.
- **Point-in-time everything.** Expanding-window statistics, embargoed candidates, adjusted-close return
  outcomes, raw-OHLC path risk, forward-filled macro with identical treatment for query and analog dates.
  Cost: features that are null for much of the library had to be excluded from the distance metric rather
  than patched.
- **One price basis per ratio.** Forward returns are computed on the adjusted close; MAE / MFE / gap
  features are computed on raw session OHLC anchored at the raw close of the decision session, and no ratio
  ever divides one basis by the other. Cost: both closes are carried for every symbol (the committed
  dataset is 8.0 MB). Benefit: path risk is measured against the prices that actually traded — the earlier
  mixed-basis version divided raw opens and lows by adjusted closes and read a median `gap20` of 11.5% on
  RTX where the true overnight gaps median 0.50%.
- **A numeric gate on the language layer.** Every numeral the narrative contains is extracted and traced back
  to the engine payload; if it does not trace, the render fails. Cost: the LLM cannot embellish, so the prose
  is plainer than a free-running model's. Benefit: the sentence and the number are never separately wrong.
- **Negative results are first-class output.** The card states that the interval is not sharper than a
  same-name band, that PIT uniformity fails, and that directional accuracy is 50.1%. Cost: a worse demo
  headline. Benefit: a judge can trust every other number on the page.
- **Degradation is disclosed in-product.** The Bitget MCP probe result, with timestamp and error class, is
  rendered on the card. Cost: the product shows a red line at start-up. Benefit: no silent substitution of
  one data source for another.

## 5. Why analog retrieval, if it is not sharper

Because sharpness was never the thing being bought, and saying so is the point. Retrieval buys three things a
parametric band cannot:

1. **Auditability.** Every figure decomposes into a list of 50 dated episodes a sceptic can inspect. A
   volatility model gives you a number and a promise.
2. **Regime conditioning that survives longer horizons.** At H = 20 the analog interval covers 87.4% while
   the same-name unconditional band falls to 76.6%; width scales 2.06x from calm to stressed terciles with
   corr(width, own volatility) = 0.960.
3. **A natural language for stress.** "What did the 2024-08-05 carry unwind do to names that looked like this
   one" is a question a retrieval engine answers directly and a parametric model cannot even express.

What it costs: 7.6% more width at matched coverage at H = 5, a PIT distribution that is skewed conservative,
and a library that cannot retrieve 2008. That trade is explicit and it is documented.

## 6. Who this is for

Not "all traders". The concrete segment: **self-directed traders on tokenised-equity venues who hold
concentrated single-name or single-sector positions and trade outside regular US hours** — the person with a
few thousand to a few hundred thousand of their own money, no risk department, and a habit of acting on a
headline at an hour when nobody is around to disagree with them. Secondary segment: **undergraduate and
independent researchers** who need a reproducible, pre-registered study they can read end-to-end and re-run,
which is why the whole pipeline is keyless, zero-dependency and regenerable from committed data.

Value to them, concretely: a 30-second answer to "has the market been here, and what happened to the path",
with the tail and the drawdown-breach probabilities that determine position size, and with the provenance
needed to decide whether to believe it.

## 7. What this is not

Not an alpha source (directional hit rate 50.1%). Not a forecasting model. Not investment advice. Not
execution — AnalogDesk never places an order and never touches funds. Not a live-data product in its static
form: `dist/` is a frozen snapshot of the library as of 2026-09-18 with zero network calls, so a judge
without keys or connectivity still gets the complete artefact.

## 8. Relationship to the Bitget stack

The connector for the official Bitget MCP (`agent.bitget.com/mcp`, JSON-RPC `tools/list`) is implemented in
`src/data/bitget.mjs` with timeouts and precise transport-error classification. On the network this build ran
on, all three Bitget hosts reset at the TCP layer **on a direct connection**. Through a local HTTP proxy all
three answer, and the official MCP identifies itself as `bitget-mcp-server@4.0.5` with a 67-entry catalog
including 22 US-equity entries, no account and no API key. Both routes are measured and both are reported —
`0/3 direct, 3/3 proxied` — because a green badge that does not say how it got there is worse than a red one.

What the proxied route bought is not a data feed. It is a **cross-check**: 396 overlapping daily crypto
fear-&-greed readings that are **identical** to the independently-sourced series this project already ships
(mean absolute difference 0), 1,826 Bitget-disclosed earnings dates compared against the calendar derived
independently from EDGAR full-text search (69.44% within three days), 24/24 company profiles with ISINs, and
68/71 live quotes used to state how stale the frozen snapshot is. The deepest available test — a historical
price cross-check — is absent because `equity_price_historical` returns HTTP 204 with an empty body, and that
absence is recorded rather than worked around. No Bitget figure enters the retrieval features, the frozen
conformal scale or any validated number.

The §9 limitation that used to follow from this — that the 7x24 wrapper's own microstructure was unmeasured —
has since been closed **from a venue that is reachable**: `scripts/measure-wrapper.mjs` measures tokenised US
equities on Gate.io spot v4 (public, keyless) and commits the result to `data-cache/wrapper-probe.json`. It
supplies exactly the quantities the list below asks for, for 33 verified wrappers: live quote and spread,
premium/discount to the underlying, and order-book depth for the size-at-which-it-breaks question a daily-bar
library cannot answer. What it cannot substitute for is Bitget's own instrument design — issuer, custody and
redemption differ between venues — so if the official MCP becomes reachable, the natural addition is to
re-run the same measurement against Bitget's listings and report both, rather than to treat one venue's
microstructure as the market's. The thesis is about the
market structure those instruments create; the evidence in this repo is deliberately built on sources a judge
can reach without an account.