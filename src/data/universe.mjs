// Universe for the analog library. Prices: api.stockanalysis.com (keyless, 10y daily).
// Earnings dates: SEC EDGAR full-text search on 8-K "Item 2.02" (keyless).
export const UNIVERSE = [
  // --- US mega cap / semis ---
  { s: "AAPL",  n: "Apple",            sec: "Technology",      cik: "0000320193" },
  { s: "MSFT",  n: "Microsoft",        sec: "Technology",      cik: "0000789019" },
  { s: "NVDA",  n: "NVIDIA",           sec: "Technology",      cik: "0001045810" },
  { s: "GOOGL", n: "Alphabet A",       sec: "Communication",   cik: "0001652044" },
  { s: "AMZN",  n: "Amazon",           sec: "Consumer Disc.",  cik: "0001018724" },
  { s: "META",  n: "Meta Platforms",   sec: "Communication",   cik: "0001326801" },
  { s: "TSLA",  n: "Tesla",            sec: "Consumer Disc.",  cik: "0001318605" },
  { s: "AVGO",  n: "Broadcom",         sec: "Technology",      cik: "0001730168" },
  { s: "AMD",   n: "Advanced Micro",   sec: "Technology",      cik: "0000002488" },
  { s: "CRM",   n: "Salesforce",       sec: "Technology",      cik: "0001108524" },
  { s: "ORCL",  n: "Oracle",           sec: "Technology",      cik: "0001341439" },
  { s: "ADBE",  n: "Adobe",            sec: "Technology",      cik: "0000796343" },
  { s: "INTC",  n: "Intel",            sec: "Technology",      cik: "0000050863" },
  { s: "QCOM",  n: "Qualcomm",         sec: "Technology",      cik: "0000804328" },
  { s: "TXN",   n: "Texas Instruments",sec: "Technology",      cik: "0000097476" },
  { s: "MU",    n: "Micron",           sec: "Technology",      cik: "0000723125" },
  { s: "PLTR",  n: "Palantir",         sec: "Technology",      cik: "0001321655" },
  // --- financials ---
  { s: "JPM",   n: "JPMorgan Chase",   sec: "Financials",      cik: "0000019617" },
  { s: "BAC",   n: "Bank of America",  sec: "Financials",      cik: "0000070858" },
  { s: "GS",    n: "Goldman Sachs",    sec: "Financials",      cik: "0000886982" },
  { s: "MS",    n: "Morgan Stanley",   sec: "Financials",      cik: "0000895421" },
  { s: "WFC",   n: "Wells Fargo",      sec: "Financials",      cik: "0000072971" },
  { s: "BLK",   n: "BlackRock",        sec: "Financials",      cik: "0001364742" },
  { s: "C",     n: "Citigroup",        sec: "Financials",      cik: "0000831001" },
  // --- health care ---
  { s: "UNH",   n: "UnitedHealth",     sec: "Health Care",     cik: "0000731766" },
  { s: "JNJ",   n: "Johnson & Johnson",sec: "Health Care",     cik: "0000200406" },
  { s: "LLY",   n: "Eli Lilly",        sec: "Health Care",     cik: "0000059478" },
  { s: "PFE",   n: "Pfizer",           sec: "Health Care",      cik: "0000078003" },
  { s: "MRK",   n: "Merck & Co",       sec: "Health Care",     cik: "0000310158" },
  { s: "ABBV",  n: "AbbVie",           sec: "Health Care",     cik: "0001551152" },
  { s: "TMO",   n: "Thermo Fisher",    sec: "Health Care",     cik: "0000097745" },
  // --- energy ---
  { s: "XOM",   n: "Exxon Mobil",      sec: "Energy",          cik: "0000034088" },
  { s: "CVX",   n: "Chevron",          sec: "Energy",          cik: "0000093410" },
  { s: "COP",   n: "ConocoPhillips",   sec: "Energy",          cik: "0001163165" },
  { s: "SLB",   n: "Schlumberger",     sec: "Energy",          cik: "0000087347" },
  // --- consumer ---
  { s: "WMT",   n: "Walmart",          sec: "Consumer Staples",cik: "0000104169" },
  { s: "COST",  n: "Costco",           sec: "Consumer Staples",cik: "0000909832" },
  { s: "PG",    n: "Procter & Gamble", sec: "Consumer Staples",cik: "0000080424" },
  { s: "KO",    n: "Coca-Cola",        sec: "Consumer Staples",cik: "0000021344" },
  { s: "MCD",   n: "McDonald's",       sec: "Consumer Disc.",  cik: "0000063908" },
  { s: "NKE",   n: "Nike",             sec: "Consumer Disc.",  cik: "0000320187" },
  { s: "HD",    n: "Home Depot",       sec: "Consumer Disc.",  cik: "0000354950" },
  { s: "DIS",   n: "Walt Disney",      sec: "Communication",   cik: "0001744489" },
  // --- industrial / defense ---
  { s: "CAT",   n: "Caterpillar",      sec: "Industrials",     cik: "0000018230" },
  { s: "BA",    n: "Boeing",           sec: "Industrials",     cik: "0000012927" },
  { s: "GE",    n: "GE Aerospace",     sec: "Industrials",     cik: "0000040545" },
  { s: "HON",   n: "Honeywell",        sec: "Industrials",     cik: "0000773840" },
  { s: "LMT",   n: "Lockheed Martin",  sec: "Industrials",     cik: "0000936468" },
  { s: "RTX",   n: "RTX",              sec: "Industrials",     cik: "0000101829" },
  // --- China / HK ADRs (core holdings of Bitget's Asia-hours retail users) ---
  { s: "BABA",  n: "Alibaba ADR",      sec: "China ADR",       cik: "0001577552" },
  { s: "PDD",   n: "PDD Holdings",     sec: "China ADR",       cik: "0001737806" },
  { s: "JD",    n: "JD.com ADR",       sec: "China ADR",       cik: "0001549802" },
  { s: "BIDU",  n: "Baidu ADR",        sec: "China ADR",       cik: "0001329099" },
  { s: "NIO",   n: "NIO ADR",          sec: "China ADR",       cik: "0001736541" },
  { s: "LI",    n: "Li Auto ADR",      sec: "China ADR",       cik: "0001791706" },
  // --- ETFs / cross-asset (no CIK -> no earnings calendar) ---
  { s: "SPY",   n: "S&P 500 ETF",      sec: "ETF Broad",       etf: true },
  { s: "QQQ",   n: "Nasdaq 100 ETF",   sec: "ETF Broad",       etf: true },
  { s: "IWM",   n: "Russell 2000 ETF", sec: "ETF Broad",       etf: true },
  { s: "DIA",   n: "Dow 30 ETF",       sec: "ETF Broad",       etf: true },
  { s: "XLK",   n: "Tech Select ETF",  sec: "ETF Sector",      etf: true },
  { s: "XLF",   n: "Financial Select", sec: "ETF Sector",      etf: true },
  { s: "XLE",   n: "Energy Select",    sec: "ETF Sector",      etf: true },
  { s: "XLV",   n: "Health Care Select",sec:"ETF Sector",      etf: true },
  { s: "XLI",   n: "Industrial Select",sec: "ETF Sector",      etf: true },
  { s: "GLD",   n: "Gold Trust",       sec: "ETF Commodity",   etf: true },
  { s: "TLT",   n: "20y+ Treasury ETF",sec: "ETF Rates",       etf: true },
  { s: "UUP",   n: "US Dollar Index",  sec: "ETF FX",          etf: true },
  { s: "VIXY",  n: "VIX Short Futures",sec: "ETF Vol",         etf: true },
  { s: "KWEB",  n: "China Internet ETF",sec:"ETF China",       etf: true },
  { s: "FXI",   n: "China Large-Cap",  sec: "ETF China",       etf: true },
  { s: "EEM",   n: "Emerging Markets", sec: "ETF EM",          etf: true }
];

