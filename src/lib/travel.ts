import "server-only";
import { convexMutation, convexQuery } from "./context";
import { lookupGmailBookingsReadOnly, type ConfirmedBooking } from "./booking-email";
import {
  enrichOpenStreetMapPlacesWithWikimedia,
  openStreetMapDistanceKm,
  openStreetMapDirectionsUrl,
  routeOpenStreetMapItinerary,
  searchOpenStreetMapPlaces,
  type OpenStreetMapPlace,
  type OpenStreetMapWikipediaSource,
  type WikimediaPlaceArticle,
} from "./openstreetmap";
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
  /** Stable provider candidate key, including city so comparisons never collide. */
  id?: string;
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
  /** City/region supplied to the hotel provider for this result set. */
  city?: string;
  /** Provider label retained when multiple cities are compared on one globe. */
  source?: string;
  /** Durable city/base identity, distinct from the display-only city label. */
  cityContextId?: string;
};
export type TripActivity = {
  /** Stable source-backed key; allows duplicate venue names across towns. */
  id?: string;
  name: string;
  rating?: number;
  ratings?: number;
  lat?: number;
  lng?: number;
  mapsLink: string;
  photo?: string;
  address?: string;
  /** Exact `opening_hours` value supplied by OpenStreetMap; venue verification may still be needed. */
  openingHours?: string;
  /** Exact `charge` value supplied by OpenStreetMap; never normalized or inferred. */
  charge?: string;
  /** Source-tagged venue website, validated by the OpenStreetMap adapter. */
  websiteUrl?: string;
  /** Exact language/title article reference supplied by OpenStreetMap. */
  wikipedia?: OpenStreetMapWikipediaSource;
  /** Source-attributed Wikipedia/Wikimedia article and optional thumbnail. */
  wikipediaArticle?: WikimediaPlaceArticle;
  /** City/region used to obtain this exact OpenStreetMap candidate. */
  city?: string;
  /** The persisted discovery collection that produced this candidate. */
  discoveryId?: string;
  /** Durable city/base identity for cross-city itinerary routing. */
  cityContextId?: string;
  source?: "OpenStreetMap";
};
export type TripBookingReference = {
  /** The exact city context this Gmail-derived reference was independently verified against. */
  cityContextId?: string;
  city: string;
  title: string;
  bookingName?: string;
  location: string;
  start: number;
  end: number;
  timeZone?: string;
  lat: number;
  lng: number;
  /** Geocoded distance from the named city centre, never inferred client-side. */
  distanceKm: number;
  state: "active" | "upcoming";
  verifiedAt: number;
};
export type TripCityContext = {
  /** Stable city-plus-coordinate key; never infer identity from a city name alone. */
  id: string;
  city: string;
  center: { lat: number; lng: number };
  source: "destination" | "explore";
  createdAt: number;
  updatedAt: number;
  /** Present only after an independently geocoded, time-valid Gmail stay match. */
  bookingReference?: TripBookingReference;
  /** Timestamp of the successful Gmail refresh for this exact city context. */
  bookingCheckedAt?: number;
};
export type TripDiscovery = {
  id: string;
  /** Links this collection, its route, and every candidate to one map base. */
  cityContextId?: string;
  city: string;
  query: string;
  center: { lat: number; lng: number };
  fetchedAt: number;
  provider: "OpenStreetMap";
  items: TripActivity[];
  route?: TripDayRoute;
  /** Present only when a time-valid Gmail stay was geocoded near this city. */
  bookingReference?: TripBookingReference;
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
  /** Immutable successful destination geocode; unlike `center`, providers never move it. */
  destinationCenter?: { lat: number; lng: number };
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
  /** Timestamp of the last successful read-only Gmail booking refresh. */
  bookingsCheckedAt?: number;
  /** Source-verified, city-scoped Gmail stay references for the active globe. */
  bookingReferences?: TripBookingReference[];
  /** Durable city bases shared by stays, discoveries, Gmail references, and the globe. */
  cityContexts?: TripCityContext[];
  /** Selected city/base restored when a live or permanent travel plan reopens. */
  activeCityContextId?: string;
  /** Persisted arbitrary-city exploration result sets shown on the same globe. */
  discoveries?: TripDiscovery[];
  /**
   * Owner-device Apple Maps offline handoff derived from one confirmed Gmail
   * flight. This records only Jarvis-owned reminders/actions; Maps download
   * and deletion remain an explicit action inside Apple's Maps app.
   */
  offlineMapPreflight?: {
    city: string;
    flightMarker: string;
    flightTitle: string;
    flightStart: number;
    at: number;
    timeZone: string;
    mapUrl: string;
    sourceKey: string;
    todoStatus: "created" | "existing" | "needs_retry";
    reminderStatus: "scheduled";
    calendarStatus: "approval_required" | "needs_connection" | "needs_reconnect";
    /** Saved-trip-only background state; never implies an Apple Maps device action. */
    refreshState?: "scheduled" | "pending_refresh" | "pending_google" | "needs_flight_confirmation" | "needs_city_confirmation" | "too_late" | "trip_missing" | "draft_manual_only" | "pending_city_identity" | "pending_registry";
    refreshError?: string;
    lastCheckedAt?: number;
    nextRefreshAt?: number;
    flightSelectionId?: string;
    calendarRefreshRequired?: boolean;
    updatedAt: number;
  };
};

/** Keep live conversation workspaces distinct from permanent saved trip creations. */
export type TripStorage = "draft" | "creation";
export type TripWorkspaceRef = { draftId: string } | { creationId: string };
export type TripStorageContext = {
  storage: TripStorage;
  /** Trusted host provenance only; never model-authored tool input. */
  sourceMessageId?: string;
};
export type TripRecord = {
  id: string;
  doc: TripDoc;
  storage: TripStorage;
};

export function tripWorkspaceRef(storage: TripStorage, id: string): TripWorkspaceRef {
  return storage === "draft" ? { draftId: id } : { creationId: id };
}

