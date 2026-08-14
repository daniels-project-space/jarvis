import "server-only";
import { convexMutation, convexQuery } from "./context";
import type { ConfirmedBooking } from "./booking-email";
import { openStreetMapDirectionsUrl, routeOpenStreetMapItinerary, searchOpenStreetMapPlaces } from "./openstreetmap";
import {
  isTripTime,
  isTripTravelMode,
  normalizeTripItinerary,
  routeNeedsRefresh,
  sortTripItineraryItems,
  stableTripItemId,
  type TripDayRoute,
  type TripItineraryDay,
  type TripItineraryItem,
  type TripTravelMode,
} from "./trip-itinerary";

// JARVIS travel engine — drives the SAME infrastructure the project-hub travel
// widget already proved out (its public Convex actions: hotel and flight search)
// plus an owner-scale OpenStreetMap place-search adapter.
// One orchestrated scout call fans out to every provider in parallel; the trip
// lives as a `creations` row (kind "trip") that the interactive globe panel
// reads reactively and the brain edits with trip_update / trip_finalize.

const HUB = "https://fantastic-roadrunner-485.convex.cloud";

export async function hubAction(path: string, args: unknown): Promise<any> {
  const r = await fetch(`${HUB}/api/action`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, args, format: "json" }),
  });
  const j = await r.json();
  if (j.status === "error") throw new Error(j.errorMessage ?? `${path} failed`);
  return j.value;
}

const METRO: Record<string, string> = {
  LON: "LHR", NYC: "JFK", PAR: "CDG", TYO: "NRT", MIL: "MXP", ROM: "FCO",
  STO: "ARN", CHI: "ORD", WAS: "IAD", SAO: "GRU", BUE: "EZE",
};
const fixIata = (c: string) => METRO[c.toUpperCase().trim()] ?? c.toUpperCase().trim();

export type TripFlight = {
  airline?: string;
  priceGbp?: number;
  durationMin?: number;
  stops?: number;
  from?: string;
  to?: string;
  departTime?: string;
  arriveTime?: string;
  bookLink?: string;
  airlineLogo?: string;
  roundTrip?: boolean;
};
export type TripStay = {
  name: string;
  priceGbp?: number;
  totalGbp?: number;
  rating?: number;
  hotelClass?: number;
  propertyType?: string;
  freeCancellation?: boolean;
  amenities?: string[];
  image?: string;
  thumb?: string;
  lat?: number;
  lng?: number;
  link?: string;
  googleLink?: string;
};
export type TripActivity = {
  name: string;
  rating?: number;
  ratings?: number;
  lat?: number;
  lng?: number;
  mapsLink: string;
  photo?: string;
  address?: string;
};
export type TripProviderState = {
  status: "queued" | "searching" | "ready" | "error" | "skipped";
  source: string;
  count?: number;
  checkedAt?: number;
  error?: string;
};
export type { TripDayRoute, TripItineraryDay, TripItineraryItem, TripTravelMode } from "./trip-itinerary";
export type TripDoc = {
  kind: "trip";
  title: string;
  destination: string;
  destIata: string;
  origin: string;
  departDate: string;
  returnDate: string;
  adults: number;
  budgetGbp: number;
  vibe?: string;
  status: "scouting" | "planned";
  threadId?: string;
  center: { lat: number; lng: number };
  airport?: { name: string; lat: number; lng: number };
  flights: TripFlight[];
  stays: TripStay[];
  activities: TripActivity[];
  locked: { flight?: TripFlight; returnFlight?: TripFlight; stay?: TripStay; activities: string[] };
  transfer?: { durationText: string; distanceText: string; mode: string; fareText?: string };
  /** Ordered source-backed days shared by the globe, map overlay, and saved plan. */
  itinerary?: TripItineraryDay[];
  /** Monotonic version used to reject late route results after a day was edited. */
  planRevision?: number;
  /** Persistent canvas created on finalization, so the saved plan can reopen it. */
  mindmapCreationId?: string;
  timeZone?: string;
  totals?: { flights: number; stay: number; activitiesEst: number; total: number; projectedTotal?: number; lockedTotal?: number };
  providers?: Record<"flights" | "stays" | "activities" | "airport", TripProviderState>;
  searchCompletedAt?: number;
  calendarSyncedAt?: number;
  includeFlights?: boolean;
  // Read-only Gmail confirmations are distilled into structured trip facts;
  // raw email bodies and OAuth data never enter the trip document.
  confirmedBookings?: ConfirmedBooking[];
};

