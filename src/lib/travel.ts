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
  center: { lat: number; lng: number };
  airport?: { name: string; lat: number; lng: number };
  flights: TripFlight[];
  stays: TripStay[];
  activities: TripActivity[];
  locked: { flight?: TripFlight; stay?: TripStay; activities: string[] };
  transfer?: { durationText: string; distanceText: string; mode: string; fareText?: string };
  itinerary?: { date: string; label: string; items: { time: string; title: string; kind: string; link?: string; note?: string }[] }[];
  totals?: { flights: number; stay: number; activitiesEst: number; total: number };
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
  const seen = new Set<string>();
  const out: TripActivity[] = [];
  for (const q of queries) {
    try {
      const j: any = await (
        await fetch(`https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(q)}&key=${key}`)
      ).json();
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
    } catch {
      /* partial is fine */
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
  const stay = doc.locked.stay?.totalGbp ?? (doc.locked.stay?.priceGbp ?? 0) * nights;
  const activitiesEst = doc.locked.activities.length * 25 * doc.adults;
  return { flights: Math.round(flights), stay: Math.round(stay), activitiesEst, total: Math.round(flights + stay + activitiesEst) };
}

// Spawn the globe the moment trip talk starts: a skeleton trip doc centred on
// the destination (city geocode + airport marker), populated live by trip_plan.
export async function openTrip(a: { destination: string; destIata?: string }): Promise<{ id: string; doc: TripDoc }> {
  let center = { lat: 41.39, lng: 2.17 };
  try {
    const g: any = await (
      await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(a.destination)}&count=1&language=en`, {
        signal: AbortSignal.timeout(6000),
      })
    ).json();
    if (g?.results?.[0]) center = { lat: g.results[0].latitude, lng: g.results[0].longitude };
  } catch {
    /* keep default */
  }
  const destIata = a.destIata ? fixIata(a.destIata) : "";
  const airport = destIata ? await findAirport(destIata, a.destination) : undefined;
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
    center,
    airport,
    flights: [],
    stays: [],
    activities: [],
    locked: { activities: [] },
  };
  const id = await convexMutation("creations:create", { kind: "trip", title: doc.title, data: JSON.stringify(doc) });
  await convexMutation("ui:setPanel", { type: "trip", value: JSON.stringify({ creationId: String(id) }), title: `trip · ${a.destination}` });
  return { id: String(id), doc };
}

// The orchestrated scout — every provider in parallel, one trip doc out.
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

  const [flightsRes, staysRes, activities, airport] = await Promise.all([
    a.includeFlights === false
      ? Promise.resolve({ available: false, options: [] })
      : hubAction("travelActions:searchFlights", {
          origin,
          destination: destIata,
          outboundDate: a.departDate,
          returnDate: a.returnDate,
          adults: a.adults,
        }).catch(() => ({ available: false, options: [] })),
    hubAction("travelActions:searchStays", {
      query: `${a.destination} hotels`,
      checkIn: a.departDate,
      checkOut: a.returnDate,
      adults: a.adults,
      maxPricePerNight: perNightCap,
      vacationRentals: a.vacationRentals ?? false,
    }).catch(() => ({ available: false, options: [] })),
    placesActivities(a.destination, a.vibe),
    findAirport(destIata, a.destination),
  ]);

  const stays: TripStay[] = (staysRes.options ?? [])
    .filter((s: TripStay) => s.lat && s.lng)
    .slice(0, 24);
  const flights: TripFlight[] = (flightsRes.options ?? []).slice(0, 8);
  const centerSrc = stays.length ? stays : activities;
  const center = {
    lat: centerSrc.reduce((s: number, p: any) => s + (p.lat ?? 0), 0) / Math.max(1, centerSrc.length),
    lng: centerSrc.reduce((s: number, p: any) => s + (p.lng ?? 0), 0) / Math.max(1, centerSrc.length),
  };

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
    center,
    airport,
    flights,
    stays,
    activities,
    locked: { activities: [] },
  };
  doc.totals = tripTotals(doc);

  let id: string;
  if (a.reuseId) {
    id = a.reuseId; // the globe is already up — it fills in live (reactive panel)
    await convexMutation("creations:update", {
      id,
      title: doc.title,
      data: JSON.stringify(doc),
      thumb: stays[0]?.thumb ?? activities[0]?.photo,
    });
  } else {
    id = String(
      await convexMutation("creations:create", {
        kind: "trip",
        title: doc.title,
        data: JSON.stringify(doc),
        thumb: stays[0]?.thumb ?? activities[0]?.photo,
      }),
    );
  }
  await convexMutation("ui:setPanel", { type: "trip", value: JSON.stringify({ creationId: id }), title: `trip · ${doc.title}` });
  await convexMutation("chatQueue:postCard", {
    threadId: (await convexQuery("ui:getActiveThread", {})) || "main",
    type: "trip",
    value: JSON.stringify({ creationId: id }),
    title: `trip · ${doc.title}`,
  }).catch(() => {});
  return { id, doc };
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
  const f = doc.locked.flight ?? doc.flights[0];
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
      if (f) items.push({ time: "", title: `Flight ${doc.destIata} → ${doc.origin}`, kind: "flight", link: f.bookLink });
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

// Locked trip → hub calendar events (flights, hotel, activities) — they flow
// into briefings and calendar_view automatically.
export async function tripToCalendar(doc: TripDoc, tripId: string): Promise<number> {
  const mkEvent = async (title: string, date: string, time: string | undefined, notes: string) => {
    const [y, mo, d] = date.split("-").map(Number);
    const [h, mi] = (time ?? "09:00").split(":").map(Number);
    const start = Date.UTC(y, mo - 1, d, h - 1, mi); // approx Europe/London summer
    await fetch(`${HUB}/api/mutation`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        path: "events:create",
        args: { title: title.slice(0, 120), start, allDay: !time, color: "brass", notes: `${notes} · jarvis-trip:${tripId}`.slice(0, 400) },
        format: "json",
      }),
    });
  };
  let n = 0;
  for (const day of doc.itinerary ?? []) {
    for (const item of day.items) {
      if (item.kind === "transfer") continue;
      const icon = item.kind === "flight" ? "✈" : item.kind === "hotel" ? "🏨" : "📍";
      await mkEvent(`${icon} ${item.title}`, day.date, item.time || undefined, item.link ?? "");
      n++;
    }
  }
  return n;
}

// Locked trip → interactive connected-node map (canvas creation): clickable
// links, times, transfer distances on the connectors — the whole trip at a glance.
export async function tripToMindmap(doc: TripDoc, tripId: string): Promise<string> {
  const f = doc.locked.flight ?? doc.flights[0];
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
