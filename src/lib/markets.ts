import "server-only";
import { getSecret } from "./vault";

// JARVIS market engine — real OHLCV charts (always USD/USDT), computed
// indicators, and the per-asset context bundle (VIX / news / funding / open
// interest / fear-greed) that feeds the analyst brain. Crypto candles come from
// Binance's public data mirror (data-api.binance.vision — not geo-blocked on
// cloud IPs); stocks/indices/commodities from Yahoo in USD.

export type Candle = { t: number; o: number; h: number; l: number; c: number; v: number };
export type AssetRef = {
  kind: "crypto" | "stock" | "index" | "commodity" | "fx";
  label: string;
  binance?: string; // BTCUSDT
  yahoo?: string; // AAPL, ^GSPC, GC=F
  profile: string; // per-asset analyst calibration
};

const CRYPTO: Record<string, { sym: string; label: string; profile: string }> = {
  btc: { sym: "BTCUSDT", label: "Bitcoin", profile: "BTC: the market's reserve asset. Calibration: funding > +0.03%/8h = crowded longs, < -0.01% = shorts paying (squeeze fuel); Fear&Greed <20 historically marks capitulation zones, >75 euphoria; watch the 200-day SMA as the bull/bear regime line and prior halving-cycle rhythm; weekend moves on thin volume often retrace." },
  eth: { sym: "ETHUSDT", label: "Ethereum", profile: "ETH: high-beta to BTC — always read ETH/BTC relative strength first; staking flows dampen sell pressure; funding extremes matter more (levered market)." },
  sol: { sym: "SOLUSDT", label: "Solana", profile: "SOL: very high beta, retail-heavy; moves 1.5-2x BTC's swings; volume spikes fade fast — demand Wyckoff volume confirmation before trusting breakouts." },
  xrp: { sym: "XRPUSDT", label: "XRP", profile: "XRP: news/legal-headline driven; technicals break on headlines — weight news context heavily." },
  doge: { sym: "DOGEUSDT", label: "Dogecoin", profile: "DOGE: sentiment/meme asset; social momentum IS the fundamental; distribution tops form fast." },
  bnb: { sym: "BNBUSDT", label: "BNB", profile: "BNB: exchange token, tied to Binance news flow." },
  ada: { sym: "ADAUSDT", label: "Cardano", profile: "ADA: retail-heavy, long accumulation ranges." },
  link: { sym: "LINKUSDT", label: "Chainlink", profile: "LINK: infra token with long Wyckoff re-accumulation history." },
  avax: { sym: "AVAXUSDT", label: "Avalanche", profile: "AVAX: high-beta alt." },
};
const INDEX: Record<string, { sym: string; label: string; profile: string }> = {
  spx: { sym: "^GSPC", label: "S&P 500", profile: "S&P 500: read WITH the VIX regime (see VIX data); breadth matters — a rally on falling volume + rising VIX is distribution; 50/200-day SMA golden/death crosses carry real flows here." },
  ndx: { sym: "^IXIC", label: "Nasdaq", profile: "Nasdaq: rate-sensitive growth; amplifies S&P moves; watch mega-cap earnings dates in news." },
  dji: { sym: "^DJI", label: "Dow Jones", profile: "Dow: price-weighted, defensive tilt." },
  vix: { sym: "^VIX", label: "VIX", profile: "VIX itself: mean-reverting; spikes >30 mark fear extremes that fade, sub-13 = complacency." },
};
const COMMODITY: Record<string, { sym: string; label: string; profile: string }> = {
  gold: { sym: "GC=F", label: "Gold", profile: "Gold: trades inverse to real yields and DXY; central-bank buying underpins dips; breakouts from multi-month ranges tend to run — measure the range and project it." },
  silver: { sym: "SI=F", label: "Silver", profile: "Silver: gold's high-beta sibling; gold/silver ratio extremes (>85 cheap silver, <65 rich) matter." },
  oil: { sym: "CL=F", label: "WTI Crude", profile: "Oil: OPEC headlines + inventory data dominate; technical levels break on supply news." },
  dxy: { sym: "DX-Y.NYB", label: "Dollar Index", profile: "DXY: the anti-asset — strength pressures crypto, gold and equities alike." },
};