export async function placesActivities(destination: string, vibe?: string, limit = 14): Promise<TripActivity[]> {
  // The adapter serialises public Nominatim requests and never invents the
  // ratings, hours, or photos its public data source does not provide.
  const queries = [`attractions in ${destination}`];
  if (vibe) queries.push(`${vibe} in ${destination}`);
  const seen = new Set<string>();
  const out: TripActivity[] = [];
  for (const query of queries) {
    // The provider serialises public Nominatim requests to respect its policy.
    const places = await searchOpenStreetMapPlaces(query, { maxResults: Math.min(10, limit) }).catch(() => []);
    for (const place of places) {
      const identity = `${place.name}\u0000${place.lat}\u0000${place.lng}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      out.push({
        name: place.name.slice(0, 70),
        lat: place.lat,
        lng: place.lng,
        address: place.address.slice(0, 100) || undefined,
        mapsLink: place.mapsUri,
      });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

async function findAirport(destIata: string, destination: string): Promise<TripDoc["airport"]> {
  const place = (await searchOpenStreetMapPlaces(`${destIata} airport ${destination}`, { maxResults: 1 }).catch(() => []))[0];
  return place ? { name: place.name.slice(0, 60), lat: place.lat, lng: place.lng } : undefined;
}

export function tripTotals(doc: TripDoc): TripDoc["totals"] {
  const nights = Math.max(1, Math.round((Date.parse(doc.returnDate) - Date.parse(doc.departDate)) / 86_400_000));
  const flights = (doc.locked.flight?.priceGbp ?? doc.flights[0]?.priceGbp ?? 0) * doc.adults;
  const projectedStay = doc.locked.stay ?? doc.stays[0];
  const stay = projectedStay?.totalGbp ?? (projectedStay?.priceGbp ?? 0) * nights;
  const activitiesEst = doc.locked.activities.length * 25 * doc.adults;
  const lockedFlights = (doc.locked.flight?.priceGbp ?? 0) * doc.adults;
  const lockedStay = doc.locked.stay?.totalGbp ?? (doc.locked.stay?.priceGbp ?? 0) * nights;
  return {
    flights: Math.round(flights),
    stay: Math.round(stay),
    activitiesEst,
    total: Math.round(flights + stay + activitiesEst),
    projectedTotal: Math.round(flights + stay + activitiesEst),
    lockedTotal: Math.round(lockedFlights + lockedStay + activitiesEst),
  };
}

// Spawn the globe the moment trip talk starts: a skeleton trip doc centred on
// the destination (city geocode + airport marker), populated live by trip_plan.
export async function openTrip(a: {
  destination: string;
  destIata?: string;
  departDate?: string;
  returnDate?: string;
  /** Reopening is explicit; a same-city plan must never be guessed globally. */
  reuseExisting?: boolean;
}): Promise<{ id: string; doc: TripDoc }> {
  const destIata = a.destIata ? fixIata(a.destIata) : "";
  const normalized = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
  const [threadId, existingRows, geocode, airport] = await Promise.all([
    convexQuery("ui:getActiveThread", {}).then((value) => (typeof value === "string" && value ? value : "main")),
    a.reuseExisting ? convexQuery("creations:list", { kind: "trip", limit: 30 }).catch(() => []) : Promise.resolve([]),
    fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(a.destination)}&count=1&language=en`, {
      signal: AbortSignal.timeout(6000),
    })
      .then((response) => response.json())
      .catch(() => null),
    destIata ? findAirport(destIata, a.destination) : Promise.resolve(undefined),
  ]);
  for (const row of Array.isArray(existingRows) ? existingRows : []) {
    try {
      const existing = JSON.parse(row.data ?? "") as TripDoc;
      if (
        a.reuseExisting &&
        normalized(existing.destination) === normalized(a.destination) &&
        existing.threadId === threadId &&
        (!a.departDate || existing.departDate === a.departDate) &&
        (!a.returnDate || existing.returnDate === a.returnDate) &&
        Date.now() - Number(row.updatedAt ?? 0) < 30 * 86_400_000
      ) {
        await convexMutation("ui:setPanel", {
          type: "trip",
          value: JSON.stringify({ creationId: String(row._id) }),
          title: `trip · ${existing.title}`,
        });
        return { id: String(row._id), doc: existing };
      }
    } catch {
      /* ignore malformed historical rows */
    }
  }
  let center = { lat: 41.39, lng: 2.17 };
  if ((geocode as any)?.results?.[0]) center = { lat: (geocode as any).results[0].latitude, lng: (geocode as any).results[0].longitude };
  const doc: TripDoc = {
    kind: "trip",
    title: `${a.destination} · planning`,
    destination: a.destination,
    destIata,
    origin: "LHR",
    departDate: "",
    returnDate: "",
    adults: 2,
    budgetGbp: 0,
    status: "scouting",
    includeFlights: undefined,
    threadId,
    center,
    airport,
    flights: [],
    stays: [],
    activities: [],
    locked: { activities: [] },
    providers: {
      flights: { status: "queued", source: "Google Flights" },
      stays: { status: "queued", source: "Google Hotels" },
      activities: { status: "queued", source: "OpenStreetMap" },
      airport: { status: airport ? "ready" : "queued", source: "OpenStreetMap", count: airport ? 1 : 0, checkedAt: airport ? Date.now() : undefined },
    },
  };
  const id = await convexMutation("creations:create", { kind: "trip", title: doc.title, data: JSON.stringify(doc) });
  await convexMutation("ui:setPanel", { type: "trip", value: JSON.stringify({ creationId: String(id) }), title: `trip · ${a.destination}` });
  return { id: String(id), doc };
}

