/**
 * Owner-scale OpenStreetMap place lookup. The public Nominatim instance is a
 * shared community service, so this adapter deliberately serialises uncached
 * requests to below its one-request-per-second policy and keeps a tiny cache.
 * Move `NOMINATIM_BASE_URL` to a self-hosted instance before serving multiple
 * people or high-volume traffic.
 */

export type OpenStreetMapPoint = { lat: number; lng: number };

export type OpenStreetMapWikipediaSource = {
  language: string;
  title: string;
  articleUrl: string;
};

export type WikimediaPlaceArticle = {
  title: string;
  articleUrl: string;
  thumbnailUrl?: string;
  attribution: string;
};

export type OpenStreetMapPlace = OpenStreetMapPoint & {
  name: string;
  address: string;
  type?: string;
  dist: number | null;
  mapsUri: string;
  /** Raw OSM tags are deliberately narrowed to these source-backed fields. */
  openingHours?: string;
  websiteUrl?: string;
  wikipedia?: OpenStreetMapWikipediaSource;
  wikipediaArticle?: WikimediaPlaceArticle;
};

export type OpenStreetMapSearchOptions = {
  center?: OpenStreetMapPoint;
  radiusMetres?: number;
  maxResults?: number;
};

type NominatimPlace = {
  lat?: unknown;
  lon?: unknown;
  name?: unknown;
  display_name?: unknown;
  type?: unknown;
  category?: unknown;
  namedetails?: { name?: unknown };
  extratags?: Record<string, unknown>;
};

type WikimediaPage = {
  title?: unknown;
  fullurl?: unknown;
  missing?: unknown;
  thumbnail?: { source?: unknown };
};

const NOMINATIM_BASE_URL = process.env.NOMINATIM_BASE_URL?.trim() || "https://nominatim.openstreetmap.org";
const NOMINATIM_MIN_INTERVAL_MS = process.env.NODE_ENV === "test" ? 0 : 1_100;
const CACHE_TTL_MS = 5 * 60_000;
const MAX_CACHE_ENTRIES = 160;
const placeCache = new Map<string, { expiresAt: number; places: OpenStreetMapPlace[] }>();
const WIKIMEDIA_CACHE_TTL_MS = 10 * 60_000;
const WIKIMEDIA_TIMEOUT_MS = 4_500;
const MAX_WIKIMEDIA_ENRICHMENTS = 4;
const MAX_WIKIMEDIA_CACHE_ENTRIES = 120;
const wikipediaArticleCache = new Map<string, { expiresAt: number; article: WikimediaPlaceArticle | null }>();
let nextNominatimRequestAt = 0;

function bounded(value: unknown, fallback: number, min: number, max: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.floor(number))) : fallback;
}

export function openStreetMapDistanceKm(a: OpenStreetMapPoint, b: OpenStreetMapPoint): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(h));
}

function locationViewbox(center: OpenStreetMapPoint, radiusMetres: number): string {
  const latDelta = radiusMetres / 111_320;
  const lngDelta = radiusMetres / Math.max(1, 111_320 * Math.cos((center.lat * Math.PI) / 180));
  const west = center.lng - lngDelta;
  const east = center.lng + lngDelta;
  const north = Math.min(90, center.lat + latDelta);
  const south = Math.max(-90, center.lat - latDelta);
  return `${west},${north},${east},${south}`;
}

async function respectNominatimRateLimit(): Promise<void> {
  const now = Date.now();
  const scheduledAt = Math.max(now, nextNominatimRequestAt);
  nextNominatimRequestAt = scheduledAt + NOMINATIM_MIN_INTERVAL_MS;
  if (scheduledAt > now) await new Promise<void>((resolve) => setTimeout(resolve, scheduledAt - now));
}

function placeName(place: NominatimPlace): string {
  const named = String(place.namedetails?.name ?? place.name ?? "").trim();
  if (named) return named;
  return String(place.display_name ?? "").split(",")[0]?.trim() || "Unnamed place";
}

function mapUrl(point: OpenStreetMapPoint): string {
  return `https://www.openstreetmap.org/?mlat=${encodeURIComponent(String(point.lat))}&mlon=${encodeURIComponent(String(point.lng))}#map=18/${encodeURIComponent(String(point.lat))}/${encodeURIComponent(String(point.lng))}`;
}

function sourceText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text || text.length > maxLength || /[\u0000-\u001f\u007f]/.test(text)) return undefined;
  return text;
}

