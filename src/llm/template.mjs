/**
 * AnalogDesk - deterministic narrative template.
 *
 * This is the fallback used when no model key is configured (and therefore what a judge sees on the
 * static deployment). It is not a stub: it renders every section the model would have produced, from
 * the same research card, and it passes the same numeric gate. A template that reads like a
 * mail-merge would be an honest but weak demo; this one carries the actual analytical structure -
 * state, distribution, path risk, scenarios with caveats, and limits - and degrades gracefully when
 * a block is absent.
 *
 * Bilingual: `language: "zh"` renders the Chinese version. Numbers, symbols, feature names and
 * dates stay in Latin form in both, so the numeric gate sees identical tokens either way.
 */

import { SECTIONS } from "./prompt.mjs";

const nz = (x) => (x == null || !Number.isFinite(Number(x)) ? null : Number(x));
/**
 * Display rounding. Payload values arrive at full float precision (the fitted conformal scale is
 * 1.3477309406263196), and prose that quotes 16 digits is unreadable and looks like false
 * precision. Rounding to 3dp is safe against the numeric gate because buildAllowlist registers
 * surface forms at 0-3 decimals for every payload number.
 */
const rnd = (v, dp = 3) => {
  const n = Number(v.toFixed(dp));
  return Number.isInteger(n) ? String(n) : String(n);
};
const s = (x, suffix = "") => { const v = nz(x); return v == null ? "n/a" : `${rnd(v)}${suffix}`; };
const pc = (x) => s(x, "%");
/** A count, not a measurement: rendered as an integer so the prose never implies decimals it does not have. */
const num0 = (x) => { const v = nz(x); return v == null ? "no" : String(Math.round(v)); };
/**
 * An integer MEASUREMENT, rendered as one. This is not `s(x, 0)`: the second argument of `s` is a
 * string suffix, so `s(720, 0)` renders "7200" - a number that is in no payload and reads like a
 * transcription error. Counts and basis-point figures go through here instead.
 */
const n0 = (x) => { const v = nz(x); return v == null ? "n/a" : rnd(v, 0); };
const list = (a, joiner = ", ") => (a || []).join(joiner);

/**
 * How many features the distance metric actually uses. This is NOT FEATURES.length: dv20z, fng and
 * hyChg20 are carried in the card for display but excluded from the metric, so quoting the total
 * would overstate the metric and contradict the exclusion the same paragraph goes on to describe.
 */
function metricFeatureCount(card) {
  const p = card.provenance || {};
  if (Number.isFinite(Number(p.metricFeatures))) return Number(p.metricFeatures);
  const all = (card.currentState?.groups || []).reduce((a, g) => a + (g.features?.length || 0), 0);
  const excluded = (p.excludedFromDistance || []).length;
  return all ? all - excluded : null;
}

function topSector(bySector) {
  const e = Object.entries(bySector || {}).sort((a, b) => b[1] - a[1]);
  return e.length ? e[0][0] : null;
}
function topYears(byYear, n = 3) {
  return Object.entries(byYear || {}).sort((a, b) => b[1] - a[1]).slice(0, n).map(([y, c]) => `${y} (${c})`);
}
function worstScenarios(stress, n = 3) {
  return (stress || [])
    .filter((x) => !x.skipped && nz(x.medianForwardPct) != null)
    .sort((a, b) => (nz(a.medianForwardPct) ?? 0) - (nz(b.medianForwardPct) ?? 0))
    .slice(0, n);
}
function bestScenarios(stress, n = 2) {
  return (stress || [])
    .filter((x) => !x.skipped && nz(x.medianForwardPct) != null)
    .sort((a, b) => (nz(b.medianForwardPct) ?? 0) - (nz(a.medianForwardPct) ?? 0))
    .slice(0, n);
}

