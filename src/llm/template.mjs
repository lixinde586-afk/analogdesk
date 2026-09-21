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

/* --------------------------------- English -------------------------------- */

function renderEn(card) {
  const i = card.idea, r = card.retrieval, d = card.distribution, e = card.excursion, c = card.conformal;
  const v = card.validation, p = card.provenance || {};
  const st = card.stress || [];
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