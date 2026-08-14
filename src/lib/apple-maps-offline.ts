import "server-only";

import { createHash } from "node:crypto";

const DAY_MS = 24 * 60 * 60_000;
const DEFAULT_TIME_ZONE = "Europe/London";

export type AppleMapsOfflineFlight = {
  id: string;
  marker?: string;
  kind: string;
  title?: string;
  start?: number;
  allDay?: boolean;
  timeZone?: string;
};

export type AppleMapsOfflinePreflight = {
  city: string;
  flightMarker: string;
  flightTitle: string;
  flightStart: number;
  at: number;
  timeZone: string;
  mapUrl: string;
  sourceKey: string;
  todoText: string;
  reminderText: string;
};

export type AppleMapsOfflinePreflightResult =
  | { status: "ready"; preflight: AppleMapsOfflinePreflight }
  | { status: "needs_flight_confirmation"; reason: string }
  | { status: "too_late"; reason: string };

function cleanCity(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
}

function validTimeZone(value: unknown): string {
  const candidate = String(value ?? "").trim();
  if (!candidate || candidate.length > 80) return DEFAULT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: candidate }).format(0);
    return candidate;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

function dateParts(ms: number, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(ms).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

function previousDate({ year, month, day }: { year: number; month: number; day: number }): { year: number; month: number; day: number } {
  const previous = new Date(Date.UTC(year, month - 1, day) - DAY_MS);
  return { year: previous.getUTCFullYear(), month: previous.getUTCMonth() + 1, day: previous.getUTCDate() };
}

/** Converts a local wall-clock time in an IANA zone to an epoch without relying on server locale. */
function zonedEpoch(parts: { year: number; month: number; day: number; hour: number; minute: number }, timeZone: string): number {
  const target = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  let candidate = target;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const rendered = dateParts(candidate, timeZone);
    const renderedEpoch = Date.UTC(rendered.year, rendered.month - 1, rendered.day, rendered.hour, rendered.minute);
    candidate -= renderedEpoch - target;
  }
  return candidate;
}

function localDateText(ms: number, timeZone: string): string {
  const { year, month, day } = dateParts(ms, timeZone);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function appleMapsCitySearchUrl(city: string): string {
  const url = new URL("https://maps.apple.com/search");
  url.searchParams.set("query", city);
  return url.toString();
}

/**
 * Builds an owner-device handoff one local calendar day before a *confirmed*
 * flight. It deliberately has no download/delete operation: Apple only lets
 * the owner manage offline maps inside Maps on the device.
 */
export function buildAppleMapsOfflinePreflight(input: {
  city: string;
  flights: readonly AppleMapsOfflineFlight[];
  now?: number;
}): AppleMapsOfflinePreflightResult {
  const city = cleanCity(input.city);
  if (!city) return { status: "needs_flight_confirmation", reason: "the trip has no verified destination city" };
  const now = input.now ?? Date.now();
  const flights = input.flights
    .filter((flight) => flight.kind === "flight" && Number.isFinite(flight.start) && Number(flight.start) > now)
    .sort((left, right) => Number(left.start) - Number(right.start));
  const flight = flights[0];
  if (!flight || !Number.isFinite(flight.start)) {
    return { status: "needs_flight_confirmation", reason: "no upcoming confirmed Gmail flight is attached to this exact trip" };
  }

  const timeZone = validTimeZone(flight.timeZone);
  const departure = dateParts(Number(flight.start), timeZone);
  const date = previousDate(departure);
  const time = flight.allDay ? { hour: 9, minute: 0 } : { hour: departure.hour, minute: departure.minute };
  const at = zonedEpoch({ ...date, ...time }, timeZone);
  if (!Number.isFinite(at) || at <= now) {
    return { status: "too_late", reason: "the one-day-before preparation time has already passed" };
  }

  const flightMarker = String(flight.marker || flight.id).slice(0, 240);
  const sourceKey = createHash("sha256")
    .update("jarvis-apple-maps-offline-preflight-v1\0")
    .update(flightMarker)
    .update("\0")
    .update(city.toLocaleLowerCase("en-GB"))
    .digest("hex");
  const flightDate = localDateText(Number(flight.start), timeZone);
  const title = String(flight.title || "confirmed flight").replace(/\s+/g, " ").trim().slice(0, 120);
  const task = `Apple Maps offline · ${city} · before flight ${flightDate}`;
  return {
    status: "ready",
    preflight: {
      city,
      flightMarker,
      flightTitle: title || "confirmed flight",
      flightStart: Number(flight.start),
      at,
      timeZone,
      mapUrl: appleMapsCitySearchUrl(city),
      sourceKey,
      todoText: `${task}. Open Maps, download ${city}, then remove the old unused map in Maps > Offline Maps (or enable Optimize Storage).`,
      reminderText: `${task}. Open the Apple Maps handoff, download ${city} for offline use, then remove an old unused offline map in Maps.`,
    },
  };
}
