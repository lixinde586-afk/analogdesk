/**
 * AnalogDesk - tokenised-equity wrapper connector (Gate.io spot v4, keyless).
 *
 * WHY THIS FILE EXISTS
 * The thesis is about a market that runs 7x24, but every number the desk reports came from a daily
 * primary-market library: US trading days only. research/LIMITATIONS.md §9 named that
 * gap exactly - the 7x24 wrapper's own microstructure was unmeasured, because the venue that was
 * supposed to supply it (the Bitget official MCP) resets at the TCP layer from this network and
 * contributes nothing. This connector closes the gap from a venue that IS reachable: Gate.io lists
 * tokenised US equities against USDT, keyless, with public candles, tickers and order books.
 *
 * WHAT IT IS AND IS NOT
 * It is a MEASUREMENT of the wrapper layer, not a new price source for the analog library. Nothing
 * here feeds the retrieval engine, the conformal scale or any published validation figure - those stay
 * frozen on the primary-market library so that adding a venue cannot move a number a judge has already
 * read. The wrapper layer answers a different question: given the distribution the desk computed for
 * the UNDERLYING, what does the instrument you would actually trade at 3am on a Saturday add on top -
 * spread, depth, tracking error, premium, and the risk that lives in the hours the primary market is
 * shut.
 *
 * HONESTY RULES, same as everywhere else in this project
 *  - A pair is only accepted as a wrapper for symbol S after TWO independent tests: its price must sit
 *    within a tolerance of S's RAW session close - a live wrapper quote is a traded price, so it is
 *    compared with the traded close, never with the dividend-adjusted close, which sits below it by
 *    the cumulative dividend factor - AND its daily returns must correlate with S's over the
 *    overlap. The price test alone is not enough and was caught being not enough: LINK (Chainlink)
 *    trades near LI Auto's share price, so price proximity would have "verified" a crypto token as a
 *    tokenised Chinese EV maker. The correlation test rejects it. Rejected candidates are recorded with
 *    the reason, not dropped silently.
 *  - Tracking quality is tiered and the tier is shown, so a weak tracker is never presented as if it
 *    were the underlying.
 *  - Snapshots are timestamped. Order books and tickers change every second; what ships is the state at
 *    generatedAt, and the UI says so.
 *  - If the venue is unreachable the connector degrades to a disclosure block, exactly like the Bitget
 *    adapter, and no wrapper figure is invented.
 */

import { get, UA_BROWSER } from "./sources.mjs";
import { classifyError, probeEndpoint } from "./bitget.mjs";

export const VENUE = {
  name: "Gate.io spot v4 (public, keyless)",
  base: "https://api.gateio.ws/api/v4",
  quote: "USDT",
  docs: "https://www.gate.io/docs/developers/apiv4/en/",
  role: "measurement of the tokenised-equity wrapper layer; NOT a price source for the analog library"
};

const H = { "User-Agent": UA_BROWSER, Accept: "application/json" };
const json = (t) => JSON.parse(t);

/* ------------------------------ raw endpoints ----------------------------- */

export const pairListUrl = () => `${VENUE.base}/spot/currency_pairs`;
export const tickersUrl = () => `${VENUE.base}/spot/tickers`;
export const tickerUrl = (pair) => `${VENUE.base}/spot/tickers?currency_pair=${encodeURIComponent(pair)}`;
export const bookUrl = (pair, limit = 20) => `${VENUE.base}/spot/order_book?currency_pair=${encodeURIComponent(pair)}&limit=${limit}`;
export const candlesUrl = (pair, interval, { from = null, to = null, limit = null } = {}) => {
  const q = [`currency_pair=${encodeURIComponent(pair)}`, `interval=${interval}`];
  if (from) q.push(`from=${Math.floor(from)}`);
  if (to) q.push(`to=${Math.floor(to)}`);
  if (limit) q.push(`limit=${limit}`);
  return `${VENUE.base}/spot/candlesticks?${q.join("&")}`;
};

export async function listSpotPairs() { return json(await get(pairListUrl(), { headers: H, label: "gate pair list" })); }
export async function allTickers() { return json(await get(tickersUrl(), { headers: H, timeout: 45000, label: "gate all tickers" })); }
export async function ticker(pair) { const a = json(await get(tickerUrl(pair), { headers: H, label: `gate ticker ${pair}` })); return a[0] || null; }
export async function orderBook(pair, limit = 20) { return json(await get(bookUrl(pair, limit), { headers: H, label: `gate book ${pair}` })); }
export async function candles(pair, interval, opts = {}) { return json(await get(candlesUrl(pair, interval, opts), { headers: H, label: `gate ${interval} ${pair}` })); }

/**
 * Gate.io candle row: [t, quoteVolume, close, high, low, open, baseVolume, windowClosed].
 * Returned as objects with the session date in UTC, because every downstream alignment in this project
 * is by ISO date and an array of positional strings is how off-by-one bugs get shipped.
 */
export function parseCandles(rows) {
  const out = [];
  for (const k of rows || []) {
    const ts = Number(k[0]);
    if (!Number.isFinite(ts)) continue;
    out.push({
      t: ts, d: new Date(ts * 1000).toISOString().slice(0, 10),
      iso: new Date(ts * 1000).toISOString(),
      qv: Number(k[1]), c: Number(k[2]), h: Number(k[3]), l: Number(k[4]), o: Number(k[5]), bv: Number(k[6])
    });
  }
  return out.sort((a, b) => a.t - b.t);
}