export function bookingsForTripWindow(bookings: ConfirmedBooking[], departDate?: string, returnDate?: string): ConfirmedBooking[] {
  const start = Date.parse(`${departDate ?? ""}T00:00:00Z`);
  const end = Date.parse(`${returnDate ?? ""}T23:59:59Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];
  return bookings.filter((booking) => {
    const bookingStart = Number(booking.start);
    const bookingEnd = Number(booking.end ?? booking.start);
    return Number.isFinite(bookingStart) && Number.isFinite(bookingEnd) && bookingEnd >= start && bookingStart <= end;
  });
}

function mergeTripBookings(existing: ConfirmedBooking[] | undefined, incoming: ConfirmedBooking[]): ConfirmedBooking[] {
  const byMarker = new Map((existing ?? []).map((booking) => [booking.marker, booking]));
  for (const booking of incoming) byMarker.set(booking.marker, booking);
  return [...byMarker.values()].sort((left, right) => (left.start ?? Number.MAX_SAFE_INTEGER) - (right.start ?? Number.MAX_SAFE_INTEGER));
}

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
        id: tripActivityId({ name: place.name, lat: place.lat, lng: place.lng }),
        name: place.name.slice(0, 70),
        lat: place.lat,
        lng: place.lng,
        address: place.address.slice(0, 100) || undefined,
        mapsLink: place.mapsUri,
        ...(place.openingHours ? { openingHours: place.openingHours } : {}),
        ...(place.charge ? { charge: place.charge } : {}),
        ...(place.websiteUrl ? { websiteUrl: place.websiteUrl } : {}),
        ...(place.wikipedia ? { wikipedia: place.wikipedia } : {}),
        ...(place.wikipediaArticle ? { wikipediaArticle: place.wikipediaArticle } : {}),
        // The adapter permits this only for an exact OpenStreetMap Wikipedia
        // tag and records the article/attribution alongside it above.
        ...(place.wikipediaArticle?.thumbnailUrl ? { photo: place.wikipediaArticle.thumbnailUrl } : {}),
        city: destination,
        source: "OpenStreetMap",
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

// Spawn the globe the moment trip talk starts. Until Daniel explicitly locks
// it, this is a conversation-scoped draft rather than a saved library record.
export async function openTrip(a: {
  destination: string;
  destIata?: string;
  departDate?: string;
  returnDate?: string;
  /** Trusted host provenance when this starts from a chat message. */
  sourceMessageId?: string;
  /** Host-selected conversation thread; worker calls are verified by Convex. */
  threadId?: string;
}): Promise<TripRecord> {
  const destIata = a.destIata ? fixIata(a.destIata) : "";
  const [activeThread, geocode, airport] = await Promise.all([
    convexQuery("ui:getActiveThread", {}).then((value) => (typeof value === "string" && value ? value : "main")),
    fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(a.destination)}&count=1&language=en`, {
      signal: AbortSignal.timeout(6000),
    })
      .then((response) => response.json())
      .catch(() => null),
    destIata ? findAirport(destIata, a.destination) : Promise.resolve(undefined),
  ]);
  const threadId = a.threadId || activeThread;
  let center = { lat: 41.39, lng: 2.17 };
  let destinationCenter: { lat: number; lng: number } | undefined;
  const geocoded = (geocode as any)?.results?.[0];
  if (Number.isFinite(geocoded?.latitude) && Number.isFinite(geocoded?.longitude)) {
    center = { lat: geocoded.latitude, lng: geocoded.longitude };
    destinationCenter = center;
  }
  const openedAt = Date.now();
  const initialCityContext = destinationCenter ? {
    id: tripCityContextId(a.destination, destinationCenter),
    city: a.destination.trim().slice(0, 120),
    center: destinationCenter,
    source: "destination" as const,
    createdAt: openedAt,
    updatedAt: openedAt,
  } satisfies TripCityContext : undefined;
  const doc: TripDoc = {
    kind: "trip",
    title: `${a.destination} · planning`,
    destination: a.destination,
    destIata,
    origin: "LHR",
    // The globe opens before provider work starts. Keep dates that were
    // already spoken in that first durable draft rather than briefly showing
    // an undated trip until the scout's later provider patch arrives.
    departDate: a.departDate?.trim() ?? "",
    returnDate: a.returnDate?.trim() ?? "",
    adults: 2,
    budgetGbp: 0,
    status: "scouting",
    includeFlights: undefined,
    threadId,
    center,
    destinationCenter,
    ...(initialCityContext ? { cityContexts: [initialCityContext], activeCityContextId: initialCityContext.id } : {}),
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
  const created = await convexMutation("travelDrafts:createDraft", {
    threadId,
    title: doc.title,
    destination: doc.destination,
    data: JSON.stringify(doc),
    ...(a.sourceMessageId ? { sourceMessageId: a.sourceMessageId } : {}),
  });
  if (!created?.ok || !created.id) throw new Error(`Trip draft could not be created${created?.reason ? `: ${created.reason}` : ""}`);
  const id = String(created.id);
  doc.planRevision = Number.isSafeInteger(created.planRevision) ? created.planRevision : 0;
  await convexMutation("ui:setPanel", { type: "trip", value: JSON.stringify({ draftId: id }), title: `trip · ${a.destination}` });
  return { id, doc, storage: "draft" };
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
  reuseId?: string; // populate the exact already-open workspace only
  reuseStorage?: TripStorage;
  sourceMessageId?: string;
  /** Trusted chat provenance for a newly opened workspace. */
  threadId?: string;
}): Promise<TripRecord> {
  const nights = Math.max(1, Math.round((Date.parse(a.returnDate) - Date.parse(a.departDate)) / 86_400_000));
  // Budget shaping: stays get ~45% of total budget unless caller overrides.
  const perNightCap = a.maxPricePerNight ?? Math.max(30, Math.round((a.budgetGbp * 0.45) / nights));
  const origin = fixIata(a.origin);
  const destIata = fixIata(a.destIata);
  // This is read-only and intentionally starts alongside trip setup. A failed
  // Gmail connection must never prevent an unrelated city plan from opening.
  const bookingLookup = lookupGmailBookingsReadOnly({ days: 730, maxResults: 24 })
    .then((bookings) => ({ bookings, checkedAt: Date.now() }))
    .catch(() => ({ bookings: [] as ConfirmedBooking[], checkedAt: undefined }));

  let id = a.reuseId;
  let storage: TripStorage = a.reuseStorage ?? "draft";
  let prior: TripDoc | undefined;
  if (id) {
    const existing = await getTrip(id, { storage, sourceMessageId: a.sourceMessageId });
    if (existing) {
      prior = existing.doc;
      storage = existing.storage;
    } else {
      id = undefined;
    }
  }
  if (!id) {
    const opened = await openTrip({
      destination: a.destination,
      destIata,
      departDate: a.departDate,
      returnDate: a.returnDate,
      sourceMessageId: a.sourceMessageId,
      threadId: a.threadId,
    });
    id = opened.id;
    prior = opened.doc;
    storage = opened.storage;
  }
  if (!id) throw new Error("Trip workspace could not be created");
  const tripId = id;
  const priorActiveCity = prior ? activeTripCityContext(prior) : undefined;
  // A worker turn may finish after the owner has selected another chat. The
  // turn's provenance, not that global UI selection, owns any new trip draft.
  const threadId = prior?.threadId || a.threadId || ((await convexQuery("ui:getActiveThread", {})) as string) || "main";
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
    status: storage === "creation" && preservePlan && prior?.status === "planned" ? "planned" : "scouting",
    includeFlights: a.includeFlights !== false,
    threadId,
    center: priorActiveCity?.center ?? prior?.center ?? { lat: 41.39, lng: 2.17 },
    destinationCenter: prior?.destinationCenter,
    cityContexts: prior?.cityContexts,
    activeCityContextId: prior?.activeCityContextId,
    airport: prior?.airport,
    flights: [],
    stays: [],
    activities: [],
    locked: preservePlan ? prior?.locked ?? { activities: [] } : { activities: [] },
    transfer: preservePlan ? prior?.transfer : undefined,
    itinerary: preservePlan ? prior?.itinerary : undefined,
    planRevision: storage === "draft" ? prior?.planRevision : preservePlan ? prior?.planRevision : undefined,
    mindmapCreationId: storage === "creation" && preservePlan ? prior?.mindmapCreationId : undefined,
    confirmedBookings: preservePlan ? prior?.confirmedBookings : undefined,
    providers: {
      flights: { status: a.includeFlights === false ? "skipped" : "searching", source: "Google Flights", checkedAt: a.includeFlights === false ? Date.now() : undefined },
      stays: { status: "searching", source: "Google Hotels" },
      activities: { status: "searching", source: "OpenStreetMap" },
      airport: { status: "searching", source: "OpenStreetMap" },
    },
  };
  const freshBookings = await bookingLookup;
  const matchingBookings = bookingsForTripWindow(freshBookings.bookings, doc.departDate, doc.returnDate);
  if (freshBookings.checkedAt) {
    // A successful Gmail refresh is authoritative for this trip window so a
    // changed/cancelled confirmation cannot linger as a live map reference.
    doc.confirmedBookings = matchingBookings;
    doc.bookingsCheckedAt = freshBookings.checkedAt;
  }
  doc.totals = tripTotals(doc);
  await saveTrip(tripId, doc, false, { storage, sourceMessageId: a.sourceMessageId });
  const workspace = tripWorkspaceRef(storage, tripId);
  await convexMutation("ui:setPanel", { type: "trip", value: JSON.stringify(workspace), title: `trip · ${doc.title}` });
  await convexMutation("chatQueue:postCard", {
    threadId,
    type: "trip",
    value: JSON.stringify(workspace),
    title: `trip · ${doc.title}`,
  }).catch(() => {});

  const patchProvider = async (
    provider: "flights" | "stays" | "activities" | "airport",
    status: TripProviderState["status"],
    source: string,
    items?: unknown,
    error?: string,
  ) => {
    if (storage === "draft") {
      const result = await convexMutation("travelDrafts:patchProvider", {
        id: tripId,
        provider,
        status,
        source,
        ...(items !== undefined ? { itemsJson: JSON.stringify(items) } : {}),
        ...(error !== undefined ? { error: error.slice(0, 300) } : {}),
        ...(a.sourceMessageId ? { sourceMessageId: a.sourceMessageId } : {}),
      });
      // A late scout result must never turn a newly locked permanent plan back
      // into an error state. The lock is the terminal authority boundary.
      if (!result?.ok && !["locked", "expired"].includes(String(result?.reason))) {
        throw new Error(`Trip provider update failed${result?.reason ? `: ${result.reason}` : ""}`);
      }
      return;
    }
    await convexMutation("creations:updateTripProvider", {
      id: tripId,
      provider,
      status,
      source,
      ...(items !== undefined ? { items } : {}),
      ...(error !== undefined ? { error: error.slice(0, 300) } : {}),
    });
  };

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
      await patchProvider(provider, available ? "ready" : "error", source, items, available ? undefined : String(result?.reason ?? `${source} returned no airport`));
    } catch (error: any) {
      await patchProvider(provider, "error", source, undefined, String(error?.message ?? error)).catch(() => {});
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
        await patchProvider("stays", "error", "Google Hotels", undefined, String(first?.reason ?? "No stays returned"));
        return;
      }
      const initial = ((first?.options ?? []).slice(0, 16) as TripStay[]).map((stay) => {
        const scoped = { ...stay, city: a.destination, source: "Google Hotels" };
        return { ...scoped, id: tripStayId(scoped) };
      });
      await patchProvider("stays", "ready", "Google Hotels · first page", initial);
      if (!first?.nextPageToken) return;
      await patchProvider("stays", "searching", "Google Hotels · enriching");
      const more = await hubAction("travelActions:searchStays", {
        ...base,
        maxPages: 2,
        pageToken: first.nextPageToken,
      });
      const merged = [...initial, ...((more?.options ?? []) as TripStay[]).map((stay) => {
        const scoped = { ...stay, city: a.destination, source: "Google Hotels" };
        return { ...scoped, id: tripStayId(scoped) };
      })]
        .filter((stay, index, all) => all.findIndex((candidate) => candidate.name === stay.name) === index)
        .slice(0, 36);
      await patchProvider("stays", "ready", "Google Hotels · 3 pages", merged, more?.available === false ? String(more?.reason ?? "Enrichment stopped") : undefined);
    } catch (error: any) {
      await patchProvider("stays", "error", "Google Hotels", undefined, String(error?.message ?? error)).catch(() => {});
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
  const finalTrip = await getTrip(tripId, { storage, sourceMessageId: a.sourceMessageId });
  if (finalTrip && freshBookings.checkedAt && finalTrip.doc.destinationCenter) {
    const reference = await verifyTripCityBookingReference({
      doc: finalTrip.doc,
      city: finalTrip.doc.destination,
      center: finalTrip.doc.destinationCenter,
      bookings: freshBookings.bookings,
      now: freshBookings.checkedAt,
    });
    const destinationContext = normalizeTripCityContexts(finalTrip.doc, freshBookings.checkedAt)
      .find((context) => sameTripCity(context.city, finalTrip.doc.destination));
    if (destinationContext) {
      setTripCityContextBookingReference(finalTrip.doc, destinationContext.id, reference, freshBookings.checkedAt);
    } else {
      finalTrip.doc.bookingReferences = setTripBookingReference(finalTrip.doc.bookingReferences, reference, finalTrip.doc.destination);
    }
    try {
      await saveTrip(finalTrip.id, finalTrip.doc, false, { storage: finalTrip.storage, sourceMessageId: a.sourceMessageId });
    } catch (error: any) {
      // Locking wins over a late read-only Gmail refresh; never surface it as a
      // failed provider or overwrite the permanent plan after promotion.
      if (!/already been locked/i.test(String(error?.message ?? error))) throw error;
    }
  }
  return finalTrip ?? { id: tripId, doc, storage };
}

