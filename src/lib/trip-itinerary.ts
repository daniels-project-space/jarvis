/**
 * Shared, persisted itinerary primitives.  This module deliberately has no
 * server-only dependency: the travel worker writes the document and the Trip
 * workspace renders exactly the same shape.
 */

export const TRIP_TRAVEL_MODES = ["walking", "bicycling", "driving", "transit"] as const;
export type TripTravelMode = (typeof TRIP_TRAVEL_MODES)[number];

export const TRIP_ITINERARY_KINDS = ["flight", "hotel", "transfer", "activity", "booking"] as const;
export type TripItineraryItemKind = (typeof TRIP_ITINERARY_KINDS)[number];

export type TripItineraryItemSource = "generated" | "owner" | "gmail" | "recommendation";

export type TripItineraryItem = {
  /** Stable across reorders so legs, tiles, and a saved mind map stay linked. */
  id: string;
  /**
   * Durable city/base identity for a stop. This is intentionally separate from
   * the human-facing place name: two towns can have same-named venues, and a
   * verified booked stay may only anchor routes inside its own city context.
   */
  cityContextId?: string;
  date: string;
  time?: string;
  durationMinutes?: number;
  title: string;
  kind: TripItineraryItemKind;
  placeId?: string;
  lat?: number;
  lng?: number;
  link?: string;
  note?: string;
  source: TripItineraryItemSource;
  locked?: boolean;
};

export type TripRouteLeg = {
  fromItemId: string;
  toItemId: string;
  durationSeconds: number;
  distanceMeters: number;
};

export type TripDayRoute = {
  mode: TripTravelMode;
  /** stale means the order, timing, or mode changed and needs a fresh route. */
  status: "ready" | "unavailable" | "stale";
  coordinates?: [number, number][];
  durationSeconds?: number;
  distanceMeters?: number;
  legs?: TripRouteLeg[];
  attribution?: string;
  directionsUrl?: string;
  calculatedAt?: number;
};

export type TripItineraryDay = {
  date: string;
  label: string;
  status: "draft" | "locked";
  items: TripItineraryItem[];
  route?: TripDayRoute;
};

const MAX_ROUTE_COORDINATES = 2_000;
const MAX_ITEMS_PER_DAY = 24;
const MAX_DAYS = 45;
const MAX_TITLE = 180;
const MAX_NOTE = 400;

const VALID_SOURCES = new Set<TripItineraryItemSource>(["generated", "owner", "gmail", "recommendation"]);
const VALID_KINDS = new Set<TripItineraryItemKind>(TRIP_ITINERARY_KINDS);
const VALID_MODES = new Set<TripTravelMode>(TRIP_TRAVEL_MODES);

function cleanText(value: unknown, limit: number): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  return Number.isFinite(Date.parse(`${value}T12:00:00Z`));
}

export function isTripTravelMode(value: unknown): value is TripTravelMode {
  return typeof value === "string" && VALID_MODES.has(value as TripTravelMode);
}

export function isTripTime(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{2}:\d{2}$/.test(value)) return false;
  const [hour, minute] = value.split(":").map(Number);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}

function coordinate(value: unknown, max: number): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && Math.abs(number) <= max ? number : undefined;
}

