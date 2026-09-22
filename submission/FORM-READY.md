# 表单提交包（逐字段复制）

表单：https://forms.gle/GyWZCMCPocgJdJon6

## 字段 1 · Project Description（必交）
用记事本打开 submission/PROJECT-DESCRIPTION-EN.txt（18,840 字符，推荐）或 submission/PROJECT-DESCRIPTION-CN.txt（7,634 字符），Ctrl+A → Ctrl+C → 粘贴。二选一。

## 字段 2 · Role of the LLM in Your Project（必交）
复制下面整段（即 SUBMISSION.md 的 D1；未获 Qwen 额度不要加 D2）：

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

## 字段 3 · Submission Materials Link（必交）
复制 submission/MATERIALS-LINK-READY.txt 全文（已把视频项标为 optional 未附，并加入"提问到可用判断"全链路文档与一键复现深链）。
若你录了视频：把其中第 6 项的 "not attached" 换成你的 YouTube 链接即可。

## 字段 4 · 完整投研任务演示（如表单有该栏，或作为补充材料）
复制 submission/FULL-CHAIN-DEMO-CN.txt 全文（纯文本、中文、结论在前）；或只贴全链路文档链接：
https://github.com/lixinde586-afk/analogdesk/blob/main/submission/FULL-CHAIN-DEMO-CN.md
英文对照（同一次运行的完整记录，评委读英文时用这个）：
https://github.com/lixinde586-afk/analogdesk/blob/main/demo/RUN-RECORD.md
再加一键复现深链（免登录/免密钥/免网络，点开即出研究卡）：
https://lixinde586-afk.github.io/analogdesk/?symbol=NVDA&horizon=5&k=50&run=1&q=NVDA%20%E7%8E%B0%E5%9C%A8%E8%BF%99%E4%B8%AA%E4%BD%8D%E7%BD%AE%E8%BF%9B%E5%9C%BA%EF%BC%8C%E6%9C%AA%E6%9D%A5%E4%B8%80%E5%91%A8%E5%8E%86%E5%8F%B2%E4%B8%8A%E7%9B%B8%E4%BC%BC%E7%9A%84%E8%B5%B0%E5%8A%BF%E6%98%AF%E4%BB%80%E4%B9%88%E6%A0%B7%E7%9A%84%EF%BC%9F

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