export async function latestTrip(): Promise<TripRecord | null> {
  const row: any = await convexQuery("creations:latest", { kind: "trip" });
  if (!row?.data) return null;
  try {
    const doc = JSON.parse(row.data) as TripDoc;
    normalizeTripCityContexts(doc);
    return { id: String(row._id), doc, storage: "creation" };
  } catch {
    return null;
  }
}

export async function getTrip(id: string, context: TripStorageContext = { storage: "creation" }): Promise<TripRecord | null> {
  if (context.storage === "draft") {
    const row: any = await convexQuery("travelDrafts:get", {
      id,
      ...(context.sourceMessageId ? { sourceMessageId: context.sourceMessageId } : {}),
    }).catch(() => null);
    if (!row?.data || row.state !== "draft") return null;
    try {
      const doc = JSON.parse(row.data) as TripDoc;
      normalizeTripCityContexts(doc);
      return { id: String(row._id), doc, storage: "draft" };
    } catch {
      return null;
    }
  }
  const row: any = await convexQuery("creations:get", { id }).catch(() => null);
  if (!row?.data || row.kind !== "trip") return null;
  try {
    const doc = JSON.parse(row.data) as TripDoc;
    normalizeTripCityContexts(doc);
    return { id: String(row._id), doc, storage: "creation" };
  } catch {
    return null;
  }
}

