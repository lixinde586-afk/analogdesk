/**
 * Extract the two paste-ready versions of the form's "Project Description" field out of
 * submission/SUBMISSION.md and write them as plain text:
 *
 *   submission/PROJECT-DESCRIPTION-EN.txt   (section B)
 *   submission/PROJECT-DESCRIPTION-CN.txt   (section C)
 *
 * Google Forms renders a long-answer field as raw text, so Markdown is stripped rather than kept:
 * emphasis and inline code are unwrapped, tables become one "header: value" line per row, and
 * hard-wrapped paragraphs and list items are re-joined into single lines so the form's own wrapping
 * decides the layout. Run with `npm run form:text`.
 */
import { readFileSync, writeFileSync } from "node:fs";

const SRC = "submission/SUBMISSION.md";
const GH = "https://github.com/lixinde586-afk/analogdesk";
const DEMO = "https://lixinde586-afk.github.io/analogdesk/";
const md = readFileSync(SRC, "utf8");

const extract = (startMark, endMark) => {
  const i = md.indexOf(startMark);
  if (i < 0) throw new Error(`section start not found: ${startMark}`);
  const j = md.indexOf(endMark, i);
  if (j < 0) throw new Error(`section end not found: ${endMark}`);
  return md.slice(i + startMark.length, j);
};

const CJK = /[\u2E80-\u9FFF\u3000-\u303F\uFF00-\uFFEF]/;
/** Join two fragments of one logical line. Chinese needs no space at a CJK/CJK boundary. */
function joinFragments(left, right, lang) {
  if (!left) return right;
  if (lang === "cn" && CJK.test(left.slice(-1)) && CJK.test(right.slice(0, 1))) return left + right;
  return left + " " + right;
}
/** Inline Markdown only, applied per line BEFORE fragments are joined, so the CJK spacing rule
 *  sees the real characters rather than asterisks and backticks. */
function stripInline(s) {
  return s
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/(^|[^*\w])\*([^*]+?)\*(?=$|[^*\w])/g, "$1$2")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)");
}

/** Turn ASCII double quotes into full-width ones in Chinese copy, alternating per line. */
function cjkQuotes(text) {
  return text.split("\n").map((line) => {
    let open = false;
    return line.replace(/"/g, () => { open = !open; return open ? "\u201c" : "\u201d"; });
  }).join("\n");
}

export function markdownToPlainText(body, lang = "en") {
  const out = [];
  let block = null;
  let table = [];
  const flushBlock = () => { if (block) { out.push(lang === "cn" ? block.replace(/[ \t]{2,}/g, " ").trim() : block.replace(/\s+/g, " ").trim()); block = null; } };
  const flushTable = () => {
    if (!table.length) return;
    const rows = table.filter((r) => !/^\|[\s:|-]+\|$/.test(r))
      .map((r) => r.replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
    const head = rows.shift() || [];
    flushBlock();
    for (const r of rows) out.push(r.map((c, i) => `${head[i] || `col${i + 1}`}: ${c}`).join("  |  "));
    out.push("");
    table = [];
  };

  for (const raw of body.split(/\r?\n/)) {
    const line = stripInline(raw.replace(/\s+$/, ""));
    if (/^\s*\|/.test(line)) { table.push(line.trim()); continue; }
    flushTable();
    if (/^\s*(-{3,}|={3,})\s*$/.test(line)) { flushBlock(); out.push(""); continue; }
    const heading = line.match(/^#{2,4}\s+(.*)$/);
    if (heading) { flushBlock(); out.push("", heading[1].trim(), ""); continue; }
    if (!line.trim()) { flushBlock(); out.push(""); continue; }
    const item = line.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
    if (item) {
      flushBlock();
      const indent = item[1].length >= 2 ? "   " : "";
      block = `${indent}${/^\d+\./.test(item[2]) ? item[2] : "-"} ${item[3]}`;
      continue;
    }
    block = joinFragments(block, line.trim(), lang);
  }
  flushBlock(); flushTable();

  let text = out.join("\n")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/(^|[^*\w])\*([^*\n]+?)\*(?=$|[^*\w])/g, "$1$2")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (lang === "cn") text = cjkQuotes(text);
  return text;
}

const header = {
  en: `AnalogDesk - pre-trade decision stress testing for 7x24 tokenised US equities
Bitget AI Base Camp Hackathon S2 | Track 3: AI Trading Desk | Sub-theme: Decision Stress Testing
Live demo (no login, no API key, no network): ${DEMO}
Source: ${GH}

`,
  cn: `AnalogDesk —— 面向 7x24 代币化美股的开仓前决策压力测试台
Bitget AI Base Camp Hackathon S2 | 赛道 3：AI Trading Desk | 子题：Decision Stress Testing（决策压力测试）
在线 Demo（免登录 / 免密钥 / 免网络）：${DEMO}
源码仓库：${GH}

`
};

let en = header.en + markdownToPlainText(extract("## B. Project Description — ENGLISH (paste as one field)", "\n---\n\n## C."), "en") + "\n";
let cn = header.cn + markdownToPlainText(extract("## C. 项目描述 — 中文（可整段粘贴；与英文版等价）", "\n---\n\n## D."), "cn") + "\n";
en = en.replace(/6\. 3-minute demo video: <VIDEO_URL>/, "6. 3-minute demo video - link given in the Submission Materials Link field");
cn = cn.replace(/6\. 3 分钟演示视频：<VIDEO_URL>/, "6. 3 分钟演示视频 —— 链接见「提交材料链接」字段");

// refuse to ship a raw placeholder or leftover Markdown into a judged form field
for (const [name, text] of [["EN", en], ["CN", cn]]) {
  const ph = text.match(/<[A-Z_]+>/g) || [];
  const mdLeft = text.match(/\*\*|^\|/gm) || [];
  if (ph.length || mdLeft.length) throw new Error(`${name}: placeholders ${ph.length}, markdown ${mdLeft.length}`);
}

writeFileSync("submission/PROJECT-DESCRIPTION-EN.txt", en, "utf8");
writeFileSync("submission/PROJECT-DESCRIPTION-CN.txt", cn, "utf8");
const parts = (t) => (t.match(/^\d · /gm) || []).length;
console.log(`submission/PROJECT-DESCRIPTION-EN.txt  ${[...en].length} chars, ${parts(en)} parts, ${en.split("\n").length} lines`);
console.log(`submission/PROJECT-DESCRIPTION-CN.txt  ${[...cn].length} chars, ${parts(cn)} parts, ${cn.split("\n").length} lines`);
console.log("no placeholders, no residual Markdown");