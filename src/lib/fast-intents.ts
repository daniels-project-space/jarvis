export type FastChartIntent = { asset: string; interval: "1h" | "4h" | "1d" | "1w" };

const ALIASES: Record<string, string> = {
  bitcoin: "btc", btc: "btc", ethereum: "eth", eth: "eth", solana: "sol", sol: "sol",
  xrp: "xrp", ripple: "xrp", dogecoin: "doge", doge: "doge", cardano: "ada", ada: "ada",
  chainlink: "link", link: "link", avalanche: "avax", avax: "avax",
};

// This is intentionally narrow. A direct visual request should open without
// asking a model to decide what "BTC chart" means; an analysis, prediction or
// trading question still goes through the full market analyst.
export function parseFastChartIntent(input: string): FastChartIntent | null {
  const text = input.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  if (!text || /\b(analy[sz]e|analysis|should|buy|sell|forecast|outlook|why|explain|trade|prediction)\b/.test(text)) return null;
  const alias = Object.entries(ALIASES).find(([name]) => new RegExp(`\\b${name}\\b`).test(text));
  if (!alias) return null;
  const visualRequest = /\b(chart|price|candles?|graph|show|open|look at)\b/.test(text);
  if (!visualRequest) return null;
  const interval = /\b(weekly|week|1w)\b/.test(text)
    ? "1w"
    : /\b(4h|four hour)\b/.test(text)
      ? "4h"
      : /\b(1h|hourly|hour)\b/.test(text)
        ? "1h"
        : "1d";
  return { asset: alias[1], interval };
}