// Progressive scout: the workspace appears immediately, and each provider
// patches the same trip atomically as soon as it returns.
export async function scoutTrip(a: {
  destination: string;
  destIata: string;
  origin: string;
  departDate: string;
  returnDate: string;
  adults: number;
  budgetGbp: number;
  vibe?: string;
  maxPricePerNight?: number;
  vacationRentals?: boolean;
  includeFlights?: boolean; // Daniel doesn't always fly — never assume
  reuseId?: string; // populate the already-open globe instead of spawning a new doc
}): Promise<{ id: string; doc: TripDoc }> {
  const nights = Math.max(1, Math.round((Date.parse(a.returnDate) - Date.parse(a.departDate)) / 86_400_000));
  // Budget shaping: stays get ~45% of total budget unless caller overrides.
  const perNightCap = a.maxPricePerNight ?? Math.max(30, Math.round((a.budgetGbp * 0.45) / nights));
  const origin = fixIata(a.origin);
  const destIata = fixIata(a.destIata);

  let id = a.reuseId;
  let prior: TripDoc | undefined;
  if (id) {
    const row: any = await convexQuery("creations:get", { id }).catch(() => null);
    try {
      prior = row?.data ? JSON.parse(row.data) : undefined;
    } catch {
      prior = undefined;
    }
  }
  if (!id) {
    const opened = await openTrip({ destination: a.destination, destIata, departDate: a.departDate, returnDate: a.returnDate });
    id = opened.id;
    prior = opened.doc;
  }
  if (!id) throw new Error("Trip workspace could not be created");
  const creationId = id;
  const threadId = prior?.threadId || ((await convexQuery("ui:getActiveThread", {})) as string) || "main";
  const preservePlan = Boolean(prior && prior.departDate === a.departDate && prior.returnDate === a.returnDate);
  const doc: TripDoc = {
    kind: "trip",
    title: `${a.destination} · ${a.departDate.slice(5)} → ${a.returnDate.slice(5)}`,
    destination: a.destination,
    destIata,
    origin,
    departDate: a.departDate,
    returnDate: a.returnDate,
    adults: a.adults,
    budgetGbp: a.budgetGbp,
    vibe: a.vibe,
    status: preservePlan && prior?.status === "planned" ? "planned" : "scouting",
    includeFlights: a.includeFlights !== false,
    threadId,
    center: prior?.center ?? { lat: 41.39, lng: 2.17 },
    airport: prior?.airport,
    flights: [],
    stays: [],
    activities: [],
    locked: preservePlan ? prior?.locked ?? { activities: [] } : { activities: [] },
    transfer: preservePlan ? prior?.transfer : undefined,
    itinerary: preservePlan ? prior?.itinerary : undefined,
    planRevision: preservePlan ? prior?.planRevision : undefined,
    mindmapCreationId: preservePlan ? prior?.mindmapCreationId : undefined,
    confirmedBookings: preservePlan ? prior?.confirmedBookings : undefined,
    providers: {
      flights: { status: a.includeFlights === false ? "skipped" : "searching", source: "Google Flights", checkedAt: a.includeFlights === false ? Date.now() : undefined },
      stays: { status: "searching", source: "Google Hotels" },
      activities: { status: "searching", source: "OpenStreetMap" },
      airport: { status: "searching", source: "OpenStreetMap" },
    },
  };
  doc.totals = tripTotals(doc);
  await convexMutation("creations:update", { id: creationId, title: doc.title, data: JSON.stringify(doc) });
  await convexMutation("ui:setPanel", { type: "trip", value: JSON.stringify({ creationId }), title: `trip · ${doc.title}` });
  await convexMutation("chatQueue:postCard", {
    threadId,
    type: "trip",
    value: JSON.stringify({ creationId }),
    title: `trip · ${doc.title}`,
  }).catch(() => {});

  const updateProvider = async (
    provider: "flights" | "stays" | "activities" | "airport",
    source: string,
    task: () => Promise<any>,
    select: (result: any) => any,
  ) => {
    try {
      const result = await task();
      const items = select(result);
      const available = result?.available !== false && (provider !== "airport" || Boolean(items));
      await convexMutation("creations:updateTripProvider", {
        id: creationId,
        provider,
        status: available ? "ready" : "error",
        source,
        items,
        error: available ? undefined : String(result?.reason ?? `${source} returned no airport`).slice(0, 300),
      });
    } catch (error: any) {
      await convexMutation("creations:updateTripProvider", {
        id: creationId,
        provider,
        status: "error",
        source,
        error: String(error?.message ?? error).slice(0, 300),
      }).catch(() => {});
    }
  };

  const searchStaysProgressively = async () => {
    const base = {
      query: `${a.destination} hotels`,
      checkIn: a.departDate,
      checkOut: a.returnDate,
      adults: a.adults,
      maxPricePerNight: perNightCap,
      vacationRentals: a.vacationRentals ?? false,
    };
    try {
      const first = await hubAction("travelActions:searchStays", { ...base, maxPages: 1 });
      if (first?.available === false) {
        await convexMutation("creations:updateTripProvider", {
          id: creationId,
          provider: "stays",
          status: "error",
          source: "Google Hotels",
          error: String(first?.reason ?? "No stays returned").slice(0, 300),
        });
        return;
      }
      const initial = (first?.options ?? []).slice(0, 16) as TripStay[];
      await convexMutation("creations:updateTripProvider", {
        id: creationId,
        provider: "stays",
        status: "ready",
        source: "Google Hotels · first page",
        items: initial,
      });
      if (!first?.nextPageToken) return;
      await convexMutation("creations:updateTripProvider", {
        id: creationId,
        provider: "stays",
        status: "searching",
        source: "Google Hotels · enriching",
      });
      const more = await hubAction("travelActions:searchStays", {
        ...base,
        maxPages: 2,
        pageToken: first.nextPageToken,
      });
      const merged = [...initial, ...((more?.options ?? []) as TripStay[])]
        .filter((stay, index, all) => all.findIndex((candidate) => candidate.name === stay.name) === index)
        .slice(0, 36);
      await convexMutation("creations:updateTripProvider", {
        id: creationId,
        provider: "stays",
        status: "ready",
        source: "Google Hotels · 3 pages",
        items: merged,
        error: more?.available === false ? String(more?.reason ?? "Enrichment stopped").slice(0, 300) : undefined,
      });
    } catch (error: any) {
      await convexMutation("creations:updateTripProvider", {
        id: creationId,
        provider: "stays",
        status: "error",
        source: "Google Hotels",
        error: String(error?.message ?? error).slice(0, 300),
      }).catch(() => {});
    }
  };

  const work: Promise<void>[] = [
    searchStaysProgressively(),
    updateProvider("activities", "OpenStreetMap", () => placesActivities(a.destination, a.vibe), (result) => result ?? []),
    updateProvider("airport", "OpenStreetMap", () => findAirport(destIata, a.destination), (result) => result),
  ];
  if (a.includeFlights !== false)
    work.push(
      updateProvider(
        "flights",
        "Google Flights",
        () =>
          hubAction("travelActions:searchFlights", {
            origin,
            destination: destIata,
            outboundDate: a.departDate,
            returnDate: a.returnDate,
            adults: a.adults,
          }),
        (result) =>
          ((result?.options ?? []).slice(0, 8) as TripFlight[]).map((flight) => ({ ...flight, roundTrip: Boolean(a.returnDate) })),
      ),
    );
  await Promise.allSettled(work);
  const finalRow: any = await convexQuery("creations:get", { id: creationId }).catch(() => null);
  let finalDoc = doc;
  try {
    if (finalRow?.data) finalDoc = JSON.parse(finalRow.data);
  } catch {
    /* return the shell */
  }
  return { id: creationId, doc: finalDoc };
}

