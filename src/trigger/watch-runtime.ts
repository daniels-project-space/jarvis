import { randomUUID } from "node:crypto";
import { observeProduct, type ProductObservation } from "../lib/product-observation";
import { vaultService } from "../lib/vault-client";
import { sendPush } from "./push-send";

const CONVEX_URL = process.env.CONVEX_URL ?? process.env.NEXT_PUBLIC_CONVEX_URL ?? "https://tangible-goose-318.convex.cloud";

async function convexMutation(path: string, args: Record<string, unknown>) {
  const workerToken = process.env.JARVIS_WORKER_TOKEN;
  if (!workerToken) throw new Error("JARVIS_WORKER_TOKEN is not configured");
  const response = await fetch(`${CONVEX_URL}/api/mutation`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, args: { ...args, workerToken }, format: "json" }),
  });
  const body = await response.json();
  if (!response.ok || body.status === "error") throw new Error(String(body.errorMessage ?? response.status));
  return body.value;
}

type AssetObservation = {
  symbol: string;
  price: number;
  currency: string;
  source: {
    provider: string;
    feed: string;
    tier: "official" | "aggregator";
    latency: "current" | "delayed" | "unknown";
    observedAt: number;
    receivedAt: number;
    freshUntil: number;
    url?: string;
  };
};

const CRYPTO: Record<string, string> = {
  BTC: "BTCUSDT", BITCOIN: "BTCUSDT", ETH: "ETHUSDT", ETHEREUM: "ETHUSDT",
  SOL: "SOLUSDT", SOLANA: "SOLUSDT", BNB: "BNBUSDT", XRP: "XRPUSDT",
  DOGE: "DOGEUSDT", ADA: "ADAUSDT", AVAX: "AVAXUSDT", LINK: "LINKUSDT",
};

export function normalizeAssetSymbol(input: string) {
  const compact = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return CRYPTO[compact] ?? (compact.endsWith("USDT") ? compact : compact);
}

