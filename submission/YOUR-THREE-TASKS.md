# 只需你做的三件事 · Your three tasks

项目已经全部构建完成并可运行。**你不需要写任何代码。** 下面三件事只有你能做（需要你的账号/身份），
每件都给了逐字可粘贴的内容。目标：9/25 前提交，官方截止 9/27（UTC+8）。

所有要粘贴的文字都在 `submission/SUBMISSION.md` 里，按章节编号取用。

---

## 前置（一次性，约 10 分钟）：把项目放到公网

表单要求「可访问的 Demo 或项目地址；GitHub 仓库须为 public 且含完整 README」。这一步需要你的 GitHub 账号，
所以只能你来点。**命令可以整段复制粘贴**，不需要理解内容。

1. 在 https://github.com/new 建一个 **public** 仓库，名字填 `analogdesk`，**不要**勾选 "Add a README"
   （本地已经有了）。建好后复制它的地址，形如 `https://github.com/你的用户名/analogdesk`。
2. 打开 PowerShell，逐段粘贴（第一次会让你在浏览器里登录 GitHub 授权）：

```powershell
cd "C:\Users\26973\Documents\Codex\2026-09-18\codex-mcp-add-bitgetai-hackathons2-url\outputs\analogdesk"
git init -b main
git add -A
git commit -m "AnalogDesk: pre-trade decision stress testing for 7x24 tokenised US equities"
git remote add origin https://github.com/你的用户名/analogdesk.git
git push -u origin main
```

3. 开启 GitHub Pages（给评审的免登录 Demo）：仓库 → Settings → Pages → Source 选 `Deploy from a branch`
   → Branch 选 `main`、目录选 `/dist` → Save。等 1-2 分钟，页面顶部会出现
   `https://你的用户名.github.io/analogdesk/` —— **这就是 `<DEMO_URL>`**。
   打开它、用**无痕窗口**再打开一次，确认能看到界面并输入 `NVDA`。
4. 视频（可选但强烈建议）：按 `submission/SUBMISSION.md` 第 G 节的分镜录 3 分钟，传到 YouTube
   （公开或"知道链接的人可看"），链接就是 `<VIDEO_URL>`。
   录屏用 Windows 自带 `Win + G`（Xbox Game Bar）即可；录 `dist/index.html` 那个页面，不要录开发服务器。
5. 把三个占位符替换掉：在 `submission/SUBMISSION.md` 里用编辑器把 `<GITHUB_URL>`、`<DEMO_URL>`、
   `<VIDEO_URL>` 全部替换成真实链接（Ctrl+H 全部替换），这样第 E 节那段就能直接整段粘贴进表单。

> 如果你把仓库建好并告诉我地址，我可以替你跑 git 命令和替换占位符；GitHub 登录授权那一步必须你本人完成。

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

表单地址：https://forms.gle/GyWZCMCPocgJdJon6 · 逐字段对照下表，内容全部从
`submission/SUBMISSION.md` 复制。**「项目描述」必须在表单里写完整，GitHub README 或 X 长推都不能替代。**

| 表单字段 | 填什么 | 从哪复制 |
|---|---|---|
| 项目基本信息（名称/队名/Bitget UID 等） | 项目名 `AnalogDesk`；队名按你自己；UID 填你的 Bitget UID | — |
| Are you an S1 participant/team | `No` | — |
| Track | `AI Trading Desk` | — |
| Sub-theme | `Decision Stress Testing` | — |
| **Project Description** ✅必交 | 六个部分的长文。**英文版粘贴 B 节；中文版粘贴 C 节**（二选一，或中英都贴：先英文后中文，中间加一行 `--- 中文版 ---`） | `SUBMISSION.md` → **B** 或 **C** |
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
| 今天 | 前置步骤（建仓库 + 推代码 + 开 Pages），确认 Demo 链接可用 |
| 9/22 | 录 3 分钟视频（G 节分镜），上传 YouTube；替换三个占位符 |
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
npm run check     # 校验叙述数字闸门 + 重建静态包
npm start         # 本地全功能服务：http://127.0.0.1:3000
```

任何一步报错，把完整报错文字发我即可。项目零依赖，不需要 `npm install`。