export function resolveAsset(name: string): AssetRef | null {
  const n = name.toLowerCase().trim().replace(/[^a-z0-9^=. -]/g, "");
  const alias: Record<string, string> = {
    bitcoin: "btc", ethereum: "eth", solana: "sol", ripple: "xrp", dogecoin: "doge", cardano: "ada",
    chainlink: "link", avalanche: "avax", "s&p": "spx", "s&p 500": "spx", sp500: "spx", "es": "spx",
    nasdaq: "ndx", dow: "dji", "dow jones": "dji", "the vix": "vix", crude: "oil", "wti": "oil",
    dollar: "dxy", "dollar index": "dxy",
  };
  const key = alias[n] ?? n;
  if (CRYPTO[key]) return { kind: "crypto", label: CRYPTO[key].label, binance: CRYPTO[key].sym, profile: CRYPTO[key].profile };
  if (INDEX[key]) return { kind: "index", label: INDEX[key].label, yahoo: INDEX[key].sym, profile: INDEX[key].profile };
  if (COMMODITY[key]) return { kind: "commodity", label: COMMODITY[key].label, yahoo: COMMODITY[key].sym, profile: COMMODITY[key].profile };
  // anything ticker-shaped = equity via Yahoo (crypto majors are all mapped above)
  if (/^[a-z.^=-]{1,7}$/.test(key)) {
    const upper = key.toUpperCase();
    return {
      kind: "stock",
      label: upper,
      yahoo: upper,
      profile: `${upper}: single stock — earnings dates and guidance dominate; check news; respect the sector and index (S&P) regime; VIX applies. Patterns on single names need volume confirmation (gaps matter).`,
    };
  }
  return null;
}

const IV_BINANCE: Record<string, string> = { "1h": "1h", "4h": "4h", "1d": "1d", "1w": "1w" };
const IV_YAHOO: Record<string, { interval: string; range: string }> = {
  "1h": { interval: "60m", range: "1mo" },
  "4h": { interval: "1d", range: "1y" }, // yahoo has no 4h — daily is the honest nearest
  "1d": { interval: "1d", range: "2y" },
  "1w": { interval: "1wk", range: "10y" },
};