export async function saveTrip(
  id: string,
  doc: TripDoc,
  showPanel = true,
  context: TripStorageContext = { storage: "creation" },
): Promise<void> {
  normalizeTripCityContexts(doc);
  doc.totals = tripTotals(doc);
  if (context.storage === "draft") {
    const expectedPlanRevision = Number.isSafeInteger(doc.planRevision) ? Number(doc.planRevision) : 0;
    const result = await convexMutation("travelDrafts:updatePlan", {
      id,
      expectedPlanRevision,
      title: doc.title,
      destination: doc.destination,
      data: JSON.stringify(doc),
      ...(context.sourceMessageId ? { sourceMessageId: context.sourceMessageId } : {}),
    });
    if (!result?.ok) {
      if (result?.reason === "stale") throw new Error("This trip changed while you were editing it. Reopen the live workspace and try again.");
      if (result?.reason === "locked") throw new Error("This trip has already been locked into the saved travel library.");
      throw new Error(`Trip draft could not be saved${result?.reason ? `: ${result.reason}` : ""}`);
    }
    doc.planRevision = result.planRevision;
    if (showPanel)
      await convexMutation("ui:setPanel", { type: "trip", value: JSON.stringify(tripWorkspaceRef("draft", id)), title: `trip · ${doc.title}` });
    return;
  }
  await convexMutation("creations:update", { id, title: doc.title, data: JSON.stringify(doc) });
  if (showPanel)
    await convexMutation("ui:setPanel", { type: "trip", value: JSON.stringify(tripWorkspaceRef("creation", id)), title: `trip · ${doc.title}` });
}

const CITY_BOOKING_MAX_DISTANCE_KM = 35;
const CITY_BOOKING_SEARCH_RADIUS_METRES = 48_000;

const compactTravelKey = (value: string) =>
  value.toLocaleLowerCase("en-GB").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 72) || "place";

/** Stable across reopening/reordering, including places with the same name in different towns. */
export function tripActivityId(activity: Pick<TripActivity, "id" | "name" | "lat" | "lng">): string {
  if (activity.id?.trim()) return activity.id.slice(0, 180);
  const lat = Number(activity.lat);
  const lng = Number(activity.lng);
  const coordinates = Number.isFinite(lat) && Number.isFinite(lng) ? `${lat.toFixed(5)}:${lng.toFixed(5)}` : "unmapped";
  return `osm:${compactTravelKey(activity.name)}:${coordinates}`.slice(0, 180);
}

export function tripStayId(stay: Pick<TripStay, "id" | "name" | "lat" | "lng" | "city">, city = stay.city ?? ""): string {
  if (stay.id?.trim()) return stay.id.slice(0, 180);
  const lat = Number(stay.lat);
  const lng = Number(stay.lng);
  const coordinates = Number.isFinite(lat) && Number.isFinite(lng) ? `${lat.toFixed(5)}:${lng.toFixed(5)}` : "unmapped";
  return `stay:${compactTravelKey(city)}:${compactTravelKey(stay.name)}:${coordinates}`.slice(0, 180);
}

function tripActivityFromPlace(place: OpenStreetMapPlace, city: string, discoveryId: string, cityContextId?: string): TripActivity {
  return {
    id: `${discoveryId}:place:${compactTravelKey(place.name)}:${place.lat.toFixed(5)}:${place.lng.toFixed(5)}`.slice(0, 180),
    name: place.name.slice(0, 120),
    lat: place.lat,
    lng: place.lng,
    address: place.address.slice(0, 180) || undefined,
    mapsLink: place.mapsUri,
    ...(place.openingHours ? { openingHours: place.openingHours } : {}),
    ...(place.charge ? { charge: place.charge } : {}),
    ...(place.websiteUrl ? { websiteUrl: place.websiteUrl } : {}),
    ...(place.wikipedia ? { wikipedia: place.wikipedia } : {}),
    ...(place.wikipediaArticle ? { wikipediaArticle: place.wikipediaArticle } : {}),
    ...(place.wikipediaArticle?.thumbnailUrl ? { photo: place.wikipediaArticle.thumbnailUrl } : {}),
    city,
    discoveryId,
    ...(cityContextId ? { cityContextId } : {}),
    source: "OpenStreetMap",
  };
}

function liveTripStayCandidates(doc: TripDoc, candidates: ConfirmedBooking[], now: number): ConfirmedBooking[] {
  return bookingsForTripWindow(candidates, doc.departDate, doc.returnDate)
    .filter((booking) => {
      const start = Number(booking.start);
      const end = Number(booking.end ?? booking.start);
      return booking.kind === "stay" && Boolean(booking.location?.trim()) && Number.isFinite(start) && Number.isFinite(end) && end >= now;
    })
    .sort((left, right) => {
      const leftActive = Number(left.start) <= now && Number(left.end ?? left.start) >= now;
      const rightActive = Number(right.start) <= now && Number(right.end ?? right.start) >= now;
      if (leftActive !== rightActive) return leftActive ? -1 : 1;
      return Number(left.start) - Number(right.start);
    });
}

/**
 * A Gmail stay is displayed only after its address was independently geocoded
 * within the selected city. It remains a read-only reference, never a booking
 * instruction or an inferred location.
 */
export async function verifyTripCityBookingReference(args: {
  doc: TripDoc;
  city: string;
  center: { lat: number; lng: number };
  bookings?: ConfirmedBooking[];
  now?: number;
}): Promise<TripBookingReference | undefined> {
  const now = args.now ?? Date.now();
  for (const booking of liveTripStayCandidates(args.doc, args.bookings ?? args.doc.confirmedBookings ?? [], now)) {
    const lookup = await searchOpenStreetMapPlaces(booking.location!, {
      center: args.center,
      radiusMetres: CITY_BOOKING_SEARCH_RADIUS_METRES,
      maxResults: 1,
    }).catch(() => []);
    const place = lookup[0];
    if (!place) continue;
    const distanceKm = openStreetMapDistanceKm(args.center, place);
    if (!Number.isFinite(distanceKm) || distanceKm > CITY_BOOKING_MAX_DISTANCE_KM) continue;
    const start = Number(booking.start);
    const end = Number(booking.end ?? booking.start);
    return {
      city: args.city.slice(0, 120),
      title: booking.title.slice(0, 180),
      bookingName: booking.bookingName?.slice(0, 180),
      location: booking.location!.slice(0, 300),
      start,
      end,
      timeZone: booking.timeZone,
      lat: place.lat,
      lng: place.lng,
      distanceKm: Math.round(distanceKm * 10) / 10,
      state: start <= now && end >= now ? "active" : "upcoming",
      verifiedAt: now,
    };
  }
  return undefined;
}

const TRIP_CITY_CONTEXT_LIMIT = 12;
const TRIP_BOOKING_REFERENCE_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

function validTripCenter(value: unknown): value is { lat: number; lng: number } {
  const point = value as { lat?: unknown; lng?: unknown } | null;
  return Boolean(point)
    && Number.isFinite(point?.lat)
    && Number.isFinite(point?.lng)
    && Math.abs(Number(point?.lat)) <= 90
    && Math.abs(Number(point?.lng)) <= 180;
}

