/**
 * Turn the paste-ready X posts in section F of submission/SUBMISSION.md into plain-text files and
 * prove that each of them actually fits the platform:
 *
 *   submission/X-POST-MAIN-EN.txt     (F2 - the quote-tweet you submit)
 *   submission/X-POST-MAIN-CN.txt     (F3 - Chinese equivalent)
 *   submission/X-POST-DEVLOG-EN.txt   (F4 - optional reply under your own post)
 *
 * Section F5 (the optional 3-tweet thread) is measured and validated too, but deliberately not written
 * to disk: three extra files that each hold one paragraph is clutter, and the thread is posted straight
 * out of SUBMISSION.md.
 *
 * Every block is checked against X's own weighted-length rule (twitter-text v3): code points in
 * U+0000-U+10FF, U+2000-U+200F, U+2010-U+201F and U+2032-U+2037 weigh 1, every other code point
 * (CJK, full-width punctuation, emoji) weighs 2, and any URL is billed at a flat 23 regardless of
 * length. A quoted post does not consume budget, so the quote-tweet itself is not counted.
 *
 * The script aborts (exit 1) rather than writing anything if a block is over 280 weighted units, drops
 * #BitgetHackathon or @Bitget_AI, contains a placeholder, contains leftover Markdown, or links to a URL
 * that is not the deployed demo or the public repo. Run with `npm run xpost`.
 */
import { readFileSync, writeFileSync } from "node:fs";

const SRC = "submission/SUBMISSION.md";
const DEMO = "https://lixinde586-afk.github.io/analogdesk/";
const REPO = "https://github.com/lixinde586-afk/analogdesk";
const OFFICIAL = "https://x.com/Bitget_AI/status/2100519318824055159?s=20";
const TAG = "#BitgetHackathon";
const HANDLE = "@Bitget_AI";
const LIMIT = 280;
const URL_WEIGHT = 23;

/** Code-point ranges that X bills at 1 unit; everything else costs 2. */
const SINGLE_WEIGHT = [[0x0000, 0x10ff], [0x2000, 0x200f], [0x2010, 0x201f], [0x2032, 0x2037]];
const charWeight = (cp) => (SINGLE_WEIGHT.some(([lo, hi]) => cp >= lo && cp <= hi) ? 1 : 2);

/** Weighted length of a post, with every URL replaced by its flat 23-unit bill. */
export function weightedLength(text) {
  let total = 0;
  for (const chunk of text.split(/(https?:\/\/\S+)/g)) {
    if (/^https?:\/\//.test(chunk)) total += URL_WEIGHT;
    else for (const ch of chunk) total += charWeight(ch.codePointAt(0));
  }
  return total;
}

const md = readFileSync(SRC, "utf8");
const start = md.indexOf("## F. Compliant X post");
if (start < 0) throw new Error("section F not found in " + SRC);
const end = md.indexOf("\n## G.", start);
if (end < 0) throw new Error("section G not found after section F in " + SRC);
const section = md.slice(start, end);

/** Collect the fenced blocks under each `### F<n>.` heading, in document order. */
function blocksOf(sectionId) {
  const re = new RegExp(`^### ${sectionId}\\.[^\\d]`, "m");
  const from = section.search(re);
  if (from < 0) throw new Error(`subsection ${sectionId} not found in section F`);
  const rest = section.slice(from);
  // search past the heading itself, otherwise the subsection matches its own opening line
  const stop = rest.slice(1).search(/^### F\d+\.[^\d]/m);
  const body = stop < 0 ? rest : rest.slice(0, stop + 1);
  const blocks = [...body.matchAll(/```\r?\n([\s\S]*?)```/g)].map((m) => m[1].replace(/\r/g, "").replace(/\n+$/, ""));
  if (!blocks.length) throw new Error(`no fenced post text in subsection ${sectionId}`);
  return blocks;
}

const PLAN = [
  { id: "F2", file: "submission/X-POST-MAIN-EN.txt", label: "main post, English", eachBlockIsAPost: true },
  { id: "F3", file: "submission/X-POST-MAIN-CN.txt", label: "main post, Chinese", eachBlockIsAPost: true },
  { id: "F4", file: "submission/X-POST-DEVLOG-EN.txt", label: "dev-log reply", eachBlockIsAPost: true },
  { id: "F5", file: null, label: "optional 3-tweet thread", eachBlockIsAPost: false },
];

const problems = [];
const rows = [];
const outputs = [];

for (const entry of PLAN) {
  const blocks = blocksOf(entry.id);
  blocks.forEach((text, i) => {
    const where = `${entry.id}${blocks.length > 1 ? `[${i + 1}]` : ""}`;
    const weighted = weightedLength(text);
    rows.push({
      where,
      label: entry.label,
      weighted,
      codePoints: [...text].length,
      urls: (text.match(/https?:\/\/\S+/g) || []).length,
      fits: weighted <= LIMIT,
    });
    if (weighted > LIMIT) problems.push(`${where}: ${weighted}/${LIMIT} weighted units - too long`);
    if (/<[A-Z_]+>/.test(text)) problems.push(`${where}: placeholder left in the copy`);
    if (/\*\*|`|^#{1,6}\s|^\s*\|/m.test(text)) problems.push(`${where}: Markdown residue in a plain-text field`);
    if (/[ \t]+$/m.test(text)) problems.push(`${where}: trailing whitespace`);
    for (const url of text.match(/https?:\/\/\S+/g) || []) {
      if (url !== DEMO && url !== REPO && url !== OFFICIAL) problems.push(`${where}: unrecognised URL ${url}`);
    }
    // A thread's later tweets inherit the tags from tweet 1, so only standalone posts must each carry both.
    const needsTags = entry.eachBlockIsAPost;
    if (needsTags) {
      if (!text.includes(TAG)) problems.push(`${where}: missing ${TAG}`);
      if (!text.includes(HANDLE)) problems.push(`${where}: missing ${HANDLE}`);
    }
  });
  if (!entry.eachBlockIsAPost) {
    const joined = blocks.join("\n");
    if (!joined.includes(TAG)) problems.push(`${entry.id}: no block carries ${TAG}`);
    if (!joined.includes(HANDLE)) problems.push(`${entry.id}: no block carries ${HANDLE}`);
  }
  if (entry.file) outputs.push([entry.file, blocks[0]]);
}

if (problems.length) {
  console.error("X post copy FAILED validation:");
  for (const p of problems) console.error("  - " + p);
  process.exit(1);
}

for (const [file, text] of outputs) writeFileSync(file, text + "\n", { encoding: "utf8" });

const pad = (s, n) => String(s).padEnd(n);
console.log(`${pad("block", 8)}${pad("weighted", 10)}${pad("codepoints", 12)}${pad("urls", 6)}what`);
for (const r of rows) console.log(`${pad(r.where, 8)}${pad(`${r.weighted}/${LIMIT}`, 10)}${pad(r.codePoints, 12)}${pad(r.urls, 6)}${r.label}`);
for (const [file] of outputs) console.log(`wrote ${file}`);
console.log(`all blocks <= ${LIMIT} weighted units, ${TAG} and ${HANDLE} present, no placeholders, no Markdown`);
