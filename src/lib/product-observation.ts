export type ProductProviderSecrets = {
  ebayClientId?: string;
  ebayClientSecret?: string;
  serperApiKey?: string;
  serpApiKey?: string;
};

export type ProductObservation = {
  productKey: string;
  providerProductId?: string;
  title: string;
  pricePence: number;
  deliveryPence: number;
  deliveryKnown: boolean;
  landedPence: number;
  currency: "GBP";
  condition: string;
  url: string;
  image?: string;
  merchant?: string;
  source: {
    provider: string;
    feed: string;
    tier: "official" | "aggregator" | "scrape";
    latency: "current" | "snapshot" | "unknown";
    sourceId?: string;
    url?: string;
    observedAt: number;
    receivedAt: number;
    freshUntil: number;
  };
};

type Candidate = Omit<ProductObservation, "source"> & { provider: string; tier: ProductObservation["source"]["tier"]; latency: ProductObservation["source"]["latency"] };

export function parseDeliveryPrice(raw: unknown): { pence: number; known: boolean } {
  const text = String(raw ?? "").trim();
  if (!text) return { pence: 0, known: false };
  if (/free/i.test(text)) return { pence: 0, known: true };
  const value = Number(text.replace(/[^\d.]/g, ""));
  return Number.isFinite(value) ? { pence: Math.round(value * 100), known: true } : { pence: 0, known: false };
}

let ebayTokenCache: { key: string; token: string; until: number } | null = null;
async function ebayToken(secrets: ProductProviderSecrets): Promise<string> {
  const id = secrets.ebayClientId;
  const secret = secrets.ebayClientSecret;
  if (!id || !secret) return "";
  const key = `${id.slice(0, 8)}:${secret.length}`;
  if (ebayTokenCache?.key === key && ebayTokenCache.until > Date.now()) return ebayTokenCache.token;
  try {
    const response = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Fapi_scope",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return "";
    const body: any = await response.json();
    ebayTokenCache = { key, token: String(body.access_token), until: Date.now() + Number(body.expires_in ?? 7200) * 1_000 - 120_000 };
    return ebayTokenCache.token;
  } catch {
    return "";
  }
}

async function ebayCandidates(query: string, secrets: ProductProviderSecrets): Promise<Candidate[]> {
  const token = await ebayToken(secrets);
  if (!token) return [];
  try {
    const response = await fetch(
      `https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encodeURIComponent(query)}&limit=30&filter=buyingOptions:{FIXED_PRICE}`,
      { headers: { Authorization: `Bearer ${token}`, "X-EBAY-C-MARKETPLACE-ID": "EBAY_GB" }, signal: AbortSignal.timeout(12_000) },
    );
    if (!response.ok) return [];
    const body: any = await response.json();
    return (body.itemSummaries ?? []).flatMap((item: any) => {
      const pricePence = Math.round(Number(item.price?.value) * 100);
      if (!pricePence || item.price?.currency !== "GBP") return [];
      const shippingValue = item.shippingOptions?.[0]?.shippingCost?.value;
      const deliveryKnown = shippingValue !== undefined && shippingValue !== null;
      const deliveryPence = deliveryKnown ? Math.round(Number(shippingValue) * 100) : 0;
      const providerProductId = String(item.itemId ?? "");
      return [{
        productKey: `ebay:${providerProductId}`,
        providerProductId,
        title: String(item.title ?? "").slice(0, 200),
        pricePence,
        deliveryPence,
        deliveryKnown,
        landedPence: pricePence + Math.max(0, deliveryPence),
        currency: "GBP" as const,
        condition: String(item.condition ?? "unknown").toLowerCase(),
        url: String(item.itemWebUrl ?? ""),
        image: String(item.image?.imageUrl ?? item.thumbnailImages?.[0]?.imageUrl ?? "") || undefined,
        merchant: "eBay",
        provider: "eBay Browse",
        tier: "official" as const,
        latency: "current" as const,
      }];
    });
  } catch {
    return [];
  }
}