function sameTripCity(left: string, right: string): boolean {
  return compactTravelKey(left) === compactTravelKey(right);
}

export function tripCityContextId(city: string, center: { lat: number; lng: number }): string {
  return `city:${compactTravelKey(city)}:${center.lat.toFixed(3)}:${center.lng.toFixed(3)}`.slice(0, 180);
}

function currentTripBookingReference(reference: TripBookingReference | undefined, now: number): TripBookingReference | undefined {
  if (!reference) return undefined;
  const start = Number(reference.start);
  const end = Number(reference.end ?? reference.start);
  const verifiedAt = Number(reference.verifiedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < now || !Number.isFinite(verifiedAt)) return undefined;
  if (verifiedAt > now || now - verifiedAt > TRIP_BOOKING_REFERENCE_MAX_AGE_MS) return undefined;
  return reference;
}

/**
 * Makes legacy trip JSON city-aware on read and before each normal save. The
 * original global candidate arrays remain intact for backwards compatibility;
 * this is only the durable identity/selection layer that prevents unrelated
 * towns from being averaged into one meaningless map base.
 */
export function normalizeTripCityContexts(doc: TripDoc, now = Date.now()): TripCityContext[] {
  const known = new Map<string, TripCityContext>();
  const add = (cityValue: unknown, centerValue: unknown, source: TripCityContext["source"], preferredId?: unknown) => {
    const city = String(cityValue ?? "").trim().slice(0, 120);
    if (!city || !validTripCenter(centerValue)) return undefined;
    const center = { lat: Number(centerValue.lat), lng: Number(centerValue.lng) };
    const id = typeof preferredId === "string" && preferredId.trim()
      ? preferredId.trim().slice(0, 180)
      : tripCityContextId(city, center);
    const existing = known.get(id);
    const raw = (doc.cityContexts ?? []).find((entry) => entry?.id === id);
    const createdAt = Number.isFinite(Number(raw?.createdAt)) ? Number(raw?.createdAt) : now;
    const updatedAt = Number.isFinite(Number(raw?.updatedAt)) ? Number(raw?.updatedAt) : createdAt;
    const context: TripCityContext = {
      id,
      city,
      center,
      source: raw?.source === "destination" || raw?.source === "explore" ? raw.source : source,
      createdAt: existing?.createdAt ?? createdAt,
      updatedAt: Math.max(existing?.updatedAt ?? 0, updatedAt),
      ...(currentTripBookingReference(raw?.bookingReference, now) ? { bookingReference: raw!.bookingReference } : {}),
      ...(Number.isFinite(Number(raw?.bookingCheckedAt)) ? { bookingCheckedAt: Number(raw?.bookingCheckedAt) } : {}),
    };
    known.set(id, existing ? {
      ...existing,
      ...context,
      createdAt: existing.createdAt,
      updatedAt: Math.max(existing.updatedAt, context.updatedAt),
      ...(existing.bookingReference && !context.bookingReference ? { bookingReference: existing.bookingReference } : {}),
    } : context);
    return known.get(id)!;
  };

  for (const entry of doc.cityContexts ?? []) {
    add(entry?.city, entry?.center, entry?.source === "destination" ? "destination" : "explore", entry?.id);
  }
  // A verified booking is enough to restore a legacy city context even when an
  // old draft predates `destinationCenter`. Never use the globe's fallback
  // point for that purpose: an un-geocoded city must not quietly become
  // Barcelona (the historical default globe position).
  for (const reference of doc.bookingReferences ?? []) {
    add(reference.city, { lat: reference.lat, lng: reference.lng }, "explore", reference.cityContextId);
  }
  const legacyCenter = validTripCenter(doc.destinationCenter)
    ? doc.destinationCenter
    : (!doc.discoveries?.length && validTripCenter(doc.center) ? doc.center : undefined);
  const destinationContext = add(doc.destination, legacyCenter, "destination");
  for (const discovery of doc.discoveries ?? []) {
    const context = add(discovery.city, discovery.center, "explore", discovery.cityContextId);
    if (!context) continue;
    discovery.cityContextId = context.id;
    for (const item of discovery.items ?? []) {
      if (!item.cityContextId) item.cityContextId = context.id;
    }
  }

  const contexts = [...known.values()]
    .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id));
  const activeId = typeof doc.activeCityContextId === "string" ? doc.activeCityContextId : undefined;
  const keepIds = new Set<string>([
    ...(destinationContext ? [destinationContext.id] : []),
    ...(activeId && known.has(activeId) ? [activeId] : []),
  ]);
  const retained = contexts.filter((context) => keepIds.has(context.id));
  for (const context of contexts) {
    if (retained.length >= TRIP_CITY_CONTEXT_LIMIT) break;
    if (!retained.some((entry) => entry.id === context.id)) retained.push(context);
  }
  const retainedIds = new Set(retained.map((context) => context.id));

  for (const stay of doc.stays ?? []) {
    if (stay.cityContextId && retainedIds.has(stay.cityContextId)) continue;
    const match = retained.find((context) => sameTripCity(context.city, stay.city ?? doc.destination));
    if (match) stay.cityContextId = match.id;
  }
  if (doc.locked.stay && (!doc.locked.stay.cityContextId || !retainedIds.has(doc.locked.stay.cityContextId))) {
    const match = retained.find((context) => sameTripCity(context.city, doc.locked.stay?.city ?? doc.destination));
    if (match) doc.locked.stay.cityContextId = match.id;
  }
  for (const activity of doc.activities ?? []) {
    if (activity.cityContextId && retainedIds.has(activity.cityContextId)) continue;
    const match = retained.find((context) => sameTripCity(context.city, activity.city ?? doc.destination));
    if (match) activity.cityContextId = match.id;
  }
  const scopedContexts = new Map(retained.map((context) => [context.id, context]));
  for (const reference of doc.bookingReferences ?? []) {
    let match = reference.cityContextId && retainedIds.has(reference.cityContextId)
      ? scopedContexts.get(reference.cityContextId)
      : undefined;
    if (!match) match = retained.find((context) => sameTripCity(context.city, reference.city));
    if (!match) continue;
    reference.cityContextId = match.id;
    const live = currentTripBookingReference(reference, now);
    if (!live) continue;
    const current = currentTripBookingReference(match.bookingReference, now);
    if (!current || live.verifiedAt >= current.verifiedAt) {
      const projected = { ...live, cityContextId: match.id };
      const next = {
        ...match,
        bookingReference: projected,
        bookingCheckedAt: Math.max(Number(match.bookingCheckedAt) || 0, projected.verifiedAt),
      };
      scopedContexts.set(match.id, next);
      const index = retained.findIndex((context) => context.id === match.id);
      if (index >= 0) retained[index] = next;
    }
  }

  doc.cityContexts = retained;
  if (!doc.activeCityContextId || !retainedIds.has(doc.activeCityContextId)) {
    doc.activeCityContextId = destinationContext && retainedIds.has(destinationContext.id)
      ? destinationContext.id
      : retained[0]?.id;
  }
  return retained;
}

