/**
 * AnalogDesk - markup integrity check.
 *
 *   npm run check:html
 *
 * WHY THIS EXISTS
 * The static demo once shipped with a single mis-quoted attribute in index.html: the placeholder was
 * opened with ' and closed with ". The value therefore never terminated, and the HTML tokenizer
 * absorbed the rest of the document - the Analyze button, every <select>, the tabs, all five result
 * panels - into that one attribute. The page still looked like a page, and nothing was clickable.
 *
 * A regex such as /id="([^"]+)"/ cannot detect this: the swallowed ids are still present in the file
 * as text. Only a scan that tracks which quote opened the current attribute value can tell the
 * difference, so that is what this does. It then cross-checks the real element ids against both the
 * ids web/app.js looks up and the REQUIRED_IDS list app.js asserts at runtime, so the markup and the
 * UI can no longer drift apart without the build failing.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(p, "utf8");

/**
 * Walk the source the way a tokenizer does. Returns the real elements, their attributes, and any
 * tag whose attribute value ran to EOF without a closing quote.
 */
export function scanHtml(src) {
  const elements = [];
  const n = src.length;
  let i = 0;
  let line = 1;
  const nl = (from, to) => { for (let j = from; j < to && j < n; j++) if (src[j] === "\n") line++; };

  while (i < n) {
    if (src[i] !== "<") { if (src[i] === "\n") line++; i++; continue; }
    if (src.startsWith("<!--", i)) { const e = src.indexOf("-->", i + 4); const to = e < 0 ? n : e + 3; nl(i, to); i = to; continue; }
    if (src.startsWith("<!", i) || src.startsWith("<?", i)) { const e = src.indexOf(">", i); const to = e < 0 ? n : e + 1; nl(i, to); i = to; continue; }
    if (src[i + 1] === "/") { const e = src.indexOf(">", i); const to = e < 0 ? n : e + 1; nl(i, to); i = to; continue; }

    const m = /^<([a-zA-Z][\w:-]*)/.exec(src.slice(i, i + 64));
    if (!m) { i++; continue; }

    const startLine = line;
    let j = i + m[0].length;
    const attrs = new Map();
    let unterminated = null;

    while (j < n) {
      while (j < n && /\s/.test(src[j])) { if (src[j] === "\n") line++; j++; }
      if (j >= n) { unterminated = unterminated || "(end of file)"; break; }
      if (src[j] === ">") { j++; break; }
      if (src[j] === "/" && src[j + 1] === ">") { j += 2; break; }

      const ns = j;
      while (j < n && !/[\s=/>]/.test(src[j])) j++;
      const name = src.slice(ns, j).toLowerCase();
      if (!name) { j++; continue; }

      let k = j;
      while (k < n && /\s/.test(src[k])) k++;
      let value = null;
      if (src[k] === "=") {
        k++;
        while (k < n && /\s/.test(src[k])) k++;
        const q = src[k];
        if (q === '"' || q === "'") {
          k++;
          const vs = k;
          while (k < n && src[k] !== q) { if (src[k] === "\n") line++; k++; }
          if (k >= n) {
            unterminated = `${name}=${q} (opened on line ${startLine}, never closed)`;
            value = src.slice(vs);
            j = k;
            break;
          }
          value = src.slice(vs, k);
          nl(vs, k);
          k++;
        } else {
          const vs = k;
          while (k < n && !/[\s>]/.test(src[k])) k++;
          value = src.slice(vs, k);
        }
        j = k;
      } else {
        j = k;
      }
      attrs.set(name, value);
    }

    elements.push({ tag: m[1].toLowerCase(), attrs, line: startLine, unterminated });
    i = j;
  }
  return { elements, unterminated: elements.filter((e) => e.unterminated) };
}

/** Real ids in parse order, with their tag and line. */
export function realIds(src) {
  return scanHtml(src).elements
    .filter((e) => e.attrs.has("id"))
    .map((e) => ({ id: e.attrs.get("id"), tag: e.tag, line: e.line }));
}

/** Ids an html file mentions as text, whether or not they are real elements - for the diff. */
export function textualIds(src) {
  return new Set([...src.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
}

/* ------------------------------- checks -------------------------------- */

/** Elements app.js creates at runtime; they are legitimately absent from the markup. */
const RUNTIME_IDS = new Set(["copy-narr", "toast", "fatal"]);

function appJsIds() {
  const src = read(resolve(ROOT, "web", "app.js"));
  const looked = new Set([...src.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]));
  for (const m of src.matchAll(/getElementById\("([^"]+)"\)/g)) looked.add(m[1]);
  const rm = /const REQUIRED_IDS = \[([\s\S]*?)\];/.exec(src);
  const required = rm ? [...rm[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];
  return { looked: [...looked], required };
}

let failures = 0;
const fail = (m) => { failures++; console.error("  FAIL " + m); };
const ok = (m) => console.log("  ok   " + m);

function checkFile(relPath, { looked, required }) {
  const abs = resolve(ROOT, relPath);
  console.log(`\n${relPath}`);
  if (!existsSync(abs)) { console.log("  SKIP file not present - run `npm run compile` first"); return; }
  const src = read(abs);
  const { elements, unterminated } = scanHtml(src);
  const ids = realIds(src);
  const seen = new Set();
  const dupes = [];
  for (const { id, line } of ids) { if (seen.has(id)) dupes.push(`#${id} (line ${line})`); seen.add(id); }

  console.log(`  ${elements.length} elements, ${ids.length} real ids`);
  if (unterminated.length) {
    for (const e of unterminated) fail(`${e.tag} on line ${e.line}: unterminated attribute ${e.unterminated}`);
  } else ok("every attribute value is terminated");

  if (dupes.length) fail(`duplicate ids: ${dupes.join(", ")}`); else ok("no duplicate ids");

  const text = textualIds(src);
  const swallowed = [...text].filter((x) => !seen.has(x) && !RUNTIME_IDS.has(x));
  if (swallowed.length) {
    fail(`${swallowed.length} id(s) appear in the file as text but are NOT elements - markup was absorbed `
      + `into an attribute value: ${swallowed.map((s) => "#" + s).join(", ")}`);
  } else ok("every id in the source text is a real element");

  const missingReq = required.filter((id) => !seen.has(id));
  if (missingReq.length) fail(`REQUIRED_IDS not in markup: ${missingReq.map((s) => "#" + s).join(", ")}`);
  else ok(`all ${required.length} REQUIRED_IDS are present`);

  const missingUsed = looked.filter((id) => !seen.has(id) && !RUNTIME_IDS.has(id));
  if (missingUsed.length) fail(`app.js looks these up but the markup lacks them: ${missingUsed.map((s) => "#" + s).join(", ")}`);
  else ok(`all ${looked.filter((x) => !RUNTIME_IDS.has(x)).length} ids app.js looks up are present`);
}

export function main() {
  const { looked, required } = appJsIds();
  console.log(`web/app.js: ${looked.length} ids looked up, ${required.length} declared in REQUIRED_IDS`);
  const unlisted = looked.filter((x) => !RUNTIME_IDS.has(x) && !required.includes(x));
  if (unlisted.length) console.log(`  note: looked up but not in REQUIRED_IDS (add them so boot can assert): ${unlisted.join(", ")}`);

  checkFile("web/index.html", { looked, required });
  checkFile("dist/index.html", { looked, required });

  console.log(failures ? `\ncheck:html FAILED (${failures})` : "\ncheck:html passed");
  return failures;
}

// Importable - check-bundle.mjs uses scanHtml() - without running the checks and exiting the importer.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main() ? 1 : 0);
}