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
  { key: "reasoning", heading: "Which scenarios matter for this idea", ask: "Rank the three scenarios most relevant to the stated idea - not merely the three worst - one sentence each, justifying each choice with figures already in the card (scenario median, delta versus baseline, analog count, breach probability). Then name exactly one concentration in the retrieved analog set that a reader should distrust (a sector, year or symbol concentration visible in the analog list or the retrieval notes), and name any scenario whose result contradicts the direction the idea assumes, or state that none does. If every scenario was skipped, say so and rank nothing. Introduce no numeral that is not on the card." },
  { key: "limits", heading: "What this does not tell you", ask: "Mandatory. State the concrete limits of this specific analysis, drawn from the card's validation and provenance blocks and from the scenario caveats. Include the honestVerdict field if present. Then handle the card's `pathRisk` block, which scores the drawdown-breach probabilities printed elsewhere in this card against what actually happened out of sample on the same frozen split: put the realised breach rate at the stated level next to the mean rate the analog excursion share predicted, give the calibration gap with its clustered standard error, and give the Brier score of the analog share against the reflection-principle volatility benchmark and against the frozen same-name and pooled calibration-era rates. Say which of those comparisons the pairedBrierVs confidence intervals actually resolve and which they do not: an interval that spans zero means unresolved and must be reported as unresolved, not as a tie broken in your favour. If pathRisk is null, say the breach probabilities were not validated on this build and invent no figure for them. Then handle the card's `wrapper` block, which measures the tokenised instrument this analysis would actually be traded through, and report its status field honestly. If status is `measured`, quote the closed-hours figures from sevenByTwentyFour (the share of the week the reference market is shut, and the share of the wrapper's own hourly movement that landed in those hours), the tracking tier with its correlation and tracking error, the premium band, and the spread - and carry the wrapper's caveat. Then report the RETURN layer from closedSessionReturns, which is the part that can actually be sized: the number of weekend closed-market blocks observed, the median and tenth-percentile weekend block return, the standard deviation, the median intra-weekend adverse excursion, and the share of weekends that breached the stated drawdown threshold. State plainly that these are wrapper returns measured while the reference market was shut and NOT the retrieved outcome distribution above, which is built on 5x24 daily sessions. If closedSessionReturns is absent or its weekendReturnDistribution is null, say that the movement share has no return distribution behind it on this build and invent no figure for it. If status is `no-verified-wrapper` or `not-measured`, say exactly that and report no wrapper figure at all: never substitute a number from a different instrument or estimate one." }
];

export const SYSTEM_PROMPT = [
  "You are the narrative layer of AnalogDesk, a pre-trade historical analog retrieval and stress-testing desk.",
  "A deterministic engine has already done the analysis. Your only job is to explain it to a trader in plain, specific prose.",
  "",
  "HARD RULES",
  "1. Every numeral you write must be copied from the research card supplied in the user message. You may reformat a number (0.107 as 10.7%) but you may never estimate, extrapolate, round aggressively, or introduce a figure that is not in the card. If the card lacks a figure, describe the direction qualitatively instead. Write every number at the precision the card shows and never longer: percentages to one or two decimals, z-scores and index levels to two or three. Trailing float digits are noise rather than precision, and reproducing them makes the card read as a machine dump instead of an analysis.",
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