export function activeTripCityContext(doc: TripDoc, now = Date.now()): TripCityContext | undefined {
  const contexts = normalizeTripCityContexts(doc, now);
  return contexts.find((context) => context.id === doc.activeCityContextId) ?? contexts[0];
}

export function setTripBookingReference(
  existing: TripBookingReference[] | undefined,
  reference: TripBookingReference | undefined,
  city: string,
  cityContextId?: string,
): TripBookingReference[] | undefined {
  const cityKey = compactTravelKey(city);
  const retained = (existing ?? []).filter((entry) => cityContextId
    ? entry.cityContextId !== cityContextId
    : compactTravelKey(entry.city) !== cityKey);
  const scoped = reference
    ? { ...reference, ...(cityContextId ? { cityContextId } : {}) }
    : undefined;
  return scoped ? [...retained, scoped].slice(-8) : retained.length ? retained.slice(-8) : undefined;
}

/** Selects an already-known city base. Call the refresh helper separately for Gmail freshness. */
export function selectTripCityContext(doc: TripDoc, cityContextId: string, now = Date.now()): TripCityContext {
  const context = normalizeTripCityContexts(doc, now).find((entry) => entry.id === cityContextId);
  if (!context) throw new Error("Choose one of this trip's saved cities before changing the map base.");
  doc.activeCityContextId = context.id;
  return context;
}

export function setTripCityContextBookingReference(
  doc: TripDoc,
  cityContextId: string,
  reference: TripBookingReference | undefined,
  checkedAt = Date.now(),
): TripCityContext {
  const context = normalizeTripCityContexts(doc, checkedAt).find((entry) => entry.id === cityContextId);
  if (!context) throw new Error("Choose one of this trip's saved cities before updating its booking reference.");
  const scoped = reference ? { ...reference, cityContextId: context.id } : undefined;
  doc.cityContexts = (doc.cityContexts ?? []).map((entry) => entry.id === context.id ? {
    ...entry,
    updatedAt: checkedAt,
    bookingCheckedAt: checkedAt,
    ...(scoped ? { bookingReference: scoped } : { bookingReference: undefined }),
  } : entry);
  doc.bookingReferences = setTripBookingReference(doc.bookingReferences, scoped, context.city, context.id);
  return (doc.cityContexts ?? []).find((entry) => entry.id === context.id) ?? context;
}

/**
 * Revalidates one selected city against Gmail. A provider failure deliberately
 * retains the last verified reference rather than fabricating a newer check.
 */
export async function refreshTripCityContextBookings(args: {
  doc: TripDoc;
  cityContextId: string;
  now?: number;
}): Promise<{ context: TripCityContext; bookingReference?: TripBookingReference; refreshed: boolean }> {
  const now = args.now ?? Date.now();
  const context = selectTripCityContext(args.doc, args.cityContextId, now);
  const bookings = await lookupGmailBookingsReadOnly({ days: 730, maxResults: 24 }).catch(() => undefined);
  if (!bookings) {
    return {
      context,
      bookingReference: currentTripBookingReference(context.bookingReference, now),
      refreshed: false,
    };
  }
  const relevant = bookingsForTripWindow(bookings, args.doc.departDate, args.doc.returnDate);
  args.doc.confirmedBookings = relevant;
  args.doc.bookingsCheckedAt = now;
  const reference = await verifyTripCityBookingReference({
    doc: args.doc,
    city: context.city,
    center: context.center,
    bookings: relevant,
    now,
  });
  const updated = setTripCityContextBookingReference(args.doc, context.id, reference, now);
  return { context: updated, bookingReference: reference, refreshed: true };
}

/** Upserts a map-valid city base, selects it, and performs one read-only Gmail refresh. */
export async function activateTripCityContext(args: {
  doc: TripDoc;
  city: string;
  source: TripCityContext["source"];
  center?: { lat: number; lng: number };
  now?: number;
}): Promise<{ context: TripCityContext; bookingReference?: TripBookingReference; refreshed: boolean }> {
  const city = args.city.trim().slice(0, 120);
  if (!city) throw new Error("Name the city or town to set as the travel map base.");
  let center = args.center;
  if (!validTripCenter(center)) {
    const match = (await searchOpenStreetMapPlaces(city, { maxResults: 1 }))[0];
    if (!match) throw new Error(`I couldn't locate ${city} on the map.`);
    center = { lat: match.lat, lng: match.lng };
  }
  const now = args.now ?? Date.now();
  const id = tripCityContextId(city, center);
  const contexts = normalizeTripCityContexts(args.doc, now);
  const prior = contexts.find((entry) => entry.id === id);
  const next: TripCityContext = {
    id,
    city,
    center,
    source: prior?.source === "destination" ? "destination" : args.source,
    createdAt: prior?.createdAt ?? now,
    updatedAt: now,
    ...(prior?.bookingReference ? { bookingReference: prior.bookingReference } : {}),
    ...(prior?.bookingCheckedAt ? { bookingCheckedAt: prior.bookingCheckedAt } : {}),
  };
  args.doc.cityContexts = [...contexts.filter((entry) => entry.id !== id), next];
  args.doc.activeCityContextId = id;
  return await refreshTripCityContextBookings({ doc: args.doc, cityContextId: id, now });
}

async function routeTripDiscovery(
  items: TripActivity[],
  mode: TripTravelMode,
  bookingReference?: TripBookingReference,
): Promise<TripDayRoute> {
  const mapped = items.filter((item): item is TripActivity & { id: string; lat: number; lng: number } =>
    Boolean(item.id) && Number.isFinite(item.lat) && Number.isFinite(item.lng),
  );
  const calculatedAt = Date.now();
  const liveBooking = currentTripBookingReference(bookingReference, calculatedAt);
  const bookedBase = liveBooking && validTripCenter(liveBooking)
    ? {
      id: `booking:${liveBooking.cityContextId ?? compactTravelKey(liveBooking.city)}:${liveBooking.start}`.slice(0, 180),
      lat: Number(liveBooking.lat),
      lng: Number(liveBooking.lng),
    }
    : undefined;
  const stops = bookedBase ? [bookedBase, ...mapped] : mapped;
  if (stops.length < 2 || mode === "transit") return { mode, status: "unavailable", calculatedAt };
  const route = await routeOpenStreetMapItinerary({ points: stops.map((item) => ({ lat: item.lat, lng: item.lng })), mode });
  if (!route) return { mode, status: "unavailable", calculatedAt };
  return {
    mode,
    status: "ready",
    coordinates: route.coordinates,
    durationSeconds: route.durationSeconds,
    distanceMeters: route.distanceMeters,
    legs: route.legs.map((leg, index) => ({
      fromItemId: stops[index]!.id,
      toItemId: stops[index + 1]!.id,
      durationSeconds: leg.durationSeconds,
      distanceMeters: leg.distanceMeters,
    })),
    attribution: route.attribution,
    directionsUrl: openStreetMapDirectionsUrl({
      origin: stops[0]!,
      destination: stops[stops.length - 1]!,
      waypoints: stops.slice(1, -1),
      mode,
    }),
    calculatedAt,
  };
}