export const BENCH = { market: "SPY", growth: "QQQ", small: "IWM", china: "KWEB" };

// Human aliases -> canonical symbol (used by the NL parser; includes Chinese retail phrasing).
export const ALIASES = (() => {
  const m = new Map();
  for (const u of UNIVERSE) {
    m.set(u.s.toUpperCase(), u.s);
    m.set(u.n.toUpperCase(), u.s);
    const lower = u.n.toLowerCase().split(/\s+/)[0];
    if (lower.length > 3) m.set(lower.toUpperCase(), u.s);
  }
  const extra = {
    "英伟达":"NVDA","苹果":"AAPL","微软":"MSFT","谷歌":"GOOGL","亚马逊":"AMZN","特斯拉":"TSLA",
    "脸书":"META","META平台":"META","博通":"AVGO","超微":"AMD","甲骨文":"ORCL","英特尔":"INTC",
    "摩根大通":"JPM","高盛":"GS","联合健康":"UNH","联合健康集团":"UNH","礼来":"LLY","辉瑞":"PFE",
    "埃克森":"XOM","雪佛龙":"CVX","沃尔玛":"WMT","好市多":"COST","可口可乐":"KO","麦当劳":"MCD",
    "耐克":"NKE","家得宝":"HD","迪士尼":"DIS","波音":"BA","通用电气":"GE","霍尼韦尔":"HON",
    "洛克希德":"LMT","阿里巴巴":"BABA","阿里":"BABA","拼多多":"PDD","京东":"JD","百度":"BIDU",
    "蔚来":"NIO","理想":"LI","纳指":"QQQ","纳斯达克":"QQQ","标普":"SPY","标普500":"SPY",
    "黄金":"GLD","美债":"TLT","中概":"KWEB","中概股":"KWEB","恒生科技":"KWEB","原油":"XLE",
    "半导体":"XLK","半导体板块":"XLK","芯片":"XLK","芯片股":"XLK","科技股":"XLK",
    "金融股":"XLF","医疗股":"XLV","能源股":"XLE",
    "苹果股票":"AAPL","美股大盘":"SPY","罗素":"IWM",
    // English spellings of the same sector, index and commodity words. The desk is demoed to a
    // bilingual audience, and a judge who types "crude oil" is entitled to the same proxy disclosure
    // as one who types 原油 rather than the generic "no instrument recognised" dead end. Multi-word
    // entries are matched on word boundaries by ALIAS_LIST_LATIN, and ALIAS_LIST is sorted longest
    // first, so "crude oil" is tried before "oil".
    "semiconductors":"XLK","semiconductor":"XLK","semiconductor stocks":"XLK","chip stocks":"XLK","chips":"XLK",
    "tech stocks":"XLK","technology sector":"XLK",
    "crude oil":"XLE","oil":"XLE","oil price":"XLE","energy stocks":"XLE",
    "china concept stocks":"KWEB","china internet":"KWEB","chinese adrs":"KWEB","hang seng tech":"KWEB",
    "us treasuries":"TLT","treasuries":"TLT","treasury bonds":"TLT","long bonds":"TLT",
    "financials":"XLF","banks":"XLF","health care":"XLV","healthcare":"XLV","pharma":"XLV",
    "gold":"GLD","gold price":"GLD","nasdaq":"QQQ","nasdaq 100":"QQQ",
    "us market":"SPY","us stock market":"SPY","the broad market":"SPY","s&p 500":"SPY","s&p":"SPY"
  };
  for (const [k, v] of Object.entries(extra)) m.set(k.toUpperCase(), v);
  return m;
})();

