/**
 * AnalogDesk - decision stress testing.
 * Isomorphic (Node + browser), zero dependencies.
 *
 * Three complementary lenses, all of them reuse the same retrieval engine so a stress result and a
 * baseline result are always numerically comparable:
 *
 *  1. HISTORICAL REPLAY (`kind: "window"`). Pin the analog library to a named crisis window and ask
 *     what happened next to names that looked like this one. This is the "preset stress test" the
 *     sub-theme asks for, and it is honest about what it is: a conditional historical sample, not a
 *     model of the crisis.
 *  2. SHOCK OVERLAY (`kind: "shock"`). Move the query state in z-space (VIX up 2 sigma, 90-day
 *     policy-rate path up 1.5 sigma, ...) and re-retrieve across the whole library. This answers
 *     "what does a regime like that one tend to do next?" without pretending to simulate paths.
 *  3. EXCURSION / TAIL PROFILE. For whatever analog set came back, summarise the intra-horizon path:
 *     max adverse excursion, max favourable excursion, breach probabilities and a path fan. A trade
 *     can have a benign H-day return and still have been un-holdable on the way.
 *
 * Every scenario ships with `why` (the mechanism being stressed) and `caveat` (what it cannot tell
 * you). Both are surfaced in the UI and in the LLM payload so the narrative never oversells them.
 */

import { summarize, histogram, quantile, pct } from "./distribution.mjs";

export const SCENARIOS = [
  {
    id: "covid-crash", label: "2020-02/03 liquidity crash", kind: "window",
    from: "2020-02-19", to: "2020-03-23", tags: ["equity", "liquidity", "vol"],
    why: "A five-week, cross-asset forced-deleveraging: correlation to 1, bid-ask blowout, cash raising that hits even safe assets. Stress what a position does when diversification stops working.",
    caveat: "Central-bank backstops arrived inside the window, so the realised rebound is baked into the forward returns. It is a sample of one regime, not a forecast of the next one."
  },
  {
    id: "fed-tightening-2018", label: "2018-Q4 tightening scare", kind: "window",
    from: "2018-10-01", to: "2018-12-24", tags: ["rates", "equity"],
    why: "Policy normalisation plus a growth scare: multiples compress without an earnings collapse. Isolates rate-driven de-rating from recession-driven drawdown.",
    caveat: "Ended with a policy pivot in January 2019, which flatters the forward returns of late-window analogs."
  },
  {
    id: "rate-shock-2022", label: "2022 inflation / rate bear", kind: "window",
    from: "2022-01-03", to: "2022-10-12", tags: ["rates", "inflation", "equity"],
    why: "Sustained positive inflation surprises and a steep policy-rate path: stocks and bonds fall together, so the usual 60/40 hedge fails. Stresses duration-sensitive and multiple-rich names hardest.",
    caveat: "A nine-month window means the per-date cap of 2 analogs samples it repeatedly; treat it as a regime description, not 50 independent events."
  },
  {
    id: "regional-banks-2023", label: "2023-03 regional bank stress", kind: "window",
    from: "2023-03-08", to: "2023-03-31", tags: ["credit", "financials", "contagion"],
    why: "Idiosyncratic balance-sheet risk turning systemic in days, with sharp sector rotation rather than a broad de-rating. Tests whether a name is exposed to the specific channel that is breaking.",
    caveat: "Very short window; the analog set will be dominated by a handful of sessions."
  },
  {
    id: "carry-unwind-2024", label: "2024-08-05 carry unwind", kind: "window",
    from: "2024-07-11", to: "2024-08-05", tags: ["vol", "crowding", "fx"],
    why: "A funding-currency shock that unwound crowded positioning in three sessions. The cleanest available example of gap risk arriving from outside the equity complex.",
    caveat: "Reversal was almost as fast as the drawdown, so H-day forward returns look benign even though the intra-horizon excursion did not."
  },
  {
    id: "tariff-shock-2025", label: "2025-04 tariff shock", kind: "window",
    from: "2025-03-24", to: "2025-04-09", tags: ["policy", "trade", "china"],
    why: "An unpriced, discrete policy shock concentrated on trade-exposed and China-linked cash flows. Directly relevant to the China ADR sleeve of the universe.",
    caveat: "Policy reversals inside the window make the tail of the distribution asymmetric in a way that is specific to that episode."
  },
  {
    id: "vol-spike", label: "Volatility spike (+2 sigma VIX)", kind: "shock",
    shock: { z: { vix: 2, vixChg5: 1.5, mktVol20: 1 } }, tags: ["vol"],
    why: "The single most reliable regime marker in the library. Conditioning on it asks what a position did next the last few dozen times the vol complex re-priced this hard.",
    caveat: "VIX shocks mean-revert quickly, so this stresses entry timing more than terminal value."
  },
  {
    id: "rates-up", label: "Policy-rate path re-pricing (+1.5 sigma)", kind: "shock",
    shock: { z: { dRate90: 1.5, slope: -1, beiChg20: 0.5 } }, tags: ["rates", "inflation"],
    why: "Combines a higher 90-day policy-rate path with a flattening curve and firmer inflation compensation: the mix that historically compressed equity multiples without a credit event.",
    caveat: "Uses DGS3MO/T10Y2Y levels as proxies; the transmission to a single name depends on its duration and balance sheet, which are not features here."
  },
  {
    id: "liquidity-air-pocket", label: "Liquidity air pocket", kind: "shock",
    shock: { z: { vix: 1.5, mktVol20: 1.5, mktRet20: -1.5, gap20: 1 } }, tags: ["liquidity", "vol", "7x24"],
    why: "Wide realised gaps plus a falling, more volatile tape: the state in which a tokenized-stock wrapper is hardest to exit, because the underlying reference market is closed while the wrapper still trades.",
    caveat: "gap20 is measured on the underlying exchange session, not on a 7x24 venue. It bounds the reference-market gap risk only."
  },
  {
    id: "earnings-day", label: "Earnings release day", kind: "shock",
    shock: { raw: { dte: 0 }, z: { eventLoad5: 1 } }, tags: ["event", "7x24"],
    why: "Forces the analog set onto known-event sessions. Earnings are released outside the cash session for many names, so this is where a 7x24 wrapper changes the risk profile most.",
    caveat: "Earnings dates for foreign private issuers come from 6-K full-text search and are noisier than the 8-K Item 2.02 dates; see DATA-PROVENANCE."
  },
  {
    id: "fomc-day", label: "FOMC decision day", kind: "shock",
    shock: { raw: { isFomcDay: 1 }, z: { eventLoad5: 1 } }, tags: ["event", "macro"],
    why: "Conditions on scheduled macro risk. Useful for sizing into a known catalyst rather than for tail estimation.",
    caveat: "Only 92 decision days exist in the calendar, so the analog set is small and highly overlapping."
  },
  {
    id: "crypto-contagion", label: "Crypto drawdown contagion", kind: "shock",
    shock: { z: { btcRet5: -2, btcRet20: -1.5 } }, tags: ["crypto", "cross-asset", "7x24"],
    why: "Bitget's user base trades crypto 7x24 and reaches tokenized equities in the same session. This asks whether a crypto-led risk-off has historically coincided with worse equity outcomes for the same name.",
    caveat: "The BTC feature is a market-wide regime proxy. Any name-level linkage to crypto flows is not identified here, and fng is excluded from the distance metric."
  },
  {
    id: "china-adr-shock", label: "China ADR de-rating", kind: "shock",
    shock: { z: { relBench20: -1.5, usdChg20: 1, mktRet20: -0.5 } }, tags: ["china", "fx", "policy"],
    why: "Sustained underperformance versus SPY with a firmer dollar: the historical signature of a China-equity policy or capital-flow shock, which is the dominant risk for the ADR sleeve.",
    caveat: "Delisting and audit-access risks are structural and will not appear in a price/vol feature space at all."
  }
];