/** Persist one real, source-backed arbitrary-city discovery on the trip itself. */
export async function discoverTripPlaces(args: {
  id: string;
  doc: TripDoc;
  storage?: TripStorage;
  sourceMessageId?: string;
  city: string;
  query: string;
  mode?: TripTravelMode;
  includeRoute?: boolean;
}): Promise<{ doc: TripDoc; discovery: TripDiscovery }> {
  const city = args.city.trim().slice(0, 120);
  const query = args.query.trim().slice(0, 120);
  if (!city) throw new Error("Name the city or town to explore.");
  if (!query) throw new Error("Name the kind of places to find.");
  const cityLookup = await searchOpenStreetMapPlaces(city, { maxResults: 1 });
  const cityMatch = cityLookup[0];
  if (!cityMatch) throw new Error(`I couldn't locate ${city} on the map.`);
  const center = { lat: cityMatch.lat, lng: cityMatch.lng };
  const raw = await searchOpenStreetMapPlaces(`${query} in ${city}`, { center, radiusMetres: 28_000, maxResults: 10 });
  const places = await enrichOpenStreetMapPlacesWithWikimedia(raw);
  if (!places.length) throw new Error(`I couldn't find source-backed places for ${query} in ${city}.`);

  const fetchedAt = Date.now();
  const discoveryId = `discovery:${fetchedAt.toString(36)}:${compactTravelKey(city)}:${compactTravelKey(query)}`.slice(0, 180);
  const activated = await activateTripCityContext({
    doc: args.doc,
    city,
    center,
    source: "explore",
    now: fetchedAt,
  });
  const items = places.map((place) => tripActivityFromPlace(place, city, discoveryId, activated.context.id));
  const mode = isTripTravelMode(args.mode) ? args.mode : "walking";
  const route = args.includeRoute === false
    ? undefined
    : await routeTripDiscovery(items.slice(0, 8), mode, activated.bookingReference);
  const discovery: TripDiscovery = {
    id: discoveryId,
    cityContextId: activated.context.id,
    city,
    query,
    center,
    fetchedAt,
    provider: "OpenStreetMap",
    items,
    route,
    ...(activated.bookingReference ? { bookingReference: activated.bookingReference } : {}),
  };
  const matchingCityAndQuery = (entry: TripDiscovery) => (
    entry.cityContextId === activated.context.id
    || compactTravelKey(entry.city) === compactTravelKey(city)
  ) && compactTravelKey(entry.query) === compactTravelKey(query);
  args.doc.discoveries = [...(args.doc.discoveries ?? []).filter((entry) => !matchingCityAndQuery(entry)), discovery].slice(-8);
  const known = new Set(args.doc.activities.map((activity) => tripActivityId(activity)));
  args.doc.activities = [...args.doc.activities, ...items.filter((item) => !known.has(tripActivityId(item)))];
  await saveTrip(args.id, args.doc, true, { storage: args.storage ?? "creation", sourceMessageId: args.sourceMessageId });
  return { doc: args.doc, discovery };
}

