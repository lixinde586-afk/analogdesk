# 只需你做的三件事 · Your three tasks

项目已经全部构建完成并可运行。**你不需要写任何代码。** 下面三件事只有你能做（需要你的账号/身份），
每件都给了逐字可粘贴的内容。目标：9/25 前提交，官方截止 9/27（UTC+8）。

所有要粘贴的文字都在 `submission/SUBMISSION.md` 里，按章节编号取用。

---

## 已经替你完成 · 项目已在公网可访问

| 交付物 | 地址 / 状态 |
|---|---|
| GitHub **public** 仓库（含完整 README） | https://github.com/lixinde586-afk/analogdesk |
| 在线 Demo（GitHub Pages，免登录 / 免密钥 / 免网络） | https://lixinde586-afk.github.io/analogdesk/ |
| Pages 构建状态 | `built`；四个静态文件全部返回 200，且线上 `index.html` / `styles.css` / `app.bundle.js` 的 sha256 与本地构建产物**逐字节相同** |
| 线上与本地一致性 | `main` 远端根树 `273b4b5` 与本地 HEAD 完全相同（58 个 blob，0 处不一致）；`gh-pages` 的根树就是 HEAD 的 `dist` 子树 `b94ae62`，5/5 条目逐一核对一致。工作副本已全部归一化为 LF，此前 `.gitattributes` 造成的 2 字节 CRLF 差异已消除——**本地验证的产物 = git 里的产物 = Pages 上的产物** |
| 真实浏览器复验 | `npm run check:live` 直接打线上地址，3 个场景全绿：NVDA H=5 深链、KWEB H=10 中文提问深链、无参数冷加载；控制台无未捕获异常，浏览器内引擎 71 标的 x 2513 交易日，13 个压力情景，15 个面板全部渲染，0 次网络请求 |
| 运行记录（必交，代码生成非截图） | `demo/RUN-RECORD.md` + `demo/run-record.json` + 生成器 `scripts/run-demo.mjs` |

三件你可能想知道的事：

1. **为什么没用 `git push`**：这台机器上 `github.com:443` 被阻断（TCP 连接超时 20 秒），而 `api.github.com`
   返回 200。所以我写了 `scripts/publish-github.mjs`：用 GitHub 的 Git Data API 把提交对象逐个上传，
   并把 API 返回的每一个 SHA 与 git 本地值比对，任何不一致立即中止。已发布内容与本地提交是同一棵对象树。
   以后要更新仓库，改完文件后执行 `git add -A; git commit -m "..."; npm run publish:github` 即可。
2. **GitHub 登录态**：账号 `lixinde586-afk`，凭据由 GitHub CLI 存在你本机
   `%APPDATA%\GitHub CLI\hosts.yml`，没有被打印、没有进仓库、也没有写进任何提交。
   想随时撤销：GitHub → Settings → Applications → Authorized GitHub Apps → GitHub CLI → Revoke。
   （另外 `git` 因为文件属主是沙箱账号，加过一条 `safe.directory` 例外，仅影响这台机器。）
3. **你报的那个 bug（页面能打开、输入没反应）已经修好并复验**：原因是 `web/index.html` 里输入框的
   `placeholder` 属性用单引号开、用双引号闭，属性值永远没有结束，浏览器于是把后面的 **25 个元素**
   （Analyze 按钮、所有下拉框、标签栏、五个结果面板）全部吞进了这一个属性里——页面上其实只剩一个畸形
   输入框，事件也从未绑定，所以怎么点都没反应。我此前只在 Node 的 DOM 假环境里测过、没在真实浏览器里
   点一遍，**是你发现的，谢谢**。现在多了两道闸门：`npm run check:html`（按属性感知解析标记，能识别
   "id 只是文本、不是真元素"）和 `npm run check:browser`（起真实 headless Chrome，注入探针模拟输入
   问题、按回车、切标签页、改标的、点 Analyze）。两道闸门都拿旧的坏版本反向验证过，确实会失败——
   不会失败的测试没有价值。另外 `web/app.js` 现在启动前会核对所需元素，缺哪个就直接在页面上写出来，
   不再只在没人看的控制台里静默失败。

---

## 唯一还需要你做的一次性动作 · 录 3 分钟视频

表单本身不强制要求视频（Demo 免登录，属于"可访问"），但 AI Trading Desk 赛道允许附**屏幕录像**，
而且"完整投研任务的演示"有视频会让评审打分更稳。分镜脚本已经写好，照着录即可。