export async function latestTrip(): Promise<{ id: string; doc: TripDoc } | null> {
  const row: any = await convexQuery("creations:latest", { kind: "trip" });
  if (!row?.data) return null;
  try {
    return { id: String(row._id), doc: JSON.parse(row.data) };
  } catch {
    return null;
  }
}

export async function getTrip(id: string): Promise<{ id: string; doc: TripDoc } | null> {
  const row: any = await convexQuery("creations:get", { id }).catch(() => null);
  if (!row?.data || row.kind !== "trip") return null;
  try {
    return { id: String(row._id), doc: JSON.parse(row.data) };
  } catch {
    return null;
  }
}

export async function saveTrip(id: string, doc: TripDoc, showPanel = true): Promise<void> {
  doc.totals = tripTotals(doc);
  await convexMutation("creations:update", { id, title: doc.title, data: JSON.stringify(doc) });
  if (showPanel)
    await convexMutation("ui:setPanel", { type: "trip", value: JSON.stringify({ creationId: id }), title: `trip · ${doc.title}` });
}

function bookingDate(booking: ConfirmedBooking): string | undefined {
  if (!booking.start) return undefined;
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: booking.timeZone || "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(booking.start);
    const year = parts.find((part) => part.type === "year")?.value;
    const month = parts.find((part) => part.type === "month")?.value;
    const day = parts.find((part) => part.type === "day")?.value;
    return year && month && day ? `${year}-${month}-${day}` : undefined;
  } catch {
    return new Date(booking.start).toISOString().slice(0, 10);
  }
}

function bookingTime(booking: ConfirmedBooking): string | undefined {
  if (booking.allDay || !booking.start) return undefined;
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: booking.timeZone || "UTC",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(booking.start);
    const hour = parts.find((part) => part.type === "hour")?.value;
    const minute = parts.find((part) => part.type === "minute")?.value;
    return hour && minute && isTripTime(`${hour}:${minute}`) ? `${hour}:${minute}` : undefined;
  } catch {
    return undefined;
  }
}

function activityForItem(doc: TripDoc, item: TripItineraryItem): TripActivity | undefined {
  return doc.activities.find((activity) => activity.name === item.placeId || activity.name === item.title);
}

function itemCoordinates(doc: TripDoc, item: TripItineraryItem): { lat: number; lng: number } | undefined {
  if (Number.isFinite(item.lat) && Number.isFinite(item.lng)) return { lat: Number(item.lat), lng: Number(item.lng) };
  const activity = activityForItem(doc, item);
  if (Number.isFinite(activity?.lat) && Number.isFinite(activity?.lng)) return { lat: Number(activity?.lat), lng: Number(activity?.lng) };
  if (item.kind === "hotel" && Number.isFinite(doc.locked.stay?.lat) && Number.isFinite(doc.locked.stay?.lng)) {
    return { lat: Number(doc.locked.stay?.lat), lng: Number(doc.locked.stay?.lng) };
  }
  return undefined;
}