/** Atomically promotes an already-CAS-saved draft and its deterministic mind map. */
export async function lockTripDraft(
  id: string,
  doc: TripDoc,
  context: Omit<TripStorageContext, "storage"> = {},
): Promise<{ creationId: string; mindmapCreationId?: string; alreadyLocked: boolean }> {
  const expectedPlanRevision = Number.isSafeInteger(doc.planRevision) ? Number(doc.planRevision) : 0;
  const result = await convexMutation("travelDrafts:lockDraft", {
    id,
    expectedPlanRevision,
    ...(context.sourceMessageId ? { sourceMessageId: context.sourceMessageId } : {}),
  });
  if (!result?.ok || !result.creationId) {
    if (result?.reason === "stale") throw new Error("This trip changed while it was being locked. Reopen the live workspace and try again.");
    if (result?.reason === "expired") throw new Error("This travel draft expired before it could be locked. Start a fresh plan to continue.");
    throw new Error(`Trip could not be locked${result?.reason ? `: ${result.reason}` : ""}`);
  }
  const creationId = String(result.creationId);
  const mindmapCreationId = result.mindmapCreationId ? String(result.mindmapCreationId) : undefined;
  await convexMutation("ui:setPanel", {
    type: "trip",
    value: JSON.stringify(tripWorkspaceRef("creation", creationId)),
    title: `trip · ${doc.title}`,
  });
  await convexMutation("chatQueue:postCard", {
    threadId: doc.threadId,
    type: "trip",
    value: JSON.stringify(tripWorkspaceRef("creation", creationId)),
    title: `trip · ${doc.title}`,
  }).catch(() => {});
  return { creationId, mindmapCreationId, alreadyLocked: result.alreadyLocked === true };
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
  return doc.activities.find((activity) => activity.id === item.placeId)
    ?? doc.activities.find((activity) => activity.name === item.placeId || activity.name === item.title);
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
      placeId: tripActivityId(activity),
      cityContextId: activity.cityContextId,
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
  const activeCity = activeTripCityContext(doc);
  const f = doc.locked.flight;
  const returnFlight = doc.locked.returnFlight;
  const stay = doc.locked.stay;
  const cityActivities = activeCity
    ? doc.activities.filter((activity) => activity.cityContextId === activeCity.id)
    : doc.activities;
  const picked = cityActivities.filter((activity) => doc.locked.activities.includes(tripActivityId(activity)) || doc.locked.activities.includes(activity.name));
  const pool = picked.length ? picked : cityActivities.slice(0, 8);
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
        if (doc.transfer && stay) {
          const transfer = items.find((item) => item.id === "arrival-transfer");
          if (transfer) {
            // Transfers are calculated from the one locked hotel, so retain
            // that hotel's city identity when a saved itinerary is rebuilt.
            // Without it the multi-city timeline correctly rejects the tile
            // as ambiguous and hides the real transfer timing everywhere.
            if (!transfer.cityContextId) transfer.cityContextId = stay.cityContextId;
          } else {
            items.push({
              id: "arrival-transfer",
              date,
              title: `Transfer to ${stay.name}`,
              kind: "transfer",
              cityContextId: stay.cityContextId,
              note: `${doc.transfer.durationText} · ${doc.transfer.distanceText}`,
              source: "generated",
            });
          }
        }
        if (stay && !items.some((item) => item.id === "check-in")) {
          items.push({
            id: "check-in",
            date,
            time: "15:00",
            title: `Check in — ${stay.name}`,
            kind: "hotel",
            cityContextId: stay.cityContextId,
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
            cityContextId: stay.cityContextId,
            lat: stay.lat,
            lng: stay.lng,
            source: "generated",
            locked: true,
          });
        }
        if (doc.transfer) {
          const transfer = items.find((item) => item.id === "departure-transfer");
          if (transfer) {
            if (!transfer.cityContextId && stay?.cityContextId) transfer.cityContextId = stay.cityContextId;
          } else {
            items.push({
              id: "departure-transfer",
              date,
              title: `Transfer to ${doc.airport?.name ?? doc.destIata}`,
              kind: "transfer",
              cityContextId: stay?.cityContextId,
              note: `${doc.transfer.durationText} · ${doc.transfer.distanceText}`,
              source: "generated",
            });
          }
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

function bookingOverlapsTripDay(reference: TripBookingReference, date: string): boolean {
  const dayStart = Date.parse(`${date}T00:00:00Z`);
  const dayEnd = dayStart + 86_400_000 - 1;
  return Number.isFinite(dayStart) && Number(reference.start) <= dayEnd && Number(reference.end ?? reference.start) >= dayStart;
}

function itemCityContextId(doc: TripDoc, item: TripItineraryItem): string | undefined {
  if (item.cityContextId) return item.cityContextId;
  const activity = activityForItem(doc, item);
  if (activity?.cityContextId) return activity.cityContextId;
  if (item.kind === "hotel") return doc.locked.stay?.cityContextId;
  return undefined;
}

function routeItemsForDay(doc: TripDoc, day: TripItineraryDay): Array<{ item: TripItineraryItem; lat: number; lng: number }> {
  const contexts = normalizeTripCityContexts(doc);
  const stops = day.items.flatMap((item) => {
    const point = itemCoordinates(doc, item);
    return point ? [{ item, ...point }] : [];
  });
  const firstContextId = day.items.map((item) => itemCityContextId(doc, item)).find(Boolean);
  const cityContext = contexts.find((context) => context.id === firstContextId)
    ?? (firstContextId ? undefined : activeTripCityContext(doc));
  const hasCityHotel = stops.some((stop) => stop.item.kind === "hotel"
    && (!cityContext || itemCityContextId(doc, stop.item) === cityContext.id));
  const currentBooking = cityContext ? currentTripBookingReference(cityContext.bookingReference, Date.now()) : undefined;
  const bookingReference = currentBooking && bookingOverlapsTripDay(currentBooking, day.date)
    ? currentBooking
    : undefined;
  // A Gmail booking is an independently geocoded, time-valid base for this
  // city. It is deliberately scoped to its own context, so an old Barcelona
  // hotel cannot become the origin of a Seville walking route.
  if (stops.length && bookingReference && !hasCityHotel) {
    stops.unshift({
      item: {
        id: `booking:${cityContext!.id}:${day.date}`.slice(0, 180),
        cityContextId: cityContext!.id,
        date: day.date,
        title: bookingReference.bookingName ?? bookingReference.title,
        kind: "hotel",
        lat: bookingReference.lat,
        lng: bookingReference.lng,
        note: "Gmail booking reference · independently geocoded",
        source: "gmail",
        locked: true,
      },
      lat: bookingReference.lat,
      lng: bookingReference.lng,
    });
    return stops;
  }
  // On a free day the selected city's locked hotel is an implicit first stop:
  // it gives the map a real first-mile leg without inventing a visible tile.
  if (
    stops.length &&
    !hasCityHotel &&
    Number.isFinite(doc.locked.stay?.lat) &&
    Number.isFinite(doc.locked.stay?.lng) &&
    (!cityContext || doc.locked.stay?.cityContextId === cityContext.id)
  ) {
    stops.unshift({
      item: {
        id: `stay:${day.date}`,
        cityContextId: doc.locked.stay?.cityContextId,
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

export async function saveTripItinerary(
  id: string,
  doc: TripDoc,
  itinerary: TripItineraryDay[],
  mindmapCreationId?: string,
  context: TripStorageContext = { storage: "creation" },
  ensureMindmap = false,
): Promise<TripDoc> {
  const normalized = normalizeTripItinerary(itinerary);
  if (context.storage === "draft") {
    const next: TripDoc = { ...doc, itinerary: normalized, mindmapCreationId: mindmapCreationId ?? doc.mindmapCreationId };
    await saveTrip(id, next, true, context);
    return next;
  }
  const planRevision = Math.max(0, Number(doc.planRevision) || 0) + 1;
  const result: any = await convexMutation("creations:updateTripItinerary", {
    id,
    itinerary: JSON.stringify(normalized),
    planRevision,
    mindmapCreationId,
    ensureMindmap,
  });
  if (!result?.ok) {
    if (result?.reason === "stale") throw new Error("This trip changed while its route was being refreshed. Please try that day again.");
    throw new Error("Trip itinerary could not be saved.");
  }
  const persistedMindmapCreationId = typeof result.mindmapCreationId === "string"
    ? result.mindmapCreationId
    : mindmapCreationId ?? doc.mindmapCreationId;
  return { ...doc, itinerary: normalized, planRevision, mindmapCreationId: persistedMindmapCreationId };
}

export async function scheduleTripDay(args: {
  id: string;
  doc: TripDoc;
  storage?: TripStorage;
  sourceMessageId?: string;
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
  const activities = names.map((name) =>
    args.doc.activities.find((activity) => activity.id === name)
      ?? args.doc.activities.find((activity) => activity.name === name),
  ).filter(Boolean) as TripActivity[];
  if (activities.length !== names.length) throw new Error("Choose activities from this trip's current place list.");
  const kept = args.activityNames ? day.items.filter((item) => item.kind !== "activity") : day.items.filter((item) => item.kind !== "activity");
  const activityItems = activities.map((activity, index) => ({
    id: stableTripItemId(args.date, "activity", activity.name, index),
    date: args.date,
    time: isTripTime(args.times?.[index]) ? args.times?.[index] : undefined,
    durationMinutes: 90,
    title: activity.name,
    kind: "activity" as const,
    placeId: tripActivityId(activity),
    cityContextId: activity.cityContextId,
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
  return saveTripItinerary(args.id, args.doc, itinerary, undefined, { storage: args.storage ?? "creation", sourceMessageId: args.sourceMessageId });
}

/** Adds one user-requested, geocoded place without pretending it came from the scout list. */
export async function addTripPlaceToDay(args: {
  id: string;
  doc: TripDoc;
  storage?: TripStorage;
  sourceMessageId?: string;
  date: string;
  place: { id?: string; name: string; lat: number; lng: number; link?: string; note?: string; cityContextId?: string };
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
  const placeId = args.place.id?.trim().slice(0, 180) || tripActivityId(args.place);
  const duplicate = day.items.find((item) => item.placeId === placeId || (item.title.toLowerCase() === args.place.name.trim().toLowerCase() && item.lat === args.place.lat && item.lng === args.place.lng));
  const item: TripItineraryItem = duplicate ?? {
    id: stableTripItemId(args.date, "activity", args.place.name, day.items.filter((entry) => entry.kind === "activity").length),
    date: args.date,
    time: isTripTime(args.time) ? args.time : undefined,
    durationMinutes: 90,
    title: args.place.name.trim().slice(0, 180),
    kind: "activity",
    placeId,
    cityContextId: args.place.cityContextId?.trim().slice(0, 180) || undefined,
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
  return saveTripItinerary(args.id, args.doc, itinerary, undefined, { storage: args.storage ?? "creation", sourceMessageId: args.sourceMessageId });
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

/** A successful Gmail scan is authoritative for this trip window. */
export function replaceConfirmedBookings(doc: TripDoc, bookings: ConfirmedBooking[]): number {
  doc.confirmedBookings = [...bookings].sort((left, right) => (left.start ?? Number.MAX_SAFE_INTEGER) - (right.start ?? Number.MAX_SAFE_INTEGER));
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
