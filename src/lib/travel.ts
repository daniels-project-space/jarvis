import "server-only";
import { getSecret } from "./vault";
import { convexMutation, convexQuery } from "./context";

// JARVIS travel engine — drives the SAME infrastructure the project-hub travel
// widget already proved out (its public Convex actions: Google Hotels + Google
// Flights via SerpAPI, Google Directions) plus Google Places for activities.
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
  itinerary?: { date: string; label: string; items: { time: string; title: string; kind: string; link?: string; note?: string }[] }[];
  totals?: { flights: number; stay: number; activitiesEst: number; total: number; projectedTotal?: number; lockedTotal?: number };
  providers?: Record<"flights" | "stays" | "activities" | "airport", TripProviderState>;
  searchCompletedAt?: number;
  calendarSyncedAt?: number;
  includeFlights?: boolean;
};

async function googleKey(): Promise<string> {
  return await getSecret("google", "GOOGLE_PLACES_API_KEY");
}

// Activities/attractions with coordinates, ratings, photos, maps links.
export async function placesActivities(destination: string, vibe?: string, limit = 14): Promise<TripActivity[]> {
  const key = await googleKey().catch(() => "");
  if (!key) return [];
  const queries = [`top attractions in ${destination}`];
  if (vibe) queries.push(`best ${vibe} in ${destination}`);
  const results = await Promise.all(
    queries.map(async (q) => {
      try {
        return await (
          await fetch(`https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(q)}&key=${key}`)
        ).json();
      } catch {
        return { results: [] };
      }
    }),
  );
  const seen = new Set<string>();
  const out: TripActivity[] = [];
  for (const j of results as any[]) {
      for (const r of (j.results ?? []).slice(0, limit)) {
        if (seen.has(r.place_id)) continue;
        seen.add(r.place_id);
        out.push({
          name: String(r.name).slice(0, 70),
          rating: r.rating,
          ratings: r.user_ratings_total,
          lat: r.geometry?.location?.lat,
          lng: r.geometry?.location?.lng,
          address: r.formatted_address ? String(r.formatted_address).slice(0, 100) : undefined,
          mapsLink: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(r.name + " " + destination)}`,
          photo: r.photos?.[0]?.photo_reference
            ? `https://maps.googleapis.com/maps/api/place/photo?maxwidth=480&photo_reference=${r.photos[0].photo_reference}&key=${key}`
            : undefined,
        });
    }
  }
  return out.sort((a, b) => (b.rating ?? 0) * Math.log10((b.ratings ?? 1) + 1) - (a.rating ?? 0) * Math.log10((a.ratings ?? 1) + 1)).slice(0, limit);
}

async function findAirport(destIata: string, destination: string): Promise<TripDoc["airport"]> {
  const key = await googleKey().catch(() => "");
  if (!key) return undefined;
  try {
    const j: any = await (
      await fetch(
        `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(`${destIata} airport ${destination}`)}&key=${key}`,
      )
    ).json();
    const r = j.results?.[0];
    if (!r) return undefined;
    return { name: String(r.name).slice(0, 60), lat: r.geometry?.location?.lat, lng: r.geometry?.location?.lng };
  } catch {
    return undefined;
  }
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
export async function openTrip(a: { destination: string; destIata?: string }): Promise<{ id: string; doc: TripDoc }> {
  const destIata = a.destIata ? fixIata(a.destIata) : "";
  const normalized = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
  const [threadId, existingRows, geocode, airport] = await Promise.all([
    convexQuery("ui:getActiveThread", {}).then((value) => (typeof value === "string" && value ? value : "main")),
    convexQuery("creations:list", { kind: "trip", limit: 30 }).catch(() => []),
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
        normalized(existing.destination) === normalized(a.destination) &&
        (!existing.threadId || existing.threadId === threadId) &&
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
      activities: { status: "queued", source: "Google Places" },
      airport: { status: airport ? "ready" : "queued", source: "Google Places", count: airport ? 1 : 0, checkedAt: airport ? Date.now() : undefined },
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
    const opened = await openTrip({ destination: a.destination, destIata });
    id = opened.id;
    prior = opened.doc;
  }
  if (!id) throw new Error("Trip workspace could not be created");
  const creationId = id;
  const threadId = prior?.threadId || ((await convexQuery("ui:getActiveThread", {})) as string) || "main";
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
    status: "scouting",
    includeFlights: a.includeFlights !== false,
    threadId,
    center: prior?.center ?? { lat: 41.39, lng: 2.17 },
    airport: prior?.airport,
    flights: [],
    stays: [],
    activities: [],
    locked: { activities: [] },
    providers: {
      flights: { status: a.includeFlights === false ? "skipped" : "searching", source: "Google Flights", checkedAt: a.includeFlights === false ? Date.now() : undefined },
      stays: { status: "searching", source: "Google Hotels" },
      activities: { status: "searching", source: "Google Places" },
      airport: { status: "searching", source: "Google Places" },
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
    updateProvider("activities", "Google Places", () => placesActivities(a.destination, a.vibe), (result) => result ?? []),
    updateProvider("airport", "Google Places", () => findAirport(destIata, a.destination), (result) => result),
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

// Deterministic day-by-day itinerary from what's locked: flight out, transfer,
// check-in, two activities a day, check-out, transfer, flight home.
export function buildItinerary(doc: TripDoc): TripDoc["itinerary"] {
  const f = doc.locked.flight;
  const returnFlight = doc.locked.returnFlight;
  const s = doc.locked.stay;
  const picked = doc.activities.filter((x) => doc.locked.activities.includes(x.name));
  const pool = picked.length ? picked : doc.activities.slice(0, 8);
  const nights = Math.max(1, Math.round((Date.parse(doc.returnDate) - Date.parse(doc.departDate)) / 86_400_000));
  const days: NonNullable<TripDoc["itinerary"]> = [];
  let act = 0;
  for (let i = 0; i <= nights; i++) {
    const date = addDays(doc.departDate, i);
    const items: NonNullable<TripDoc["itinerary"]>[number]["items"] = [];
    if (i === 0) {
      if (f) items.push({ time: hhmm(f.departTime) || "morning", title: `Flight ${doc.origin} → ${doc.destIata} (${f.airline ?? "flight"})`, kind: "flight", link: f.bookLink, note: f.arriveTime ? `lands ${hhmm(f.arriveTime)}` : undefined });
      if (doc.transfer && s) items.push({ time: "", title: `Transfer to ${s.name}`, kind: "transfer", note: `${doc.transfer.durationText} · ${doc.transfer.distanceText}` });
      if (s) items.push({ time: "15:00", title: `Check in — ${s.name}`, kind: "hotel", link: s.link });
    } else if (i === nights) {
      if (s) items.push({ time: "11:00", title: `Check out — ${s.name}`, kind: "hotel" });
      if (doc.transfer) items.push({ time: "", title: `Transfer to ${doc.airport?.name ?? doc.destIata}`, kind: "transfer", note: `${doc.transfer.durationText} · ${doc.transfer.distanceText}` });
      if (returnFlight)
        items.push({
          time: hhmm(returnFlight.departTime),
          title: `Flight ${doc.destIata} → ${doc.origin} (${returnFlight.airline ?? "flight"})`,
          kind: "flight",
          link: returnFlight.bookLink,
          note: returnFlight.arriveTime ? `lands ${hhmm(returnFlight.arriveTime)}` : undefined,
        });
      else if (f)
        items.push({
          time: "",
          title: `Review return flight ${doc.destIata} → ${doc.origin}`,
          kind: "flight",
          link: f.bookLink,
          note: "round-trip price found; return schedule not selected",
        });
    } else {
      for (const slot of ["10:00", "14:30"]) {
        const a = pool[act++ % Math.max(1, pool.length)];
        if (!a || (act > pool.length && picked.length)) break;
        items.push({ time: slot, title: a.name, kind: "activity", link: a.mapsLink, note: a.rating ? `★ ${a.rating}` : undefined });
      }
    }
    days.push({ date, label: dayLabel(date), items });
  }
  return days;
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

async function hubMutation(path: string, args: unknown): Promise<any> {
  const response = await fetch(`${HUB}/api/mutation`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, args, format: "json" }),
  });
  const body = await response.json();
  if (!response.ok || body.status === "error") throw new Error(body.errorMessage ?? `${path} failed`);
  return body.value;
}

async function hubQuery(path: string, args: unknown): Promise<any> {
  const response = await fetch(`${HUB}/api/query`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, args, format: "json" }),
  });
  const body = await response.json();
  if (!response.ok || body.status === "error") throw new Error(body.errorMessage ?? `${path} failed`);
  return body.value;
}