export const byId = (id) => SCENARIOS.find((s) => s.id === id);

/** Data-grounded alternative to hand-picked windows: the worst realised market-level windows. */
export function worstMarketWindows(mx, { H = 20, top = 8, gap = 21 } = {}) {
  const { priceA, nDates, dates, benchIdx } = mx;
  const base = benchIdx * nDates;
  const rows = [];
  for (let j = 0; j + H < nDates; j++) {
    const a = priceA[base + j], b = priceA[base + j + H];
    if (Number.isFinite(a) && a > 0 && Number.isFinite(b)) rows.push({ j, r: b / a - 1 });
  }
  rows.sort((x, y) => x.r - y.r);
  const out = [];
  for (const r of rows) {
    if (out.length >= top) break;
    if (out.some((o) => Math.abs(o.j - r.j) < gap)) continue;
    out.push({ from: dates[r.j], to: dates[Math.min(nDates - 1, r.j + H)], j: r.j, horizon: H, benchReturn: r.r });
  }
  return out.sort((a, b) => (a.from < b.from ? -1 : 1));
}

/** Intra-horizon path fan: percentiles of the analog path at each step 1..H. */
export function pathFan(engine, analogs, H, levels = [0.1, 0.25, 0.5, 0.75, 0.9]) {
  const { mx } = engine;
  const nDates = mx.nDates;
  const symIdx = Object.fromEntries(mx.syms.map((s, i) => [s, i]));
  const perT = Array.from({ length: H }, () => []);
  for (const a of analogs) {
    const si = symIdx[a.sym]; if (si == null) continue;
    const base = si * nDates;
    const p0 = mx.priceA[base + a.idx];
    if (!(p0 > 0)) continue;
    for (let t = 1; t <= H; t++) {
      const p = mx.priceA[base + a.idx + t];
      perT[t - 1].push(Number.isFinite(p) && p > 0 ? p / p0 - 1 : NaN);
    }
  }
  return perT.map((arr, i) => {
    const v = arr.filter(Number.isFinite).sort((x, y) => x - y);
    if (!v.length) return { t: i + 1, n: 0 };
    const o = { t: i + 1, n: v.length };
    for (const lv of levels) o[`p${Math.round(lv * 100)}`] = quantile(v, lv);
    return o;
  });
}