1. 打开 https://lixinde586-afk.github.io/analogdesk/ （或本地 `dist\index.html`，两者完全相同）。
2. 按 `Win + G` 打开 Xbox Game Bar → 点录制（或按 `Win + Alt + R`）。
3. 照 `submission/SUBMISSION.md` **第 G 节**的分镜表操作：输入 `英伟达 未来5天` → 状态面板 → 类比清单 →
   分布与路径风险 → 点两个压力情景 → 切到终端跑 `npm run demo` 展示 `RUN-RECORD.md` 与
   `142/142` 数字闸门 → 展示诚实结论面板 → 结束卡。
4. 上传到 YouTube（公开或"知道链接的人可看"），拿到链接。
5. 把链接替换掉 `submission/SUBMISSION.md` 里剩下的 3 处 `<VIDEO_URL>`（Ctrl+H 全部替换），
   然后第 E 节那段就能整段粘贴进表单。

> 录完把链接发我，我可以替你替换占位符并重新发布仓库（`npm run publish:github`），你不用碰命令行。

---

## 第一件事（可选）· 注册百炼 API Key

**不做也完全不影响提交和评审**：没有密钥时产品自动回落到「回放缓存 → 确定性模板」，
静态 Demo（`dist/`）本来就不联网，评审看到的画面一模一样。区别只是研究卡的文案由 qwen-plus 实时生成
还是由模板生成，卡片上会标明是哪一种。

想做的话：

1. 打开 https://bailian.console.aliyun.com/ ，用阿里云账号登录，开通「百炼」。
2. 右上角头像 → **API-KEY** → 创建 API Key，复制那串 `sk-...`。
3. 在项目根目录把 `.env.example` 复制成 `.env`，填成：

```
DASHSCOPE_API_KEY=sk-你复制的那串
```

4. 重启服务：`npm start`，浏览器打开 http://127.0.0.1:3000 ，输入 `英伟达 未来5天`。
   研究卡右上角应显示 **LIVE / qwen-plus**；如果显示 TEMPLATE，说明密钥没读到，检查 `.env` 有没有多余空格。
5. **另外**：黑客松有单独的「Qwen build credit」申请表（不是提交表单）。如果你申请到了额度，
   就在 `submission/SUBMISSION.md` 的 **D2** 段落里保留那段话一起粘贴；如果没申请到，
   **把 D2 整段删掉**——官方 FAQ 明确说没有额度可以跳过 Qwen 部分，不影响评分，也不要虚报额度。

⚠️ `.env` 已被 `.gitignore` 排除，永远不会被推上 GitHub。不要把密钥发到聊天、帖子或表单里。

---

## 第二件事 · 发 X 帖（必交，缺了直接判无效）

合规硬要求（来自大赛文档）：帖子里必须有 `#BitgetHackathon` 和 `@Bitget_AI`，必须**引用转发**（Quote）
官方这条推文 https://x.com/Bitget_AI/status/2100519318824055159?s=20 ，必须有实质性介绍
（纯转发或无内容 = 提交不完整）。必须用**你自己的账号**发（KOL/KOC 代发的数据不计入传播奖）。

操作步骤：

1. 打开 https://x.com/Bitget_AI/status/2100519318824055159?s=20
2. 点 **Quote / 引用**（不要点 Repost）。用引用方式，链接不会占用你的字数。
3. 粘贴 `submission/SUBMISSION.md` → **F2** 那段英文（273 字符，已在 280 限内）。
   想发中文就用 **F3**（257 字符）。想再发一条开发日志用 **F4**（268 字符），对传播奖有加分。
4. 配一张图：打开 `dist/index.html`，输入 `NVDA`，截图那张研究卡的分布图部分。
   （截图只是配图，**不是**提交材料本身——运行记录是代码生成的 `demo/RUN-RECORD.md`。）
5. 发布后：点自己那条推文 → Share → **Copy link**，这个链接就是表单里的
   「X Promotional Post Link」字段要填的内容。

发之前自检（4 项，缺一即无效）：`#BitgetHackathon` ✅ / `@Bitget_AI` ✅ / 是 Quote 而不是 Repost ✅ /
有产品介绍正文而不是只有一句话 ✅

---

## 第三件事 · 填表单

表单地址：https://forms.gle/GyWZCMCPocgJdJon6 · 逐字段对照下表。**「项目描述」必须在表单里写完整，
GitHub README 或 X 长推都不能替代。**

