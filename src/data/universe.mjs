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
    "摩根大通":"JPM","高盛":"GS","美联航":"UNH","联合健康":"UNH","礼来":"LLY","辉瑞":"PFE",
    "埃克森":"XOM","雪佛龙":"CVX","沃尔玛":"WMT","好市多":"COST","可口可乐":"KO","麦当劳":"MCD",
    "耐克":"NKE","家得宝":"HD","迪士尼":"DIS","波音":"BA","通用电气":"GE","霍尼韦尔":"HON",
    "洛克希德":"LMT","阿里巴巴":"BABA","阿里":"BABA","拼多多":"PDD","京东":"JD","百度":"BIDU",
    "蔚来":"NIO","理想":"LI","纳指":"QQQ","纳斯达克":"QQQ","标普":"SPY","标普500":"SPY",
    "黄金":"GLD","美债":"TLT","中概":"KWEB","恒生科技":"KWEB","原油":"XLE","半导体":"NVDA",
    "苹果股票":"AAPL","美股大盘":"SPY","罗素":"IWM"
  };
  for (const [k, v] of Object.entries(extra)) m.set(k.toUpperCase(), v);
  return m;
})();

export const bySymbol = (sym) => UNIVERSE.find((u) => u.s === sym.toUpperCase());
