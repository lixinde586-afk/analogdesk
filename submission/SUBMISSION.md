# AnalogDesk — submission kit (Bitget Hackathon S2)

Track **🟧 AI Trading Desk** · Sub-theme **Decision Stress Testing** · Deadline **2026-09-27 (UTC+8)**, target submit **2026-09-25**.
Form: https://forms.gle/GyWZCMCPocgJdJon6

Everything below is **paste-ready**. Replace the three `<...>` placeholders (GitHub URL, demo URL, video URL)
once the repo is public. Every figure quoted here is reproduced by `npm run verify` / `npm run demo` from
committed data — no number is hand-entered.

---

## A. Field-by-field map

| Form field | Required | What to paste |
|---|---|---|
| Project name | ✅ | `AnalogDesk` |
| Track | ✅ | `AI Trading Desk` |
| Sub-theme | ✅ | `Decision Stress Testing` |
| Project Description | ✅ | Section **B** (English) or **C** (Chinese). One long-form field, six parts; external links do not substitute |
| Role of the LLM in Your Project | ✅ | Section **D** |
| Submission Materials Link | ✅ | Section **E** |
| X Promotional Post Link | ✅ | The post from section **F**, after it is live |
| University Name | ⚪ but do it | Full official school name → enters the University Special Prize pool (10 x 500 USDT). Blank = not evaluated. Note: if the entry wins a main-track prize it becomes ineligible for the university pool |
| Apply for Demo Day | ⚪ | Optional |
| Are you an S1 participant/team | ✅ | `No` |

**Invalid submission triggers** (from the rules): missing a compliant X post, missing the project description,
or inaccessible submission materials. Section F's post is compliant only if it carries `#BitgetHackathon` +
`@Bitget_AI`, **quote-tweets** https://x.com/Bitget_AI/status/2100519318824055159?s=20, and contains a
substantive introduction — a pure retweet is explicitly incomplete.

---

## B. Project Description — ENGLISH (paste as one field)

### 1 · Thesis

AnalogDesk is a pre-trade **decision stress-testing** desk for tokenised US equity exposure in a 7x24 market.

The pain point is specific. When a venue runs around the clock, decision time migrates away from the hours
when primary-market information, liquidity and human oversight exist. A self-directed trader ends up acting on
a headline at 3am with no desk to sanity-check the size, and with no way to distinguish "this setup is
unusual" from "this setup is Tuesday". At the same time, every retail-facing signal collapses a distribution
into one number — a price target, a buy/sell/hold, a confident paragraph from an LLM — and the thing that
actually decides whether a position is survivable is not the median but the **left tail and the path**: how far
underwater it goes, and whether that drawdown would have forced you out. A trade can finish flat and still
have been un-holdable, and an endpoint-only view hides exactly that.

Why existing solutions fall short: analyst price targets are unconditional on today's state and 12 months out;
screeners say "now looks like X" but never show the sample of past episodes, so "like X" is unauditable;
backtesting frameworks answer "would this rule have made money" rather than "what happens to *this* position
entered *today*", and are usually fit on the era they are scored on; broker VaR is portfolio-level, opaque and
built for regulators, not for the person taking the trade; signal services publish instructions with no
provenance and an incentive to hide drawdowns; and a general-purpose LLM with market data produces fluent
prose whose numerals the reader cannot verify — the failure mode that makes AI research tools dangerous rather
than merely wrong.

The core hypothesis: the useful pre-trade artefact is not a forecast but a **stress-tested, fully sourced
distribution of what actually happened next in the historical episodes that most resemble this one**,
delivered in the time it takes to read one card. Forecasts are unverifiable until it is too late.
Episode-conditioned distributions are auditable *before* the trade. AnalogDesk therefore retrieves the k = 50
nearest historical market states, reports the realised forward-return distribution **and the path risk**
(maximum adverse excursion, drawdown-breach probabilities), overlays 13 named stress scenarios, wraps the
interval in a frozen conformal calibration, and refuses to print any numeral it cannot trace back to the
engine.

### 2 · Target user and product value

Primary segment: **self-directed traders on tokenised-equity venues who hold concentrated single-name or
single-sector positions and trade outside regular US hours.** Concretely: retail-to-prosumer, own capital
roughly 1k-100k USDT, no risk department and no institutional stack, 1-10 position changes per week, primary
market US large-cap tech / China ADR / broad-index ETF exposure, use case = "I am about to open or add to this
position; show me the tail and the path before I size it". They need it because they are the group with the
most discretion and the least verification: they can act any hour, and nobody is around to disagree with them.

Secondary segment: **undergraduate and independent researchers** who need a reproducible, pre-registered study
they can read end to end and re-run. That is why the entire pipeline is keyless, has **zero runtime
dependencies**, and regenerates every published number from committed data with one command.

Value delivered, concretely: a 30-second answer to "has the market been here, and what happened to the path",
expressed in the statistics that determine position size (p10/p90, VaR90/CVaR90, median and p10 MAE,
probability of breaching 5%/10%/20% drawdown intra-path), plus the list of 50 dated episodes behind every
figure so the reader can inspect — and distrust — the evidence.

### 3 · Validation data and key metrics

This is a tool, so the validation is (a) out-of-sample measurement of the engine and (b) reproducible task
completion, not P&L. **AnalogDesk runs no strategy, takes no position and reports no Sharpe — none is claimed.**

**Observed — engine, pre-registered protocol.** Protocol fixed before any test-era number was inspected:
calibration 2019-01-01..2022-12-31, test 2023-01-01..2026-09-18, **2698 out-of-sample queries** over 71
instruments, coverage target 80%, standard errors clustered by query date (38 clusters).

- Out-of-sample coverage of the conformal analog interval at H = 5 sessions: **81.8%** vs the 80% target,
  clustered SE **+/- 1.87 pp**, mean width **10.73%** — [OBSERVED]