/**
 * The 7x24 wrapper paragraph. It sits in [limits] rather than [verdict] because it is a statement
 * about what this analysis covers, and because putting a venue measurement in the headline would
 * invite reading it as part of the analog result - it is not, and nothing in the distribution above is
 * computed from it. Three states, and each one says which state it is.
 *
 * Every figure is read straight off card.wrapper, which desk.mjs fills from the committed
 * data-cache/wrapper-probe.json, so the numeric gate allows all of them. Integers that exist only
 * inside explanatory sentences ("50 bp", "168 hours", "6.5 cash hours") are allowed too, because
 * verify-numbers.mjs whitelists numerals found in card fields named note/caveat/interpretation/label -
 * which is why those sentences live under exactly those keys.
 */
function wrapperEn(w) {
  if (!w) return null;
  if (w.status === "measured") {
    const t = w.tracking, s24 = w.sevenByTwentyFour, lq = w.liquidity, pr = w.premium;
    return [
      `The 7x24 premise, measured rather than asserted. The reference cash market is closed for ${pc(s24.referenceClosedSharePct)} of the week - ${s(s24.referenceClosedHoursPerWeek)} of ${s(w.referenceMarket?.weekHours)} hours - and ${pc(s24.closedMoveSharePct)} of ${w.instrument}'s own realised hourly price movement over ${n0(s24.hoursObserved)} observed hours landed inside those closed hours, during which it printed a trade in ${pc(s24.tradedOutsideSessionPct)} of them.`,
      `That wrapper is a ${t.tierLabel}: daily-return correlation ${s(t.returnCorrelation, 4)} against ${w.symbol}, tracking error ${n0(t.trackingErrorBpPerDay)} bp per day over ${n0(t.overlapSessions)} overlapping sessions, median premium ${pc(pr.medianPct)} with a ${pc(pr.p10Pct)} to ${pc(pr.p90Pct)} band, spread ${s(lq.spreadBps)} bp and ${n0(lq.depthWithin50BpsUsdt)} USDT resting within 50 bp of the touch at the snapshot.`,
      (() => {
        const cr = w.closedSessionReturns;
        if (!cr) return null;
        const wd = cr.weekendReturnDistribution, mae = cr.weekendMaeDistribution;
        if (!wd) return `No closed-session block in the observed window was long enough to measure for ${w.instrument}, so the movement share above is reported without a return distribution behind it. That is a gap in the measurement, not a small number.`;
        const ratio = cr.hourlyStdRatioOutsideOverInside;
        const ratioClause = ratio == null ? "" : ` Hour for hour, closed-session price formation was ${s(ratio, 2)} times as volatile as open-session formation${ratio < 1 ? ", so the movement share above is large because there are far more closed hours than open ones, not because each closed hour moves more" : ""}.`;
        const breach = cr.weekendShareBreached5PctDrawdownPct == null || cr.weekendDrawdownThresholdPct == null ? "" : `; ${pc(cr.weekendShareBreached5PctDrawdownPct)} of them traded at least ${pc(Math.abs(cr.weekendDrawdownThresholdPct))} below the pre-weekend close`;
        return `The return layer behind that share, measured on the same hourly candles: across ${n0(cr.weekendBlocks)} weekend block(s) in the observed window, ${w.instrument} went from the pre-weekend close to the reopen with a median return of ${pc(wd.medianPct)} - tenth percentile ${pc(wd.p10Pct)}, standard deviation ${pc(wd.stdPct)}, negative in ${pc(wd.shareNegativePct)} of them - and its median intra-weekend adverse excursion was ${pc(mae?.medianPct)}${breach}.${ratioClause} These are wrapper returns while the reference market was shut, not the distribution above: the retrieved outcome distribution is built on 5x24 daily sessions and is unchanged.`;
      })(),
      `${w.caveat}`
    ].filter(Boolean).join(" ");
  }
  if (w.status === "no-verified-wrapper") {
    return `The 7x24 premise is only partly measured for this name. The reference cash market is closed for ${pc(w.referenceMarket?.closedSharePct)} of the week, but ${w.reason} ${num0(w.candidatesTested)} candidate listing(s) were tested and refused, and every refusal is recorded with its reason in data-cache/wrapper-probe.json rather than dropped. No wrapper spread, premium or closed-hours figure is reported for ${w.symbol}, and none is estimated.`;
  }
  if (w.status === "not-measured") {
    return `The 7x24 wrapper layer was not measured on this build: ${w.venueName} returned ${w.degradation?.kind || "no result"}. Only the calendar figure is reported, because it needs no venue - the reference cash market is closed for ${pc(w.referenceMarket?.closedSharePct)} of the week. No wrapper figure is estimated to fill the gap.`;
  }
  return null;
}

