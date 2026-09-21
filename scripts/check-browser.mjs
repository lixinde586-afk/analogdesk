/**
 * AnalogDesk - real-browser check.
 *
 *   npm run compile && npm run check:browser
 *
 * Serves dist/ over 127.0.0.1 with node:http, loads it in headless Chrome, and asserts on the DOM
 * Chrome actually built, on everything it printed to the console, and - via an injected probe - on
 * what happens when a person types a question and presses Enter.
 *
 * WHY THIS EXISTS
 * check:bundle runs the same bundle against a DOM stub in Node and check:html verifies the markup
 * statically, but neither is a browser. The bug that made the live demo look fine and do nothing -
 * one mis-quoted attribute swallowing 25 elements - only shows up in a real HTML parser, and the
 * first person to see it was a reviewer. So the last gate before publishing is a real browser, and
 * it exercises the controls rather than only the deep link.
 *
 * Needs Chrome or Edge. Set the CHROME environment variable to an executable path to override the
 * default install locations. Chrome needs DPAPI and registry access, so this check cannot run
 * inside a locked-down sandbox.
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve, dirname, join, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");

const CANDIDATES = [
  process.env.CHROME,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
].filter(Boolean);
const CHROME = CANDIDATES.find((p) => existsSync(p));

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

/* ---------------------------- interaction probe ---------------------------- */

/**
 * Injected into a copy of dist/index.html and served at /__interaction.html. It drives the page the
 * way a reviewer would - type, press Enter, click a tab, change the symbol, click Analyze - and
 * writes a machine-readable verdict into <pre id="probe">, which --dump-dom then hands back.
 * --dump-dom cannot click anything itself, so this is what turns a screenshot test into a test.
 */
const PROBE = `
<script>
(function () {
  var out = document.createElement("pre");
  out.id = "probe";
  out.setAttribute("data-probe", "pending");
  document.body.appendChild(out);
  var steps = [];
  function finish(status, note) {
    out.setAttribute("data-probe", status);
    out.textContent = "PROBE " + status + " :: " + steps.join(" | ") + (note ? " :: " + note : "");
  }
  window.addEventListener("error", function (ev) { steps.push("window.onerror: " + (ev.message || ev.error)); });
  window.addEventListener("unhandledrejection", function (ev) { steps.push("unhandledrejection: " + (ev.reason && (ev.reason.message || ev.reason))); });
  function waitFor(fn, label, cb) {
    var n = 0;
    var t = setInterval(function () {
      n++;
      var v = null;
      try { v = fn(); } catch (e) { v = null; }
      if (v) { clearInterval(t); steps.push(label); cb(); }
      else if (n > 600) { clearInterval(t); finish("FAIL", "timed out waiting for " + label); }
    }, 100);
  }
  setTimeout(function () {
    try {
      var q = document.getElementById("q");
      var go = document.getElementById("go");
      if (!q || !go) { finish("FAIL", "#q or #go missing from the parsed DOM"); return; }
      q.value = "BABA 未来 20 个交易日，历史上相似的状态后来怎么走？";
      q.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      steps.push("enter-dispatched");
      waitFor(function () {
        var r = document.getElementById("results");
        var n = document.getElementById("narrative");
        return r && !r.hidden && n && n.textContent.trim().length > 100;
      }, "enter-ran-analysis", function () {
        steps.push("narrative-chars=" + document.getElementById("narrative").textContent.trim().length);
        steps.push("cardbar-has-BABA=" + /BABA/.test(document.getElementById("cardbar").textContent));
        var tab = document.querySelector('.tab[data-tab="stress"]');
        if (!tab) { finish("FAIL", "stress tab button missing"); return; }
        tab.click();
        steps.push("tab-click-switched=" + document.getElementById("panel-stress").classList.contains("active"));
        // readParams() lets the question text win over the dropdown, so clear the question first:
        // this step then isolates the Analyze button and the dropdown-driven path.
        q.value = "";
        var sym = document.getElementById("symbol");
        sym.value = "SPY";
        sym.dispatchEvent(new Event("change", { bubbles: true }));
        var hz = document.getElementById("horizon");
        hz.value = "1";
        hz.dispatchEvent(new Event("change", { bubbles: true }));
        steps.push("hint-says-dropdown=" + /dropdown/.test(document.getElementById("parsed").textContent || ""));
        document.getElementById("cardbar").textContent = "";
        go.click();
        waitFor(function () { return /SPY/.test(document.getElementById("cardbar").textContent); },
          "analyze-button-click-reruns", function () {
            steps.push("stress-rows=" + document.querySelectorAll("#stresstable tbody tr").length);
            steps.push("analog-rows=" + document.querySelectorAll("#analogtable tbody tr").length);
            steps.push("hist-svg=" + !!document.querySelector("#hist svg"));
            steps.push("no-fatal-banner=" + !document.getElementById("fatal"));
            var bad = steps.filter(function (s) { return /=false$|=0$/.test(s); });
            finish(bad.length ? "FAIL" : "PASS", bad.length ? bad.join(", ") : "");
          });
      });
    } catch (e) { finish("FAIL", String((e && e.message) || e)); }
  }, 300);
})();
</script>`;