「项目描述」已经为你准备好两个**纯文本文件**（已去掉 Markdown 符号、合并断行、中文用全角引号，粘进表单不会出现
`**` 或 `#` 这类符号），二选一：

| 文件 | 字符数 | 什么时候用 |
|---|---|---|
| `submission\PROJECT-DESCRIPTION-EN.txt` | 17,345 | **推荐**：评审是国际团队，英文版信息最全 |
| `submission\PROJECT-DESCRIPTION-CN.txt` | 7,028 | 若表单提示内容过长、或你更想用中文 |

两个文件都由 `npm run form:text` 从 `submission/SUBMISSION.md` 自动生成（不是手抄），所以改了 SUBMISSION.md
之后重跑一次这个命令，txt 就会同步更新。其余字段（Role of the LLM、材料链接、X 帖）仍从 SUBMISSION.md 复制，
那些字段较短、带 Markdown 也不影响阅读。

| 表单字段 | 填什么 | 从哪复制 |
|---|---|---|
| 项目基本信息（名称/队名/Bitget UID 等） | 项目名 `AnalogDesk`；队名按你自己；UID 填你的 Bitget UID | — |
| Are you an S1 participant/team | `No` | — |
| Track | `AI Trading Desk` | — |
| Sub-theme | `Decision Stress Testing` | — |
| **Project Description** ✅必交 | 用记事本打开 `submission\PROJECT-DESCRIPTION-EN.txt`（英文，17,345 字符）**或** `submission\PROJECT-DESCRIPTION-CN.txt`（中文，7,028 字符）→ Ctrl+A 全选 → Ctrl+C → 粘进表单。**二选一，不要两份都贴** | 那两个 txt 文件 |
| **Role of the LLM in Your Project** ✅必交 | 整段粘贴 D1；有 Qwen 额度再加上 D2 | `SUBMISSION.md` → **D** |
| **Submission Materials Link** ✅必交 | 整段粘贴（已含 Demo/代码/运行记录/验证报告/研究文档/视频六项，替换好占位符后直接贴） | `SUBMISSION.md` → **E** |
| **X Promotional Post Link** ✅必交 | 第二件事里复制的那条帖子链接 | — |
| **University Name** ⚪但一定要填 | 你学校的**完整官方名称**（中文全称或英文全称都可，建议与在读证明一致）。填了才进大学专项奖池（10 × 500 USDT）；留空则不参与评审 | — |
| Apply for Demo Day | 想参加就勾，不影响主赛道评审 | — |
| Apply for K3 Token Subsidy | 与 Qwen 额度申请无关，按需 | — |

提交前 5 项自检：

1. 仓库是 **public**，无痕窗口能打开，README 正常渲染（有表格和代码块）。
2. `<DEMO_URL>` 无痕窗口能打开，能输入 `NVDA` 并出卡片。
3. `demo/RUN-RECORD.md` 的 GitHub 链接能打开（这是「运行记录」，代码生成、非截图）。
4. 四个必交字段都有内容：项目描述 / Role of the LLM / 材料链接 / X 帖链接。
5. University Name 已填全称。

---

## 时间线建议

| 日期 | 做什么 |
|---|---|
| 已完成 ✅ | 仓库已建、代码已发布、Pages 已上线并逐字节校验 |
| 9/22 | 录 3 分钟视频（G 节分镜），上传 YouTube，把链接发我替换 `<VIDEO_URL>` |
| 9/23 | 发 X 帖（F2 + 配图），复制链接；可选：注册百炼 Key 跑一次 LIVE 模式截图留档 |
| 9/24 | 填表单，六个部分逐段粘贴，做完 5 项自检 |
| **9/25** | **提交**（留 2 天缓冲应对表单/网络问题） |
| 9/27 | 官方截止（UTC+8） |

提交完成后，官方会公布 project ID；届时在公开投票帖下评论你的 ID 即可参与投票（每个账号 1 票）。

---

## 出问题时找我，附上这几行

```powershell
cd "C:\Users\26973\Documents\Codex\2026-09-18\codex-mcp-add-bitgetai-hackathons2-url\outputs\analogdesk"
npm run demo      # 重新生成运行记录（离线可跑，约 2 秒）
npm run check     # 四道闸门：数字闸门 + 标记扫描 + DOM stub 整包 + 真实 headless Chrome（需本机 Chrome/Edge）
npm run check:live # 把同一组页面断言打在已部署的线上地址上
npm start         # 本地全功能服务：http://127.0.0.1:3000
```

任何一步报错，把完整报错文字发我即可。项目零依赖，不需要 `npm install`。