/**
 * Words that name a SECTOR, a BASKET or a COMMODITY rather than one instrument, and the single
 * instrument this library resolves them to.
 *
 * These used to be ordinary entries in ALIASES, which made two of them silently wrong rather than
 * merely lossy:
 *
 *   - "半导体" resolved to NVDA. A sector question answered with one stock - and with the one stock
 *     whose idiosyncratic behaviour least represents the sector's dispersion. It now resolves to XLK,
 *     the nearest sector instrument this library holds, and says that XLK is broader than chips.
 *   - "美联航" (United Airlines) resolved to UNH (UnitedHealth). That was not a proxy, it was a
 *     different company in a different industry, reached because the two English names both start
 *     with "United". The entry is gone: UAL is not in this library, so the honest answer to "美联航"
 *     is "not held here", which is what the parser now returns.
 *
 * Every remaining entry is a real proxy with a real gap, so the gap travels with it. The parser marks
 * the match "sector-proxy" and the desk prints `why` on the card, because a trader who asked about
 * crude oil and is handed energy equities should be told that XLE is not a crude-oil return before the
 * position is on, not after.
 */
const SECTOR_BASE = {
  "半导体": { symbol: "XLK", want: "the semiconductor sector", have: "XLK (Tech Select Sector SPDR)", why: "This library holds no semiconductor index (SOXX/SMH). XLK is the nearest sector instrument it holds and it is broader than semiconductors: its largest weights are platform names, not chipmakers. This card describes XLK, not the chip sector." , whyZh: "本库没有半导体指数（SOXX/SMH）。XLK 是本库持有的最接近的行业标的，但它比半导体更宽：权重最大的是平台型公司，不是芯片股。这张卡片描述的是 XLK，不是芯片行业。" },
  "半导体板块": { symbol: "XLK", want: "the semiconductor sector", have: "XLK (Tech Select Sector SPDR)", why: "This library holds no semiconductor index (SOXX/SMH). XLK is the nearest sector instrument it holds and it is broader than semiconductors. This card describes XLK, not the chip sector." , whyZh: "本库没有半导体指数（SOXX/SMH）。XLK 是本库持有的最接近的行业标的，但它比半导体更宽。这张卡片描述的是 XLK，不是芯片行业。" },
  "芯片": { symbol: "XLK", want: "the semiconductor sector", have: "XLK (Tech Select Sector SPDR)", why: "This library holds no semiconductor index (SOXX/SMH). XLK is the nearest sector instrument it holds and it is broader than semiconductors. This card describes XLK, not the chip sector." , whyZh: "本库没有半导体指数（SOXX/SMH）。XLK 是本库持有的最接近的行业标的，但它比半导体更宽：权重最大的是平台型公司，不是芯片股。这张卡片描述的是 XLK，不是芯片行业。" },
  "芯片股": { symbol: "XLK", want: "the semiconductor sector", have: "XLK (Tech Select Sector SPDR)", why: "This library holds no semiconductor index (SOXX/SMH). XLK is the nearest sector instrument it holds and it is broader than semiconductors. This card describes XLK, not the chip sector." , whyZh: "本库没有半导体指数（SOXX/SMH）。XLK 是本库持有的最接近的行业标的，但它比半导体更宽：权重最大的是平台型公司，不是芯片股。这张卡片描述的是 XLK，不是芯片行业。" },
  "科技股": { symbol: "XLK", want: "the technology sector", have: "XLK (Tech Select Sector SPDR)", why: "XLK is the GICS technology sector only. It excludes the communication-services platforms (GOOGL, META) that most retail questions about tech also mean, so it is narrower than the word. This card describes XLK." , whyZh: "XLK 只覆盖 GICS 信息技术行业，不含多数人说“科技股”时也想到的通信服务平台（GOOGL、META），所以它比这个词更窄。这张卡片描述的是 XLK。" },
  "中概": { symbol: "KWEB", want: "China concept stocks", have: "KWEB (KraneShares CSI China Internet)", why: "KWEB is China INTERNET: it holds no Chinese banks, industrials or onshore A-shares, and it is US-listed, so it carries ADR delisting and audit risk rather than the domestic one. This card describes KWEB." , whyZh: "KWEB 是中国互联网：不含中国的银行、工业或 A 股，而且在美国上市，因此承担的是 ADR 退市与审计风险，不是境内风险。这张卡片描述的是 KWEB。" },
  "中概股": { symbol: "KWEB", want: "China concept stocks", have: "KWEB (KraneShares CSI China Internet)", why: "KWEB is China INTERNET: it holds no Chinese banks, industrials or onshore A-shares, and it is US-listed, so it carries ADR delisting and audit risk rather than the domestic one. This card describes KWEB." , whyZh: "KWEB 是中国互联网：不含中国的银行、工业或 A 股，而且在美国上市，因此承担的是 ADR 退市与审计风险，不是境内风险。这张卡片描述的是 KWEB。" },
  "恒生科技": { symbol: "KWEB", want: "the Hang Seng TECH index", have: "KWEB (KraneShares CSI China Internet)", why: "This library holds no Hang Seng instrument. KWEB overlaps the index's large constituents but is a different index, is US-listed and trades on a different calendar, so its closed-hours behaviour is not the Hang Seng's. This card describes KWEB." , whyZh: "本库没有恒生指数标的。KWEB 与该指数的部分大权重成分重叠，但它是另一个指数、在美国上市、交易日历不同，所以它休市时段的表现并不等于恒生科技的表现。这张卡片描述的是 KWEB。" },
  "原油": { symbol: "XLE", want: "crude oil", have: "XLE (Energy Select Sector SPDR)", why: "XLE holds energy EQUITIES, not the commodity. It is an operating-leverage proxy whose correlation to WTI decays exactly when equities sell off for a non-oil reason, so it is not a crude-oil return and does not reproduce one. This card describes XLE." , whyZh: "XLE 持有的是能源股票，不是商品本身。它是一个经营杠杆代理，与 WTI 的相关性恰恰在股市因为非油价原因下跌时失效，所以它不是原油收益，也无法复现原油收益。这张卡片描述的是 XLE。" },
  "美债": { symbol: "TLT", want: "US Treasuries", have: "TLT (iShares 20+ Year Treasury Bond)", why: "TLT is the long end of the curve only. It carries roughly twice the duration of an intermediate Treasury fund, so it over-states the effect of a rate move of a given size. This card describes TLT." , whyZh: "TLT 只覆盖收益率曲线的长端，久期大约是中期国债基金的两倍，因此会放大同等幅度利率变动的影响。这张卡片描述的是 TLT。" },
  "金融股": { symbol: "XLF", want: "the financial sector", have: "XLF (Financial Select Sector SPDR)", why: "XLF is US large-cap financials, weighted to banks and insurers. It holds no non-US financials and little fintech. This card describes XLF." , whyZh: "XLF 是美国大盘金融股，权重集中在银行和保险。它不含非美金融机构，金融科技占比也很低。这张卡片描述的是 XLF。" },
  "医疗股": { symbol: "XLV", want: "the health-care sector", have: "XLV (Health Care Select Sector SPDR)", why: "XLV is US large-cap health care, weighted to pharma and managed care. It holds no medtech small caps and no non-US names. This card describes XLV." , whyZh: "XLV 是美国大盘医疗保健，权重集中在制药和医疗保险。它不含医疗器械小盘股，也不含非美公司。这张卡片描述的是 XLV。" },
  "能源股": { symbol: "XLE", want: "the energy sector", have: "XLE (Energy Select Sector SPDR)", why: "XLE is US large-cap integrated energy and E&P. It holds no midstream MLPs and no non-US majors. This card describes XLE." , whyZh: "XLE 是美国大盘一体化能源与勘探生产企业。它不含中游 MLP，也不含非美石油巨头。这张卡片描述的是 XLE。" },
  "美股大盘": { symbol: "SPY", want: "the broad US market", have: "SPY (SPDR S&P 500 ETF Trust)", why: "SPY is cap-weighted into the largest US names, so it is the large-cap market rather than the whole one, and it under-weights exactly the small caps a breadth question is usually about. IWM is in this library. This card describes SPY." , whyZh: "SPY 按市值加权，偏向美国最大的公司，所以它是大盘而不是整个市场，并且恰恰低配了问“市场广度”时通常最关心的小盘股。本库也持有 IWM。这张卡片描述的是 SPY。" }
};

