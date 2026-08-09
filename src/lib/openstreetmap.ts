/**
 * Owner-scale OpenStreetMap place lookup. The public Nominatim instance is a
 * shared community service, so this adapter deliberately serialises uncached
 * requests to below its one-request-per-second policy and keeps a tiny cache.
 * Move `NOMINATIM_BASE_URL` to a self-hosted instance before serving multiple
 * people or high-volume traffic.
 */

export type OpenStreetMapPoint = { lat: number; lng: number };

export type OpenStreetMapPlace = OpenStreetMapPoint & {
  name: string;
  address: string;
  type?: string;
  dist: number | null;
  mapsUri: string;
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
};

const NOMINATIM_BASE_URL = process.env.NOMINATIM_BASE_URL?.trim() || "https://nominatim.openstreetmap.org";
const NOMINATIM_MIN_INTERVAL_MS = process.env.NODE_ENV === "test" ? 0 : 1_100;
const CACHE_TTL_MS = 5 * 60_000;
const MAX_CACHE_ENTRIES = 160;
const placeCache = new Map<string, { expiresAt: number; places: OpenStreetMapPlace[] }>();
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