function interactionPage() {
  const html = readFileSync(join(DIST, "index.html"), "utf8");
  if (!html.includes("</body>")) throw new Error("dist/index.html has no </body> to inject the probe before");
  return html.replace("</body>", PROBE + "\n</body>");
}

/* ------------------------------- static server ---------------------------- */

function serve() {
  return new Promise((res) => {
    const srv = createServer((req, out) => {
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname === "/__interaction.html") {
        const page = Buffer.from(interactionPage(), "utf8");
        out.writeHead(200, { "Content-Type": MIME[".html"], "Content-Length": page.length });
        out.end(page);
        return;
      }
      const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, "") || "index.html";
      const p = join(DIST, rel);
      if (!p.startsWith(DIST) || !existsSync(p)) { out.writeHead(404).end("not found"); return; }
      const body = readFileSync(p);
      out.writeHead(200, {
        "Content-Type": MIME[extname(p).toLowerCase()] || "application/octet-stream",
        "Content-Length": body.length
      });
      out.end(body);
    });
    srv.listen(0, "127.0.0.1", () => res({ srv, port: srv.address().port }));
  });
}

/* --------------------------------- chrome -------------------------------- */

function chromeDumpDom(url) {
  // A fresh profile per launch: Chrome holds locks on the previous one briefly after exit, and
  // reusing it makes the next launch fail on "file in use" rather than on a real problem.
  const profile = mkdtempSync(join(ROOT, ".tmp", "chrome-"));
  return new Promise((res) => {
    const args = [
      "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
      "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--mute-audio",
      "--password-store=basic", "--use-mock-keychain",
      "--user-data-dir=" + profile,
      "--enable-logging=stderr", "--virtual-time-budget=180000", "--timeout=300000",
      "--dump-dom", url
    ];
    const child = spawn(CHROME, args, { windowsHide: true });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    const killer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } }, 420000);
    const done = (code) => {
      clearTimeout(killer);
      try { rmSync(profile, { recursive: true, force: true }); } catch { /* chrome may still hold a handle */ }
      res({ code, out, err });
    };
    child.on("close", done);
    child.on("error", (e) => { err += String(e); done(-1); });
  });
}

/* ------------------------------- assertions ------------------------------ */

let failures = 0;
const fail = (m) => { failures++; console.error("  FAIL " + m); };
const ok = (m) => console.log("  ok   " + m);
const assert = (c, good, bad) => (c ? ok(good) : fail(bad));

const between = (s, a, b) => {
  const i = s.indexOf(a);
  if (i < 0) return null;
  const j = s.indexOf(b, i + a.length);
  return j < 0 ? null : s.slice(i + a.length, j);
};
const countOf = (s, re) => (String(s).match(re) || []).length;

/** Checks that apply to every page load, whether or not an analysis was triggered. */
function checkShell(out, err, expect) {
  const consoleLines = err.split("\n").filter((l) => /CONSOLE/.test(l));
  for (const l of consoleLines) console.log("  console> " + l.replace(/^.*CONSOLE[^"]*/, "").slice(0, 300).trim());
  assert(!/Uncaught|ERROR:CONSOLE/i.test(err), "console clean - no uncaught errors",
    "console has errors:\n" + (consoleLines.join("\n") || err).slice(0, 900));

  assert(!out.includes('id="fatal"'), "no on-page fatal banner",
    "fatal banner: " + (between(out, 'id="fatal"', "</div>") || "").slice(0, 300));
  assert(!out.includes("The desk did not start"), "startup failure panel absent", "startup failure panel is showing");

  for (const b of ["badge-mode", "badge-runtime", "badge-lib", "badge-bitget"]) {
    const m = new RegExp('id="' + b + '"[^>]*>([^<]*)<').exec(out);
    const t = m ? m[1].trim() : "";
    assert(t && !/loading|probing/i.test(t), "#" + b + ": " + t, "#" + b + " stuck at " + JSON.stringify(t));
  }

  const symOpts = between(out, '<select id="symbol">', "</select>") || "";
  assert(countOf(symOpts, /<option/g) >= 50,
    "#symbol has " + countOf(symOpts, /<option/g) + " options",
    "#symbol has only " + countOf(symOpts, /<option/g) + " options");
  if (expect.symbol) {
    assert(symOpts.includes('<option value="' + expect.symbol + '"') || symOpts.includes("selected"),
      "#symbol offers " + expect.symbol, "#symbol does not offer " + expect.symbol);
  }
  assert(countOf(out, /class="tab[ "]/g) >= 5,
    "tab bar has " + countOf(out, /class="tab[ "]/g) + " tabs",
    "tab bar has only " + countOf(out, /class="tab[ "]/g) + " tabs");
  assert(countOf(out, /class="chip"/g) >= 4, countOf(out, /class="chip"/g) + " example chips", "example chips missing");
  assert(/<button id="go"/.test(out), "Analyze button is a real element", "Analyze button missing from the parsed DOM");
  const dirty = out.match(/.{0,80}>\s*(undefined|NaN)\s*<.{0,40}/);
  assert(!dirty, "no literal undefined/NaN rendered", "found: " + (dirty && dirty[0]));
}

