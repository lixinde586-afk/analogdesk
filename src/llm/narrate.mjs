/**
 * AnalogDesk - narrative orchestration.
 *
 * Resolution order, always reported honestly to the UI as `mode`:
 *   LIVE     a real call to the configured OpenAI-compatible endpoint (default: DashScope qwen-plus)
 *   REPLAY   a previously stored generation for this exact research card
 *   TEMPLATE the deterministic renderer in template.mjs
 *
 * Every path ends at the same gate: verify-numbers.mjs checks that each numeral in the output is
 * traceable to the research card. LIVE output gets one corrective retry before falling back. A draft
 * that still fails the gate is never shown to the user - the template is shown instead, with the
 * rejection recorded in `warnings`. That is the whole point of the design: the model writes the
 * sentences, the engine owns the numbers.
 *
 * Writing is opt-in. persist:true is passed only by scripts/warm-replay.mjs, because
 * data-cache/llm-replay is COMMITTED and baked into the static bundle: if a gate run, a demo run or
 * a live server also wrote to it, every test query would silently add a record, dist/ would stop
 * being reproducible, and the shipped cache would be test residue rather than a curated set. That
 * was observed, not theorised - one full npm run check with a key configured added seven records
 * from the gates' own test queries. Readers are unaffected: a store passed without persist is still
 * read for REPLAY.
 */

import { buildMessages, parseSections } from "./prompt.mjs";
import { chat } from "./client.mjs";
import { renderTemplate } from "./template.mjs";
import { buildAllowlist, verifyNumbers, retryInstruction, defaultAllowance } from "./verify-numbers.mjs";
import { cardDigest } from "./replay.mjs";
import { detectLang } from "./lui.mjs";

/**
 * Part of the replay-cache key, so bumping it deliberately invalidates every stored generation.
 *   1 -> 2  the card stopped carrying raw doubles and the prompt gained the precision rule.
 *   2 -> 3  the card gained the measured 7x24 wrapper block and the prompt tells the model to cite it.
 * A bump is the honest way to retire prose that was written against a different payload: leaving the
 * version alone would keep serving a cached narrative that never saw the new figures.
 */
export const PROMPT_VERSION = "5";

function allowFor(card) {
  return buildAllowlist(card, defaultAllowance(card));
}

export async function narrate({ card, question = "", language = null, llm, store = null, forceMode = null, persist = false }) {
  const allow = allowFor(card);
  const warnings = [];
  // Language is resolved BEFORE the digest because it is part of the cache key: the card is the same
  // for a Chinese and an English question, the prose is not, and one slot holding both would answer
  // an English question with Chinese text. The model is NOT part of the key - see replay.mjs.
  const lang = language || detectLang(question);
  const id = cardDigest(card, { promptVersion: PROMPT_VERSION, language: lang });
  const wantMode = forceMode || (llm?.enabled ? "LIVE" : "REPLAY");

  const finish = (text, mode, model, extra = {}) => {
    const parsed = parseSections(text);
    const check = verifyNumbers(text, allow);
    if (!check.ok) warnings.push(`numeric gate rejected ${check.unsupportedCount} of ${check.total} numerals; falling back to TEMPLATE`);
    if (!check.ok) {
      const fb = renderTemplate(card, { language: language || detectLang(question) });
      const fbCheck = verifyNumbers(fb.text, allow);
      return { ...fb, mode: "TEMPLATE", model: null, cardId: id, checks: { primary: check, fallback: fbCheck },
        warnings: [...warnings, ...(fbCheck.ok ? [] : [`TEMPLATE also failed the gate (${fbCheck.unsupportedCount} numerals) - investigate the card`])], ...extra };
    }
    return { text, sections: parsed.sections, order: parsed.order, mode, model: model || null,
      cardId: id, checks: { primary: check }, malformed: parsed.malformed, warnings, ...extra };
  };

  // 1. REPLAY (also the only option when no key is configured and a cache entry exists)
  if (wantMode !== "LIVE" && store) {
    const rec = await store.get(id).catch(() => null);
    if (rec?.text) {
      const check = verifyNumbers(rec.text, allow);
      if (check.ok) return finish(rec.text, "REPLAY", rec.model, { storedAt: rec.storedAt });
      warnings.push(`cached generation for ${id} failed the numeric gate (${check.unsupportedCount} unsupported); regenerating`);
    } else if (wantMode === "REPLAY") {
      warnings.push("no cached generation for this exact research card; using TEMPLATE");
    }
  }

  // 2. LIVE
  if (llm?.enabled && wantMode === "LIVE") {
    const messages = buildMessages({ card, question, language: lang });
    const r1 = await chat(llm, messages);
    if (r1.ok) {
      const c1 = verifyNumbers(r1.text, allow);
      if (c1.ok) {
        if (store && persist) await store.set(id, { text: r1.text, model: r1.model, storedAt: new Date().toISOString(), cardId: id, mode: "LIVE", language: lang, promptVersion: PROMPT_VERSION }).catch(() => {});
        return finish(r1.text, "LIVE", r1.model, { usage: r1.usage, latencyMs: r1.latencyMs, attempts: r1.attempts });
      }
      warnings.push(`first draft failed the numeric gate (${c1.unsupportedCount} of ${c1.total} numerals); retrying with the offending list`);
      const r2 = await chat(llm, [...messages, { role: "assistant", content: r1.text }, { role: "user", content: retryInstruction(c1) }]);
      if (r2.ok) {
        const c2 = verifyNumbers(r2.text, allow);
        if (c2.ok) {
          if (store && persist) await store.set(id, { text: r2.text, model: r2.model, storedAt: new Date().toISOString(), cardId: id, mode: "LIVE", language: lang, promptVersion: PROMPT_VERSION }).catch(() => {});
          return finish(r2.text, "LIVE", r2.model, { usage: r2.usage, latencyMs: r1.latencyMs + r2.latencyMs, attempts: r1.attempts + r2.attempts, checksExtra: { firstDraft: c1, retry: c2 } });
        }
        warnings.push(`retry still failed the numeric gate (${c2.unsupportedCount} unsupported); refusing to display model output`);
      } else {
        warnings.push(`retry call failed: ${r2.error}`);
      }
    } else {
      warnings.push(`model call failed: ${r1.error}`);
    }
  } else if (wantMode === "LIVE" && !llm?.enabled) {
    warnings.push("no LLM_API_KEY configured; running in TEMPLATE mode (all numbers still come from the engine)");
  }

  // 3. TEMPLATE
  const t = renderTemplate(card, { language: lang });
  return finish(t.text, "TEMPLATE", null, { warnings });
}

// Language detection lives in the shared parser, not here: the UI, this module, the HTTP API and the
// MCP tool server must all reach the same verdict about whether a sentence is Chinese or English.
export { detectLang };