// Calendar sync is an idempotent upsert keyed per trip item. It handles GMT
// and BST through Intl rather than a hard-coded UTC-1 offset.
export async function tripToCalendar(doc: TripDoc, tripId: string): Promise<number> {
  const existing: any[] = (await hubQuery("events:list", {})) ?? [];
  const tagged = existing.filter((event) => String(event.notes ?? "").includes(`jarvis-trip:${tripId}`));
  const desired: { key: string; title: string; start: number; allDay: boolean; notes: string }[] = [];
  for (const day of doc.itinerary ?? []) {
    for (const item of day.items) {
      if (item.kind === "transfer") continue;
      const icon = item.kind === "flight" ? "✈" : item.kind === "hotel" ? "🏨" : "📍";
      const key = `${day.date}:${item.time || "all-day"}:${item.kind}:${item.title}`
        .toLowerCase()
        .replace(/[^a-z0-9:-]+/g, "-")
        .slice(0, 180);
      desired.push({
        key,
        title: `${icon} ${item.title}`.slice(0, 120),
        start: londonTime(day.date, item.time || undefined),
        allDay: !item.time,
        notes: `${item.link ?? ""} · jarvis-trip:${tripId}:item:${key}`.slice(0, 400),
      });
    }
  }
  for (const event of desired) {
    const row = tagged.find((candidate) => String(candidate.notes ?? "").includes(`:item:${event.key}`));
    if (row) {
      await hubMutation("events:update", {
        id: row._id,
        title: event.title,
        start: event.start,
        allDay: event.allDay,
        color: "brass",
        notes: event.notes,
      });
    } else {
      await hubMutation("events:create", {
        title: event.title,
        start: event.start,
        allDay: event.allDay,
        color: "brass",
        notes: event.notes,
      });
    }
  }
  const currentKeys = new Set(desired.map((event) => event.key));
  for (const old of tagged) {
    const key = String(old.notes ?? "").match(/:item:([^·]+)$/)?.[1]?.trim();
    if (!key || !currentKeys.has(key)) await hubMutation("events:remove", { id: old._id });
  }
  return desired.length;
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
  for (const day of (doc.itinerary ?? []).slice(1, -1)) {
    d++;
    const dayId = `day-${d}`;
    nodes.push({ id: dayId, label: `Day ${d} · ${day.label}`, parent: "hotel", color: "slate" });
    let i = 0;
    for (const item of day.items.filter((x) => x.kind === "activity")) {
      i++;
      nodes.push({
        id: `${dayId}-a${i}`,
        label: item.title.slice(0, 40),
        detail: `${item.time}${item.note ? " · " + item.note : ""}`,
        parent: dayId,
        color: "blue",
        url: item.link,
      });
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
