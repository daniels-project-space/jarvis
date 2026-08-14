/**
 * The location row is deliberately a last-known position, not a location
 * history. These helpers make its freshness explicit at every caller so an
 * old browser tab cannot masquerade as where Daniel is now.
 */
export const LIVE_DEVICE_LOCATION_MAX_AGE_MS = 15 * 60_000;
export const CURRENT_LOCATION_MAX_AGE_MS = 12 * 60 * 60_000;
export const LIVE_LOCATION_MIN_REPORT_INTERVAL_MS = 90_000;
export const LIVE_LOCATION_HEARTBEAT_MS = 5 * 60_000;
export const LIVE_LOCATION_MIN_MOVE_METRES = 40;

export type StoredLocationRow = {
  value?: unknown;
  updatedAt?: unknown;
  title?: unknown;
};

export type StoredCurrentLocationRow = {
  value?: unknown;
  observedAt?: unknown;
};

export type FreshDeviceLocation = {
  lat: number;
  lng: number;
  updatedAt: number;
  label?: string;
};

export type FreshCurrentLocation = {
  value: string;
  observedAt: number;
};

export type LocationFreshness = "missing" | "invalid" | "stale" | "fresh";

export function isValidLocationCoordinate(lat: number, lng: number) {
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

function parsedCoordinates(value: unknown): { lat: number; lng: number } | undefined {
  const parts = String(value ?? "").split(",");
  if (parts.length !== 2 || !parts[0]?.trim() || !parts[1]?.trim()) return undefined;
  const lat = Number(parts[0]);
  const lng = Number(parts[1]);
  return isValidLocationCoordinate(lat, lng) ? { lat, lng } : undefined;
}

function freshTimestamp(value: unknown, now: number, maxAgeMs: number) {
  const timestamp = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(timestamp) || timestamp <= 0 || timestamp > now) return undefined;
  return now - timestamp <= maxAgeMs ? timestamp : undefined;
}

export function deviceLocationFreshness(row: StoredLocationRow | null | undefined, now = Date.now()): LocationFreshness {
  if (!row?.value) return "missing";
  if (!parsedCoordinates(row.value)) return "invalid";
  const updatedAt = typeof row.updatedAt === "number" ? row.updatedAt : Number.NaN;
  if (!Number.isFinite(updatedAt) || updatedAt <= 0 || updatedAt > now) return "invalid";
  return now - updatedAt <= LIVE_DEVICE_LOCATION_MAX_AGE_MS ? "fresh" : "stale";
}

export function freshDeviceLocation(row: StoredLocationRow | null | undefined, now = Date.now()): FreshDeviceLocation | undefined {
  if (!row) return undefined;
  const coordinates = parsedCoordinates(row.value);
  const updatedAt = freshTimestamp(row.updatedAt, now, LIVE_DEVICE_LOCATION_MAX_AGE_MS);
  if (!coordinates || !updatedAt) return undefined;
  const label = typeof row.title === "string" && row.title.trim() ? row.title.trim().slice(0, 160) : undefined;
  return { ...coordinates, updatedAt, label };
}

export function freshCurrentLocation(row: StoredCurrentLocationRow | null | undefined, now = Date.now()): FreshCurrentLocation | undefined {
  const value = typeof row?.value === "string" ? row.value.trim() : "";
  const observedAt = freshTimestamp(row?.observedAt, now, CURRENT_LOCATION_MAX_AGE_MS);
  return value && observedAt ? { value, observedAt } : undefined;
}

export type LiveLocationSample = {
  lat: number;
  lng: number;
  capturedAt: number;
};

export type ReportedLiveLocation = {
  lat: number;
  lng: number;
  sentAt: number;
};

export function distanceBetweenLocationMetres(from: Pick<LiveLocationSample, "lat" | "lng">, to: Pick<LiveLocationSample, "lat" | "lng">) {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const latitudeDelta = radians(to.lat - from.lat);
  const longitudeDelta = radians(to.lng - from.lng);
  const a = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(radians(from.lat)) * Math.cos(radians(to.lat)) * Math.sin(longitudeDelta / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Bound browser watch traffic while still refreshing a stationary position. */
export function shouldPersistLiveLocation(previous: ReportedLiveLocation | null | undefined, next: LiveLocationSample) {
  if (!isValidLocationCoordinate(next.lat, next.lng) || !Number.isFinite(next.capturedAt)) return false;
  if (!previous) return true;
  const elapsed = next.capturedAt - previous.sentAt;
  if (!Number.isFinite(elapsed) || elapsed < 0) return true;
  if (elapsed < LIVE_LOCATION_MIN_REPORT_INTERVAL_MS) return false;
  return elapsed >= LIVE_LOCATION_HEARTBEAT_MS
    || distanceBetweenLocationMetres(previous, next) >= LIVE_LOCATION_MIN_MOVE_METRES;
}