/* ------------------------------- discovery -------------------------------- */

/**
 * Candidate wrapper bases for one underlying: any spot base whose name STARTS WITH the underlying
 * ticker and is quoted in USDT. Deliberately permissive - Gate.io lists the same underlying from more
 * than one issuer under different suffixes (AAPLX / AAPLG / AAPLON), and guessing the suffix would have
 * hidden two of the three families. The price and correlation tests below are what decide.
 */
export function candidateBases(symbol, pairs, { quote = VENUE.quote, maxExtraChars = 3 } = {}) {
  const s = String(symbol).toUpperCase();
  const out = [];
  for (const p of pairs || []) {
    if (p.quote !== quote) continue;
    const b = String(p.base || "").toUpperCase();
    if (!b.startsWith(s) || b.length > s.length + maxExtraChars) continue;
    out.push({ base: b, pair: `${b}_${quote}`, suffix: b.slice(s.length) || "(none)" });
  }
  return out;
}

/**
 * Price-level test: a 1:1 notional wrapper trades near the underlying's last RAW session close.
 * The reference passed in must be the traded close (prices[sym].c), not the dividend-adjusted close
 * (prices[sym].a): mixing the bases would fail every dividend payer by the size of its cumulative
 * dividend factor.
 */
export function priceRatioTest(last, ref, tolerancePct = 7) {
  if (!Number.isFinite(last) || !Number.isFinite(ref) || last <= 0 || ref <= 0) return { ok: false, reason: "no comparable price" };
  const ratio = last / ref, devPct = (ratio - 1) * 100;
  return { ok: Math.abs(devPct) <= tolerancePct, ratio, devPct, tolerancePct,
    reason: Math.abs(devPct) <= tolerancePct ? null : `price is ${devPct.toFixed(1)}% from the underlying close, outside +/-${tolerancePct}%` };
}

/* --------------------------- statistics (pure) ---------------------------- */

export function mean(a) { const v = a.filter(Number.isFinite); return v.length ? v.reduce((x, y) => x + y, 0) / v.length : NaN; }
export function stdev(a) { const v = a.filter(Number.isFinite); const n = v.length; if (n < 2) return NaN; const m = mean(v); return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1)); }
export function quantile(a, p) { const v = a.filter(Number.isFinite).sort((x, y) => x - y); if (!v.length) return NaN; const h = (v.length - 1) * p, lo = Math.floor(h), hi = Math.ceil(h); return lo === hi ? v[lo] : v[lo] + (v[hi] - v[lo]) * (h - lo); }
export function correlation(a, b) {
  const n = Math.min(a.length, b.length); if (n < 3) return NaN;
  const ma = mean(a.slice(0, n)), mb = mean(b.slice(0, n));
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : NaN;
}

/** Percentage returns from a price series aligned to the same index. */
export function returnsFrom(prices) { const out = []; for (let i = 1; i < prices.length; i++) { const p = prices[i - 1]; out.push(p > 0 ? prices[i] / p - 1 : NaN); } return out; }

/** Tracking quality tier. The tier is always shown next to the number; a loose tracker is never dressed as the underlying. */
export function trackingTier(corr, teBp) {
  if (!Number.isFinite(corr)) return { tier: "unknown", label: "not enough overlap to measure" };
  if (corr >= 0.95 && Number.isFinite(teBp) && teBp <= 60) return { tier: "tight", label: "tight tracker" };
  if (corr >= 0.85) return { tier: "fair", label: "fair tracker" };
  if (corr >= 0.50) return { tier: "loose", label: "loose tracker - do not read as the underlying" };
  return { tier: "rejected", label: "does not track" };
}

/* --------------------------------- probe ---------------------------------- */

/** Reachability probe, symmetric with the Bitget one, so both venues are disclosed the same way. */
export async function probeVenue({ timeoutMs = 8000 } = {}) {
  const p = await probeEndpoint(`${VENUE.base}/spot/time`, VENUE.name, { timeoutMs });
  const fallback = p.ok ? p : await probeEndpoint(pairListUrl(), VENUE.name, { timeoutMs });
  return { ...fallback, venue: VENUE.name, role: VENUE.role };
}

/** Classify a failure the same way the Bitget adapter does, so a degradation reads identically. */
export { classifyError };

/**
 * The disclosure block used when the venue cannot be reached. Callers can render it unconditionally:
 * it is either null or a complete, timestamped statement of what failed and what that means for the card.
 */
export function venueDegradation(probe) {
  if (probe?.ok) return null;
  return {
    status: "degraded",
    venue: VENUE.name,
    kind: probe?.kind || "error",
    detail: probe?.detail || "the wrapper-layer connector did not return a result",
    probedAt: probe?.probedAt || new Date().toISOString(),
    disclosure: `The tokenised-equity wrapper layer could not be measured on this run (${VENUE.name}: ${probe?.kind || "unreachable"}). No wrapper figure is shown, and none is estimated: the research card describes the underlying only, which is exactly what it described before this connector existed.`
  };
}