/**
 * English spellings of the same sector words, each attached to the rationale of its Chinese twin.
 *
 * The rationale is a fact about the LIBRARY ("XLK is broader than semiconductors"), not about the
 * language the question arrived in, so it is shared verbatim rather than written twice and left to
 * drift. The zh rendering travels alongside it as whyZh and the desk picks by language.
 */
const SECTOR_EN = {
  "半导体": ["semiconductors", "semiconductor", "semiconductor stocks", "chip stocks", "chips"],
  "科技股": ["tech stocks", "technology sector"],
  "原油": ["crude oil", "oil", "oil price"],
  "能源股": ["energy stocks"],
  "中概股": ["china concept stocks", "china internet", "chinese adrs"],
  "恒生科技": ["hang seng tech"],
  "美债": ["us treasuries", "treasuries", "treasury bonds", "long bonds"],
  "金融股": ["financials", "banks"],
  "医疗股": ["health care", "healthcare", "pharma"],
  "美股大盘": ["us market", "us stock market", "the broad market"]
};

export const SECTOR_PROXIES = new Map(
  Object.entries(SECTOR_BASE)
    .flatMap(([word, v]) => [[word, v], ...(SECTOR_EN[word] || []).map((w) => [w, v])])
    .map(([k, v]) => [k.toUpperCase(), v])
);