async function observeAsset(definition: any): Promise<AssetObservation | null> {
  const symbol = normalizeAssetSymbol(String(definition.symbol ?? ""));
  const now = Date.now();
  const binance = definition.provider === "binance" || symbol.endsWith("USDT") || Boolean(CRYPTO[String(definition.symbol ?? "").toUpperCase()]);
  if (binance) {
    try {
      const pair = symbol.endsWith("USDT") ? symbol : `${symbol}USDT`;
      const response = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${encodeURIComponent(pair)}`, { signal: AbortSignal.timeout(8_000) });
      if (response.ok) {
        const body: any = await response.json();
        const price = Number(body.price);
        if (Number.isFinite(price) && price > 0)
          return {
            symbol: pair,
            price,
            currency: "USDT",
            source: { provider: "Binance", feed: "spot-ticker", tier: "official", latency: "current", observedAt: now, receivedAt: Date.now(), freshUntil: now + 2 * 60_000, url: "https://www.binance.com/en/markets/overview" },
          };
      }
    } catch { /* use equity sources */ }
  }

  const finnhub = await vaultService("finnhub").catch(() => ({} as Record<string, string>));
  const finnhubKey = finnhub.FINNHUB_API_KEY ?? process.env.FINNHUB_API_KEY;
  if (finnhubKey) {
    try {
      const response = await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(finnhubKey)}`, { signal: AbortSignal.timeout(8_000) });
      if (response.ok) {
        const body: any = await response.json();
        const price = Number(body.c);
        if (price > 0)
          return {
            symbol, price, currency: definition.currency || "USD",
            source: { provider: "Finnhub", feed: "quote", tier: "official", latency: "current", observedAt: Number(body.t) * 1_000 || now, receivedAt: Date.now(), freshUntil: (Number(body.t) * 1_000 || now) + 5 * 60_000, url: "https://finnhub.io" },
          };
      }
    } catch { /* fallback below */ }
  }

  try {
    const response = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1m`, { signal: AbortSignal.timeout(8_000) });
    if (!response.ok) return null;
    const body: any = await response.json();
    const result = body?.chart?.result?.[0];
    const price = Number(result?.meta?.regularMarketPrice);
    if (!price) return null;
    return {
      symbol, price, currency: result?.meta?.currency ?? definition.currency ?? "USD",
      source: { provider: "Yahoo Finance", feed: "unofficial-chart", tier: "aggregator", latency: "unknown", observedAt: Number(result?.meta?.regularMarketTime) * 1_000 || now, receivedAt: Date.now(), freshUntil: (Number(result?.meta?.regularMarketTime) * 1_000 || now) + 15 * 60_000, url: `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}` },
    };
  } catch {
    return null;
  }
}

async function productSecrets() {
  const [ebay, serper, serpapi] = await Promise.all([
    vaultService("ebay").catch(() => ({} as Record<string, string>)),
    vaultService("serper").catch(() => ({} as Record<string, string>)),
    vaultService("serpapi").catch(() => ({} as Record<string, string>)),
  ]);
  return {
    ebayClientId: ebay.EBAY_CLIENT_ID ?? process.env.EBAY_CLIENT_ID,
    ebayClientSecret: ebay.EBAY_CLIENT_SECRET ?? process.env.EBAY_CLIENT_SECRET,
    serperApiKey: serper.SERPER_API_KEY ?? process.env.SERPER_API_KEY,
    serpApiKey: serpapi.SERPAPI_KEY ?? process.env.SERPAPI_KEY,
  };
}

export async function runWatchSweep() {
  const now = Date.now();
  const leaseToken = randomUUID();
  const claimed: any[] = (await convexMutation("watchRules:claimDue", { now, limit: 30, leaseMs: 120_000, leaseToken })) ?? [];
  if (!claimed.length) return { claimed: 0, checked: 0, triggered: 0, failed: 0 };
  const secrets = claimed.some((rule) => rule.kind === "product") ? await productSecrets() : {};
  const bySubject = new Map<string, any[]>();
  for (const rule of claimed) bySubject.set(rule.subjectKey, [...(bySubject.get(rule.subjectKey) ?? []), rule]);
  let checked = 0; let triggered = 0; let failed = 0;
  for (const rules of bySubject.values()) {
    const first = rules[0];
    let observation: ProductObservation | AssetObservation | null = null;
    let error = "";
    try {
      observation = first.kind === "product"
        ? await observeProduct(
            String(first.definition?.query ?? first.label),
            secrets,
            first.lastObservation,
            String(first.definition?.condition ?? "any"),
          )
        : await observeAsset(first.definition);
      if (!observation) error = "No trustworthy matching observation";
      else if (first.kind === "product" && (observation as ProductObservation).deliveryKnown === false) {
        error = "Delivery cost unavailable; landed price is not verified";
        observation = null;
      }
      else if (observation.source.freshUntil <= now) { error = "Provider observation was stale"; observation = null; }
    } catch (cause: any) {
      error = String(cause?.message ?? cause).slice(0, 300);
    }
    for (const rule of rules) {
      const result: any = await convexMutation("watchRules:commitObservation", {
        id: String(rule._id), leaseToken, observation: observation ?? undefined, error: error || undefined, now,
      }).catch(() => null);
      checked += 1;
      if (!result?.ok) { failed += 1; continue; }
      if (error) failed += 1;
      if (result.triggered && result.eventId) {
        triggered += 1;
        const signalTag = `watch-${String(result.eventId).slice(-20)}`;
        const sent = await sendPush(
          result.title || "JARVIS signal",
          result.spoken || "A watch condition was met.",
          "/",
          { tag: signalTag, topic: signalTag, ttl: 24 * 3600, urgency: "high" },
        ).then(() => true).catch(() => false);
        await convexMutation("watchRules:markPush", { id: result.eventId, status: sent ? "sent" : "failed" }).catch(() => {});
      }
    }
  }
  return { claimed: claimed.length, checked, triggered, failed };
}