- Matched-coverage width **10.29%** vs **9.48%** for a same-name unconditional point-in-time band: the analog
  interval is **8.5% WIDER**. The negative result is reported in-product, in the README and in
  `research/LIMITATIONS.md` — [OBSERVED]
- Matched-coverage gain by horizon: H=1 **+0.4%**, H=5 **-8.5%**, H=10 **-3.4%**, H=20 **-5.3%**, H=40
  **-5.5%**, H=60 0.0% — [OBSERVED]
- Coverage discipline at longer horizons: at H = 20 the analog interval covers **86.9%** while the same-name
  band falls to **76.6%** — [OBSERVED]
- Regime adaptivity: width scales **1.94x** from the calm to the stressed volatility tercile;
  corr(width, own 20-session vol) = **0.955**; coverage drift +6.2 pp (calm) to -2.7 pp (stressed) — [OBSERVED]
- Probability calibration **FAILS**: PIT chi-square **212.5** vs a 5% critical value of **16.92**; median PIT
  0.580; directional hit rate **50.6%** (a coin toss) — [OBSERVED]
- Per-name consistency: per-symbol coverage SD **8.7 pp**, 53/71 symbols within +/-10 pp; worst BIDU 63.2%,
  best DIA 100.0% — [OBSERVED]
- Cost: retrieval **8.4 ms** mean per query across the 2698-query sweep (**14.7 ms** in a dedicated 108-query
  cold harness), engine build **614-626 ms**, full research card **167 ms**, full 13-scenario stress report
  **~191 ms**, peak RSS **346 MB** — [OBSERVED]

**Observed — data.** 6 keyless sources; **2513 sessions x 71 instruments** (55 single names + 16 ETFs),
2016-09-20..2026-09-18; 11 FRED macro series; **92** FOMC decision dates; **2680** earnings dates of which
**402 (15.0%)** recovered through a purpose-built 6-K fallback for the six China ADRs that file no 8-K.

**Observed — product QA.** The narrative layer passes a numeric gate that traces every numeral back to the
engine payload: **144/144** renders in the gate smoke suite, **142/142** numerals in the shipped demo run.
Automated render harness on the static bundle (`npm run check:bundle`): **15/15** panels, **0**
undefined/NaN leaks, **zero** network calls, in-browser engine init **0.5-1.0 s** and **0.15-0.45 s** per
analysis across 4 test queries (NVDA/BABA/SPY/KWEB, H = 5/20/1/10), varying with machine load.

**Observed — degradation.** Bitget official MCP: **0 of 3** endpoints reachable from the build network, every
attempt a TCP-layer `connection-reset`. Disclosed in-product on every card, with timestamp and evidence
source; consequently **no Bitget-sourced figure ships**.

**Estimated.** Nothing in this submission is estimated. Where a number could not be measured it is labelled
out of scope in `research/LIMITATIONS.md` (§9: the 7x24 wrapper's own microstructure is unmeasured because all
prices are US daily sessions).

**Targeted — usage and distribution.** No external users yet; test user count is **1** (the builder), so
task-completion evidence is automated rather than behavioural. Targets, labelled as targets: **[TARGET]** 30
self-directed traders onboarded within the first month via a public static demo requiring no key and no
sign-up; **[TARGET]** 60% of them completing at least one full research card (input -> card -> stress panel);
**[TARGET]** 10 undergraduate users reproducing `npm run verify` from the committed dataset. Validation plan:
the static `dist/` build is instrumented to log anonymous, opt-in card completions client-side; the same
13-scenario run record is re-generated weekly from a refreshed dataset so quality drift is measurable without
requiring users to report anything.
### 4 · Progress

**Built and working.**
- Data pipeline (`src/data/`): 6 keyless sources, raw HTTP cache (225 files, 20.8 MB), idempotent rebuild,
  per-symbol coverage report. 7.09 MB committed dataset — the demo and validation run with **no network**.