function defaultActivityItems(doc: TripDoc, date: string, pool: TripActivity[], offset: number): TripItineraryItem[] {
  return ["10:00", "14:30"].flatMap((time, index) => {
    const activity = pool[offset + index];
    if (!activity) return [];
    return [{
      id: stableTripItemId(date, "activity", activity.name, index),
      date,
      time,
      durationMinutes: 90,
      title: activity.name,
      kind: "activity" as const,
      placeId: activity.name,
      lat: Number.isFinite(activity.lat) ? activity.lat : undefined,
      lng: Number.isFinite(activity.lng) ? activity.lng : undefined,
      link: activity.mapsLink,
      note: activity.rating ? `★ ${activity.rating}` : "Suggested time",
      source: "recommendation" as const,
    }];
  });
}

/**
 * Builds a durable, backward-compatible skeleton. Existing owner-edited or
 * locked days are retained, while unplanned days get clearly marked suggested
 * slots. Route data is never faked here: edits mark it stale until refreshed.
 */
export function buildItinerary(doc: TripDoc): TripItineraryDay[] {
  const existing = new Map(normalizeTripItinerary(doc.itinerary).map((day) => [day.date, day]));
  const f = doc.locked.flight;
  const returnFlight = doc.locked.returnFlight;
  const stay = doc.locked.stay;
  const picked = doc.activities.filter((activity) => doc.locked.activities.includes(activity.name));
  const pool = picked.length ? picked : doc.activities.slice(0, 8);
  const nights = Math.max(1, Math.round((Date.parse(doc.returnDate) - Date.parse(doc.departDate)) / 86_400_000));
  const days: TripItineraryDay[] = [];
  let activityOffset = 0;

  for (let index = 0; index <= nights; index++) {
    const date = addDays(doc.departDate, index);
    const prior = existing.get(date);
    const hasOwnerItems = Boolean(prior?.status === "locked" || prior?.items.some((item) => item.source === "owner" || item.locked));
    const items = prior?.items.map((item) => ({ ...item, date })) ?? [];

    for (const booking of doc.confirmedBookings ?? []) {
      if (bookingDate(booking) !== date) continue;
      const id = `gmail:${booking.marker}`.slice(0, 180);
      if (items.some((item) => item.id === id)) continue;
      items.push({
        id,
        date,
        time: bookingTime(booking),
        title: booking.title,
        kind: booking.kind === "stay" ? "hotel" : booking.kind === "activity" ? "activity" : "booking",
        link: booking.sourceUrl,
        note: `Confirmed${booking.confirmationCode ? ` · ref ${booking.confirmationCode}` : ""}`,
        source: "gmail",
        locked: true,
      });
    }

    if (!hasOwnerItems) {
      if (index === 0) {
        if (f && !items.some((item) => item.id === "flight-out")) {
          items.push({
            id: "flight-out",
            date,
            time: hhmm(f.departTime) || undefined,
            title: `Flight ${doc.origin} → ${doc.destIata} (${f.airline ?? "flight"})`,
            kind: "flight",
            link: f.bookLink,
            note: f.arriveTime ? `lands ${hhmm(f.arriveTime)}` : undefined,
            source: "generated",
            locked: true,
          });
        }
        if (doc.transfer && stay && !items.some((item) => item.id === "arrival-transfer")) {
          items.push({
            id: "arrival-transfer",
            date,
            title: `Transfer to ${stay.name}`,
            kind: "transfer",
            note: `${doc.transfer.durationText} · ${doc.transfer.distanceText}`,
            source: "generated",
          });
        }
        if (stay && !items.some((item) => item.id === "check-in")) {
          items.push({
            id: "check-in",
            date,
            time: "15:00",
            title: `Check in — ${stay.name}`,
            kind: "hotel",
            lat: stay.lat,
            lng: stay.lng,
            link: stay.link,
            source: "generated",
            locked: true,
          });
        }
      } else if (index === nights) {
        if (stay && !items.some((item) => item.id === "check-out")) {
          items.push({
            id: "check-out",
            date,
            time: "11:00",
            title: `Check out — ${stay.name}`,
            kind: "hotel",
            lat: stay.lat,
            lng: stay.lng,
            source: "generated",
            locked: true,
          });
        }
        if (doc.transfer && !items.some((item) => item.id === "departure-transfer")) {
          items.push({
            id: "departure-transfer",
            date,
            title: `Transfer to ${doc.airport?.name ?? doc.destIata}`,
            kind: "transfer",
            note: `${doc.transfer.durationText} · ${doc.transfer.distanceText}`,
            source: "generated",
          });
        }
        if (returnFlight && !items.some((item) => item.id === "flight-home")) {
          items.push({
            id: "flight-home",
            date,
            time: hhmm(returnFlight.departTime) || undefined,
            title: `Flight ${doc.destIata} → ${doc.origin} (${returnFlight.airline ?? "flight"})`,
            kind: "flight",
            link: returnFlight.bookLink,
            note: returnFlight.arriveTime ? `lands ${hhmm(returnFlight.arriveTime)}` : undefined,
            source: "generated",
            locked: true,
          });
        }
      } else if (!items.some((item) => item.kind === "activity")) {
        const additions = defaultActivityItems(doc, date, pool, activityOffset);
        activityOffset += additions.length;
        items.push(...additions);
      }
    }

    const next: TripItineraryDay = {
      date,
      label: dayLabel(date),
      status: prior?.status === "locked" ? "locked" : "draft",
      items: sortTripItineraryItems(items),
      route: prior?.route,
    };
    days.push(prior?.route?.status === "ready" && !hasOwnerItems ? routeNeedsRefresh(next) : next);
  }
  return days;
}