export async function fetchCandles(a: AssetRef, interval: string, limit = 260): Promise<Candle[]> {
  if (a.binance) {
    const iv = IV_BINANCE[interval] ?? "1d";
    for (const host of ["https://data-api.binance.vision", "https://api.binance.com"]) {
      try {
        const r = await fetch(`${host}/api/v3/klines?symbol=${a.binance}&interval=${iv}&limit=${Math.min(limit, 720)}`, {
          signal: AbortSignal.timeout(8000),
        });
        if (!r.ok) continue;
        const rows: any[] = await r.json();
        return rows.map((k) => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
      } catch {
        /* next host */
      }
    }
    return [];
  }
  const cfg = IV_YAHOO[interval] ?? IV_YAHOO["1d"];
  try {
    const j: any = await (
      await fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(a.yahoo!)}?range=${cfg.range}&interval=${cfg.interval}`,
        { headers: { "user-agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(8000) },
      )
    ).json();
    const res = j?.chart?.result?.[0];
    const q = res?.indicators?.quote?.[0];
    if (!res?.timestamp || !q) return [];
    const out: Candle[] = [];
    for (let i = 0; i < res.timestamp.length; i++) {
      if (q.close[i] == null) continue;
      out.push({ t: res.timestamp[i] * 1000, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i] ?? 0 });
    }
    return out.slice(-limit);
  } catch {
    return [];
  }
}

// ── indicators ──────────────────────────────────────────────────────────────
export const sma = (xs: number[], n: number): (number | null)[] =>
  xs.map((_, i) => (i + 1 < n ? null : xs.slice(i + 1 - n, i + 1).reduce((a, b) => a + b, 0) / n));

export function rsi(closes: number[], n = 14): (number | null)[] {
  const out: (number | null)[] = [null];
  let ag = 0,
    al = 0;
  for (let i = 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    const g = Math.max(0, ch),
      l = Math.max(0, -ch);
    if (i <= n) {
      ag += g / n;
      al += l / n;
      out.push(i === n ? 100 - 100 / (1 + (al === 0 ? 100 : ag / al)) : null);
    } else {
      ag = (ag * (n - 1) + g) / n;
      al = (al * (n - 1) + l) / n;
      out.push(100 - 100 / (1 + (al === 0 ? 100 : ag / al)));
    }
  }
  return out;
}

// Pivot-based support/resistance: fractal highs/lows clustered into levels.
export function keyLevels(candles: Candle[], maxLevels = 6): { price: number; kind: "support" | "resistance"; touches: number }[] {
  const piv: { price: number; hi: boolean }[] = [];
  for (let i = 2; i < candles.length - 2; i++) {
    const w = candles.slice(i - 2, i + 3);
    if (candles[i].h === Math.max(...w.map((x) => x.h))) piv.push({ price: candles[i].h, hi: true });
    if (candles[i].l === Math.min(...w.map((x) => x.l))) piv.push({ price: candles[i].l, hi: false });
  }
  const last = candles[candles.length - 1]?.c ?? 0;
  const tol = last * 0.012;
  const clusters: { price: number; touches: number; hi: number; lo: number }[] = [];
  for (const p of piv) {
    const c = clusters.find((x) => Math.abs(x.price - p.price) < tol);
    if (c) {
      c.price = (c.price * c.touches + p.price) / (c.touches + 1);
      c.touches++;
      if (p.hi) c.hi++;
      else c.lo++;
    } else clusters.push({ price: p.price, touches: 1, hi: p.hi ? 1 : 0, lo: p.hi ? 0 : 1 });
  }
  return clusters
    .filter((c) => c.touches >= 2)
    .sort((a, b) => b.touches - a.touches)
    .slice(0, maxLevels)
    .map((c) => ({ price: Math.round(c.price * 100) / 100, kind: c.price > last ? ("resistance" as const) : ("support" as const), touches: c.touches }));
}

export function chartWidget(a: AssetRef, interval: string, candles: Candle[], levels: ReturnType<typeof keyLevels>, notes?: string[]) {
  const closes = candles.map((c) => c.c);
  const view = candles.slice(-180);
  const off = candles.length - view.length;
  const rnd = (x: number | null) => (x == null ? null : Math.round(x * 10000) / 10000);
  const last = closes[closes.length - 1];
  const prev = closes[closes.length - 2] ?? last;
  return {
    kind: "candles",
    asset: a.label,
    interval,
    unit: a.binance ? "USDT" : "USD",
    last: rnd(last),
    changePct: Math.round(((last - prev) / prev) * 10000) / 100,
    candles: view.map((c) => [c.t, rnd(c.o), rnd(c.h), rnd(c.l), rnd(c.c), Math.round(c.v)]),
    sma20: sma(closes, 20).slice(off).map(rnd),
    sma50: sma(closes, 50).slice(off).map(rnd),
    sma200: sma(closes, 200).slice(off).map(rnd),
    rsi: rsi(closes).slice(off).map((x) => (x == null ? null : Math.round(x * 10) / 10)),
    levels,
    notes: notes ?? [],
  };
}

// ── context feeds for the analyst ───────────────────────────────────────────
export async function fetchVix(): Promise<{ value: number; regime: string } | null> {
  try {
    const j: any = await (
      await fetch("https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?range=5d&interval=1d", {
        headers: { "user-agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(6000),
      })
    ).json();
    const v = j?.chart?.result?.[0]?.meta?.regularMarketPrice;
    if (typeof v !== "number") return null;
    const regime = v < 13 ? "complacency" : v < 18 ? "calm" : v < 25 ? "elevated caution" : v < 32 ? "fear" : "panic";
    return { value: Math.round(v * 100) / 100, regime };
  } catch {
    return null;
  }
}

export async function fetchCryptoFlows(binanceSym: string): Promise<string> {
  const bits: string[] = [];
  try {
    const fg: any = await (await fetch("https://api.alternative.me/fng/?limit=8", { signal: AbortSignal.timeout(6000) })).json();
    const now = fg?.data?.[0];
    const wk = fg?.data?.[7];
    if (now) bits.push(`Fear&Greed ${now.value} (${now.value_classification})${wk ? `, week ago ${wk.value}` : ""}`);
  } catch { /* skip */ }
  let funding: string | null = null;
  try {
    const p: any = await (await fetch(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${binanceSym}`, { signal: AbortSignal.timeout(5000) })).json();
    if (p?.lastFundingRate != null) funding = `${(Number(p.lastFundingRate) * 100).toFixed(4)}%/8h (Binance)`;
  } catch { /* geo-blocked on some hosts */ }
  if (!funding) {
    try {
      const inst = binanceSym.replace("USDT", "-USDT-SWAP");
      const o: any = await (await fetch(`https://www.okx.com/api/v5/public/funding-rate?instId=${inst}`, { signal: AbortSignal.timeout(5000) })).json();
      const fr = o?.data?.[0]?.fundingRate;
      if (fr != null) funding = `${(Number(fr) * 100).toFixed(4)}%/8h (OKX)`;
    } catch { /* skip */ }
  }
  if (funding) bits.push(`perp funding ${funding}`);
  try {
    const oi: any = await (await fetch(`https://fapi.binance.com/futures/data/openInterestHist?symbol=${binanceSym}&period=1d&limit=8`, { signal: AbortSignal.timeout(5000) })).json();
    if (Array.isArray(oi) && oi.length >= 2) {
      const a = Number(oi[0].sumOpenInterestValue);
      const b = Number(oi[oi.length - 1].sumOpenInterestValue);
      bits.push(`open interest ${b > a ? "up" : "down"} ${Math.abs(Math.round(((b - a) / a) * 100))}% over ${oi.length}d ($${(b / 1e9).toFixed(2)}b)`);
    }
  } catch { /* skip */ }
  return bits.join("; ") || "flows data unavailable";
}