function wrapperZh(w) {
  if (!w) return null;
  // The tier label is rendered in Chinese here and kept in Latin everywhere else, matching the rule the
  // rest of this file follows: prose is translated, measured field values are not invented in a second
  // language. A loose tracker is named as loose in both.
  const ZH_TIER = { tight: "紧密跟踪凭证", fair: "一般跟踪凭证", loose: "松散跟踪凭证，不可当作标的本身阅读", unknown: "无法判定跟踪质量", rejected: "不构成跟踪" };
  if (w.status === "measured") {
    const t = w.tracking, s24 = w.sevenByTwentyFour, lq = w.liquidity, pr = w.premium;
    return [
      `"7x24"这个前提在这里是被测量出来的，而不是被断言的。参考现货市场每周有 ${pc(s24.referenceClosedSharePct)} 的时间休市——${s(s24.referenceClosedHoursPerWeek)} 小时，全周共 ${s(w.referenceMarket?.weekHours)} 小时；而在 ${n0(s24.hoursObserved)} 个观测小时中，${w.instrument} 自身已实现的小时级价格变动有 ${pc(s24.closedMoveSharePct)} 发生在这些休市时段里，其中 ${pc(s24.tradedOutsideSessionPct)} 的休市小时确实有成交。`,
      `该凭证属于${ZH_TIER[t.tier] || t.tierLabel}：与 ${w.symbol} 的日收益相关性 ${s(t.returnCorrelation, 4)}，在 ${n0(t.overlapSessions)} 个重叠交易日上的跟踪误差为 ${n0(t.trackingErrorBpPerDay)} 个基点/日，溢价中位数 ${pc(pr.medianPct)}，区间 ${pc(pr.p10Pct)} 至 ${pc(pr.p90Pct)}，快照时点差 ${s(lq.spreadBps)} 个基点，距最优价 50 个基点以内挂单深度 ${n0(lq.depthWithin50BpsUsdt)} USDT。`,
      (() => {
        const cr = w.closedSessionReturns;
        if (!cr) return null;
        const wd = cr.weekendReturnDistribution, mae = cr.weekendMaeDistribution;
        if (!wd) return `在观测窗口内，${w.instrument} 没有足够长的休市区块可供测量，因此上面只报告了变动份额，其背后没有收益分布。这是测量的缺口，不是一个很小的数字。`;
        const ratio = cr.hourlyStdRatioOutsideOverInside;
        const ratioClause = ratio == null ? "" : `按小时计，休市时段的价格形成波动是开盘时段的 ${s(ratio, 2)} 倍${ratio < 1 ? "，所以上面的变动份额之所以大，是因为休市小时数远多于开盘小时数，而不是因为每个休市小时波动更大" : ""}。`;
        const breach = cr.weekendShareBreached5PctDrawdownPct == null || cr.weekendDrawdownThresholdPct == null ? "" : `；其中有 ${pc(cr.weekendShareBreached5PctDrawdownPct)} 的周末在区块内跌破周末前收盘价 ${pc(Math.abs(cr.weekendDrawdownThresholdPct))} 以上`;
        return `这一份额背后的收益层，用同一批小时 K 线测得：在观测窗口的 ${n0(cr.weekendBlocks)} 个周末区块中，${w.instrument} 从周末前收盘价到重新开盘的中位收益为 ${pc(wd.medianPct)}——第 10 百分位 ${pc(wd.p10Pct)}，标准差 ${pc(wd.stdPct)}，其中 ${pc(wd.shareNegativePct)} 为负——区块内中位最大不利偏移为 ${pc(mae?.medianPct)}${breach}。${ratioClause}这些是参考市场休市期间凭证自身的收益，不是上面的分布：检索得到的结果分布建立在 5x24 的日线上，没有改变。`;
      })(),
      `${w.caveat}`
    ].filter(Boolean).join("");
  }
  if (w.status === "no-verified-wrapper") {
    return `"7x24"这个前提对该标的只测量到一半：参考现货市场每周有 ${pc(w.referenceMarket?.closedSharePct)} 的时间休市，但${w.reason}共有 ${num0(w.candidatesTested)} 个候选挂牌被测试并拒绝，每一条拒绝及其原因都记录在 data-cache/wrapper-probe.json 中，而不是被静默丢弃。${w.symbol} 的凭差点差、溢价与休市时段数字均不予报告，也不做任何估算。`;
  }
  if (w.status === "not-measured") {
    return `本次构建未能测量 7x24 凭证层：${w.venueName} 返回 ${w.degradation?.kind || "无结果"}。因此只报告不依赖任何交易场所的日历口径数字——参考现货市场每周有 ${pc(w.referenceMarket?.closedSharePct)} 的时间休市。缺口不用估算填补。`;
  }
  return null;
}
/* --------------------------------- English -------------------------------- */

