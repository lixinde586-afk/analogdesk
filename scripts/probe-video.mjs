/**
 * Read the demo video's real technical facts straight out of the MP4 box tree - no ffmpeg, no
 * dependencies, nothing hand-entered. Prints them, writes submission/VIDEO-FACTS.json, and fails
 * (exit 1) if submission/SUBMISSION.md quotes a duration, resolution, frame rate or file size that
 * the recording does not actually have.
 *
 * Usage:
 *   npm run video:probe                          newest .mp4 under %USERPROFILE%\\Videos\\Captures
 *   npm run video:probe -- "C:\\path\\take.mp4"   an explicit take
 *   set VIDEO_PATH=C:\\path\\take.mp4            same, via the environment
 *
 * The video itself is deliberately not committed: it is a large binary, GitHub's contents API caps a
 * single file at 1 MB, and the repo only keeps artefacts that are small or regenerable. Its SHA-256
 * is recorded instead, so every fact below is tied to the exact take that gets uploaded.
 *
 * Deliberately NOT part of `npm run check`: the source file lives outside the repo, so the gate must
 * not fail for anyone who clones it. Run it on the machine that recorded the video.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

const FACTS_FILE = "submission/VIDEO-FACTS.json";
const SUBMISSION = "submission/SUBMISSION.md";
const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "edts", "udta"]);
const VIDEO_CODECS = new Set(["avc1", "avc3", "hev1", "hvc1", "av01", "vp09", "mp4v"]);

function pickTake() {
  const explicit = process.argv[2] || process.env.VIDEO_PATH;
  if (explicit) return resolve(explicit);
  const dir = join(homedir(), "Videos", "Captures");
  if (!existsSync(dir)) fail("no take given and " + dir + " does not exist - pass the path as an argument");
  const takes = readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith(".mp4"))
    .map((name) => ({ name, path: join(dir, name), mtime: statSync(join(dir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (!takes.length) fail("no .mp4 found under " + dir + " - pass the path as an argument");
  return takes[0].path;
}

const problems = [];
function fail(message) {
  console.error("video:probe FAILED - " + message);
  process.exit(1);
}

/** Walk the box tree, recording each box's absolute range so tracks can be parsed independently. */
function walk(buf, offset, end, path, out) {
  let cursor = offset;
  while (cursor + 8 <= end) {
    let length = buf.readUInt32BE(cursor);
    const type = buf.toString("latin1", cursor + 4, cursor + 8);
    let header = 8;
    if (length === 1) {
      length = Number(buf.readBigUInt64BE(cursor + 8));
      header = 16;
    } else if (length === 0) {
      length = end - cursor;
    }
    if (length < header || cursor + length > end) break;
    const box = { type, path: path + "/" + type, start: cursor, header, length };
    out.push(box);
    if (CONTAINERS.has(type)) walk(buf, cursor + header, cursor + length, box.path, out);
    cursor += length;
  }
  return out;
}

const take = pickTake();
if (!existsSync(take)) fail("no such file: " + take);
const buf = readFileSync(take);
const stat = statSync(take);
const boxes = walk(buf, 0, buf.length, "", []);
const inside = (box, parent) => box.start >= parent.start && box.start + box.length <= parent.start + parent.length;
const first = (list, type, parent) => list.find((b) => b.type === type && (!parent || inside(b, parent)));

const mvhd = first(boxes, "mvhd");
if (!mvhd) fail("no mvhd box - is this an MP4?");
const movieVersion = buf.readUInt8(mvhd.start + mvhd.header);
const movieBody = mvhd.start + mvhd.header + 4;
const timescale = movieVersion === 1 ? buf.readUInt32BE(movieBody + 16) : buf.readUInt32BE(movieBody + 8);
const durationUnits = movieVersion === 1
  ? Number(buf.readBigUInt64BE(movieBody + 20))
  : buf.readUInt32BE(movieBody + 12);
if (!timescale) fail("mvhd timescale is 0");
const durationSeconds = durationUnits / timescale;

const tracks = boxes
  .filter((b) => b.path === "/moov/trak")
  .map((trak) => {
    const track = {};
    const mdhd = first(boxes, "mdhd", trak);
    if (mdhd) {
      const version = buf.readUInt8(mdhd.start + mdhd.header);
      const body = mdhd.start + mdhd.header + 4;
      track.timescale = version === 1 ? buf.readUInt32BE(body + 16) : buf.readUInt32BE(body + 8);
      const units = version === 1 ? Number(buf.readBigUInt64BE(body + 20)) : buf.readUInt32BE(body + 12);
      track.seconds = track.timescale ? units / track.timescale : null;
    }
    const hdlr = first(boxes, "hdlr", trak);
    if (hdlr) track.handler = buf.toString("latin1", hdlr.start + hdlr.header + 8, hdlr.start + hdlr.header + 12);
    const tkhd = first(boxes, "tkhd", trak);
    if (tkhd) {
      // width and height are the last 8 bytes of tkhd, 16.16 fixed point
      const tail = tkhd.start + tkhd.length - 8;
      track.displayWidth = buf.readUInt32BE(tail) / 65536;
      track.displayHeight = buf.readUInt32BE(tail + 4) / 65536;
    }
    const stsd = first(boxes, "stsd", trak);
    if (stsd) {
      const entry = stsd.start + stsd.header + 8;
      track.codec = buf.toString("latin1", entry + 4, entry + 8);
      if (VIDEO_CODECS.has(track.codec)) {
        track.codedWidth = buf.readUInt16BE(entry + 8 + 24 + 2);
        track.codedHeight = buf.readUInt16BE(entry + 8 + 24 + 4);
      }
      if (track.codec === "mp4a") {
        track.channels = buf.readUInt16BE(entry + 8 + 16);
        track.sampleRate = buf.readUInt32BE(entry + 8 + 24) / 65536;
      }
    }
    const stts = first(boxes, "stts", trak);
    if (stts && track.timescale) {
      const entries = buf.readUInt32BE(stts.start + stts.header + 4);
      let samples = 0;
      let units = 0;
      for (let i = 0; i < entries; i++) {
        const at = stts.start + stts.header + 8 + i * 8;
        samples += buf.readUInt32BE(at);
        units += buf.readUInt32BE(at) * buf.readUInt32BE(at + 4);
      }
      track.samples = samples;
      if (samples && units) track.fps = (samples * track.timescale) / units;
    }
    return track;
  });