/**
 * Aliases whose referent is genuinely ambiguous in Chinese retail usage, and what the desk picks.
 *
 * "超微" is the live case: it abbreviates both 超微半导体 (AMD) and 超微电脑 (Super Micro Computer,
 * SMCI). This library holds AMD and not SMCI, so the resolution is defensible - but only out loud.
 * Guessing silently here is the same failure class the wrapper gate exists for, where a price-proximity
 * test "verified" the LINK token as Li Auto because the two happened to trade near each other.
 */
export const AMBIGUOUS_ALIASES = new Map(Object.entries({
  "超微": { symbol: "AMD", also: "SMCI (Super Micro Computer, 超微电脑)", why: "\"超微\" abbreviates both 超微半导体 (AMD) and 超微电脑 (Super Micro Computer, SMCI). This library holds AMD and does not hold SMCI, so this card describes AMD. If you meant the server maker, that instrument is not here and nothing on this card applies to it." , whyZh: "「超微」同时是超微半导体（AMD）和超微电脑（Super Micro Computer，SMCI）的简称。本库持有 AMD，没有 SMCI，所以这张卡片描述的是 AMD。如果你指的是那家服务器厂商，本库没有这个标的，卡上的任何结论都不适用于它。" }
}).map(([k, v]) => [k.toUpperCase(), v]));