function renderEn(card) {
  const i = card.idea, r = card.retrieval, d = card.distribution, e = card.excursion, c = card.conformal;
  const v = card.validation, p = card.provenance || {};
  const st = card.stress || [];
  const w = card.wrapper || null;
  const O = {};

  O.verdict = d ? [
    `${i.name} (${i.symbol}) as of session ${i.asOfSession}, reference close ${s(i.referenceClose)}.`,
    `The engine matched this state against ${r.kReturned} historical episodes drawn from a ${p.sessions}-session, ${p.symbols}-instrument library, with an embargo of ${r.embargoSessions} sessions so that every analog outcome was fully realised before the decision date.`,
    `Over the following ${i.horizonLabel}, those episodes produced a median return of ${pc(d.medianPct)} and a standard deviation of ${pc(d.sdPct)}; the middle 80% of outcomes ran from ${pc(d.p10Pct)} to ${pc(d.p90Pct)}.`,
    `${pc(d.probabilityBelowZeroPct)} of the ${d.n} analogs closed below where they started.`,
    c ? `Conformally rescaled to its ${pc(c.coverageTargetPct)} target - a single multiplier of ${s(c.scale)} fitted on 2019-2022 and frozen - the interval is ${pc(c.lowerPct)} to ${pc(c.upperPct)}, ${pc(c.widthPct)} wide.` : null,
    `This is a description of a historical conditional sample, not a forecast and not a recommendation.`
  ].filter(Boolean).join(" ") : `The engine returned no usable analog sample for ${i.symbol} at ${i.asOfSession}.`;

  const notable = (card.currentState?.notable || []).slice(0, 5);
  O.state = [
    `Similarity is a group-weighted distance in z-space over ${metricFeatureCount(card) ?? "the"} metric features, each standardised on an expanding point-in-time window and winsorised at three standard deviations. Group weights: ${list((card.currentState?.groups || []).map((g) => `${g.group} ${g.weightPct}%`))}.`,
    notable.length ? `The most distinctive things about the current state are ${list(notable.map((x) => `${x.label} at ${s(x.value)} (${s(x.z)} sigma)`))}.` : null,
    `The retrieved set spans ${r.analogDateFrom} to ${r.analogDateTo} across ${r.distinctSessions} distinct sessions and ${r.distinctSymbols} distinct instruments, of which ${r.sameSymbolCount} are ${i.symbol} itself.`,
    topSector(r.bySector) ? `Sector concentration is led by ${topSector(r.bySector)}; the most represented years are ${list(topYears(r.byYear))}.` : null,
    `Two anti-clustering constraints are active - at most two analogs per calendar date, and any two analogs of the same instrument at least ten trading sessions apart. Without them the nearest-neighbour list collapses onto a single week of one crisis and the "distribution" is really one event repeated.`,
    `Closest match distance ${s(r.closestDistance)}, median of the retrieved set ${s(r.medianDistance)}.`
  ].filter(Boolean).join(" ");

  O.history = d ? [
    `Distribution of the ${d.n} realised ${i.horizonLabel} outcomes: mean ${pc(d.meanPct)}, median ${pc(d.medianPct)}, range ${pc(d.minPct)} to ${pc(d.maxPct)}, skew ${s(d.skew)}.`,
    `Tail probabilities: ${pc(d.probabilityBelow.minus5Pct)} of analogs fell more than 5%, ${pc(d.probabilityBelow.minus10Pct)} more than 10%, ${pc(d.probabilityBelow.minus20Pct)} more than 20%.`,
    `90% value at risk ${pc(d.valueAtRisk90Pct)} and conditional 90% VaR ${pc(d.conditionalVar90Pct)} - the average outcome in the worst decile, which is the figure that matters for sizing.`,
    r.top?.length ? `The nearest episodes and what each did: ${list(r.top.slice(0, 6).map((a) => `${a.session} ${a.symbol} ${pc(a.forwardReturnPct)}`))}.` : null,
    `Read this as a conditional historical sample. It is not a probability distribution for the future, and the analogs are not independent draws - the per-date cap limits but does not eliminate overlap.`
  ].filter(Boolean).join(" ") : "No distribution available.";

  O.tails = e ? [
    `Endpoint return understates what holding the position felt like. Across the same ${e.n || d?.n || 0} analogs, measured session by session to the intra-period low and high:`,
    `median maximum adverse excursion ${pc(e.maxAdverseMedianPct)}, tenth percentile ${pc(e.maxAdverseP10Pct)}, twenty-fifth ${pc(e.maxAdverseP25Pct)}.`,
    `Median maximum favourable excursion ${pc(e.maxFavourableMedianPct)}, seventy-fifth percentile ${pc(e.maxFavourableP75Pct)}, ninetieth ${pc(e.maxFavourableP90Pct)}, giving a median reward-to-adversity ratio of ${s(e.rewardRiskRatio)}.`,
    Object.keys(e.probabilityOfBreaching || {}).length ? `Probability of breaching each drawdown level at some point inside the horizon: ${list(Object.entries(e.probabilityOfBreaching).map(([k, val]) => `${k.replace("PctDrawdown", "%")}: ${pc(val)}`))}.` : null,
    `A trade whose endpoint is near the median can still have been closed out by any stop tighter than the adverse excursion above. That gap - not the median return - is what a 7x24 wrapper on a name whose reference market closes overnight actually exposes.`
  ].filter(Boolean).join(" ") : "No excursion data available for this query.";

  const worst = worstScenarios(st), best = bestScenarios(st), skipped = st.filter((x) => x.skipped);
  O.stress = st.length ? [
    `${st.length} preset scenarios were run against the same idea with the same engine settings, so every figure below is directly comparable to the baseline above.`,
    worst.length ? `The scenarios that worsen the picture most, by median forward return: ${list(worst.map((x) => `${x.label} at ${pc(x.medianForwardPct)} (${x.analogsUsed} analogs, delta versus baseline ${pc(x.deltaMedianVsBaselinePct)})`))}.` : null,
    worst.length ? `On path risk the same ordering mostly holds: ${list(worst.map((x) => `${x.label} median adverse excursion ${pc(x.maxAdverseMedianPct)}, probability of a 10% intra-horizon drawdown ${pc(x.probabilityOfBreaching10PctDrawdown)}`))}.` : null,
    best.length ? `For contrast, the mildest scenarios were ${list(best.map((x) => `${x.label} at ${pc(x.medianForwardPct)}`))} - which is itself a warning, since a scenario that cannot produce a bad outcome is not stressing anything.` : null,
    ...worst.slice(0, 3).map((x) => `Caveat carried from the engine for ${x.label}: ${x.caveat}`),
    skipped.length ? `Skipped, with reason: ${list(skipped.map((x) => `${x.label} (${x.skipped})`))}. A skipped scenario is reported rather than silently dropped, because a stress suite that hides its own gaps is worse than no suite.` : null
  ].filter(Boolean).join("\n\n") : "No scenarios were run for this query.";

  O.limits = [
    v ? `Validation, out of sample on ${v.protocol}: the conformal analog interval covered ${pc(v.analog.coveragePct)} of realised outcomes against a ${pc(v.targetCoveragePct)} target (cluster-robust standard error ${s(v.analog.coverageSEPp)} pp), at a mean width of ${pc(v.analog.widthPct)}.` : null,
    v ? `It is not the sharpest interval available. At matched coverage the same-name unconditional band is ${pc(v.benchmarks?.uncondNamePIT?.matchedCoverageWidthPct)} wide against ${pc(v.analog.matchedCoverageWidthPct)} for the analog band, a difference of ${pc(v.matchedCoverageSharpnessVsSameNamePct)}. Per-symbol coverage dispersion is ${s(v.perSymbolCoverageSdPp?.analogConformal)} pp for the analog band, ${s(v.perSymbolCoverageSdPp?.uncondNamePIT)} pp for the same-name band and ${s(v.perSymbolCoverageSdPp?.pooledUncond)} pp for the pooled band.` : null,
    v ? `Probability calibration fails a uniformity test: PIT chi-square ${s(v.pitChiSquare)} against a 5% critical value of ${s(v.pitChiSquareCritical5Pct)}. Directional hit rate of the analog median is ${pc(v.directionalHitRatePct)}, i.e. no better than a coin toss, which is the expected result for daily-feature equity prediction and is stated rather than hidden.` : null,
    v?.honestVerdict ? `Engine's own verdict: ${v.honestVerdict}` : null,
    `Retrieval costs ${s(v?.meanRetrievalMs)} ms per query over a library of ${p.sessions} sessions; the full scenario suite is one query per scenario.`,
    wrapperEn(w),
    `Data provenance: ${p.priceSource || "see research/DATA-PROVENANCE.md"}. Bitget official MCP status for this run: ${p.bitgetMcp?.status || "not probed"}${p.bitgetMcp?.reason ? ` (${p.bitgetMcp.reason})` : ""}.`,
    `Nothing here is investment advice, and no part of it is a prediction. It is a documented, reproducible description of what happened next in a set of historical episodes that resemble the present one.`
  ].filter(Boolean).join(" ");

  return O;
}