const video = tracks.find((t) => t.handler === "vide");
const audio = tracks.find((t) => t.handler === "soun");
if (!video) fail("no video track found");

// a re-probe must not lose the published link that set-video-link.mjs recorded
const previous = existsSync(FACTS_FILE) ? JSON.parse(readFileSync(FACTS_FILE, "utf8")) : {};

const facts = {
  file: basename(take),
  publishedUrl: previous.publishedUrl ?? null,
  bytes: stat.size,
  megabytes: Number((stat.size / 1048576).toFixed(1)),
  sha256: createHash("sha256").update(buf).digest("hex"),
  recordedAt: stat.mtime.toISOString(),
  durationSeconds: Number(durationSeconds.toFixed(2)),
  durationLabel: Math.floor(durationSeconds / 60) + "m " + String(Math.round(durationSeconds % 60)).padStart(2, "0") + "s",
  width: video.displayWidth,
  height: video.displayHeight,
  aspect: Number((video.displayWidth / video.displayHeight).toFixed(3)),
  codec: video.codec,
  fps: video.fps ? Number(video.fps.toFixed(1)) : null,
  frames: video.samples ?? null,
  audio: audio
    ? { present: true, codec: audio.codec, channels: audio.channels ?? null, sampleRate: audio.sampleRate ?? null }
    : { present: false },
  trackCount: tracks.length,
};

const lines = [
  "video:probe - " + take,
  "  duration   " + facts.durationSeconds + " s (" + facts.durationLabel + ")",
  "  picture    " + facts.width + "x" + facts.height + " (" + facts.aspect + ":1) " + facts.codec + " @ " + facts.fps + " fps, " + facts.frames + " frames",
  "  audio      " + (facts.audio.present ? facts.audio.codec + ", " + facts.audio.channels + " ch, " + facts.audio.sampleRate + " Hz" : "NONE"),
  "  file       " + facts.megabytes + " MB, sha256 " + facts.sha256.slice(0, 16) + "...",
  "  recorded   " + facts.recordedAt,
  "  published  " + (facts.publishedUrl ?? "not yet - run npm run video:link -- <url> after uploading"),
];

// The submission text is written for judges, so it has to quote the take that actually exists:
// one "Measured by npm run video:probe" line in section G must carry every value read above, no line
// may still advertise a 3-minute video, and every deliverable line naming the video must state the
// measured length. All three checks have been reverse-verified against a mutated SUBMISSION.md.
const md = readFileSync(SUBMISSION, "utf8");
const mdLines = md.split(/\r?\n/);
const seconds = Math.round(facts.durationSeconds);
const audioClaim = facts.audio.present ? "audio track present" : "no audio track";
const factsLine = mdLines.find((line) => line.includes("Measured by") && line.includes("video:probe"));

if (!factsLine) {
  problems.push(SUBMISSION + " has no 'Measured by npm run video:probe' line in section G");
} else {
  for (const [what, needle] of [
    ["duration", seconds + " s"],
    ["resolution", facts.width + "x" + facts.height],
    ["frame rate", facts.fps + " fps"],
    ["codec", facts.codec],
    ["file size", facts.megabytes + " MB"],
    ["audio", audioClaim],
    ["sha256 prefix", facts.sha256.slice(0, 16)],
  ]) {
    if (!factsLine.includes(needle)) problems.push("the measured-facts line does not quote the " + what + " (" + needle + ")");
  }
}

mdLines.forEach((line, index) => {
  const at = "line " + (index + 1) + " of " + SUBMISSION;
  if (/3-minute|three-minute|3 分钟/.test(line)) {
    problems.push(at + " advertises a 3-minute video; the take measures " + facts.durationSeconds + " s");
  }
  if (/^6\./.test(line.trim()) && /video|视频/i.test(line) && !line.includes(seconds + " s") && !line.includes(seconds + " 秒")) {
    problems.push(at + " lists the demo video without the measured " + seconds + " s: " + line.trim());
  }
});

writeFileSync(FACTS_FILE, JSON.stringify(facts, null, 2) + "\n");
lines.push("  wrote      " + FACTS_FILE);
console.log(lines.join("\n"));

if (problems.length) {
  console.error("\nvideo:probe FAILED (" + problems.length + " problem" + (problems.length === 1 ? "" : "s") + "):");
  for (const problem of problems) console.error("  - " + problem);
  process.exit(1);
}
console.log("\nvideo:probe OK - the submission text quotes exactly what the file contains");
