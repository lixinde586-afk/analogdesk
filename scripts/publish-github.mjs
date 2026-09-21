/**
 * Publish the local HEAD commit to the GitHub remote through api.github.com.
 *
 * Why this exists. On the network this project was built on, `github.com:443` is unreachable
 * (TCP connect timeout, measured repeatedly) while `api.github.com` answers 200 - the same
 * selective blocking that resets every `*.bitget.com` connection. `git push` therefore cannot work
 * here, but the Git Data API can: git object IDs are content-addressed, so uploading the blobs,
 * trees and commit that HEAD points at reproduces exactly the same object graph on the server.
 *
 * Safety. Every SHA the API returns is compared against git's own (`git ls-tree`, `git cat-file`).
 * Any mismatch aborts with a non-zero exit code, so the remote can never silently differ from the
 * local commit. Only objects the remote does not already have are uploaded.
 *
 * Usage
 *   node scripts/publish-github.mjs [--branch main] [--message "..."] [--dry-run]
 *                                   [--no-pages] [--pages-branch gh-pages]
 * Publishes HEAD to --branch, then repoints the Pages branch at HEAD's dist/ subtree so the live
 * demo and the repository can never drift apart.
 * Auth
 *   GH_TOKEN environment variable, or `gh auth token` when the GitHub CLI is installed.
 *   The token is never printed or written to disk.
 */
import { execFileSync } from "node:child_process";

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : null; };
const has = (name) => argv.includes(`--${name}`);
const BRANCH = flag("branch") || "main";
const MESSAGE = flag("message");
const DRY = has("dry-run");
const API = "https://api.github.com";
const UA = "analogdesk-publish";

const git = (args, opts = {}) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 1 << 28, ...opts }).trim();
const gitRaw = (args, input) => execFileSync("git", args, { input, maxBuffer: 1 << 30 });
const log = (...a) => console.log(...a);

function remoteSlug() {
  const url = git(["remote", "get-url", "origin"]);
  const m = url.match(/github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?$/);
  if (!m) throw new Error(`cannot parse an owner/repo pair from origin: ${url}`);
  return `${m[1]}/${m[2]}`;
}

function token() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  for (const exe of ["gh"]) {
    try { const t = execFileSync(exe, ["auth", "token"], { encoding: "utf8" }).trim(); if (t) return t; } catch { /* not installed / not logged in */ }
  }
  throw new Error("no GitHub token: set GH_TOKEN, or install and authenticate the GitHub CLI (`gh auth login`)");
}

