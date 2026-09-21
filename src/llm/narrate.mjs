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
 */

import { buildMessages, parseSections } from "./prompt.mjs";
import { chat } from "./client.mjs";
import { renderTemplate } from "./template.mjs";
import { buildAllowlist, verifyNumbers, retryInstruction, defaultAllowance } from "./verify-numbers.mjs";
import { cardDigest } from "./replay.mjs";

export const PROMPT_VERSION = "1";

function allowFor(card) {
  return buildAllowlist(card, defaultAllowance(card));
}

export async function narrate({ card, question = "", language = null, llm, store = null, forceMode = null }) {
  const allow = allowFor(card);
  const warnings = [];
  const id = cardDigest(card, { model: llm?.model || "", promptVersion: PROMPT_VERSION });
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

  const lang = language || detectLang(question);

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
        if (store) await store.set(id, { text: r1.text, model: r1.model, storedAt: new Date().toISOString(), cardId: id, mode: "LIVE" }).catch(() => {});
        return finish(r1.text, "LIVE", r1.model, { usage: r1.usage, latencyMs: r1.latencyMs, attempts: r1.attempts });
      }
      warnings.push(`first draft failed the numeric gate (${c1.unsupportedCount} of ${c1.total} numerals); retrying with the offending list`);
      const r2 = await chat(llm, [...messages, { role: "assistant", content: r1.text }, { role: "user", content: retryInstruction(c1) }]);
      if (r2.ok) {
        const c2 = verifyNumbers(r2.text, allow);
        if (c2.ok) {
          if (store) await store.set(id, { text: r2.text, model: r2.model, storedAt: new Date().toISOString(), cardId: id, mode: "LIVE" }).catch(() => {});
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

export function detectLang(text) {
  const s = String(text || "");
  const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length;
  return cjk > 0 && cjk / Math.max(1, s.length) > 0.12 ? "zh" : "en";
}