/**
 * Well-known instruments a trader is likely to name that this library does NOT hold.
 *
 * The library is 55 single names plus 16 ETFs. Before this existed, naming anything outside it
 * produced the same generic dead end as a typo - "no instrument recognised" - which is a true
 * sentence and a useless one: it does not distinguish "you misspelled it" from "we do not carry
 * it", and the second is a fact about the desk that a trader is entitled to hear.
 *
 * These entries resolve to NOTHING. They never become a symbol. They only let the desk say which
 * instrument was recognised, what it trades as, and that it is not here - which also stops the
 * fuzzy matcher from "repairing" a name it should not repair. 美联航 is the case that started it:
 * it was an ALIASES entry pointing at UNH, so asking about United Airlines analysed UnitedHealth.
 */
const UNHELD_BASE = {
  "美联航": { name: "United Airlines", ticker: "UAL", why: "United Airlines is not one of the 71 instruments in this library. It was previously aliased to UNH, which is UnitedHealth - a different company in a different industry, reached because both English names begin with \"United\". That alias is gone rather than repointed." , whyZh: "联合航空不在本库的 71 个标的里。它此前被错误地映射到 UNH（联合健康）——那是另一家公司、另一个行业，只因为两个英文名都以“United”开头。这条映射已经被删除，而不是改指向。" },
  "联合航空": { name: "United Airlines", ticker: "UAL", why: "United Airlines is not one of the 71 instruments in this library." , whyZh: "联合航空不在本库的 71 个标的里。" },
  "超微电脑": { name: "Super Micro Computer", ticker: "SMCI", why: "Super Micro Computer is not one of the 71 instruments in this library. Note that the bare word \"超微\" is ambiguous between this company and AMD (超微半导体); this library holds AMD, and says so when it resolves that word." , whyZh: "Super Micro Computer 不在本库的 71 个标的里。另外，「超微」这个词在该公司与 AMD（超微半导体）之间有歧义；本库持有的是 AMD，解析到该词时会明确说明。" },
  "台积电": { name: "Taiwan Semiconductor Mfg", ticker: "TSM", why: "TSMC is not one of the 71 instruments in this library, so a semiconductor question cannot be answered with the foundry here. XLK is the nearest sector instrument this library holds." , whyZh: "台积电不在本库的 71 个标的里，所以半导体问题无法用这家代工厂来回答。XLK 是本库持有的最接近的行业标的。" },
  "台积": { name: "Taiwan Semiconductor Mfg", ticker: "TSM", why: "TSMC is not one of the 71 instruments in this library. XLK is the nearest sector instrument this library holds." , whyZh: "台积电不在本库的 71 个标的里。XLK 是本库持有的最接近的行业标的。" },
  "比特币": { name: "Bitcoin", ticker: "BTC", why: "This is an equity analog library. BTC is used inside it as a cross-asset FEATURE (btcRet5, btcRet20) that helps describe a market state, but it is not an instrument the desk can retrieve analogs for or stress-test." , whyZh: "这是一个股票类比库。BTC 在库里只作为跨资产特征（btcRet5、btcRet20）帮助描述市场状态，它不是可以做类比检索或压力测试的标的。" },
  "以太坊": { name: "Ethereum", ticker: "ETH", why: "This is an equity analog library. ETH is carried as cross-asset context, not as an instrument the desk can retrieve analogs for or stress-test." , whyZh: "这是一个股票类比库。ETH 只作为跨资产背景，不是可以做类比检索或压力测试的标的。" },
  "以太": { name: "Ethereum", ticker: "ETH", why: "This is an equity analog library. ETH is carried as cross-asset context, not as an instrument the desk can retrieve analogs for or stress-test." , whyZh: "这是一个股票类比库。ETH 只作为跨资产背景，不是可以做类比检索或压力测试的标的。" }
};

/**
 * English spellings of the same unheld names, attached to the Chinese entry's explanation.
 *
 * BTC and ETH matter more than they look: this library carries both as cross-asset FEATURES, so a
 * crypto question is one the desk half-understands, and half-understanding is the state where a
 * confident wrong answer gets printed. Naming them here turns that into a sentence about what the
 * library is for.
 */
const UNHELD_EN = {
  "美联航": ["united airlines", "ual"],
  "超微电脑": ["super micro", "super micro computer", "smci"],
  "台积电": ["tsmc", "taiwan semiconductor", "taiwan semiconductor manufacturing"],
  "比特币": ["bitcoin", "btc"],
  "以太坊": ["ethereum", "eth", "ether"]
};

export const UNHELD_ALIASES = new Map(
  Object.entries(UNHELD_BASE)
    .flatMap(([word, v]) => [[word, v], ...(UNHELD_EN[word] || []).map((w) => [w, v])])
    .map(([k, v]) => [k.toUpperCase(), v])
);

export const bySymbol = (sym) => UNIVERSE.find((u) => u.s === sym.toUpperCase());
