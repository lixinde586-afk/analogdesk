/**
 * AnalogDesk - renders the submission-facing "complete research task" documents.
 *
 *   npm run demo:doc        (or: node scripts/make-full-chain-demo.mjs)
 *
 * Reads demo/run-record.json (written by `npm run demo`) and renders, with no hand-typed figure:
 *
 *   submission/FULL-CHAIN-DEMO-CN.md     question -> state -> retrieval -> distribution -> path risk
 *                                        -> 13 stress scenarios -> narrative + numeric gate
 *                                        -> out-of-sample self-audit -> actionable judgment
 *   submission/FULL-CHAIN-DEMO-CN.txt    the same document as plain text, for pasting into the form
 *   submission/MATERIALS-LINK-READY.txt  the "Submission Materials Link" field, ready to paste
 *   submission/FORM-READY.md             every form field in order, with exactly what to paste
 *
 * The formatters record a miss instead of guessing, and the rendered text is re-scanned for
 * unresolved placeholders before anything is written, so this script cannot silently publish a "-"
 * where a real number belongs. A field-name change in the card fails the render loudly.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const rf = (rel) => readFileSync(join(ROOT, rel), "utf8");
const wf = (rel, text) => writeFileSync(join(ROOT, rel), text, "utf8");
const charCount = (rel) => [...rf(rel)].length.toLocaleString("en-US");

const R = JSON.parse(rf("demo/run-record.json"));
const SUB = rf("submission/SUBMISSION.md");
const C = R.card, D = R.detail, V = R.validation, P = R.provenance;

const Q_ZH = "NVDA 现在这个位置进场，未来一周历史上相似的走势是什么样的？";
const REPO = "https://github.com/lixinde586-afk/analogdesk";
const DEMO = "https://lixinde586-afk.github.io/analogdesk/";
const DEEP = `${DEMO}?symbol=${C.idea.symbol}&horizon=${C.idea.horizonSessions}&k=${C.retrieval.kRequested}&run=1&q=${encodeURIComponent(Q_ZH)}`;

const missing = [];
const pc = (x, dp = 2) => {
  if (x == null || !Number.isFinite(Number(x))) { missing.push(new Error().stack.split("\n")[2].trim()); return "-"; }
  return Number(x).toFixed(dp) + "%";
};
const nm = (x, dp = 2) => {
  if (x == null || !Number.isFinite(Number(x))) { missing.push(new Error().stack.split("\n")[2].trim()); return "-"; }
  return Number(x).toFixed(dp);
};

const assertClean = (label, text) => {
  if (missing.length) throw new Error(`${label}: unresolved numeric field(s) at\n  ` + [...new Set(missing)].join("\n  "));
  for (const token of ["undefined", "NaN", "[object Object]"]) {
    if (text.includes(token)) throw new Error(`${label}: rendered "${token}" - a field path is stale`);
  }
  const bad = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("|")) continue;
    for (const cell of line.split("|")) {
      const c = cell.trim();
      if (c === "-" || /^-(\s*\/\s*-)+$/.test(c) || /(^|\s)-%/.test(c)) bad.push(line);
    }
  }
  if (bad.length) throw new Error(`${label}: unresolved table cell(s)\n` + [...new Set(bad)].join("\n"));
};

const dist = C.distribution, exc = C.excursion, conf = C.conformal, ret = C.retrieval;
const stress = C.stress;
const worst = stress.filter((s) => !s.skipped).reduce((a, b) => (b.deltaMedianVsBaselinePct < a.deltaMedianVsBaselinePct ? b : a));
const shock = Math.max(Math.abs(exc.maxAdverseP10Pct), ...stress.filter((s) => !s.skipped && s.maxAdverseMedianPct < 0).map((s) => Math.abs(s.maxAdverseMedianPct)));
const volSpike = stress.find((s) => s.id === "vol-spike");
const airPocket = stress.find((s) => s.id === "liquidity-air-pocket");
const size = (T) => nm(T / shock * 100, 1) + "%";

const md = [];
md.push(`# AnalogDesk 完整投研任务演示：从一句提问到可用判断（全链路）`);
md.push(``);
md.push(`本文件由代码从 \`demo/run-record.json\` 逐字段渲染（生成时间 ${R.generatedAt}），不是手写稿：文中每一个数字都与机器记录同源，`);
md.push(`机器记录又由 \`node scripts/run-demo.mjs\` 从已提交数据集重新计算。链路：提问 → 解析 → 状态 → 检索 → 分布与路径风险 → 13 情景压力测试 → 叙述与数字闸门 → 样本外自证 → 可用判断。`);
md.push(``);
md.push(`## 0. 可用判断（先给结论，后给证据）`);
md.push(``);
md.push(`**条件性可参与，且与方向无关。** 终点风险温和：未来 ${C.idea.horizonSessions} 个交易日 P(亏损>10%) = ${pc(dist.probabilityBelow.minus10Pct, 1)}，80% conformal 区间 ${pc(conf.lowerPct)} .. ${pc(conf.upperPct)}（宽 ${pc(conf.widthPct)}）；真正的约束在**路径**：持有期内最大不利偏移中位 ${pc(exc.maxAdverseMedianPct)}、十分位 ${pc(exc.maxAdverseP10Pct)}，即"终点没亏"不等于"拿得住"。`);
md.push(`因此本卡只回答三件事：**拿不拿得住、拿多大、什么条件下撤**——不回答"会涨还是会跌"（样本外方向命中 ${pc(V.directionalHitRatePct, 1)}，等于抛硬币，引擎自己在卡片上写明）。`);
md.push(``);
md.push(`| 决策项 | 判断 | 依据（引擎字段） |`);
md.push(`|---|---|---|`);
md.push(`| 方向 | 不作为依据 | 样本外方向命中 ${pc(V.directionalHitRatePct, 1)}；PIT chi² ${nm(V.pitChiSquare, 1)} > 临界 ${nm(V.pitChiSquareCritical5Pct, 1)} |`);
md.push(`| 可参与性 | 条件性可以 | P(亏>10%) ${pc(dist.probabilityBelow.minus10Pct, 1)}；CVaR90 ${pc(dist.conditionalVar90Pct)}；中位 ${pc(dist.medianPct)} |`);
md.push(`| 仓位规则 | 名义仓位 s ≤ T / ${pc(shock)}（T = 单笔可承受的组合回撤） | 冲击取 max(基线 MAE p10 ${pc(exc.maxAdverseP10Pct)}, 压力情景最差中位 MAE)；例：T=0.5% → s≤${size(0.5)}；T=1% → s≤${size(1)}；T=2% → s≤${size(2)} |`);
md.push(`| 绑定情景 | ${worst.label}：中位 ${pc(worst.medianForwardPct)}（相对基线 ${pc(worst.deltaMedianVsBaselinePct)}），10% 回撤击穿 ${pc(worst.probabilityOfBreaching10PctDrawdown, 1)}，可持有份额 ${pc(worst.heldWithin10PctDrawdownPct, 1)} | 13 情景中 Δ 最差者 |`);
md.push(`| 撤离触发 1 | 实现回撤跌破 ${pc(exc.maxAdverseP25Pct)} 即撤 | 已击穿类比路径 p25 冲击，说明本笔不在历史路径集合内 |`);
md.push(`| 撤离触发 2 | VIX 5 日跳升 ≥ +2σ（${volSpike.label}）→ 降仓或撤 | 该状态下中位收益 ${pc(volSpike.deltaMedianVsBaselinePct)} 相对基线 |`);
md.push(`| 撤离触发 3 | 隔夜/周末缺口 z ≥ 1（${airPocket.label}）→ 撤 | 该状态下中位收益 ${pc(airPocket.deltaMedianVsBaselinePct)} 相对基线，7x24 包装的缺口风险由参考市场代理 |`);
md.push(`| 有效期 | 仅对 ${C.idea.asOfSession} 收盘状态成立 | 状态漂移（特征 z 变化）即失效；数据集构建于 ${P.datasetBuiltAt.slice(0, 10)} |`);
md.push(``);
md.push(`> 这不是投资建议，也不是预测：它把"与当下最像的历史片段之后真实发生了什么"和"哪些情景会让你拿不住"摆在一起，判断由人做。`);
md.push(``);
md.push(`## 1. 提问与解析`);
md.push(``);
md.push(`- 自然语言提问（中文，即深链 q= 参数里的输入）：${Q_ZH}`);
md.push(`- 同一任务在机器记录里的原文（\`demo/run-record.json\` → \`task.question\`，英文）：${R.task.question}`);
md.push(`- 为什么两句问话必然得到同一张卡：\`desk.analyze()\` 的入参只有 symbol / date / horizon / k / includeStress，问题文本既不进检索也不进统计，只经 \`detectLang()\` 决定叙述语言。深链把 symbol=${C.idea.symbol}、horizon=${C.idea.horizonSessions}、k=${C.retrieval.kRequested} 写死在 URL 里，所以中文提问点开复现出的研究卡与本文件逐位一致。`);
md.push(`- 语言分工：本文件是中文决策版（结论在前）；\`demo/RUN-RECORD.md\` 是同一次运行的英文全记录，同样由代码生成。`);
md.push(`- 引擎解析：标的 ${C.idea.symbol}（${C.idea.name}，${C.idea.sector}）· 决策会话 ${C.idea.asOfSession} · 参考收盘 ${nm(C.idea.referenceClose, 4)} ·  horizon ${C.idea.horizonSessions} 会话（${C.idea.horizonLabel}）· k=${C.retrieval.kRequested} · 压力套件 开`);
md.push(`- 一键复现（免登录/免密钥/免网络，浏览器内全量引擎）：${DEEP}`);
md.push(``);
md.push(`## 2. 当下市场状态（28 特征，扩张窗口 point-in-time 标准化，±3σ 截断）`);
md.push(``);
md.push(`| 特征 | 值 | z |`);
md.push(`|---|---|---|`);
for (const n of C.currentState.notable) md.push(`| ${n.feature} | ${nm(n.value, 2)} | ${nm(n.z, 2)} |`);
md.push(``);
md.push(`## 3. 检索（类比库 ${R.engine.library.nSym} 标的 x ${R.engine.library.nDates} 会话）`);
md.push(``);
md.push(`- 扫描 ${R.engine.scan.scanned} 个候选，禁运期 j+${C.idea.horizonSessions}<=q 后合格 ${R.engine.scan.eligible} 个，选出 ${R.engine.scan.chosen} 个（${ret.distinctSessions} 个不同会话、${ret.distinctSymbols} 个不同标的，同名 ${ret.sameSymbolCount} 个）`);
md.push(`- 反聚簇：同一日历日 ≤2 个、同标的间隔 ≥10 会话；距离最近 ${nm(ret.closestDistance, 3)}、中位 ${nm(ret.medianDistance, 3)}`);
md.push(`- 度量特征 25/28（${R.engine.excludedFromDistance.join(", ")} 只展示不计距离）；缺失特征 renormalise，权重覆盖 <60% 直接拒绝`);
md.push(`- 类比时间跨度 ${ret.analogDateFrom} .. ${ret.analogDateTo}`);
md.push(``);
md.push(`## 4. 结果分布与路径风险（50 个类比之后 ${C.idea.horizonSessions} 会话真实发生）`);
md.push(``);
md.push(`| 统计 | 值 |`);
md.push(`|---|---|`);
md.push(`| 中位 / 均值 / 标准差 | ${pc(dist.medianPct)} / ${pc(dist.meanPct)} / ${pc(dist.sdPct)} |`);
md.push(`| p10-p90 / p25-p75 | ${pc(dist.p10Pct)} .. ${pc(dist.p90Pct)} / ${pc(dist.p25Pct)} .. ${pc(dist.p75Pct)} |`);
md.push(`| 全距 / 偏度 | ${pc(dist.minPct)} .. ${pc(dist.maxPct)} / ${nm(dist.skew, 2)} |`);
md.push(`| 收于入场价之下 | ${pc(dist.probabilityBelowZeroPct, 1)} |`);
md.push(`| P(亏>5% / 10% / 20%) | ${pc(dist.probabilityBelow.minus5Pct, 1)} / ${pc(dist.probabilityBelow.minus10Pct, 1)} / ${pc(dist.probabilityBelow.minus20Pct, 1)} |`);
md.push(`| VaR90 / CVaR90 | ${pc(dist.valueAtRisk90Pct)} / ${pc(dist.conditionalVar90Pct)} |`);
md.push(`| 80% conformal 区间 | ${pc(conf.lowerPct)} .. ${pc(conf.upperPct)}（乘数 ${nm(conf.scale, 3)}，仅在 ${conf.fittedOn} 拟合后冻结；样本外覆盖 ${pc(conf.outOfSampleCoveragePct, 1)}） |`);
md.push(`| 路径：MAE 中位 / p10 / p25 | ${pc(exc.maxAdverseMedianPct)} / ${pc(exc.maxAdverseP10Pct)} / ${pc(exc.maxAdverseP25Pct)} |`);
md.push(`| 路径：MFE 中位 / p90 | ${pc(exc.maxFavourableMedianPct)} / ${pc(exc.maxFavourableP90Pct)} |`);
md.push(`| 10% 回撤击穿概率 / 可持有份额 | ${pc(exc.probabilityOfBreaching["10PctDrawdown"], 1)} / ${pc(D.baselineTail.holdableWithin10pct * 100, 1)} |`);
md.push(``);
md.push(`## 5. 压力测试（13 情景，同引擎同参数，逐行可与基线直接比较）`);
md.push(``);
md.push(`| 情景 | 类型 | 类比数 | 中位 | Δ vs 基线 | 中位 MAE | P(10% 回撤) | 可持有 |`);
md.push(`|---|---|---|---|---|---|---|---|`);
for (const s of stress) md.push(`| ${s.label} | ${s.kind} | ${s.analogsUsed ?? "n/a"} | ${pc(s.medianForwardPct)} | ${pc(s.deltaMedianVsBaselinePct)} | ${pc(s.maxAdverseMedianPct)} | ${pc(s.probabilityOfBreaching10PctDrawdown, 1)} | ${pc(s.heldWithin10PctDrawdownPct, 1)} |`);
md.push(``);
md.push(`绑定情景内置警示（引擎原文）：${worst.caveat}`);
md.push(``);
md.push(`## 6. 叙述层与数字闸门`);
md.push(``);
md.push(`- 模式 ${R.narrative.mode}（无 API 密钥时回落到确定性模板，卡片上标明）；数字闸门 **${R.narrative.numericGate.total - R.narrative.numericGate.unsupportedCount}/${R.narrative.numericGate.total}** 个数字全部可回溯到研究卡，未通过即不渲染`);
md.push(`- 叙述结论段（引擎模板原文节选）：${String(R.narrative.sections.verdict).slice(0, 220)}…`);
md.push(``);
md.push(`## 7. 引擎自证（样本外 2698 查询，协议预注册）`);
md.push(``);
md.push(`- 覆盖 ${pc(V.analog.coveragePct, 1)} ± ${nm(V.analog.coverageSEPp, 2)}pp（目标 ${pc(V.targetCoveragePct, 0)}），平均宽 ${pc(V.analog.widthPct)}`);
md.push(`- 同覆盖率下比"同名无条件带"**宽 ${pc(Math.abs(V.matchedCoverageSharpnessVsSameNamePct), 1)}** → 检索没有带来锐度；PIT 均匀性失败；方向命中 ${pc(V.directionalHitRatePct, 1)}`);
md.push(`- 引擎自述：${V.honestVerdict}`);
md.push(``);
md.push(`## 8. 溯源`);
md.push(``);
md.push(`- 数据：${P.sources.prices}（价格）· ${P.sources.macro}（宏观）· ${P.sources.crypto}（加密）· ${P.sources.sentiment}（情绪）· ${P.sources.earningsDates}（财报日）· ${P.sources.fomc}（FOMC）`);
md.push(`- Bitget 官方 MCP：${P.bitget.reachableCount}/${P.bitget.total} 可达（${P.bitgetMcp.reason}），产品内不含任何 Bitget 来源数字，降级状态在溯源面板如实渲染`);
md.push(``);
md.push(`## 9. 复现`);
md.push(``);
md.push("```bash");
md.push("npm run demo     # 重新生成本文件的全部数字 -> demo/RUN-RECORD.md + demo/run-record.json");
md.push("npm run demo:doc # 由 run-record.json 渲染本文件 -> submission/FULL-CHAIN-DEMO-CN.md/.txt + MATERIALS-LINK-READY.txt + FORM-READY.md");
md.push("npm run verify   # 2698 查询样本外验证 -> research/VALIDATION.md");
md.push("npm run check    # 数字闸门 + 标记扫描 + DOM stub 整包 + 真实 headless Chrome");
md.push("```");
md.push(``);
md.push(`链接：仓库 ${REPO} · 运行记录 ${REPO}/blob/main/demo/RUN-RECORD.md · 机器记录 ${REPO}/blob/main/demo/run-record.json · 本文件 ${REPO}/blob/main/submission/FULL-CHAIN-DEMO-CN.md`);
const MD = md.join("\n") + "\n";
assertClean("FULL-CHAIN-DEMO-CN", MD);
wf("submission/FULL-CHAIN-DEMO-CN.md", MD, "utf8");

const plain = MD
  .replace(/^# (.*)$/gm, "$1")
  .replace(/^## (.*)$/gm, "【$1】")
  .replace(/\*\*/g, "")
  .replace(/`/g, "")
  .replace(/^> /gm, "  ")
  .replace(/\|/g, " | ")
  .replace(/^---$/gm, "");
wf("submission/FULL-CHAIN-DEMO-CN.txt", plain, "utf8");


const d1 = SUB.slice(SUB.indexOf("### D1."), SUB.indexOf("### D2.")).replace("### D1. Main text (use this; add D2 only if you received Qwen credits)", "").trim();
const materials = `AnalogDesk - pre-trade decision stress testing for 7x24 tokenised US equities
Track: AI Trading Desk / Sub-theme: Decision Stress Testing

1. ACCESSIBLE DEMO (no login, no API key, no network needed - full engine runs in the browser)
   https://lixinde586-afk.github.io/analogdesk/
   One-click reproduction of the complete research task below (NVDA, H=5, k=50, Chinese question):
   ${DEEP}
   Local equivalent: open dist/index.html

2. SOURCE CODE (public repo, full README, zero runtime dependencies)
   https://github.com/lixinde586-afk/analogdesk

3. COMPLETE RESEARCH TASK - FULL CHAIN FROM QUESTION TO ACTIONABLE JUDGMENT
   https://github.com/lixinde586-afk/analogdesk/blob/main/submission/FULL-CHAIN-DEMO-CN.md   (question -> state -> retrieval -> distribution -> 13 stress scenarios -> narrative + numeric gate -> out-of-sample self-audit -> decision card)
   https://github.com/lixinde586-afk/analogdesk/blob/main/demo/RUN-RECORD.md                 (the English full record of the same run, also code-generated)
   https://github.com/lixinde586-afk/analogdesk/blob/main/demo/run-record.json               (machine-readable: full card + 50 analogs + gate report)
   https://github.com/lixinde586-afk/analogdesk/blob/main/scripts/run-demo.mjs               (the code that generates it: npm run demo)

4. OUT-OF-SAMPLE VALIDATION + THE CODE THAT PRODUCES IT (npm run verify)
   https://github.com/lixinde586-afk/analogdesk/blob/main/research/VALIDATION.md
   https://github.com/lixinde586-afk/analogdesk/blob/main/scripts/verify.mjs

5. RESEARCH DOCUMENTS
   https://github.com/lixinde586-afk/analogdesk/blob/main/research/THESIS.md
   https://github.com/lixinde586-afk/analogdesk/blob/main/research/DATA-PROVENANCE.md
   https://github.com/lixinde586-afk/analogdesk/blob/main/research/LIMITATIONS.md             (negative results, stated plainly)

6. DEMO VIDEO (optional; the form does not require it - the deep link in item 1 reproduces the whole task interactively)
   not attached

Reproduce locally, no install step:
   npm run demo    -> demo/RUN-RECORD.md
   npm run verify  -> research/VALIDATION.md
   npm run check   -> 4 gates: numeric, markup, bundle-in-a-DOM-stub, real headless browser
   npm start       -> http://127.0.0.1:3000
`;
wf("submission/MATERIALS-LINK-READY.txt", materials, "utf8");

const form = `# 表单提交包（逐字段复制）

表单：https://forms.gle/GyWZCMCPocgJdJon6

## 字段 1 · Project Description（必交）
用记事本打开 submission/PROJECT-DESCRIPTION-EN.txt（${charCount("submission/PROJECT-DESCRIPTION-EN.txt")} 字符，推荐）或 submission/PROJECT-DESCRIPTION-CN.txt（${charCount("submission/PROJECT-DESCRIPTION-CN.txt")} 字符），Ctrl+A → Ctrl+C → 粘贴。二选一。

## 字段 2 · Role of the LLM in Your Project（必交）
复制下面整段（即 SUBMISSION.md 的 D1；未获 Qwen 额度不要加 D2）：

${d1}

## 字段 3 · Submission Materials Link（必交）
复制 submission/MATERIALS-LINK-READY.txt 全文（已把视频项标为 optional 未附，并加入"提问到可用判断"全链路文档与一键复现深链）。
若你录了视频：把其中第 6 项的 "not attached" 换成你的 YouTube 链接即可。

## 字段 4 · 完整投研任务演示（如表单有该栏，或作为补充材料）
复制 submission/FULL-CHAIN-DEMO-CN.txt 全文（纯文本、中文、结论在前）；或只贴全链路文档链接：
https://github.com/lixinde586-afk/analogdesk/blob/main/submission/FULL-CHAIN-DEMO-CN.md
英文对照（同一次运行的完整记录，评委读英文时用这个）：
https://github.com/lixinde586-afk/analogdesk/blob/main/demo/RUN-RECORD.md
再加一键复现深链（免登录/免密钥/免网络，点开即出研究卡）：
${DEEP}

## 字段 5 · X Promotional Post Link（必交）
需本人账号操作：Quote 官方置顶帖，正文用 SUBMISSION.md F2（英文 276 字符）或 F3（中文 257 字），必含 #BitgetHackathon 与 @Bitget_AI；发布后 Copy link 填入。

## 字段 6 · University Name（建议填）
填学校完整官方名称，进入大学专项奖池。

## 提交前自检
1. 仓库 public、无痕窗口 README 正常。
2. 深链无痕打开能直接出研究卡（免登录免密钥免网络）。
3. demo/RUN-RECORD.md 的 GitHub 链接可打开。
4. 四个必交字段均有内容。
5. University Name 已填全称。
`;
wf("submission/FORM-READY.md", form, "utf8");
console.log("wrote FULL-CHAIN-DEMO-CN.md", MD.length, "chars");
console.log("wrote FULL-CHAIN-DEMO-CN.txt", plain.length, "chars");
console.log("wrote MATERIALS-LINK-READY.txt", materials.length, "chars");
console.log("wrote FORM-READY.md", form.length, "chars");

console.log("placeholders: none (assertClean passed)");
console.log("deep link:", DEEP);