function safeHttpUrl(value: unknown, maxLength = 500): string | undefined {
  const text = sourceText(value, maxLength);
  if (!text) return undefined;
  try {
    const url = new URL(text);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function wikipediaSource(value: unknown): OpenStreetMapWikipediaSource | undefined {
  const tagged = sourceText(value, 220);
  const match = tagged && /^([a-z][a-z0-9-]{0,14}):(.*)$/i.exec(tagged);
  if (!match) return undefined;
  const language = match[1]!.toLowerCase();
  const title = sourceText(match[2], 180);
  if (!title) return undefined;
  return {
    language,
    title,
    // This is constructed only from the exact language:title tag supplied by
    // OpenStreetMap. Never turn a place name into a Wikipedia search query.
    articleUrl: `https://${language}.wikipedia.org/wiki/${encodeURIComponent(title.replaceAll(" ", "_"))}`,
  };
}

function sourceTags(place: NominatimPlace): Pick<OpenStreetMapPlace, "openingHours" | "websiteUrl" | "wikipedia"> {
  const tags = place.extratags && typeof place.extratags === "object" && !Array.isArray(place.extratags)
    ? place.extratags
    : {};
  return {
    openingHours: sourceText(tags.opening_hours, 180),
    websiteUrl: safeHttpUrl(tags.website),
    wikipedia: wikipediaSource(tags.wikipedia),
  };
}

function safeWikipediaArticleUrl(value: unknown, language: string): string | undefined {
  const url = safeHttpUrl(value);
  if (!url) return undefined;
  const parsed = new URL(url);
  return parsed.protocol === "https:" && parsed.hostname === `${language}.wikipedia.org` ? url : undefined;
}

function safeWikimediaThumbnailUrl(value: unknown): string | undefined {
  const url = safeHttpUrl(value);
  if (!url) return undefined;
  const parsed = new URL(url);
  const hostname = parsed.hostname.toLowerCase();
  return parsed.protocol === "https:" && (hostname === "upload.wikimedia.org" || hostname.endsWith(".wikimedia.org"))
    ? url
    : undefined;
}

function wikipediaCacheKey(source: OpenStreetMapWikipediaSource): string {
  return `${source.language}:${source.title}`;
}

function cacheWikipediaArticle(key: string, article: WikimediaPlaceArticle | null): void {
  if (wikipediaArticleCache.size >= MAX_WIKIMEDIA_CACHE_ENTRIES) {
    const oldest = wikipediaArticleCache.keys().next().value;
    if (oldest) wikipediaArticleCache.delete(oldest);
  }
  wikipediaArticleCache.set(key, { expiresAt: Date.now() + WIKIMEDIA_CACHE_TTL_MS, article });
}

async function fetchWikipediaArticle(source: OpenStreetMapWikipediaSource): Promise<WikimediaPlaceArticle | undefined> {
  const key = wikipediaCacheKey(source);
  const cached = wikipediaArticleCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.article ?? undefined;
  if (cached) wikipediaArticleCache.delete(key);

  const endpoint = new URL("/w/api.php", `https://${source.language}.wikipedia.org`);
  endpoint.search = new URLSearchParams({
    action: "query",
    format: "json",
    formatversion: "2",
    redirects: "1",
    prop: "pageimages|info",
    piprop: "thumbnail",
    pithumbsize: "640",
    inprop: "url",
    // Exact title lookup only: intentionally no search/list/generator fallback.
    titles: source.title,
  }).toString();

  let article: WikimediaPlaceArticle | null = null;
  try {
    // This request contains only public source metadata from an OSM tag, never
    // the user's location, booking address, or search text.
    const response = await fetch(endpoint, {
      headers: {
        accept: "application/json",
        "user-agent": "Jarvis owner-operated assistant/1.0 (https://jarvis-orcin-six.vercel.app)",
      },
      signal: AbortSignal.timeout(WIKIMEDIA_TIMEOUT_MS),
    });
    if (response.ok) {
      const payload = await response.json() as { query?: { pages?: WikimediaPage[] } };
      const page = Array.isArray(payload.query?.pages)
        ? payload.query.pages.find((candidate) => candidate && !candidate.missing)
        : undefined;
      if (page) {
        const title = sourceText(page.title, 180) ?? source.title;
        const articleUrl = safeWikipediaArticleUrl(page.fullurl, source.language) ?? source.articleUrl;
        article = {
          title,
          articleUrl,
          thumbnailUrl: safeWikimediaThumbnailUrl(page.thumbnail?.source),
          attribution: `Wikipedia (${source.language}) · image via Wikimedia`,
        };
      }
    }
  } catch {
    // The map stays useful if the optional public source enrichment is slow or unavailable.
  }
  cacheWikipediaArticle(key, article);
  return article ?? undefined;
}

/**
 * Adds a thumbnail only for the exact language:title Wikipedia reference
 * attached to an OSM result. At most four distinct public articles are read.
 */
export async function enrichOpenStreetMapPlacesWithWikimedia(
  places: OpenStreetMapPlace[],
): Promise<OpenStreetMapPlace[]> {
  const sources = new Map<string, OpenStreetMapWikipediaSource>();
  for (const place of places) {
    if (!place.wikipedia || sources.size >= MAX_WIKIMEDIA_ENRICHMENTS) continue;
    const key = wikipediaCacheKey(place.wikipedia);
    if (!sources.has(key)) sources.set(key, place.wikipedia);
  }
  if (!sources.size) return places;

  const resolved = await Promise.all([...sources].map(async ([key, source]) => [
    key,
    await fetchWikipediaArticle(source),
  ] as const));
  const articles = new Map(resolved.filter((entry): entry is readonly [string, WikimediaPlaceArticle] => Boolean(entry[1])));
  return places.map((place) => {
    const article = place.wikipedia ? articles.get(wikipediaCacheKey(place.wikipedia)) : undefined;
    return article ? { ...place, wikipediaArticle: article } : place;
  });
}

/** A keyless, attribution-preserving place lookup for owner-scale use. */
export async function searchOpenStreetMapPlaces(
  query: string,
  options: OpenStreetMapSearchOptions = {},
): Promise<OpenStreetMapPlace[]> {
  const text = String(query ?? "").trim();
  if (!text) return [];
  const maxResults = bounded(options.maxResults, 10, 1, 10);
  const radiusMetres = bounded(options.radiusMetres, 8_000, 250, 50_000);
  const params = new URLSearchParams({
    q: text,
    format: "jsonv2",
    addressdetails: "1",
    namedetails: "1",
    extratags: "1",
    limit: String(maxResults),
  });
  if (options.center) {
    params.set("viewbox", locationViewbox(options.center, radiusMetres));
    params.set("bounded", "1");
  }
  const url = new URL("search", `${NOMINATIM_BASE_URL.replace(/\/$/, "")}/`);
  url.search = params.toString();
  const cacheKey = url.toString();
  const cached = placeCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.places;
  if (cached) placeCache.delete(cacheKey);

  await respectNominatimRateLimit();
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "accept-language": "en",
      // Required by https://operations.osmfoundation.org/policies/nominatim/.
      "user-agent": "Jarvis owner-operated assistant/1.0 (https://jarvis-orcin-six.vercel.app)",
    },
    signal: AbortSignal.timeout(9_000),
  });
  if (!response.ok) throw new Error(`OpenStreetMap lookup failed (${response.status})`);
  const payload = await response.json();
  const places = (Array.isArray(payload) ? payload : []).map((raw: NominatimPlace) => {
    const lat = Number(raw?.lat);
    const lng = Number(raw?.lon);
    const point = { lat, lng };
    return {
      name: placeName(raw).slice(0, 80),
      address: String(raw?.display_name ?? "").slice(0, 180),
      type: String(raw?.type ?? raw?.category ?? "").slice(0, 60) || undefined,
      lat,
      lng,
      dist: options.center && Number.isFinite(lat) && Number.isFinite(lng)
        ? Math.round(openStreetMapDistanceKm(options.center, point) * 10) / 10
        : null,
      mapsUri: Number.isFinite(lat) && Number.isFinite(lng) ? mapUrl(point) : "",
      ...sourceTags(raw),
    } satisfies OpenStreetMapPlace;
  }).filter((place: OpenStreetMapPlace) => Number.isFinite(place.lat) && Number.isFinite(place.lng) && Boolean(place.name))
    .sort((left: OpenStreetMapPlace, right: OpenStreetMapPlace) => (left.dist ?? Infinity) - (right.dist ?? Infinity));

  if (placeCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = placeCache.keys().next().value;
    if (oldest) placeCache.delete(oldest);
  }
  placeCache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, places });
  return places;
}

/** Opens an OSM/OSRM route. Public transit has no equivalent free global router. */
export function openStreetMapDirectionsUrl(args: {
  origin: OpenStreetMapPoint;
  destination: OpenStreetMapPoint;
  mode: "walking" | "driving" | "bicycling" | "transit";
}): string {
  const engine = args.mode === "walking"
    ? "fossgis_osrm_foot"
    : args.mode === "bicycling"
      ? "fossgis_osrm_bike"
      : "fossgis_osrm_car";
  const route = `${args.origin.lat},${args.origin.lng};${args.destination.lat},${args.destination.lng}`;
  return `https://www.openstreetmap.org/directions?engine=${encodeURIComponent(engine)}&route=${encodeURIComponent(route)}`;
}