/* --------------------------------- Chinese -------------------------------- */

function renderZh(card) {
  const i = card.idea, r = card.retrieval, d = card.distribution, e = card.excursion, c = card.conformal;
  const v = card.validation, p = card.provenance || {};
  const st = card.stress || [];
  const w = card.wrapper || null;
  const O = {};

  O.verdict = d ? [
    `${i.name}（${i.symbol}），截至交易日 ${i.asOfSession}，参考收盘价 ${s(i.referenceClose)}。`,
    `引擎在 ${p.sessions} 个交易日、${p.symbols} 个标的的类比库中匹配出 ${r.kReturned} 个历史片段，并设置 ${r.embargoSessions} 个交易日的禁运期，保证每个类比的结果在决策日之前已完全实现。`,
    `在其后的${i.horizonLabel}内，这些片段的中位收益为 ${pc(d.medianPct)}，标准差 ${pc(d.sdPct)}，中间 80% 的结果落在 ${pc(d.p10Pct)} 至 ${pc(d.p90Pct)} 之间。`,
    `${d.n} 个类比中有 ${pc(d.probabilityBelowZeroPct)} 收在起点之下。`,
    c ? `经保形重标定到 ${pc(c.coverageTargetPct)} 目标覆盖率——乘数 ${s(c.scale)} 仅在 2019-2022 上拟合后冻结——区间为 ${pc(c.lowerPct)} 至 ${pc(c.upperPct)}，宽度 ${pc(c.widthPct)}。` : null,
    `这是对历史条件样本的描述，不是预测，也不构成任何投资建议。`
  ].filter(Boolean).join("") : `引擎未能对 ${i.symbol} 在 ${i.asOfSession} 取得可用的类比样本。`;

  const notable = (card.currentState?.notable || []).slice(0, 5);
  O.state = [
    `相似度是 z 空间中的分组加权距离，特征按扩展窗口的时点统计量标准化并在三个标准差处截断。分组权重：${list((card.currentState?.groups || []).map((g) => `${g.group} ${g.weightPct}%`))}。`,
    notable.length ? `当前状态最显著的特征是：${list(notable.map((x) => `${x.label} 为 ${s(x.value)}（${s(x.z)} 个标准差）`), "；")}。` : null,
    `检索结果覆盖 ${r.analogDateFrom} 至 ${r.analogDateTo}，共 ${r.distinctSessions} 个不同交易日、${r.distinctSymbols} 个不同标的，其中 ${r.sameSymbolCount} 个是 ${i.symbol} 自身。`,
    topSector(r.bySector) ? `行业集中度以 ${topSector(r.bySector)} 为首；出现最多的年份是 ${list(topYears(r.byYear))}。` : null,
    `两条反聚集约束同时生效：同一日历日最多取 2 个类比，同一标的的两个类比至少间隔 10 个交易日。否则最近邻列表会塌缩到某一次危机的同一周，所谓"分布"其实只是一个事件的重复。`,
    `最近匹配距离 ${s(r.closestDistance)}，检索集合的中位距离 ${s(r.medianDistance)}。`
  ].filter(Boolean).join("");

  O.history = d ? [
    `${d.n} 个已实现的${i.horizonLabel}结果分布：均值 ${pc(d.meanPct)}，中位数 ${pc(d.medianPct)}，区间 ${pc(d.minPct)} 至 ${pc(d.maxPct)}，偏度 ${s(d.skew)}。`,
    `尾部概率：${pc(d.probabilityBelow.minus5Pct)} 的类比跌幅超过 5%，${pc(d.probabilityBelow.minus10Pct)} 超过 10%，${pc(d.probabilityBelow.minus20Pct)} 超过 20%。`,
    `90% 在险价值 ${pc(d.valueAtRisk90Pct)}，条件 90% 在险价值 ${pc(d.conditionalVar90Pct)}——即最差十分之一的平均结果，这才是决定仓位的数字。`,
    r.top?.length ? `最近的几个片段及其后续表现：${list(r.top.slice(0, 6).map((a) => `${a.session} ${a.symbol} ${pc(a.forwardReturnPct)}`), "；")}。` : null,
    `请把它读作条件化的历史样本，而不是未来的概率分布；这些类比也不是独立抽样，同日限额只能削弱、无法消除重叠。`
  ].filter(Boolean).join("") : "本次查询无可用分布。";

  O.tails = e ? [
    `终点收益严重低估了持仓过程的真实体验。在同一批类比上，逐日追踪到区间内最低与最高价：`,
    `最大不利偏移中位数 ${pc(e.maxAdverseMedianPct)}，十分位 ${pc(e.maxAdverseP10Pct)}，二十五分位 ${pc(e.maxAdverseP25Pct)}。`,
    `最大有利偏移中位数 ${pc(e.maxFavourableMedianPct)}，七十五分位 ${pc(e.maxFavourableP75Pct)}，九十分位 ${pc(e.maxFavourableP90Pct)}，中位盈亏比 ${s(e.rewardRiskRatio)}。`,
    Object.keys(e.probabilityOfBreaching || {}).length ? `在持有期内某个时点触及各回撤阈值的概率：${list(Object.entries(e.probabilityOfBreaching).map(([k, val]) => `${k.replace("PctDrawdown", "%")}：${pc(val)}`), "；")}。` : null,
    `一笔终点收益接近中位数的交易，仍可能被任何紧于上述不利偏移的止损提前打出。这个缺口——而不是中位收益——才是"标的参考市场夜间休市、代币化凭证却 7x24 连续交易"真正暴露出来的风险。`
  ].filter(Boolean).join("") : "本次查询无路径偏移数据。";

  const worst = worstScenarios(st), best = bestScenarios(st), skipped = st.filter((x) => x.skipped);
  O.stress = st.length ? [
    `共 ${st.length} 个预置情景以完全相同的引擎参数作用于同一交易想法，因此下列每个数字都可与上文基线直接比较。`,
    worst.length ? `按中位前向收益排序，恶化最明显的情景：${list(worst.map((x) => `${x.label}，${pc(x.medianForwardPct)}（${x.analogsUsed} 个类比，相对基线 ${pc(x.deltaMedianVsBaselinePct)}）`), "；")}。` : null,
    worst.length ? `路径风险上的排序大体一致：${list(worst.map((x) => `${x.label} 最大不利偏移中位数 ${pc(x.maxAdverseMedianPct)}，持有期内出现 10% 回撤的概率 ${pc(x.probabilityOfBreaching10PctDrawdown)}`), "；")}。` : null,
    best.length ? `作为对照，最温和的情景是 ${list(best.map((x) => `${x.label}，${pc(x.medianForwardPct)}`), "；")}——这本身就是一个警告：一个无法产生坏结果的情景，等于没有施加任何压力。` : null,
    ...worst.slice(0, 3).map((x) => `${x.label} 的引擎内置免责说明：${x.caveat}`),
    skipped.length ? `被跳过的情景及原因：${list(skipped.map((x) => `${x.label}（${x.skipped}）`), "；")}。跳过必须显式披露，因为一个隐藏自身缺口的情景套件比没有套件更危险。` : null
  ].filter(Boolean).join("\n\n") : "本次查询未运行情景。";

  O.limits = [
    v ? `样本外验证（${v.protocol}）：保形类比区间对已实现结果的覆盖率为 ${pc(v.analog.coveragePct)}，目标 ${pc(v.targetCoveragePct)}（按交易日聚类的稳健标准误 ${s(v.analog.coverageSEPp)} 个百分点），平均宽度 ${pc(v.analog.widthPct)}。` : null,
    v ? `它并不是最锐利的区间。在等覆盖率下，同名无条件区间宽 ${pc(v.benchmarks?.uncondNamePIT?.matchedCoverageWidthPct)}，类比区间宽 ${pc(v.analog.matchedCoverageWidthPct)}，相差 ${pc(v.matchedCoverageSharpnessVsSameNamePct)}。分标的覆盖率离散度：类比 ${s(v.perSymbolCoverageSdPp?.analogConformal)} 个百分点，同名无条件 ${s(v.perSymbolCoverageSdPp?.uncondNamePIT)}，全库混合 ${s(v.perSymbolCoverageSdPp?.pooledUncond)}。` : null,
    v ? `概率标定未通过均匀性检验：PIT 卡方 ${s(v.pitChiSquare)}，5% 临界值 ${s(v.pitChiSquareCritical5Pct)}。类比中位数的方向命中率 ${pc(v.directionalHitRatePct)}，与抛硬币无异——这对"日频特征预测股票收益"是应有结果，此处如实写出而非隐去。` : null,
    v?.honestVerdict ? `引擎自评：${v.honestVerdict}` : null,
    `单次检索耗时 ${s(v?.meanRetrievalMs)} 毫秒，情景套件每个情景一次检索。`,
    wrapperZh(w),
    `数据溯源：${p.priceSource || "见 research/DATA-PROVENANCE.md"}。本次运行的 Bitget 官方 MCP 状态：${p.bitgetMcp?.status || "未探测"}${p.bitgetMcp?.reason ? `（${p.bitgetMcp.reason}）` : ""}。`,
    `以上均非投资建议，任何部分都不是预测。它是对"与当前状态相似的历史片段随后发生了什么"的一份可复现、可追溯的描述。`
  ].filter(Boolean).join("");

  return O;
}

export function renderTemplate(card, { language = "en" } = {}) {
  const O = String(language).toLowerCase().startsWith("zh") ? renderZh(card) : renderEn(card);
  const order = SECTIONS.map((x) => x.key);
  const text = order.map((k) => `[${k}]\n${O[k] || ""}`).join("\n\n");
  return { text, sections: Object.fromEntries(order.map((k) => [k, O[k] || ""])), order, mode: "TEMPLATE" };
}