async function serperCandidates(query: string, secrets: ProductProviderSecrets): Promise<Candidate[]> {
  if (!secrets.serperApiKey) return [];
  try {
    const response = await fetch("https://google.serper.dev/shopping", {
      method: "POST",
      headers: { "X-API-KEY": secrets.serperApiKey, "content-type": "application/json" },
      body: JSON.stringify({ q: query, gl: "gb", hl: "en" }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) return [];
    const body: any = await response.json();
    return (body.shopping ?? []).flatMap((item: any, index: number) => {
      const raw = item.priceValue ?? String(item.price ?? "").replace(/[^\d.]/g, "");
      const pricePence = Math.round(Number(raw) * 100);
      if (!pricePence) return [];
      const id = String(item.productId ?? item.position ?? index);
      const delivery = parseDeliveryPrice(item.delivery ?? item.shipping);
      return [{
        productKey: `serper:${id}:${String(item.source ?? "").toLowerCase()}`,
        providerProductId: item.productId ? String(item.productId) : undefined,
        title: String(item.title ?? "").slice(0, 200),
        pricePence,
        deliveryPence: delivery.pence,
        deliveryKnown: delivery.known,
        landedPence: pricePence + delivery.pence,
        currency: "GBP" as const,
        condition: "unknown",
        url: String(item.link ?? ""),
        image: String(item.imageUrl ?? "") || undefined,
        merchant: String(item.source ?? "").slice(0, 80),
        provider: "Serper Shopping",
        tier: "aggregator" as const,
        latency: "snapshot" as const,
      }];
    });
  } catch {
    return [];
  }
}

async function serpApiCandidates(query: string, secrets: ProductProviderSecrets): Promise<Candidate[]> {
  if (!secrets.serpApiKey) return [];
  try {
    const params = new URLSearchParams({ engine: "google_shopping", q: query, gl: "uk", hl: "en", num: "30", api_key: secrets.serpApiKey });
    const response = await fetch(`https://serpapi.com/search.json?${params}`, { signal: AbortSignal.timeout(12_000) });
    if (!response.ok) return [];
    const body: any = await response.json();
    return (body.shopping_results ?? []).flatMap((item: any, index: number) => {
      const pricePence = Math.round(Number(item.extracted_price) * 100);
      if (!pricePence) return [];
      const id = String(item.product_id ?? item.position ?? index);
      const delivery = parseDeliveryPrice(item.delivery);
      return [{
        productKey: `serpapi:${id}:${String(item.source ?? "").toLowerCase()}`,
        providerProductId: item.product_id ? String(item.product_id) : undefined,
        title: String(item.title ?? "").slice(0, 200),
        pricePence,
        deliveryPence: delivery.pence,
        deliveryKnown: delivery.known,
        landedPence: pricePence + delivery.pence,
        currency: "GBP" as const,
        condition: "unknown",
        url: String(item.product_link ?? item.link ?? ""),
        image: String(item.thumbnail ?? "") || undefined,
        merchant: String(item.source ?? "").slice(0, 80),
        provider: "SerpAPI Shopping",
        tier: "aggregator" as const,
        latency: "snapshot" as const,
      }];
    });
  } catch {
    return [];
  }
}

const GENERIC_PRODUCT_WORDS = new Set([
  "and", "the", "with", "for", "new", "used", "pro", "combo", "kit",
  "camera", "gimbal", "drone", "body", "only", "black", "official",
]);
const tokens = (value: string) =>
  new Set(
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(/\s+/)
      // Single-digit model generations (RS 3, Mini 4, R 5) are identity,
      // whereas single-letter prose tokens add noise.
      .filter((token) => token.length > 1 || /^\d+$/.test(token)),
  );
const tokenWeight = (token: string) => {
  if (/\d/.test(token)) return 3;
  if (token.length <= 3 && !GENERIC_PRODUCT_WORDS.has(token)) return 2;
  if (GENERIC_PRODUCT_WORDS.has(token)) return 0.5;
  return 1;
};
export const productTitleSimilarity = (left: string, right: string) => {
  const a = tokens(left); const b = tokens(right);
  const weightA = [...a].reduce((sum, token) => sum + tokenWeight(token), 0);
  const weightB = [...b].reduce((sum, token) => sum + tokenWeight(token), 0);
  const overlap = [...a]
    .filter((token) => b.has(token))
    .reduce((sum, token) => sum + tokenWeight(token), 0);
  return (2 * overlap) / Math.max(1, weightA + weightB);
};

/** Reject obvious accessory-only results for a main-product hunt. */
export const isAccessoryOnlyMismatch = (title: string, query: string) => {
  if (/\b(case|bag|cover|plate|mount|cable|charger|replacement|spares?)\b/i.test(query)) return false;
  return /\b(case|bag|cover|plate|mount|cable|charger|replacement|spares?)\s+(?:made\s+)?(?:for|compatible\s+with)\b/i.test(title)
    || /^\s*(case|bag|cover|plate|mount|cable|charger|replacement|spares?)\b/i.test(title);
};

export const productConditionMatches = (candidate: string, requested = "any") => {
  const wanted = requested.toLowerCase();
  if (wanted !== "new" && wanted !== "used") return true;
  const value = candidate.toLowerCase().trim();
  if (!value || value === "unknown") return false;
  if (wanted === "new") return /^(new|brand new|new other)\b/.test(value);
  return /\b(used|pre[- ]?owned|refurbished|open box)\b/.test(value);
};

export async function observeProduct(
  query: string,
  secrets: ProductProviderSecrets,
  previous?: Partial<ProductObservation>,
  requestedCondition = "any",
): Promise<ProductObservation | null> {
  const providers = [
    () => ebayCandidates(query, secrets),
    () => serperCandidates(query, secrets),
    () => serpApiCandidates(query, secrets),
  ];
  for (const provider of providers) {
    const candidates = await provider();
    if (!candidates.length) continue;
    const plausible = candidates.filter(
      (candidate) =>
        productTitleSimilarity(candidate.title, query) >= 0.45 &&
        !isAccessoryOnlyMismatch(candidate.title, query) &&
        productConditionMatches(candidate.condition, requestedCondition),
    );
    if (!plausible.length) continue;
    const exact = previous?.providerProductId
      ? plausible.find((candidate) => candidate.providerProductId === previous.providerProductId)
      : undefined;
    const reference = previous?.title || query;
    const ranked = [...plausible].sort((left, right) => {
      const identity = productTitleSimilarity(right.title, reference) - productTitleSimilarity(left.title, reference);
      return Math.abs(identity) > 0.02 ? identity : left.landedPence - right.landedPence;
    });
    const chosen = exact ?? ranked[0];
    if (!chosen) continue;
    const observedAt = Date.now();
    const { provider: providerName, tier, latency, ...observation } = chosen;
    return {
      ...observation,
      source: {
        provider: providerName,
        feed: "shopping-search",
        tier,
        latency,
        sourceId: chosen.providerProductId,
        url: chosen.url,
        observedAt,
        receivedAt: observedAt,
        freshUntil: observedAt + (latency === "current" ? 3 : 6) * 3600_000,
      },
    };
  }
  return null;
}