/** Checks that only apply once an analysis has actually rendered. */
function checkResults(out) {
  assert(/<div id="results">/.test(out), "results container visible (hidden removed)",
    "results container still hidden - boot or run never completed");
  assert(/id="empty" hidden/.test(out), "empty state hidden", "empty state still showing");
  const narr = between(out, '<div id="narrative" class="narrative">', "</div>") || "";
  assert(narr.length > 200, "narrative rendered (" + narr.length + " chars)", "narrative too short (" + narr.length + " chars)");
  const stress = between(out, '<div id="stresstable">', '<div id="stressdetail">') || "";
  assert(countOf(stress, /data-id=/g) >= 8,
    "stress table has " + countOf(stress, /data-id=/g) + " scenario rows",
    "stress table has only " + countOf(stress, /data-id=/g) + " rows");
  const prov = between(out, '<div id="validation">', "</div>") || "";
  assert(prov.length > 100, "validation panel rendered (" + prov.length + " chars)", "validation panel empty");
  assert((between(out, '<div id="hist">', "</div>") || "").includes("<svg"),
    "distribution histogram is real SVG", "distribution histogram missing");
  assert((between(out, '<div id="analogtable">', "</div>") || "").length > 500,
    "analog table rendered", "analog table empty");
}

async function checkPage(name, url, expect) {
  console.log("\n=== " + name + " ===\n  " + url);
  const { code, out, err } = await chromeDumpDom(url);
  console.log("  chrome exit=" + code + ", dom " + out.length + " bytes, stderr " + err.length + " bytes");
  if (!out.length) { fail("chrome produced no DOM"); console.log(err.split("\n").slice(0, 10).join("\n")); return; }
  checkShell(out, err, expect);
  if (expect.ran) {
    checkResults(out);
    console.log("  rendered: " + out.length + " bytes of DOM, " + countOf(out, /class="stat|class="kpi/g) + " stat/kpi blocks");
  } else {
    assert(/<div id="results" hidden/.test(out), "results correctly still hidden - nothing analysed yet",
      "results container unexpectedly visible on a cold load");
    assert(!/<div class="empty" id="empty" hidden/.test(out), "empty state correctly showing on a cold load",
      "empty state hidden before any analysis");
  }
}

async function checkInteraction(url) {
  console.log("\n=== interaction probe: type, Enter, tab click, Analyze click ===\n  " + url);
  const { code, out, err } = await chromeDumpDom(url);
  console.log("  chrome exit=" + code + ", dom " + out.length + " bytes");
  if (!out.length) { fail("chrome produced no DOM"); console.log(err.split("\n").slice(0, 10).join("\n")); return; }
  checkShell(out, err, { symbol: null });
  const status = between(out, '<pre id="probe" data-probe="', '"') || "";
  const body = between(out, '<pre id="probe" data-probe="' + status + '">', "</pre>") || "";
  console.log("  probe verdict: " + (status || "(none rendered)"));
  for (const s of body.split(" | ")) console.log("    - " + s);
  assert(status === "PASS", "every simulated interaction worked in a real browser",
    "probe verdict " + JSON.stringify(status) + " - " + body.slice(0, 600));
  checkResults(out);
}

/* ---------------------------------- main ---------------------------------- */

if (!CHROME) {
  console.error("check:browser needs Chrome or Edge. Set CHROME to the executable path and re-run.");
  console.error("Searched:\n  " + CANDIDATES.join("\n  "));
  process.exit(1);
}
for (const f of ["index.html", "app.bundle.js", "styles.css"]) {
  if (!existsSync(join(DIST, f))) {
    console.error("check:browser: dist/" + f + " is missing - run: npm run compile");
    process.exit(1);
  }
}
mkdirSync(join(ROOT, ".tmp"), { recursive: true });
console.log("browser: " + CHROME);

const { srv, port } = await serve();
const base = "http://127.0.0.1:" + port;
console.log("serving dist/ at " + base);

try {
  await checkPage("auto-run deep link: NVDA, H=5",
    base + "/index.html?symbol=NVDA&horizon=5&k=50&run=1", { symbol: "NVDA", ran: true });
  await checkPage("auto-run deep link: KWEB, H=10, Chinese question",
    base + "/index.html?symbol=KWEB&horizon=10&k=50&run=1&q=" +
    encodeURIComponent("KWEB 未来 10 个交易日，历史相似状态的分布和最大回撤"), { symbol: "KWEB", ran: true });
  await checkPage("cold load, no parameters (controls populate, nothing analysed yet)",
    base + "/index.html", { symbol: "NVDA", ran: false });
  await checkInteraction(base + "/__interaction.html");
} finally {
  srv.close();
}

console.log(failures ? "\ncheck:browser FAILED (" + failures + ")" : "\ncheck:browser passed");
process.exit(failures ? 1 : 0);