function validUrl(value: unknown): string | undefined {
  const text = cleanText(value, 1_600);
  if (!text) return undefined;
  try {
    const url = new URL(text);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function timeValue(time?: string): number {
  if (!isTripTime(time)) return Number.MAX_SAFE_INTEGER;
  const [hour, minute] = time.split(":").map(Number);
  return hour * 60 + minute;
}

export function stableTripItemId(date: string, kind: string, title: string, ordinal = 0): string {
  const slug = cleanText(title, 96)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 56) || "stop";
  const safeDate = validDate(date) ? date : "undated";
  const safeKind = VALID_KINDS.has(kind as TripItineraryItemKind) ? kind : "booking";
  return `${safeDate}:${safeKind}:${slug}:${Math.max(0, Math.floor(ordinal))}`;
}

export function sortTripItineraryItems(items: TripItineraryItem[]): TripItineraryItem[] {
  return [...items].sort((left, right) => {
    const timeDifference = timeValue(left.time) - timeValue(right.time);
    if (timeDifference) return timeDifference;
    return left.id.localeCompare(right.id);
  });
}

function normalizeItem(raw: any, date: string, ordinal: number): TripItineraryItem | undefined {
  const title = cleanText(raw?.title, MAX_TITLE);
  if (!title) return undefined;
  const kind = VALID_KINDS.has(raw?.kind as TripItineraryItemKind) ? raw.kind as TripItineraryItemKind : "booking";
  const itemDate = validDate(raw?.date) ? raw.date : date;
  const id = cleanText(raw?.id, 180) || stableTripItemId(itemDate, kind, title, ordinal);
  const lat = coordinate(raw?.lat, 90);
  const lng = coordinate(raw?.lng, 180);
  const duration = Number(raw?.durationMinutes);
  const source = VALID_SOURCES.has(raw?.source as TripItineraryItemSource) ? raw.source as TripItineraryItemSource : "generated";
  return {
    id,
    cityContextId: cleanText(raw?.cityContextId, 180) || undefined,
    date: itemDate,
    time: isTripTime(raw?.time) ? raw.time : undefined,
    durationMinutes: Number.isFinite(duration) && duration > 0 && duration <= 1_440 ? Math.round(duration) : undefined,
    title,
    kind,
    placeId: cleanText(raw?.placeId, 180) || undefined,
    lat,
    lng,
    link: validUrl(raw?.link),
    note: cleanText(raw?.note, MAX_NOTE) || undefined,
    source,
    locked: raw?.locked === true || undefined,
  };
}

function normalizeRoute(raw: any, itemIds: Set<string>): TripDayRoute | undefined {
  if (!raw || !isTripTravelMode(raw.mode)) return undefined;
  const status = raw.status === "ready" || raw.status === "unavailable" || raw.status === "stale" ? raw.status : "stale";
  const coordinates: [number, number][] = Array.isArray(raw.coordinates)
    ? raw.coordinates.slice(0, MAX_ROUTE_COORDINATES).flatMap((point: unknown) => {
      if (!Array.isArray(point)) return [];
      const lng = coordinate(point[0], 180);
      const lat = coordinate(point[1], 90);
      return lng == null || lat == null ? [] : [[lng, lat] as [number, number]];
    })
    : [];
  const validMetric = (value: unknown) => {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? Math.round(number) : undefined;
  };
  const legs: TripRouteLeg[] = Array.isArray(raw.legs)
    ? raw.legs.slice(0, MAX_ITEMS_PER_DAY).flatMap((leg: any) => {
      const fromItemId = cleanText(leg?.fromItemId, 180);
      const toItemId = cleanText(leg?.toItemId, 180);
      const durationSeconds = validMetric(leg?.durationSeconds);
      const distanceMeters = validMetric(leg?.distanceMeters);
      if (!fromItemId || !toItemId || !itemIds.has(toItemId) || durationSeconds == null || distanceMeters == null) return [];
      return [{ fromItemId, toItemId, durationSeconds, distanceMeters }];
    })
    : [];
  const durationSeconds = validMetric(raw.durationSeconds);
  const distanceMeters = validMetric(raw.distanceMeters);
  return {
    mode: raw.mode,
    status: status === "ready" && coordinates.length >= 2 && durationSeconds != null && distanceMeters != null ? "ready" : status === "ready" ? "stale" : status,
    coordinates: coordinates.length >= 2 ? coordinates : undefined,
    durationSeconds,
    distanceMeters,
    legs: legs.length ? legs : undefined,
    attribution: cleanText(raw.attribution, 320) || undefined,
    directionsUrl: validUrl(raw.directionsUrl),
    calculatedAt: Number.isFinite(Number(raw.calculatedAt)) ? Number(raw.calculatedAt) : undefined,
  };
}

/**
 * Makes legacy JSON safe to render and bounds the persisted shape.  Existing
 * cards used items without IDs/source, so the normalizer assigns deterministic
 * values instead of dropping historic trips.
 */
export function normalizeTripItinerary(raw: unknown): TripItineraryDay[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_DAYS).flatMap((value: any) => {
    if (!validDate(value?.date)) return [];
    const seen = new Set<string>();
    const items = Array.isArray(value.items)
      ? value.items.slice(0, MAX_ITEMS_PER_DAY).flatMap((item: any, ordinal: number) => {
        const normalized = normalizeItem(item, value.date, ordinal);
        if (!normalized || seen.has(normalized.id)) return [];
        seen.add(normalized.id);
        return [normalized];
      })
      : [];
    const route = normalizeRoute(value.route, seen);
    return [{
      date: value.date,
      label: cleanText(value.label, 80) || value.date,
      status: value.status === "locked" ? "locked" : "draft",
      items: sortTripItineraryItems(items),
      route,
    }];
  });
}

export function routeNeedsRefresh(day: TripItineraryDay, mode?: TripTravelMode): TripItineraryDay {
  return {
    ...day,
    route: {
      mode: mode ?? day.route?.mode ?? "walking",
      status: "stale",
    },
  };
}