async function api(method, path, body, auth, attempt = 1) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${auth}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": UA },
    body: body == null ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  if (!res.ok) {
    if ((res.status === 403 || res.status === 429 || res.status >= 500) && attempt <= 4) {
      log(`  retry ${attempt} after HTTP ${res.status} on ${method} ${path}`);
      await new Promise((r) => setTimeout(r, 3000 * attempt));
      return api(method, path, body, auth, attempt + 1);
    }
    throw new Error(`${method} ${path} -> HTTP ${res.status} ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : null;
}

const REPO = remoteSlug();
const AUTH = token();
const head = git(["rev-parse", "HEAD"]);
const rootTree = git(["rev-parse", "HEAD^{tree}"]);
const message = MESSAGE ?? execFileSync("git", ["log", "-1", "--format=%B"], { encoding: "utf8", maxBuffer: 1 << 26 }).replace(/\n+$/, "");
const [an, ae, ad, cn, ce, cd] = git(["log", "-1", "--format=%an%x09%ae%x09%aI%x09%cn%x09%ce%x09%cI"]).split("\t");

log(`repo      ${REPO}`);
log(`local     ${head} (branch ${BRANCH})`);
log(`tree      ${rootTree}`);
log(`author    ${an} <${ae}> ${ad}`);
log(`message   ${JSON.stringify(message.split("\n")[0])}`);
if (DRY) log("dry run: nothing will be written");

/* ------------------------------- remote state ------------------------------- */
let remoteHead = null, known = new Set(), remoteTree = null;
try {
  const ref = await api("GET", `/repos/${REPO}/commits/${BRANCH}`, null, AUTH);
  remoteHead = ref.sha;
  remoteTree = ref.commit.tree.sha;
  const t = await api("GET", `/repos/${REPO}/git/trees/${remoteHead}?recursive=1`, null, AUTH);
  for (const e of t.tree) known.add(e.sha);
  known.add(remoteTree);
  log(`remote    ${remoteHead} (tree ${remoteTree}, ${t.tree.length} entries known)`);
} catch (e) {
  if (!/404/.test(e.message)) throw e;
  log(`remote    branch ${BRANCH} does not exist yet - it will be created`);
}

if (remoteTree === rootTree && remoteHead) {
  log("\nmain      nothing to publish: the remote tree already matches local HEAD byte for byte.");
  await publishPages();
  process.exit(0);
}

/* ------------------------------ local object list ----------------------------- */
const entries = git(["ls-tree", "-r", "-t", head]).split("\n").filter(Boolean).map((line) => {
  const tab = line.indexOf("\t");
  const [mode, type, sha] = line.slice(0, tab).split(" ");
  return { mode, type, sha, path: line.slice(tab + 1) };
});
const blobs = [...new Map(entries.filter((e) => e.type === "blob").map((b) => [b.sha, b])).values()];
const trees = entries.filter((e) => e.type === "tree");
const todo = blobs.filter((b) => !known.has(b.sha));
log(`objects   ${blobs.length} blobs (${todo.length} to upload), ${trees.length} subtrees`);
if (DRY) { log("dry run: exiting before any write"); process.exit(0); }

/* --------------------------------- 1. blobs ---------------------------------- */
let uploaded = 0, bytes = 0;
for (const b of todo) {
  const data = gitRaw(["cat-file", "blob", b.sha]);
  const r = await api("POST", `/repos/${REPO}/git/blobs`, { content: data.toString("base64"), encoding: "base64" }, AUTH);
  if (r.sha !== b.sha) throw new Error(`blob SHA mismatch for ${b.path}: api ${r.sha} != git ${b.sha}`);
  uploaded++; bytes += data.length;
  log(`  blob ${uploaded}/${todo.length} ${b.path} (${(data.length / 1024).toFixed(0)} KB) verified`);
}
log(`blobs     ${uploaded} uploaded (${(bytes / 1048576).toFixed(2)} MB), all SHAs verified`);

/* ---------------------------- 2. trees, deepest first --------------------------- */
const treeSha = new Map();
let made = 0;
for (const t of [...trees].sort((a, b) => b.path.split("/").length - a.path.split("/").length)) {
  if (known.has(t.sha)) { treeSha.set(t.path, t.sha); continue; }
  const items = entries
    .filter((e) => e.path.startsWith(`${t.path}/`) && !e.path.slice(t.path.length + 1).includes("/"))
    .map((e) => ({ path: e.path.slice(t.path.length + 1), mode: e.mode, type: e.type, sha: e.type === "tree" ? treeSha.get(e.path) : e.sha }));
  const r = await api("POST", `/repos/${REPO}/git/trees`, { tree: items }, AUTH);
  if (r.sha !== t.sha) throw new Error(`tree SHA mismatch for ${t.path}/: api ${r.sha} != git ${t.sha}`);
  treeSha.set(t.path, r.sha); made++;
}
const rootItems = entries.filter((e) => !e.path.includes("/"))
  .map((e) => ({ path: e.path, mode: e.mode, type: e.type, sha: e.type === "tree" ? treeSha.get(e.path) : e.sha }));
let root;
if (known.has(rootTree)) { root = { sha: rootTree }; } else {
  root = await api("POST", `/repos/${REPO}/git/trees`, { tree: rootItems }, AUTH);
  if (root.sha !== rootTree) throw new Error(`root tree SHA mismatch: api ${root.sha} != git ${rootTree}`);
  made++;
}
log(`trees     ${made} created, root ${root.sha} verified identical to git`);

/* --------------------------------- 3. commit ---------------------------------- */
const parents = remoteHead ? [remoteHead] : [];
const commit = await api("POST", `/repos/${REPO}/git/commits`, {
  message, tree: root.sha, parents,
  author: { name: an, email: ae, date: ad }, committer: { name: cn, email: ce, date: cd }
}, AUTH);
log(`commit    ${commit.sha} (parent ${parents[0] ?? "none"})`);

/* ---------------------------------- 4. ref ----------------------------------- */
const ref = remoteHead
  ? await api("PATCH", `/repos/${REPO}/git/refs/heads/${BRANCH}`, { sha: commit.sha, force: false }, AUTH)
  : await api("POST", `/repos/${REPO}/git/refs`, { ref: `refs/heads/${BRANCH}`, sha: commit.sha }, AUTH);
log(`ref       refs/heads/${BRANCH} -> ${ref.object.sha}`);

/* -------------------------------- 5. verify ---------------------------------- */
const pushed = await api("GET", `/repos/${REPO}/git/commits/${ref.object.sha}`, null, AUTH);
const check = await api("GET", `/repos/${REPO}/git/trees/${pushed.tree.sha}?recursive=1`, null, AUTH);
const remoteBlobs = check.tree.filter((e) => e.type === "blob");
const localBlobs = entries.filter((e) => e.type === "blob");
const mismatch = localBlobs.filter((e) => { const r = remoteBlobs.find((x) => x.path === e.path); return !r || r.sha !== e.sha; });
log(`verify    ${remoteBlobs.length} remote blobs vs ${localBlobs.length} local, ${mismatch.length} mismatched`);
if (mismatch.length) { for (const m of mismatch.slice(0, 10)) log(`  MISMATCH ${m.path}`); process.exit(1); }
const info = await api("GET", `/repos/${REPO}`, null, AUTH);
log(`\npublished ${info.html_url} (public: ${!info.private})`);
log(`tree      remote ${pushed.tree.sha} vs local ${rootTree} -> ${pushed.tree.sha === rootTree ? "IDENTICAL" : "DIFFERS"}`);
if (pushed.tree.sha !== rootTree) process.exit(1);

/* --------------------------- 6. GitHub Pages branch --------------------------- */
/**
 * Pages can only serve from "/" or "/docs" of a branch, and the demo lives in dist/, so the demo is
 * published to an orphan `gh-pages` branch whose ROOT tree is the dist subtree of the commit just
 * pushed. Every blob in it, and that tree, were uploaded and verified in steps 1-2, so this is at
 * most one commit and one ref. The entry-by-entry comparison against `git ls-tree HEAD:dist` is what
 * proves Pages serves exactly the artefact that `npm run check:browser` passed on.
 *
 * Declared as a hoisted function so the "main is already up to date" exit above can still reconcile
 * the demo: without that, a no-op publish would leave gh-pages pointing at an older build.
 */
async function publishPages() {
  if (has("no-pages")) { log("\npages     skipped (--no-pages)"); return; }
  const PAGES = flag("pages-branch") || "gh-pages";
  const distTree = git(["rev-parse", head + ":dist"]);
  log("\npages     local dist tree " + distTree + " -> refs/heads/" + PAGES);

  let pagesHead = null, pagesTree = null;
  try {
    const c = await api("GET", "/repos/" + REPO + "/commits/" + PAGES, null, AUTH);
    pagesHead = c.sha;
    pagesTree = c.commit.tree.sha;
  } catch (e) {
    if (!/404/.test(e.message)) throw e;
    log("pages     branch " + PAGES + " does not exist yet - it will be created");
  }

  const localEntries = git(["ls-tree", "-r", head + ":dist"]).split("\n").filter(Boolean).map((line) => {
    const tab = line.indexOf("\t");
    const parts = line.slice(0, tab).split(" ");
    return { mode: parts[0], type: parts[1], sha: parts[2], path: line.slice(tab + 1) };
  });

  /** Compare the branch's current tree against git's own view of HEAD:dist, entry by entry. */
  async function verifyPages(commitSha, treeSha) {
    const got = (await api("GET", "/repos/" + REPO + "/git/trees/" + treeSha + "?recursive=1", null, AUTH)).tree;
    const bad = localEntries.filter((e) => {
      const r = got.find((x) => x.path === e.path);
      return !r || r.sha !== e.sha || r.type !== e.type;
    });
    log("pages     verify " + got.length + " remote entries vs " + localEntries.length + " local dist entries, " + bad.length + " mismatched");
    for (const b of bad.slice(0, 10)) log("  MISMATCH " + b.path);
    if (bad.length || got.length !== localEntries.length) return false;
    log("pages     tree remote " + treeSha + " vs local dist " + distTree + " -> " + (treeSha === distTree ? "IDENTICAL" : "DIFFERS"));
    log("pages     commit " + commitSha);
    return treeSha === distTree;
  }

  if (pagesHead && pagesTree === distTree) {
    log("pages     already serves this exact dist tree - no new commit needed");
    if (!DRY && !(await verifyPages(pagesHead, pagesTree))) process.exit(1);
  } else {
    if (DRY) { log("pages     dry run: would deploy " + distTree); }
    else {
      const pagesMessage = "Deploy the demo from " + head.slice(0, 7) + "\n\n"
        + "The root tree of this commit is the dist/ subtree of that commit, so GitHub Pages serves exactly\n"
        + "the artefact that npm run check:html, check:bundle and check:browser passed on.";
      const commit = await api("POST", "/repos/" + REPO + "/git/commits", {
        message: pagesMessage, tree: distTree, parents: pagesHead ? [pagesHead] : [],
        author: { name: an, email: ae, date: ad }, committer: { name: cn, email: ce, date: cd }
      }, AUTH);
      const ref = pagesHead
        ? await api("PATCH", "/repos/" + REPO + "/git/refs/heads/" + PAGES, { sha: commit.sha, force: false }, AUTH)
        : await api("POST", "/repos/" + REPO + "/git/refs", { ref: "refs/heads/" + PAGES, sha: commit.sha }, AUTH);
      log("pages     commit " + commit.sha + " (parent " + (pagesHead ?? "none") + "); ref -> " + ref.object.sha);
      if (!(await verifyPages(commit.sha, commit.tree.sha))) process.exit(1);
    }
  }

  const pages = await api("GET", "/repos/" + REPO + "/pages", null, AUTH).catch(() => null);
  if (pages) {
    log("pages     " + pages.html_url + " source=" + (pages.source && pages.source.branch) + "/" + (pages.source && pages.source.path) + " status=" + pages.status);
  } else log("pages     no Pages configuration found on this repo");
}

await publishPages();