function routeItemsForDay(doc: TripDoc, day: TripItineraryDay): Array<{ item: TripItineraryItem; lat: number; lng: number }> {
  const stops = day.items.flatMap((item) => {
    const point = itemCoordinates(doc, item);
    return point ? [{ item, ...point }] : [];
  });
  // On a free day the hotel is an implicit first stop: it gives the map a
  // real first-mile leg without inventing a fake visible activity tile.
  if (
    stops.length &&
    !stops.some((stop) => stop.item.kind === "hotel") &&
    Number.isFinite(doc.locked.stay?.lat) &&
    Number.isFinite(doc.locked.stay?.lng)
  ) {
    stops.unshift({
      item: {
        id: `stay:${day.date}`,
        date: day.date,
        title: doc.locked.stay?.name ?? "Booked stay",
        kind: "hotel",
        lat: Number(doc.locked.stay?.lat),
        lng: Number(doc.locked.stay?.lng),
        source: "generated",
      },
      lat: Number(doc.locked.stay?.lat),
      lng: Number(doc.locked.stay?.lng),
    });
  }
  return stops;
}

/** Gets honest OSRM geometry for one ordered day, or records it as unavailable. */
export async function refreshTripDayRoute(doc: TripDoc, day: TripItineraryDay, mode: TripTravelMode): Promise<TripItineraryDay> {
  const stops = routeItemsForDay(doc, day);
  if (stops.length < 2 || mode === "transit") {
    return { ...day, route: { mode, status: "unavailable", calculatedAt: Date.now() } };
  }
  const route = await routeOpenStreetMapItinerary({ points: stops.map(({ lat, lng }) => ({ lat, lng })), mode });
  if (!route) return { ...day, route: { mode, status: "unavailable", calculatedAt: Date.now() } };
  const legs = route.legs.map((leg, index) => ({
    fromItemId: stops[index].item.id,
    toItemId: stops[index + 1].item.id,
    durationSeconds: leg.durationSeconds,
    distanceMeters: leg.distanceMeters,
  }));
  const directionsUrl = openStreetMapDirectionsUrl({
    origin: { lat: stops[0].lat, lng: stops[0].lng },
    destination: { lat: stops[stops.length - 1].lat, lng: stops[stops.length - 1].lng },
    waypoints: stops.slice(1, -1).map(({ lat, lng }) => ({ lat, lng })),
    mode,
  });
  const dayRoute: TripDayRoute = {
    mode,
    status: "ready",
    coordinates: route.coordinates,
    durationSeconds: route.durationSeconds,
    distanceMeters: route.distanceMeters,
    legs,
    attribution: route.attribution,
    directionsUrl,
    calculatedAt: Date.now(),
  };
  return { ...day, route: dayRoute };
}

export async function saveTripItinerary(id: string, doc: TripDoc, itinerary: TripItineraryDay[], mindmapCreationId?: string): Promise<TripDoc> {
  const normalized = normalizeTripItinerary(itinerary);
  const planRevision = Math.max(0, Number(doc.planRevision) || 0) + 1;
  const result: any = await convexMutation("creations:updateTripItinerary", {
    id,
    itinerary: JSON.stringify(normalized),
    planRevision,
    mindmapCreationId,
  });
  if (!result?.ok) {
    if (result?.reason === "stale") throw new Error("This trip changed while its route was being refreshed. Please try that day again.");
    throw new Error("Trip itinerary could not be saved.");
  }
  return { ...doc, itinerary: normalized, planRevision, mindmapCreationId: mindmapCreationId ?? doc.mindmapCreationId };
}

