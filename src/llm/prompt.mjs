/**
 * AnalogDesk - prompt construction.
 *
 * The model is given the research card and nothing else, and is asked for a fixed set of delimited
 * sections so the UI can render them structurally. Two rules are enforced in the prompt AND
 * re-checked after generation by verify-numbers.mjs, because prompt-level instructions alone are
 * not a control:
 *   - every numeral must be copied from the card;
 *   - the output must state what the analysis cannot tell the trader.
 */

export const SECTIONS = [
  { key: "verdict", heading: "Verdict", ask: "Two or three sentences: what the historical analog set says about this idea over the stated horizon, and the single number a trader should anchor on. Do not hedge into meaninglessness and do not give a buy/sell instruction." },
  { key: "state", heading: "Why these analogs", ask: "Which features make the current state distinctive, and why that pulls these particular historical episodes into the neighborhood. Name the features using the labels in the card." },
  { key: "history", heading: "What happened next", ask: "Describe the forward-return distribution of the retrieved analogs: median, spread, the shape of the tails, and which specific episodes dominate the bad tail. Cite analog sessions and symbols from the card." },
  { key: "tails", heading: "Path risk, not just endpoint", ask: "Use the excursion block. A trade can end near flat and still have been un-holdable. Report the median max adverse excursion and the probability of breaching the drawdown levels given in the card." },
  { key: "stress", heading: "Stress scenarios", ask: "Walk the scenario block. Lead with the scenarios that materially worsen the picture versus the baseline, say by how much, and always carry the scenario's own caveat field into the prose. Skip scenarios whose skipped field is non-null but mention that they were skipped and why." },
  { key: "limits", heading: "What this does not tell you", ask: "Mandatory. State the concrete limits of this specific analysis, drawn from the card's validation and provenance blocks and from the scenario caveats. Include the honestVerdict field if present." }
];

export const SYSTEM_PROMPT = [
  "You are the narrative layer of AnalogDesk, a pre-trade historical analog retrieval and stress-testing desk.",
  "A deterministic engine has already done the analysis. Your only job is to explain it to a trader in plain, specific prose.",
  "",
  "HARD RULES",
  "1. Every numeral you write must be copied from the research card supplied in the user message. You may reformat a number (0.107 as 10.7%) but you may never estimate, extrapolate, round aggressively, or introduce a figure that is not in the card. If the card lacks a figure, describe the direction qualitatively instead.",
  "2. Never give investment advice. No buy, sell, hold, entry, exit, target price, or position size. You are describing a historical conditional distribution, not recommending a trade.",
  "3. Never present a historical analog distribution as a forecast or a probability of the future. The correct framing is: in the N retrieved episodes where the tape looked like this, the realised H-session returns did X.",
  "4. Always carry a scenario's caveat into the prose next to its result. A stress number without its caveat is misleading.",
  "5. State the limits explicitly, including when the engine's own validation shows it does not beat a naive benchmark. Do not soften that.",
  "6. Do not invent analogs, dates, symbols, sectors or events that are not in the card. Do not add real-world market commentary from your own knowledge.",
  "7. Match the language of the trader's question. If the question is in Chinese, write the whole answer in Chinese; if in English, write in English. Keep symbols, feature names and dates in their original Latin form.",
  "8. Be concrete and short. Roughly 700-1000 words total. No preamble, no sign-off, no markdown headings of your own.",
  "",
  "OUTPUT FORMAT - exactly these section markers, each on its own line, in this order:",
  SECTIONS.map((s) => `[${s.key}]`).join("\n"),
  "",
  "Write the body of each section directly under its marker. Do not use any other bracketed marker."
].join("\n");

export function buildUserMessage({ card, question, language = null, mode = "LIVE" }) {
  const asks = SECTIONS.map((s) => `- [${s.key}] ${s.heading}: ${s.ask}`).join("\n");
  return [
    `Trader's question (answer in ${language || "the same language as this question"}):`,
    `"""${String(question || "").slice(0, 1200)}"""`,
    "",
    "RESEARCH CARD (the only permitted source of numbers):",
    "```json",
    JSON.stringify(card),
    "```",
    "",
    "Section-by-section instructions:",
    asks,
    "",
    mode === "LIVE" ? "" : "Note: this run has no live model attached; produce the deterministic template rendering.",
    "Remember: no numeral that is not in the card, no advice, caveats attached to every stress number."
  ].filter(Boolean).join("\n");
}

export function buildMessages({ card, question, language = null }) {
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: buildUserMessage({ card, question, language }) }
  ];
}

/** Parse the delimited model output into renderable sections. Tolerates missing/extra markers. */
export function parseSections(text) {
  const keys = SECTIONS.map((s) => s.key);
  const out = Object.fromEntries(keys.map((k) => [k, ""]));
  const re = /^\s*\[([a-z]+)\]\s*$/gim;
  const src = String(text || "");
  const marks = [];
  let m;
  while ((m = re.exec(src)) !== null) marks.push({ key: m[1].toLowerCase(), at: m.index, end: m.index + m[0].length });
  if (!marks.length) { out.verdict = src.trim(); return { sections: out, order: keys, malformed: true }; }
  for (let i = 0; i < marks.length; i++) {
    const stop = i + 1 < marks.length ? marks[i + 1].at : src.length;
    const body = src.slice(marks[i].end, stop).trim();
    if (keys.includes(marks[i].key)) out[marks[i].key] = (out[marks[i].key] ? out[marks[i].key] + "\n\n" : "") + body;
  }
  return { sections: out, order: keys, malformed: keys.some((k) => !out[k]) };
}