export async function fetchNews(query: string, key: string): Promise<string> {
  try {
    const qs = new URLSearchParams({ engine: "google_news", q: query, gl: "us", hl: "en", api_key: key });
    const j: any = await (await fetch(`https://serpapi.com/search.json?${qs}`, { signal: AbortSignal.timeout(8000) })).json();
    const items = (j?.news_results ?? []).slice(0, 7);
    return items.map((n: any) => `- [${n.source?.name ?? "?"} ${n.date ?? ""}] ${n.title}`).join("\n") || "no recent headlines";
  } catch {
    return "news unavailable";
  }
}

// ── the analyst charter: methodology + timeframe discipline, per asset ──────
export const ANALYST_SYSTEM = `You are JARVIS's market analyst core — a veteran technician who reads charts the way Wyckoff and Elliott intended, and who NEVER pretends certainty.

METHOD — apply in this order, and say which timeframe each read comes from:
1. REGIME: trend vs the 200-SMA (weekly/daily = regime timeframes), 50-SMA slope, higher-highs/lower-lows structure. Volatility context (VIX for equities/commodities, funding+fear-greed for crypto).
2. LEVELS: the provided support/resistance clusters — respect touch counts. Round numbers matter.
3. PATTERNS (daily/4h): head & shoulders, double/triple tops-bottoms, triangles, wedges, flags, cup & handle. State the MEASURED TARGET (pattern height projected) and what invalidates it.
4. ELLIOTT WAVE (weekly for the count, daily for the current wave): propose the most plausible count. HARD RULES: wave 2 never retraces past the start of 1; wave 3 is never the shortest; wave 4 doesn't overlap wave 1 (except diagonals). Give the count as a HYPOTHESIS with its invalidation price. Corrections are ABC (zigzag/flat/triangle).
5. WYCKOFF (daily/4h): which phase — accumulation (PS, SC, AR, ST, spring/test, SOS, LPS) or distribution (PSY, BC, AR, ST, UT/UTAD, SOW, LPSY)? Volume must CONFIRM: springs on low volume that recover fast are bullish; upthrusts on high volume that fail are bearish. Effort vs result (VSA): high volume + no progress = absorption.
6. VOLUME & FLOWS: rising price on falling volume = weak hands rally; capitulation spikes; for crypto use funding (crowded side pays), open-interest direction (OI up + price up = new longs; OI up + price down = new shorts), fear-greed extremes as contrarian timing.
7. NEWS: does the tape agree with the headlines? Markets that refuse to fall on bad news are accumulating.

INDICATOR-TIMEFRAME DISCIPLINE: RSI/stochastics = 4h-daily momentum, divergences count most at range extremes; MACD = daily/weekly trend shifts; 20-SMA = short swing, 50 = intermediate, 200 = regime; don't cite an indicator without its timeframe.

OUTPUT exactly this markdown skeleton, concise, numbers not vibes:
## Regime
## Key levels
## Pattern read
## Elliott count (hypothesis + invalidation)
## Wyckoff phase
## Volume & flows
## Verdict
The Verdict: bias (bullish/bearish/neutral + conviction /10), the trade plan IF acting (entry zone, invalidation stop, first/second targets, rough R:R), what would change your mind, and time horizon. You are advising Daniel with his own money — be direct, flag when the honest answer is "no edge, stand aside". End Verdict with one plain-English sentence a friend would say.`;