export async function scheduleTripDay(args: {
  id: string;
  doc: TripDoc;
  date: string;
  activityNames?: string[];
  times?: string[];
  mode?: TripTravelMode;
  lock?: boolean;
}): Promise<TripDoc> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.date)) throw new Error("Use a specific itinerary date (YYYY-MM-DD).");
  const itinerary = buildItinerary(args.doc);
  const dayIndex = itinerary.findIndex((day) => day.date === args.date);
  if (dayIndex < 0) throw new Error("That day is outside this trip's dates.");
  const day = itinerary[dayIndex];
  if (day.status === "locked" && args.lock !== false) throw new Error("That day is locked. Explicitly unlock it before changing the route.");
  const names = args.activityNames?.slice(0, 8) ?? day.items
    .filter((item) => item.kind === "activity")
    .map((item) => item.placeId ?? item.title)
    .filter(Boolean);
  const activities = names.map((name) => args.doc.activities.find((activity) => activity.name === name)).filter(Boolean) as TripActivity[];
  if (activities.length !== names.length) throw new Error("Choose activities from this trip's current place list.");
  const kept = args.activityNames ? day.items.filter((item) => item.kind !== "activity") : day.items.filter((item) => item.kind !== "activity");
  const activityItems = activities.map((activity, index) => ({
    id: stableTripItemId(args.date, "activity", activity.name, index),
    date: args.date,
    time: isTripTime(args.times?.[index]) ? args.times?.[index] : undefined,
    durationMinutes: 90,
    title: activity.name,
    kind: "activity" as const,
    placeId: activity.name,
    lat: activity.lat,
    lng: activity.lng,
    link: activity.mapsLink,
    note: activity.rating ? `★ ${activity.rating}` : undefined,
    source: "owner" as const,
    locked: args.lock === true || undefined,
  }));
  const replacement: TripItineraryDay = {
    ...day,
    status: args.lock === true ? "locked" : args.lock === false ? "draft" : day.status,
    items: sortTripItineraryItems([...kept, ...activityItems]),
  };
  const mode = isTripTravelMode(args.mode) ? args.mode : replacement.route?.mode ?? "walking";
  itinerary[dayIndex] = await refreshTripDayRoute(args.doc, replacement, mode);
  return saveTripItinerary(args.id, args.doc, itinerary);
}

/** Adds one user-requested, geocoded place without pretending it came from the scout list. */
export async function addTripPlaceToDay(args: {
  id: string;
  doc: TripDoc;
  date: string;
  place: { name: string; lat: number; lng: number; link?: string; note?: string };
  time?: string;
  mode?: TripTravelMode;
}): Promise<TripDoc> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.date)) throw new Error("Use a specific itinerary date (YYYY-MM-DD).");
  if (!args.place.name.trim() || !Number.isFinite(args.place.lat) || !Number.isFinite(args.place.lng) || Math.abs(args.place.lat) > 90 || Math.abs(args.place.lng) > 180) {
    throw new Error("That place did not include a valid mapped location.");
  }
  const itinerary = buildItinerary(args.doc);
  const dayIndex = itinerary.findIndex((day) => day.date === args.date);
  if (dayIndex < 0) throw new Error("That day is outside this trip's dates.");
  const day = itinerary[dayIndex];
  if (day.status === "locked") throw new Error("That day is locked. Explicitly unlock it before adding a new place.");
  const duplicate = day.items.find((item) => item.title.toLowerCase() === args.place.name.trim().toLowerCase() && item.lat === args.place.lat && item.lng === args.place.lng);
  const item: TripItineraryItem = duplicate ?? {
    id: stableTripItemId(args.date, "activity", args.place.name, day.items.filter((entry) => entry.kind === "activity").length),
    date: args.date,
    time: isTripTime(args.time) ? args.time : undefined,
    durationMinutes: 90,
    title: args.place.name.trim().slice(0, 180),
    kind: "activity",
    lat: args.place.lat,
    lng: args.place.lng,
    link: args.place.link,
    note: args.place.note,
    source: "owner",
  };
  const nextDay: TripItineraryDay = {
    ...day,
    items: sortTripItineraryItems(duplicate ? day.items : [...day.items, item]),
  };
  const mode = isTripTravelMode(args.mode) ? args.mode : nextDay.route?.mode ?? "walking";
  itinerary[dayIndex] = await refreshTripDayRoute(args.doc, nextDay, mode);
  return saveTripItinerary(args.id, args.doc, itinerary);
}

/** Bounded sequential refresh keeps public OSRM routing courteous and honest. */
export async function refreshTripItineraryRoutes(doc: TripDoc, itinerary: TripItineraryDay[], mode: TripTravelMode = "walking"): Promise<TripItineraryDay[]> {
  const refreshed: TripItineraryDay[] = [];
  for (const day of itinerary) {
    if (refreshed.length >= 14) {
      refreshed.push(routeNeedsRefresh(day, day.route?.mode ?? mode));
      continue;
    }
    const points = routeItemsForDay(doc, day);
    refreshed.push(points.length >= 2 ? await refreshTripDayRoute(doc, day, day.route?.mode ?? mode) : day);
  }
  return refreshed;
}

// Airport transfer from the locked hotel's coordinates — real drive time.
export async function computeTransfer(doc: TripDoc): Promise<TripDoc["transfer"]> {
  const stay = doc.locked.stay;
  if (!stay?.lat || !stay?.lng || !doc.airport?.lat) return undefined;
  try {
    const r = await hubAction("travelActions:routeLeg", {
      fromLat: doc.airport.lat,
      fromLng: doc.airport.lng,
      toLat: stay.lat,
      toLng: stay.lng,
      mode: "car",
    });
    if (!r?.available) return undefined;
    return { durationText: r.durationText, distanceText: r.distanceText, mode: "car", fareText: r.fareText };
  } catch {
    return undefined;
  }
}