- Engine (`src/engine/`): 28 features in 5 weighted groups (name 30 / market 20 / macro 20 / crypto 10 /
  event 20), 25 in the distance metric; expanding point-in-time z-scores winsorised at +/-3 sigma; k = 50
  exact retrieval with <= 2 analogs per calendar date, >= 10 sessions between uses of the same symbol, and an
  embargo `j + H <= q`; forward returns on the **adjusted** close; distribution + path-risk module (MAE/MFE,
  drawdown-breach probabilities, VaR90/CVaR90); 13-scenario stress module (6 named crisis windows drawn from
  the library's own worst benchmark windows + 7 shock overlays); split-conformal calibration fitted on
  2019-2022 and frozen.
- Validation harness (`scripts/verify.mjs`): 6 horizons, 5 predictors, clustered SEs, matched-coverage
  comparison, PIT calibration, reliability curve, per-year / per-sector / per-symbol breakdowns, latency, and
  an optimisation-equivalence check. Regenerates `research/VALIDATION.md` (and a 20 MB machine-readable copy)
  from the dataset — **every published number is recomputed at run time, nothing is hand-entered**.
- LLM layer (`src/llm/`): DashScope OpenAI-compatible endpoint, `qwen-plus`; a strict **numeric gate**
  (`verify-numbers.mjs`) that extracts every numeral from generated prose and traces it to the engine payload,
  failing the render otherwise; a replay cache keyed to exact research cards; a deterministic template
  renderer as the final fallback. Every card states which mode produced its text.
- Interface: LUI input in Chinese and English (alias table maps 英伟达 -> NVDA), research card, distribution
  charts, stress panel, analog list, provenance panel with the Bitget disclosure, honest-verdict panel. All
  SVG charts are hand-rolled — no chart library.
- Server (`server.mjs`): zero-dependency `node:http` API + static server, path-traversal safe, `.env` never
  served, network probe at start-up with transport-level error classification.
- Static deployment (`npm run compile` -> `dist/`): a self-written zero-dependency bundler compiles the whole
  engine + dataset into one classic `<script>` (7.5 MB, 2.78 MB gzipped) that runs the **full engine in the
  browser with zero fetch calls**, so a judge with no API key and no network gets the complete product.
- Reproducible run record (`npm run demo` -> `demo/RUN-RECORD.md`, `demo/run-record.json`,
  `demo/narrative.txt`): one complete research task from question to actionable insight, code-generated, with
  the reproduction command printed at the end.

**Not built / out of scope.** No order execution and no funds handling (by design). No live tokenised-quote
feed (Bitget MCP unreachable — see below). No intraday data, so weekend/overnight gap risk and the 7x24
wrapper's own microstructure are argued in the thesis but **not measured**. No portfolio-level view: one idea
at a time. No ANN index (an exact scan over ~178k library rows is faster at this size; that stops being true
past ~10^6 rows). No survivorship-free universe — the 55 names were liquid and large in 2026, which biases
every tail statistic optimistic, and this is stated in `research/LIMITATIONS.md` §7 rather than fixed.

**Problems found and fixed.**
1. `DGS3M` 404s on FRED; the correct series id is `DGS3MO`. Fixed, and the whole macro block re-verified
   (2826 obs, 2015-06-01..2026-09-17).
2. The six China ADRs file **no 8-K**, so they had zero earnings features and the `Earnings release day`
   scenario silently skipped them. Added a 6-K full-text fallback (`q="unaudited"` and `q="financial
   results"`, `forms=6-K`) with 6-calendar-day clustering to dedupe: 949 raw hits -> 402 events (15.0% of all
   earnings dates). Measured side effect, disclosed: full-text search over-detects for BABA (92 events), BIDU
   (81) and JD (78) against a ~40 quarterly cadence, so `dte` and `eventLoad5` are noisier for those six names.
3. `BAMLH0A0HYM2` (high-yield OAS) has **no observations before 2023-09-19**, and `FNG` none before
   2018-02-01, so `hyChg20` and `fng` are null across most of the library. Rather than patch them, they were
   **excluded from the distance metric** (still computed, still displayed) and the exclusion is printed on
   every card.
4. `dv20z` was O(n^2) per symbol. Rewritten with prefix sums and a two-pointer window (O(n)); equivalence
   verified against the naive reference over **12,360** values on 5 symbols: **0** mismatches above 1e-4, max
   absolute difference **9.4e-7**.
5. A coverage figure rendered as **8000%** in the UI and the prose: `pct()` multiplies by 100 and the caller
   passed an already-multiplied value. Fixed at the source, and the conformal scale is now emitted at full
   precision instead of being pre-rounded.
6. The numeric gate initially rejected legitimate copy because its allowlist did not know protocol integers or
   label vocabulary (52-week, VaR90, S&P 500). Fixed with one shared `defaultAllowance(card)` used by **both**
   the server and the browser renderer, so the two can never disagree about what is verifiable.
7. The static bundle executes ES modules through a hand-written CJS shim; two real bugs surfaced (bare-function
   property descriptors, and shim `require` ordering — the app must load last, after the payload). Both fixed
   and both now covered by `npm run check:bundle`, which asserts the bundle makes **zero** `fetch` calls.
8. Bitget errors collapsed into a generic "fetch failed". `classifyError` now walks the `cause` chain so
   `ECONNRESET` / `ETIMEDOUT` / `ENOTFOUND` / `ECONNREFUSED` / `UND_ERR_CONNECT_TIMEOUT` are named precisely,
   and a run without direct network egress falls back to the persisted classified probe and **labels which
   probe run the evidence came from** instead of printing a vaguer error.

**Frameworks, models and APIs used.** Node.js >= 20 with **zero runtime dependencies** (`node:http`, `node:fs`,
Web `fetch`). No ML framework — split conformal prediction and weighted k-NN are implemented directly
(~900 lines across `src/engine/`). LLM: **qwen-plus** via the DashScope OpenAI-compatible endpoint
`https://dashscope.aliyuncs.com/compatible-mode/v1`, key read from `.env`, optional. Data APIs:
api.stockanalysis.com, fred.stlouisfed.org, efts.sec.gov (EDGAR full-text search), federalreserve.gov,
coins.llama.fi, api.alternative.me. Bitget official MCP connector implemented (`agent.bitget.com/mcp`,
JSON-RPC 2.0 `tools/list`) but unreachable from this network.

### 5 · Deliverables (mirrors the "Submission Materials Link" field)

1. **Accessible demo, no login, no key, no network** — static build: `<DEMO_URL>`
2. **Public source repository with full README** — `<GITHUB_URL>`
3. **Complete research task, code-generated run record** (question -> protocol -> distribution -> 13 stress
   scenarios -> 50 retrieved analogs -> narrative -> engine validation -> provenance -> reproduction command):
   `<GITHUB_URL>/blob/main/demo/RUN-RECORD.md`, machine-readable `<GITHUB_URL>/blob/main/demo/run-record.json`,
   generator `<GITHUB_URL>/blob/main/scripts/run-demo.mjs`
4. **Out-of-sample validation report + the code that produces it**:
   `<GITHUB_URL>/blob/main/research/VALIDATION.md` (`npm run verify`)
5. **Research documents**: `research/THESIS.md`, `research/DATA-PROVENANCE.md`, `research/LIMITATIONS.md`
6. **3-minute demo video**: `<VIDEO_URL>`

Local reproduction, no install step: `npm run demo` (run record) · `npm run verify` (validation) ·
`npm run check` (narrative gate + static bundle) · `npm start` (full desk on http://127.0.0.1:3000) ·
open `dist/index.html` (static demo).

### 6 · My take on AI Trading (optional field)

The honest experience report: the Bitget official MCP endpoints (`agent.bitget.com/mcp`, `www.bitget.com`,
`api.bitget.com`) were **unreachable from the network this project was built on** — 0 of 3, every attempt reset
at the TCP layer before any HTTP response. So AnalogDesk ships no Bitget-sourced figure, and the degradation is
rendered on every card with its timestamp rather than worked around silently. Suggestion: publish a
read-only, keyless market-data endpoint (or a hosted MCP proxy) alongside the authenticated MCP, because
keyless reachability is the single biggest determinant of whether a hackathon project can integrate at all.
What the connector would add the moment it is reachable: the live tokenised quote and **spread** (turning the
unmeasured 7x24 microstructure into a measurement), funding and premium/discount to the underlying, and
order-book depth for the "at what size does this break" question a daily-bar library cannot answer.

On Agentic Trading more broadly: the bottleneck is not model capability, it is **verifiability**. An agent that
cannot show its arithmetic will be trusted exactly as much as it deserves, which is not much. Every design
choice in AnalogDesk that cost me a better demo number — pre-registration, the frozen conformal multiplier, the
numeric gate, publishing the negative sharpness result — was chosen because a research tool that hides its
failure modes is worse than no tool at all.
---

## C. 项目描述 — 中文（可整段粘贴；与英文版等价）

### 1 · 立项论点（Thesis）

AnalogDesk 是一台面向 7x24 代币化美股的**开仓前决策压力测试台**。

痛点很具体：当交易所全天候运转，决策时间就从"有初级市场信息、有流动性、有人监督"的时段迁移到了凌晨三点。
散户在这个时候凭一条新闻下单，身边没有研究台、没有风控、没有人质疑他的仓位大小，也没有办法区分
"这个形态很罕见"和"这个形态每周都出现"。同时，几乎所有面向散户的信号都把一个分布压缩成一个数字——目标价、
买卖评级、或者大模型一段自信的文字——而真正决定这笔仓位能不能拿住的，不是中位数，而是**左尾与路径**：
中途最多亏多少、那次回撤会不会把你震出局。一笔交易可以收在成本价附近，却在中途完全无法持有，
而只看终点的视角恰好把这件事藏起来了。

现有方案为什么不够：卖方目标价不与当下状态条件相关、且期限是 12 个月；选股器只说"当前像 X"，
但从不给出历史样本，因此"像 X"不可审计；回测框架回答的是"这条规则过去赚不赚钱"，而不是"今天开的这一笔会怎样"，
而且通常在同一段历史上拟合并打分；券商 VaR 是组合级、监管级、不可读的；喊单服务给出指令却没有溯源，
还有隐藏回撤的动机；通用大模型接行情数据后文字流畅，但读者无法核验其中的数字——这正是让 AI 投研工具
从"错误"变成"危险"的失效模式。

核心假设：真正有用的开仓前产物不是预测，而是**一份经过压力测试、完全可溯源的分布——在历史上与当下最相似的
那些片段里，接下来真实发生了什么**，并且要快到读完一张卡片的时间。预测在事后才可验证，而"情景条件分布"
在开仓前就可审计。AnalogDesk 因此检索 k = 50 个最相似的历史市场状态，给出真实前向收益分布**与路径风险**
（最大不利偏移、回撤击穿概率），叠加 13 个命名压力情景，用冻结的共形校准包住区间，并且**拒绝输出任何
无法回溯到引擎的数字**。

### 2 · 目标用户与产品价值

主要人群：**在代币化股票平台上交易、持有集中单一个股或单一行业仓位、并且在美国常规交易时段之外下单的
自主交易者**。具体画像：散户到半专业，自有资金约 1k-100k USDT，没有风控部门、没有机构级工具，
每周调仓 1-10 次，主要标的是美股大盘科技股 / 中概 ADR / 宽基与行业 ETF，使用场景是"我要开仓或加仓，
先让我看清尾部与路径再决定仓位"。他们需要它，是因为这群人拥有最大的自由裁量权和最少的验证手段：
他们可以在任何时间行动，而当时没有人会反对他们。

次要人群：**本科生与独立研究者**——需要一份可复现、预注册、能从头读到尾并自己跑一遍的研究。
因此整条流水线免密钥、**零运行时依赖**，并且用一条命令就能从已提交的数据重新算出报告里的每一个数字。

价值兑现方式：30 秒回答"市场来过这里吗，路径发生了什么"，并用决定仓位大小的统计量表达
（p10/p90、VaR90/CVaR90、最大不利偏移的中位数与 p10、盘中击穿 5%/10%/20% 回撤的概率），
同时列出支撑每个数字的 50 个带日期的历史片段，让读者可以逐一检查、乃至合理地不信任。

### 3 · 验证数据与关键指标

本项目是工具类，因此验证是（a）引擎的样本外度量与（b）可复现的任务完成度，而**不是**盈亏。
AnalogDesk 不运行策略、不建仓、不汇报夏普比率，也不声称有。

**已观测（引擎，预注册协议）**：校准期 2019-01-01..2022-12-31，测试期 2023-01-01..2026-09-18，
**2698 个样本外查询** x 71 个标的，覆盖率目标 80%，标准误按查询日聚类（38 个簇）。
- H = 5 个交易日，共形类比区间样本外覆盖率 **81.8%**（目标 80%），聚类标准误 **+/- 1.87 个百分点**，
  平均带宽 **10.73%**；
- 同覆盖率下带宽 **10.29%**，而"同名无条件分布"为 **9.48%**——类比区间**宽 8.5%**。这个负面结论
  在产品界面、README 与 `research/LIMITATIONS.md` 中同样醒目；
- 各期限的同覆盖率增益：H=1 **+0.4%**、H=5 **-8.5%**、H=10 **-3.4%**、H=20 **-5.3%**、H=40 **-5.5%**、H=60 0.0%；
- 长期限下的覆盖率纪律：H = 20 时类比区间覆盖 **86.9%**，同名无条件带跌到 **76.6%**；
- 状态自适应：从低波动三分位到高波动三分位，带宽放大 **1.94 倍**，corr(带宽, 自身 20 日波动) = **0.955**；
- 概率校准**未通过**：PIT 卡方 **212.5**（5% 临界值 16.92），PIT 中位数 0.580，方向命中率 **50.6%**（等同抛硬币）；
- 单标的差异：每标的覆盖率标准差 **8.7 个百分点**，71 个标的中 53 个落在 +/-10 个百分点内，最差 BIDU 63.2%；
- 成本：2698 次查询平均每次检索 **8.4 毫秒**（独立的 108 次冷启动基准为 **14.7 毫秒**），引擎构建
  **614-626 毫秒**，整张研究卡 **167 毫秒**，13 个压力情景全套 **约 191 毫秒**，峰值内存 **346 MB**。

**已观测（数据）**：6 个免密钥数据源；**2513 个交易日 x 71 个标的**（55 只个股 + 16 只 ETF），
2016-09-20..2026-09-18；11 条 FRED 宏观序列；**92** 个 FOMC 决议日；**2680** 个财报日，其中 **402 个
（15.0%）** 由专为 6 只不发 8-K 的中概 ADR 编写的 6-K 回退检索得到。

**已观测（产品质量）**：叙述层设有数字校验闸门，把生成文本中的每个数字回溯到引擎载荷——闸门冒烟测试
**144/144** 通过，交付 demo 运行 **142/142** 个数字全部可溯源；静态包的自动化渲染测试：**15/15** 个面板、
**19** 张图表、**0** 处 undefined/NaN 泄漏、浏览器内引擎初始化 **463-533 毫秒**、分析 **约 140 毫秒**、
**0** 次网络请求。

**已观测（降级）**：Bitget 官方 MCP **3 个端点 0 个可达**，每次尝试都在 TCP 层被重置（`connection-reset`）。
产品在每张卡片上带时间戳与证据来源披露，因此**产品中不含任何来自 Bitget 的数字**。

**估算值**：本提交材料中没有估算数字。无法度量的部分在 `research/LIMITATIONS.md` 中明确标注为超出范围
（§9：由于全部价格为美股日线，7x24 代币化外壳自身的微观结构未被度量）。

**目标值（明确标注为目标）**：目前尚无外部用户，测试用户数为 **1**（作者本人），因此任务完成度证据是
自动化的而非行为性的。目标：**[目标]** 首月通过无需密钥、无需注册的公开静态 demo 引入 30 名自主交易者；
**[目标]** 其中 60% 至少完成一次完整研究卡（输入 -> 卡片 -> 压力面板）；**[目标]** 10 名本科生用户
用已提交的数据复现 `npm run verify`。验证计划：静态 `dist/` 构建内置客户端匿名、可选启用的卡片完成度埋点；
同一套 13 情景运行记录每周基于刷新后的数据集重新生成，从而在不要求用户上报任何信息的前提下度量质量漂移。

### 4 · 进度

**已完成**：数据流水线（6 个免密钥源 + 225 个原始响应缓存 + 幂等重建 + 逐标的覆盖报告，7.09 MB 数据集已提交，
demo 与验证可**完全离线**运行）；引擎（28 个特征 / 5 组权重，其中 25 个进入距离度量；扩展式时点 z 分数并按
+/-3 sigma 缩尾；k = 50 精确检索，同一日历日 <= 2 个类比、同标的间隔 >= 10 个交易日、禁运 `j + H <= q`；
前向收益用**复权收盘价**；分布与路径风险模块；13 情景压力模块；2019-2022 拟合并冻结的分裂共形校准）；
验证框架（6 个期限 x 5 个预测器、聚类标准误、同覆盖率对比、PIT 校准、可靠性曲线、分年/分行业/分标的拆解、
时延、以及优化等价性检验；`research/VALIDATION.md` 中**每个数字都在运行时重算，无手填**）；LLM 层
（DashScope OpenAI 兼容端点 + `qwen-plus`；严格数字闸门；按研究卡精确键值的回放缓存；确定性模板兜底；
每张卡片标明生成模式）；界面（中英自然语言输入，"英伟达"可解析为 NVDA；研究卡、分布图、压力面板、类比清单、
含 Bitget 披露的数据溯源面板、诚实结论面板；图表全部手写 SVG，无图表库）；零依赖 `node:http` 服务端
（防目录穿越，`.env` 永不外泄，启动时做网络探测并精确分类传输层错误）；静态部署包（自写零依赖打包器把整套
引擎与数据集编译进一个传统 `<script>`，7.5 MB / gzip 2.78 MB，**浏览器内跑全量引擎且零 fetch**，
评审无密钥无网络也能得到完整产品）；可复现运行记录（`npm run demo` 生成 `demo/RUN-RECORD.md`、
`demo/run-record.json`、`demo/narrative.txt`，文末打印复现命令）。

**未做 / 超出范围**：不接单、不碰资金（有意为之）；无代币化实时行情（Bitget MCP 不可达）；无日内数据，
因此周末与隔夜跳空风险、7x24 外壳微观结构只在论点中论证、**未被度量**；无组合级视角（一次一个想法）；
无近似最近邻索引（178k 行规模下精确扫描更快，约 10^6 行以上才需要）；未使用无幸存者偏差的股票池——
55 只个股是 2026 年仍然大盘且流动的名字，这会让所有尾部统计偏乐观，已在 `research/LIMITATIONS.md` §7
如实写明而非掩盖。

**遇到的问题与修复**：① FRED 序列号 `DGS3M` 返回 404，正确为 `DGS3MO`，修复后整块宏观数据重验；
② 6 只中概 ADR 不提交 8-K，导致财报特征全空、"财报日"情景静默跳过——新增 6-K 全文检索回退
（`q="unaudited"` 与 `q="financial results"`，`forms=6-K`）并按 6 个日历日聚类去重，949 条原始命中
收敛为 402 个事件（占全部财报日 15.0%）；同时测得并披露副作用：全文检索对 BABA（92）、BIDU（81）、
JD（78）存在过度识别（干净季度节奏约 40 次），因此这 6 个标的的 `dte` 与 `eventLoad5` 噪声更大；
③ `BAMLH0A0HYM2` 在 2023-09-19 之前无观测、`FNG` 在 2018-02-01 之前无观测，故 `hyChg20` 与 `fng`
在库内大部分时段为空——不做插补，而是**从距离度量中剔除**（仍计算、仍展示），并在每张卡片上说明；
④ `dv20z` 原为 O(n^2)，改写为前缀和 + 双指针 O(n)，与朴素实现对比 5 个标的 **12360** 个取值：
超过 1e-4 的不一致 **0** 处，最大绝对差 **9.4e-7**；⑤ 界面上覆盖率一度显示为 **8000%**——`pct()` 已乘 100
而调用方又乘了一次，在源头修复，共形乘子改为全精度输出而非预先四舍五入；⑥ 数字闸门最初误杀合法文案
（白名单不含协议整数与 "52 周 / VaR90 / 标普 500" 一类标签词），改为服务端与浏览器共用同一个
`defaultAllowance(card)`，两端不可能再对"什么算可核验"产生分歧；⑦ 静态包的 CJS 兼容层暴露两个真实缺陷
（裸函数属性描述符、shim `require` 顺序——应用必须在载荷之后最后加载），修复后由 `npm run check:bundle`
断言整包**零 fetch**；⑧ Bitget 错误一度只能显示笼统的 "fetch failed"，`classifyError` 现在会遍历 `cause`
链，精确命名 `ECONNRESET` / `ETIMEDOUT` / `ENOTFOUND` / `ECONNREFUSED` / `UND_ERR_CONNECT_TIMEOUT`；
无直接网络出口的运行会回落到已持久化的、已分类的探测结果，并**标明证据来自哪一次探测**，而不是打印更含糊的错误。

**使用的框架、模型与 API**：Node.js >= 20，**零运行时依赖**（`node:http`、`node:fs`、Web `fetch`）；
不使用机器学习框架——分裂共形预测与加权 k 近邻直接实现（`src/engine/` 约 900 行）；大模型为
**qwen-plus**，走 DashScope OpenAI 兼容端点 `https://dashscope.aliyuncs.com/compatible-mode/v1`，
密钥从 `.env` 读取，**可选**；数据 API：api.stockanalysis.com、fred.stlouisfed.org、efts.sec.gov
（EDGAR 全文检索）、federalreserve.gov、coins.llama.fi、api.alternative.me；Bitget 官方 MCP 连接器已实现
（`agent.bitget.com/mcp`，JSON-RPC 2.0 `tools/list`），但本构建网络不可达。

### 5 · 交付物（与"提交材料链接"字段一一对应）

1. **可访问 Demo（免登录、免密钥、免网络）**：`<DEMO_URL>`
2. **公开源码仓库（含完整 README）**：`<GITHUB_URL>`
3. **完整投研任务的运行记录（代码生成，非截图）**：`<GITHUB_URL>/blob/main/demo/RUN-RECORD.md`、
   机器可读版 `<GITHUB_URL>/blob/main/demo/run-record.json`、生成脚本 `<GITHUB_URL>/blob/main/scripts/run-demo.mjs`
4. **样本外验证报告 + 生成它的代码**：`<GITHUB_URL>/blob/main/research/VALIDATION.md`（`npm run verify`）
5. **研究文档**：`research/THESIS.md`、`research/DATA-PROVENANCE.md`、`research/LIMITATIONS.md`
6. **3 分钟演示视频**：`<VIDEO_URL>`

### 6 · 对 AI Trading 的看法（选填）

如实汇报使用体验：Bitget 官方 MCP 的三个端点（`agent.bitget.com/mcp`、`www.bitget.com`、`api.bitget.com`）
在本项目的构建网络上**全部不可达**（0/3，每次尝试都在收到任何 HTTP 响应之前于 TCP 层被重置）。因此 AnalogDesk
不含任何来自 Bitget 的数字，并把这一降级带时间戳渲染在每张卡片上，而不是悄悄绕过。建议：在需要鉴权的 MCP 之外，
同时提供一个只读、免密钥的行情端点（或托管的 MCP 代理）——**免密钥可达性**几乎单独决定了一个黑客松项目
能否真正完成集成。一旦可达，这个连接器最自然的三项补充是：代币化标的的实时报价与**点差**（把目前未被度量的
7x24 微观结构变成可度量的）、资金费率与对标的的溢折价、以及用于回答"多大仓位会打穿"的盘口深度——
后者是日线库无法回答的问题。

关于 Agentic Trading：瓶颈不是模型能力，而是**可验证性**。一个不能展示自己算式的智能体，得到的信任
恰好等于它应得的信任，而那并不多。AnalogDesk 中每一个让我"demo 数字变难看"的设计选择——预注册、
冻结的共形乘子、数字闸门、公开"带宽不如同名基线"这一负面结论——都是因为一件会隐藏自身失效模式的研究工具，
比没有工具更糟。
---

## D. "Role of the LLM in Your Project" — paste this field

### D1. Main text (use this; add D2 only if you received Qwen credits)

The LLM has two clearly separated roles, and the separation is the design.

**At runtime — narration only, never analysis.** `qwen-plus` (DashScope OpenAI-compatible endpoint,
`https://dashscope.aliyuncs.com/compatible-mode/v1`) turns an already-computed engine payload into readable
research-card prose: it orders and phrases the state description, the analog history, the distribution, the
tail statistics, the stress results and the limitations. It performs **no** retrieval, **no** feature
selection, **no** signal generation, **no** calibration and **no** decision. Every quantitative claim it makes
is produced by the engine first.

That is enforced mechanically, not by prompt engineering. `src/llm/verify-numbers.mjs` extracts every numeral
from the generated text and traces it back to the engine payload, with surface-form normalisation (percent,
basis points, rounded variants) and a structural allowlist derived from the same card (protocol integers,
library size, retrieval settings, label vocabulary). If a numeral does not trace, **the render fails** rather
than being shown. Current status: 144/144 renders pass the gate smoke suite, and 142/142 numerals in the
shipped demo run trace to the card. The server and the in-browser renderer share one `defaultAllowance()`
implementation, so the two can never disagree about what counts as verifiable.

**Degradation path — the product is complete without a key.** Three tiers, always labelled on the card:
(1) live `qwen-plus`; (2) a replay cache keyed to the exact research card, so repeated queries return the
previously generated and previously gated text; (3) a deterministic template renderer that produces the same
structure with no model call at all. The static judge-facing build (`dist/`) uses tiers 2-3 and makes zero
network calls. A judge with no API key still gets every panel, every chart and every number.

**Known limit, stated.** The gate verifies *numbers*, not *interpretation*. A live model can still frame a
conservative median as an expectation, or call a 26-analog scenario "robust", while every numeral in the
sentence is correct. Mitigations: the honest verdict, the caveats and the provenance panel are
engine-rendered rather than model-rendered, so the negative results cannot be talked out of the copy; the
template renderer is the reference wording; and the card always states which tier produced its text.

**At development time — full disclosure.** I am an undergraduate without a coding background. The entire
codebase was written with an AI coding agent (OpenAI Codex CLI) under my direction: I set the research
question, the pre-registered protocol (calibration/test split, k, winsorisation, exclusion set, anti-clustering
and embargo rules), the requirement that the negative results be published on the card, and the rule that no
number may appear unless the engine produced it. The judgement calls are mine; the typing was not. I consider
that worth stating plainly in a hackathon about AI-assisted building, and it is why the reproducibility story
(one command regenerates every published figure from committed data) matters more here than it would in a
hand-written project.

### D2. Qwen credits paragraph — include ONLY if your credit application was approved

Qwen usage: `qwen-plus` is the sole runtime model, called through the OpenAI-compatible endpoint with the
credit key in `.env`. Call volume is one request per research card (a few hundred tokens of engine payload in,
~600 tokens of structured prose out), so the granted credits comfortably covered development and validation:
roughly 200-300 card generations across building the template renderer, the numeric-gate allowlist and the
demo run record. Did the credits meet the need? Yes for this architecture — the gate means a failed or
refused generation is simply re-attempted or falls back to the deterministic template, so no run was ever
blocked. One suggestion: because AnalogDesk is designed to run keyless for judges, a small always-on
inference allowance for the *submission period* (after credits expire) would let the live path stay
demonstrable during judging rather than only during development.

*(If you did not receive credits, delete D2 entirely — the rules say the Qwen part may be skipped and it does
not affect judging. Do not claim credits you did not get.)*

---

## E. "Submission Materials Link" — paste this block

```
AnalogDesk - pre-trade decision stress testing for 7x24 tokenised US equities
Track: AI Trading Desk / Sub-theme: Decision Stress Testing

1. ACCESSIBLE DEMO (no login, no API key, no network needed - full engine runs in the browser)
   <DEMO_URL>
   Local equivalent: open dist/index.html

2. SOURCE CODE (public repo, full README, zero runtime dependencies)
   <GITHUB_URL>

3. COMPLETE RESEARCH TASK - RUN RECORD (code-generated, not screenshots)
   <GITHUB_URL>/blob/main/demo/RUN-RECORD.md          (human-readable record)
   <GITHUB_URL>/blob/main/demo/run-record.json        (machine-readable, full card + 50 analogs + gate report)
   <GITHUB_URL>/blob/main/scripts/run-demo.mjs        (the code that generates it: `npm run demo`)

4. OUT-OF-SAMPLE VALIDATION + THE CODE THAT PRODUCES IT (`npm run verify`)
   <GITHUB_URL>/blob/main/research/VALIDATION.md
   <GITHUB_URL>/blob/main/scripts/verify.mjs

5. RESEARCH DOCUMENTS
   <GITHUB_URL>/blob/main/research/THESIS.md
   <GITHUB_URL>/blob/main/research/DATA-PROVENANCE.md
   <GITHUB_URL>/blob/main/research/LIMITATIONS.md      (negative results, stated plainly)

6. DEMO VIDEO (3 min)
   <VIDEO_URL>

Reproduce locally, no install step:
   npm run demo    -> demo/RUN-RECORD.md
   npm run verify  -> research/VALIDATION.md
   npm run check   -> narrative numeric gate + static bundle build
   npm start       -> http://127.0.0.1:3000
```

**Deployment notes.** `<DEMO_URL>`: `dist/` is a plain static site — GitHub Pages (enable Pages on `/dist` of a
`gh-pages` branch, or move `dist/*` to `docs/` and point Pages at `/docs`), Netlify drop, Vercel or any object
bucket. It is one HTML + one CSS + one JS file with **zero** `fetch` calls, so it cannot break from CORS,
mixed content or a dead backend. `<GITHUB_URL>`: the repo must be **public** and the README complete, or the
submission counts as inaccessible. Keep `data-cache/dataset.json` (7 MB) committed — it is what makes the demo
and the validation reproducible offline. `.gitignore` already excludes `data-cache/raw/` (20.8 MB cache) and
`research/validation-results.json` (20 MB, regenerable via `npm run verify`).

---

## F. Compliant X post

Rules being satisfied: `#BitgetHackathon` present, `@Bitget_AI` present, **quote-tweet** (not bare retweet) of
https://x.com/Bitget_AI/status/2100519318824055159?s=20, substantive product introduction, your own account
(no KOL/KOC ghost-posting — that is explicitly not counted for the Best Spread Award).

### F1. How to post (30 seconds)

1. Open https://x.com/Bitget_AI/status/2100519318824055159?s=20
2. Tap **Quote** (引用) — *not* Repost. Quoting attaches the link without consuming your character budget.
3. Paste the text from F2. Attach one image: a screenshot of the research card from the demo
   (`dist/index.html` -> NVDA example -> scroll to the distribution panel).
4. Post. Then copy your post's URL (Share -> Copy link) into the form field **X Promotional Post Link**.

### F2. Post text — English (276 characters, fits the 280 limit; the quote-tweet does not consume characters)

```
AnalogDesk - built for #BitgetHackathon Track 3.

Type a trade idea. It retrieves the 50 closest historical market states and shows what ACTUALLY happened next - tails and path risk included, so you can size the position.

No invented numbers: all engine-traced. @Bitget_AI
```

### F3. Post text — 中文（257 weighted characters under X's CJK double-width counting, fits the 280 limit; can be posted as its own quote-post with the same tags）

```
为 #BitgetHackathon Track 3 做的 AnalogDesk：开仓前的决策压力测试台。

用一句中文说出交易想法，它检索历史上与当下最相似的 50 个市场状态，告诉你之后真实发生了什么——包括决定你能不能拿住的路径风险。

每个数字都由引擎算出并可回溯，模型不允许自己编数。@Bitget_AI
```

### F4. Optional follow-up post, dev-log style (268 characters; good for the Best Spread Award, which judges on your own account's reach)

```
AnalogDesk's proudest feature is a negative result. #BitgetHackathon

2698 out-of-sample queries: coverage 81.8% vs an 80% target. But at matched coverage it is 8.5% WIDER than a band that only knows the stock's own history.

So every card says it out loud. @Bitget_AI
```

---

## G. 3-minute demo video — storyboard

Target: 180 s, 1080p, screen capture + voiceover, English VO with Chinese subtitles (or either language —
judges are bilingual; the run record is in English). Record the **static demo** (`dist/index.html`) so the
video matches exactly what a judge can open, and cut to the terminal for the reproducibility beat. No music
bed louder than -20 dB; captions on.

| # | Time | On screen | Voiceover / caption |
|---|---|---|---|
| 1 | 0:00-0:12 | Title card: `AnalogDesk - decision stress testing for a 7x24 market`. Repo + demo URL in the corner. | "A market that never closes moves decision time away from the hours when anyone is around to disagree with you. AnalogDesk is what you consult instead." |
| 2 | 0:12-0:32 | The LUI input box. Type in Chinese: `英伟达 未来5天 会不会被砸`. Show it resolving to NVDA + H=5. | "Natural-language input, Chinese or English. The alias table resolves 英伟达 to NVDA and the horizon to 5 sessions. This is the whole interface." |
| 3 | 0:32-0:55 | Research card top: state panel with the 28 features in 5 groups; the provenance line naming all 6 sources. | "First, the state: 28 features in 5 weighted groups, z-scored on an expanding point-in-time window, so nothing from the future leaks into the description of the past." |
| 4 | 0:55-1:25 | Analog list, scrolling; hover one row to show its date, symbol, distance, realised return. | "Then the evidence: the 50 historical sessions whose state most resembles now. At most 2 per calendar date, at least 10 sessions between two uses of the same name, and every candidate embargoed so its outcome was fully realised before today. You can click any of them and check." |
| 5 | 1:25-1:55 | Distribution chart + path-risk table (p10/p90, VaR90/CVaR90, median MAE, drawdown-breach probabilities) + conformal interval. | "What actually happened next. Not a forecast - a distribution, plus the part that decides position size: how far underwater these episodes went before they recovered, and the probability of breaching a 10% drawdown intra-path. The interval is wrapped in a conformal multiplier fitted on 2019 to 2022 and then frozen." |
| 6 | 1:55-2:20 | Stress panel: 13 scenarios; click `2020-02/03 liquidity crash` and `2025-04 tariff shock`; show the analog count (48 vs 26). | "Thirteen stress scenarios: six named crisis windows taken from the library's own worst benchmark windows, seven shock overlays. Each prints how many analogs backed it, so a 26-analog scenario is visibly weaker than a 48-analog one." |
| 7 | 2:20-2:40 | Cut to terminal: `npm run demo`, then scroll `demo/RUN-RECORD.md`; show the gate line `142/142 numerals traced to the card`. | "The whole thing is reproducible from committed data with one command, and it writes this run record. Every numeral in the narrative is traced back to the engine payload by a verification gate - 142 of 142 in this run. If a number cannot be traced, the render fails." |
| 8 | 2:40-2:55 | The honest-verdict panel: the 8.5%-wider statement, PIT failure, 50.6% directional hit rate. | "And the verdict it prints about itself: out of sample it covers 81.8% against an 80% target, but at matched coverage it is 8.5% wider than a band that only knows the stock's own history, its probability calibration fails a uniformity test, and its directional hit rate is a coin toss. It is a stress-testing and provenance instrument, not an alpha source." |
| 9 | 2:55-3:00 | End card: demo URL, repo URL, `#BitgetHackathon`. Show the Bitget MCP disclosure line. | "AnalogDesk. Zero dependencies, runs with no API key, and discloses what it could not reach - the Bitget MCP endpoints reset at the TCP layer from this network, so no Bitget-sourced figure ships." |

**Recording tips.** Use the NVDA latest-session example so the video matches the committed run record exactly.
Zoom the browser to 125% before capture so the tables are legible at 1080p. Keep cuts on panel boundaries;
never cut mid-number. If a shot needs a re-take, re-run `npm run demo` so the on-screen record and the
committed one stay identical.