export function tailProfile(analogs, H) {
  const rets = analogs.map((a) => a.fwd?.[H]).filter((x) => x != null && Number.isFinite(x));
  const mae = analogs.map((a) => a.mae).filter((x) => x != null && Number.isFinite(x));
  const mfe = analogs.map((a) => a.mfe).filter((x) => x != null && Number.isFinite(x));
  const s = summarize(rets, { mae, mfe });
  if (!s.n) return null;
  const breaches = [0.05, 0.10, 0.15, 0.20, 0.25, 0.30].map((t) => ({
    drawdown: t, breached: mae.filter((x) => x < -t).length, n: mae.length || 1,
    p: mae.length ? mae.filter((x) => x < -t).length / mae.length : null
  }));
  const holdable = mae.length ? mae.filter((x) => x > -0.10).length / mae.length : null;
  return {
    horizon: H, n: s.n, summary: s, breaches, holdableWithin10pct: holdable,
    hist: histogram(rets, 24),
    maePct: { median: pct(s.mae?.median), p10: pct(s.mae?.p10), p25: pct(s.mae?.p25) },
    mfePct: { median: pct(s.mfe?.median), p75: pct(s.mfe?.p75), p90: pct(s.mfe?.p90) },
    rewardRisk: s.mfe?.median != null && s.mae?.median ? Math.abs(s.mfe.median / s.mae.median) : null
  };
}

/**
 * Run one scenario against one idea.
 * @returns {{scenario:object, result:object|null, skipped:string|null, tail:object|null, fan:Array|null}}
 */
export function runScenario(engine, { sym, date = "latest", horizon, k, scenario }) {
  const sc = typeof scenario === "string" ? byId(scenario) : scenario;
  if (!sc) throw new Error(`unknown scenario: ${scenario}`);
  const H = horizon ?? engine.C.horizon;
  const opts = { sym, date, horizon: H, k };
  if (sc.kind === "window") {
    const { q } = engine.resolveIndex(sym, date);
    if (q < 0) return { scenario: sc, result: null, skipped: "query date not on the trading calendar", tail: null, fan: null };
    if (engine.mx.dates.findIndex((d) => d >= sc.to) > q - H) {
      return { scenario: sc, result: null, skipped: `window ends after the ${H}-session embargo before ${engine.mx.dates[q]}`, tail: null, fan: null };
    }
    opts.restrict = { from: sc.from, to: sc.to };
  } else if (sc.kind === "shock") {
    opts.shock = sc.shock;
  } else {
    throw new Error(`scenario kind not supported: ${sc.kind}`);
  }
  let result;
  try { result = engine.query(opts); }
  catch (e) { return { scenario: sc, result: null, skipped: e.message, tail: null, fan: null }; }
  return { scenario: sc, result, skipped: null, tail: tailProfile(result.analogs, H), fan: pathFan(engine, result.analogs, H) };
}

/** Baseline (no scenario) plus every scenario, in one payload the UI and the LLM can share. */
export function stressReport(engine, { sym, date = "latest", horizon, k, scenarios = SCENARIOS }) {
  const H = horizon ?? engine.C.horizon;
  const baseline = engine.query({ sym, date, horizon: H, k });
  const baseDist = summarize(baseline.analogs.map((a) => a.fwd?.[H]).filter((x) => x != null), {});
  const baseMedianPct = pct(baseDist.median);
  const runs = [];
  for (const sc of scenarios) {
    const r = runScenario(engine, { sym, date, horizon: H, k, scenario: sc });
    const dist = r.result ? summarize(r.result.analogs.map((a) => a.fwd?.[H]).filter((x) => x != null), {}) : null;
    runs.push({
      id: sc.id, label: sc.label, kind: sc.kind, tags: sc.tags || [], why: sc.why, caveat: sc.caveat,
      skipped: r.skipped, n: dist?.n || 0,
      medianPct: dist ? pct(dist.median) : null, p10Pct: dist ? pct(dist.p10) : null, p90Pct: dist ? pct(dist.p90) : null,
      probLoss10: dist?.prob?.["-0.1"] ?? null,
      maeMedianPct: r.tail ? pct(r.tail.summary.mae?.median) : null,
      breach10Pct: r.tail ? (r.tail.breaches.find((b) => b.drawdown === 0.10)?.p ?? null) : null,
      holdableWithin10pct: r.tail?.holdableWithin10pct ?? null,
      deltaMedianPct: dist ? pct(dist.median) - baseMedianPct : null,
      fan: r.fan, tail: r.tail, result: r.result
    });
  }
  return {
    query: baseline.query, config: baseline.config, library: baseline.library, timing: baseline.timing,
    baseline: { distribution: baseDist, analogs: baseline.analogs, tail: tailProfile(baseline.analogs, H), fan: pathFan(engine, baseline.analogs, H), scan: baseline.scan },
    scenarios: runs
  };
}