const addDays = (date: string, n: number) => {
  const d = new Date(Date.parse(date) + n * 86_400_000);
  return d.toISOString().slice(0, 10);
};
const dayLabel = (date: string) =>
  new Date(date + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
const hhmm = (s?: string) => (s && /\d{2}:\d{2}/.test(s) ? s.match(/(\d{2}:\d{2})/)![1] : "");

export function mergeConfirmedBookings(doc: TripDoc, bookings: ConfirmedBooking[]): number {
  const existing = new Map((doc.confirmedBookings ?? []).map((booking) => [booking.marker, booking]));
  for (const booking of bookings) existing.set(booking.marker, booking);
  doc.confirmedBookings = [...existing.values()].sort((left, right) => (left.start ?? Number.MAX_SAFE_INTEGER) - (right.start ?? Number.MAX_SAFE_INTEGER));
  if (doc.departDate && doc.returnDate) doc.itinerary = buildItinerary(doc);
  return doc.confirmedBookings.length;
}

export function londonTime(date: string, time?: string): number {
  const [year, month, day] = date.split("-").map(Number);
  if (!time) return Date.UTC(year, month - 1, day);
  const [hour, minute] = time.split(":").map(Number);
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
    .formatToParts(new Date(guess))
    .reduce<Record<string, number>>((out, part) => {
      if (part.type !== "literal") out[part.type] = Number(part.value);
      return out;
    }, {});
  const observedAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  return guess - (observedAsUtc - guess);
}

// Locked trip → interactive connected-node map (canvas creation): clickable
// links, times, transfer distances on the connectors — the whole trip at a glance.
export async function tripToMindmap(doc: TripDoc, tripId: string): Promise<string> {
  const f = doc.locked.flight;
  const s = doc.locked.stay;
  const nodes: any[] = [
    { id: "trip", label: doc.title.slice(0, 50), detail: `£${doc.totals?.total ?? "?"} of £${doc.budgetGbp} · ${doc.adults} adults`, color: "green" },
  ];
  const edges: any[] = [];
  if (f) {
    nodes.push({
      id: "flight-out",
      label: `✈ ${doc.origin} → ${doc.destIata}`,
      detail: `${f.airline ?? ""} · ${hhmm(f.departTime)} → ${hhmm(f.arriveTime)} · £${f.priceGbp ?? "?"}pp`,
      parent: "trip",
      color: "amber",
      url: f.bookLink,
    });
  }
  if (s) {
    nodes.push({
      id: "hotel",
      label: `🏨 ${s.name.slice(0, 40)}`,
      detail: `★${s.rating ?? "?"} · £${s.totalGbp ?? "?"} total · ${(s.amenities ?? []).slice(0, 2).join(", ")}`,
      parent: f ? "flight-out" : "trip",
      color: "green",
      url: s.link,
      image: s.image,
    });
    if (doc.transfer && f)
      edges.push({ from: "flight-out", to: "hotel", label: `${doc.transfer.durationText} · ${doc.transfer.distanceText}` });
  }
  let d = 0;
  const canvasStopIds = new Map<string, string>();
  for (const day of doc.itinerary ?? []) {
    d++;
    const dayId = `day-${d}`;
    nodes.push({ id: dayId, label: `Day ${d} · ${day.label}`, parent: s ? "hotel" : "trip", color: "slate" });
    if (s) canvasStopIds.set(`stay:${day.date}`, "hotel");
    for (const [itemIndex, item] of day.items.filter((entry) => entry.kind === "activity" || entry.kind === "booking").entries()) {
      const stopId = item.id || stableTripItemId(day.date, item.kind, item.title, itemIndex);
      const itemId = `${dayId}:${stopId}`;
      canvasStopIds.set(stopId, itemId);
      nodes.push({
        id: itemId,
        label: item.title.slice(0, 40),
        detail: `${item.time ?? "time tbd"}${item.durationMinutes ? ` · allow ${item.durationMinutes} min` : ""}${item.note ? " · " + item.note : ""}`,
        parent: dayId,
        color: "blue",
        url: item.link,
      });
    }
    for (const leg of day.route?.legs ?? []) {
      const from = canvasStopIds.get(leg.fromItemId);
      const to = canvasStopIds.get(leg.toItemId);
      if (!from || !to) continue;
      const minutes = Math.max(1, Math.round(leg.durationSeconds / 60));
      const distance = leg.distanceMeters >= 1_000 ? `${(leg.distanceMeters / 1_000).toFixed(1)} km` : `${Math.round(leg.distanceMeters)} m`;
      edges.push({ from, to, label: `${day.route?.mode ?? "route"} · ${minutes} min · ${distance}` });
    }
  }
  if (f) {
    nodes.push({
      id: "flight-home",
      label: `✈ ${doc.destIata} → ${doc.origin}`,
      detail: doc.returnDate,
      parent: "hotel",
      color: "amber",
      url: f.bookLink,
    });
    if (doc.transfer)
      edges.push({ from: "hotel", to: "flight-home", label: `${doc.transfer.durationText} to airport` });
  }
  const canvas = { title: `Trip map · ${doc.destination}`, nodes, edges, tripId };
  const id = await convexMutation("creations:create", {
    kind: "canvas",
    title: canvas.title,
    data: JSON.stringify(canvas),
    thumb: s?.thumb,
  });
  return String(id);
}
