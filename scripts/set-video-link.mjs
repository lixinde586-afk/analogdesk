/**
 * Record where the demo video is published, and wire that one link through the whole submission kit.
 *
 *   npm run video:link -- "https://youtu.be/xxxxxxxxxxx"
 *
 * The URL is validated (https, and a host a judge can open without an account: YouTube or Bilibili),
 * stored in submission/VIDEO-FACTS.json next to the measured facts from npm run video:probe, and
 * substituted into the three deliverable lines of submission/SUBMISSION.md (item 6 of sections B, C
 * and E) - prose that only mentions the placeholder is left alone. If a link was already wired in,
 * that link is replaced instead, so re-uploading a corrected take is a single re-run and no file is
 * ever hand-edited.
 *
 * Deliberately not part of `npm run check`: it needs a URL that only exists after a human uploads
 * the video.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const FACTS_FILE = "submission/VIDEO-FACTS.json";
const SUBMISSION = "submission/SUBMISSION.md";
const PLACEHOLDER = "<VIDEO_URL>";
const ALLOWED_HOSTS = ["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be", "bilibili.com", "www.bilibili.com"];

function fail(message) {
  console.error("video:link FAILED - " + message);
  process.exit(1);
}

const raw = process.argv[2] || process.env.VIDEO_URL;
if (!raw) fail('no URL given. Usage: npm run video:link -- "https://youtu.be/xxxxxxxxxxx"');

let url;
try {
  url = new URL(raw.trim());
} catch {
  fail("not a parseable URL: " + raw);
}
if (url.protocol !== "https:") fail("the link must be https so a judge is not warned off it; got " + url.protocol);
if (!ALLOWED_HOSTS.includes(url.hostname)) {
  fail("host " + url.hostname + " is not one a judge can open without an account. Allowed: " + ALLOWED_HOSTS.join(", "));
}

const link = url.toString();
if (!existsSync(FACTS_FILE)) {
  fail(FACTS_FILE + " does not exist - run npm run video:probe first, so the link is stored beside the measured facts");
}
const facts = JSON.parse(readFileSync(FACTS_FILE, "utf8"));
const previous = facts.publishedUrl;
facts.publishedUrl = link;
writeFileSync(FACTS_FILE, JSON.stringify(facts, null, 2) + String.fromCharCode(10));

// Only the three deliverable lines carry the link: item 6 of section B, item 6 of section C, and the
// bare URL line under item 6 of the section E block. Prose that merely *mentions* the placeholder (the
// note at the top of this file, step 3 of G4) must survive the replacement unchanged, so match by line
// shape instead of doing a blind global replace.
const md = readFileSync(SUBMISSION, "utf8");
const eol = md.includes("\r\n") ? "\r\n" : "\n";
const target = previous && md.includes(previous) ? previous : PLACEHOLDER;
let count = 0;
const rewritten = md.split(/\r?\n/).map((line) => {
  const trimmed = line.trim();
  const isDeliverableLine = trimmed.startsWith("6.") && trimmed.includes(target);
  const isBareUrlLine = trimmed === target;
  if (!isDeliverableLine && !isBareUrlLine) return line;
  count += 1;
  return line.split(target).join(link);
});
if (!count) {
  fail("no deliverable line in " + SUBMISSION + " still carries " + (previous ? "the previous link" : PLACEHOLDER) + " - nothing to replace");
}
writeFileSync(SUBMISSION, rewritten.join(eol));

console.log("video:link - " + link);
console.log("  stored in  " + FACTS_FILE + (previous ? " (replaced " + previous + ")" : " (publishedUrl was empty)"));
console.log("  wired into " + count + " place" + (count === 1 ? "" : "s") + " in " + SUBMISSION);
console.log("  next       npm run video:probe   (re-checks the submission text against the recording)");
console.log("             npm run form:text     (paste-ready Project Description picks the link up)");
console.log("             npm run xpost         (X post copy, length-checked)");
console.log("             npm run publish:github");
