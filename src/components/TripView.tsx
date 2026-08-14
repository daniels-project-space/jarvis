"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../convex/_generated/api";
import { useJarvisQuery } from "@/lib/secure-convex";
import { viewerFetch } from "@/lib/viewer-request";
import "maplibre-gl/dist/maplibre-gl.css";

// The trip planner panel: a real dark 3D map (MapLibre globe projection on
// Carto's dark-matter street basemap) plus a reactive workspace. Persisted
// itinerary routes are deliberately rendered only from their stored geometry;
// a straight line between two markers is not a route and must never look like
// one here.

type Coordinate = [number, number];
type ItineraryItem = {
  id?: string;
  placeId?: string;
  time?: string;
  durationMinutes?: number;
  title: string;
  kind: string;
  lat?: number;
  lng?: number;
  link?: string;
  note?: string;
  source?: string;
};
type ItineraryRouteLeg = {
  fromItemId?: string;
  toItemId?: string;
  durationSeconds?: number;
  distanceMeters?: number;
};
type ItineraryRoute = {
  mode?: string;
  status?: string;
  coordinates?: Coordinate[];
  durationSeconds?: number;
  distanceMeters?: number;
  legs?: ItineraryRouteLeg[];
  attribution?: string;
};
type ItineraryDay = {
  date: string;
  label?: string;
  status?: string;
  items: ItineraryItem[];
  route?: ItineraryRoute;
};
type TripDoc = { itinerary?: ItineraryDay[]; [key: string]: any };
type Marker = { key: string; lat: number; lng: number; kind: "stay" | "activity" | "airport"; name: string; locked?: boolean };

const KIND_COLOR: Record<string, string> = { stay: "#00ff88", activity: "#5cc8ff", airport: "#ffb454" };
const GLASS = "rounded-xl border border-white/10 bg-white/[0.045] backdrop-blur-xl";

const validLatLng = (lat: unknown, lng: unknown) =>
  typeof lat === "number" && Number.isFinite(lat) && lat >= -90 && lat <= 90 && typeof lng === "number" && Number.isFinite(lng) && lng >= -180 && lng <= 180;

const validRouteCoordinates = (route?: ItineraryRoute | null): Coordinate[] =>
  (route?.coordinates ?? []).filter(
    (coordinate): coordinate is Coordinate =>
      Array.isArray(coordinate) && coordinate.length >= 2 && validLatLng(coordinate[1], coordinate[0]),
  );

const routeModeLabel = (mode?: string) => {
  switch (mode) {
    case "walking":
      return "walk";
    case "bicycling":
    case "cycling":
      return "cycle";
    case "driving":
      return "drive";
    case "transit":
      return "transit";
    default:
      return mode;
  }
};

const durationText = (minutes: unknown) => {
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes < 0) return null;
  const wholeMinutes = Math.round(minutes);
  const hours = Math.floor(wholeMinutes / 60);
  return hours ? `${hours}h${wholeMinutes % 60 ? ` ${wholeMinutes % 60}m` : ""}` : `${wholeMinutes} min`;
};

const durationSecondsText = (seconds: unknown) =>
  typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0 ? durationText(seconds / 60) : null;

const distanceText = (meters: unknown) => {
  if (typeof meters !== "number" || !Number.isFinite(meters) || meters < 0) return null;
  return meters >= 1000 ? `${(meters / 1000).toFixed(meters >= 10_000 ? 0 : 1)} km` : `${Math.round(meters)} m`;
};

const routeStatusText = (route?: ItineraryRoute | null) => {
  switch (route?.status) {
    case "ready":
      return "route ready";
    case "searching":
    case "pending":
      return "routing…";
    case "unavailable":
      return "route unavailable";
    case "not_enough_points":
      return "add another mapped place to route";
    default:
      return route?.status ? route.status.replace(/_/g, " ") : null;
  }
};

function MapView({
  center,
  markers,
  route,
  selected,
  onSelect,
}: {
  center: { lat: number; lng: number };
  markers: Marker[];
  route?: ItineraryRoute | null;
  selected: string | null;
  onSelect: (key: string) => void;
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const markerObjs = useRef<Map<string, any>>(new Map());
  const lastViewportRef = useRef("");
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const [mapReady, setMapReady] = useState(false);
  const routeCoordinates = useMemo(() => validRouteCoordinates(route), [route]);

  useEffect(() => {
    let dead = false;
    (async () => {
      const maplibregl = (await import("maplibre-gl")).default;
      if (dead || !mountRef.current) return;
      const map = new maplibregl.Map({
        container: mountRef.current,
        style: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
        center: [center.lng, center.lat],
        zoom: 11.2,
        pitch: 48,
        bearing: -12,
        attributionControl: { compact: true },
      });
      try {
        (map as any).setProjection({ type: "globe" }); // zoomed out = black globe
      } catch {
        /* older runtime — flat map still fine */
      }
      map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-right");
      map.on("load", () => {
        map.addSource("itinerary-route", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        map.addLayer({
          id: "itinerary-route-glow",
          type: "line",
          source: "itinerary-route",
          paint: { "line-color": "#56d9ff", "line-width": 9, "line-opacity": 0.17, "line-blur": 4 },
        });
        map.addLayer({
          id: "itinerary-route",
          type: "line",
          source: "itinerary-route",
          paint: { "line-color": "#8cecff", "line-width": 3, "line-opacity": 0.94 },
        });
        setMapReady(true);
      });
      mapRef.current = map;
    })();
    return () => {
      dead = true;
      try {
        mapRef.current?.remove();
      } catch {
        /* gone */
      }
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Markers, persisted route geometry, and the camera all react to the plan.
  // The route source intentionally remains empty when a route was unavailable.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    let dead = false;
    (async () => {
      const maplibregl = (await import("maplibre-gl")).default;
      if (dead || mapRef.current !== map) return;
      const seen = new Set<string>();
      for (const m of markers) {
        seen.add(m.key);
        const existing = markerObjs.current.get(m.key);
        const size = m.kind === "airport" ? 16 : m.locked ? 18 : 11;
        if (existing) {
          const el = existing.getElement() as HTMLDivElement;
          el.style.width = `${size}px`;
          el.style.height = `${size}px`;
          el.style.background = m.locked ? "#ffffff" : KIND_COLOR[m.kind];
          el.style.boxShadow = `0 0 ${m.locked || selected === m.key ? 18 : 9}px ${KIND_COLOR[m.kind]}`;
          el.style.outline = m.locked || selected === m.key ? `2px solid ${KIND_COLOR[m.kind]}` : "none";
          existing.setLngLat([m.lng, m.lat]);
          continue;
        }
        const el = document.createElement("div");
        el.style.cssText = `width:${size}px;height:${size}px;border-radius:50%;cursor:pointer;background:${
          m.locked ? "#ffffff" : KIND_COLOR[m.kind]
        };box-shadow:0 0 9px ${KIND_COLOR[m.kind]};transition:all .25s ease;`;
        el.title = m.name;
        el.addEventListener("click", (e) => {
          e.stopPropagation();
          onSelectRef.current(m.key);
        });
        const mk = new maplibregl.Marker({ element: el }).setLngLat([m.lng, m.lat]).addTo(map);
        markerObjs.current.set(m.key, mk);
      }
      for (const [k, mk] of markerObjs.current) {
        if (!seen.has(k)) {
          mk.remove();
          markerObjs.current.delete(k);
        }
      }

      const routeSource = map.getSource("itinerary-route");
      if (routeSource) {
        (routeSource as any).setData({
          type: "FeatureCollection",
          features:
            routeCoordinates.length > 1
              ? [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: routeCoordinates } }]
              : [],
        });
      }

      // A newly discussed route/day or updated coordinates should move the
      // camera. Selection changes deliberately do not reset the user's view.
      const viewportPoints: Coordinate[] = routeCoordinates.length > 1 ? routeCoordinates : markers.map((marker) => [marker.lng, marker.lat]);
      const viewportKey = JSON.stringify({ center, points: viewportPoints });
      if (viewportKey === lastViewportRef.current) return;
      lastViewportRef.current = viewportKey;
      if (viewportPoints.length > 1) {
        const bounds = new maplibregl.LngLatBounds();
        viewportPoints.forEach((point) => bounds.extend(point));
        map.fitBounds(bounds, { padding: 60, pitch: 42, duration: 1100, maxZoom: 13 });
      } else if (viewportPoints.length === 1) {
        map.easeTo({ center: viewportPoints[0], zoom: 12.4, duration: 850 });
      } else if (validLatLng(center.lat, center.lng)) {
        map.easeTo({ center: [center.lng, center.lat], duration: 850 });
      }
    })();
    return () => {
      dead = true;
    };
  }, [center, markers, routeCoordinates, selected, mapReady]);

  return <div ref={mountRef} className="h-full w-full [&_.maplibregl-ctrl-attrib]:!bg-black/40 [&_.maplibregl-ctrl-attrib]:!text-[9px]" />;
}

async function tripTool(tripId: string, action: string, extra: Record<string, unknown> = {}) {
  const response = await viewerFetch("/api/tools", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: action === "finalize" ? "trip_finalize" : "trip_update",
      args: action === "finalize" ? { trip_id: tripId, ...extra } : { trip_id: tripId, action, ...extra },
    }),
  });
  const body = await response.json().catch(() => ({ result: "Travel action failed" }));
  const result = String(body.result ?? "");
  if (!response.ok || /^Tool failed:/i.test(result)) throw new Error(result || "Travel action failed");
  return result;
}

async function retryTrip(tripId: string, doc: any) {
  const response = await viewerFetch("/api/tools", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "trip_plan",
      args: {
        trip_id: tripId,
        destination: doc.destination,
        dest_iata: doc.destIata,
        origin_iata: doc.origin,
        depart_date: doc.departDate,
        return_date: doc.returnDate,
        adults: doc.adults,
        budget_total_gbp: doc.budgetGbp,
        include_flights: doc.includeFlights !== false,
        vibe: doc.vibe,
      },
    }),
  });
  const body = await response.json().catch(() => ({ result: "Travel search failed" }));
  if (!response.ok || /^Tool failed:/i.test(String(body.result ?? ""))) throw new Error(String(body.result ?? "Travel search failed"));
}

const gbp = (n?: number) => (n != null ? `£${Math.round(n).toLocaleString("en-GB")}` : "£?");

const itineraryItemKey = (day: ItineraryDay, item: ItineraryItem, index: number) => item.id ?? `${day.date}:${index}:${item.title}`;

const itineraryKindColor = (kind?: string) => {
  if (kind === "flight") return "bg-amber";
  if (kind === "hotel" || kind === "stay") return "bg-cyan";
  if (kind === "transfer") return "bg-slate";
  return "bg-sky-400";
};

export function TripTimeline({
  days,
  activeDate,
  onSelectDay,
}: {
  days: ItineraryDay[];
  activeDate: string | null;
  onSelectDay: (date: string) => void;
}) {
  const day = days.find((candidate) => candidate.date === activeDate) ?? days[0];
  if (!day) {
    return (
      <div className={`${GLASS} p-4 text-center text-[12px] text-slate`}>
        Pick places to build a dated itinerary. JARVIS will add route timing only when a real route is available.
      </div>
    );
  }

  const route = day.route;
  const routeFacts = [durationSecondsText(route?.durationSeconds), distanceText(route?.distanceMeters)].filter(Boolean);
  const routeLabel = routeStatusText(route);
  const incomingLegFor = (item: ItineraryItem) =>
    item.id ? route?.legs?.find((leg) => leg.toItemId === item.id) : undefined;

  return (
    <section aria-label="Itinerary timeline" className="space-y-2.5">
      {days.length > 1 && (
        <div role="tablist" aria-label="Itinerary days" className="flex gap-1 overflow-x-auto pb-0.5">
          {days.map((candidate) => {
            const active = candidate.date === day.date;
            return (
              <button
                key={candidate.date}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => onSelectDay(candidate.date)}
                className={`shrink-0 rounded-lg px-2.5 py-1.5 text-left text-[10px] transition ${active ? "bg-cyan/15 text-cyan ring-1 ring-cyan/40" : "bg-white/[0.035] text-slate ring-1 ring-white/10 hover:text-ice"}`}
              >
                <span className="block font-medium uppercase tracking-wider">{candidate.label ?? candidate.date}</span>
                <span className="block text-[9px] opacity-70">{candidate.items?.length ?? 0} stops</span>
              </button>
            );
          })}
        </div>
      )}

      <div className={`${GLASS} overflow-hidden p-2.5`}>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-x-2 gap-y-1 px-0.5">
          <div>
            <div className="hud-label">{day.label ?? day.date}</div>
            {day.status && <div className="mt-0.5 text-[9px] uppercase tracking-wider text-slate">{day.status.replace(/_/g, " ")}</div>}
          </div>
          {routeLabel && <span className={`rounded-full border px-2 py-0.5 text-[9px] uppercase tracking-wider ${route?.status === "unavailable" ? "border-amber/30 text-amber" : "border-cyan/30 text-cyan"}`}>{routeLabel}</span>}
        </div>

        {route && (
          <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-white/8 bg-black/20 px-2 py-1.5 text-[10px] text-slate">
            {routeModeLabel(route.mode) && <span className="uppercase tracking-wider text-ice/85">{routeModeLabel(route.mode)}</span>}
            {routeFacts.map((fact) => <span key={fact}>{fact}</span>)}
            {route.attribution && <span className="ml-auto text-[9px] text-slate/70">{route.attribution}</span>}
          </div>
        )}

        <div className="space-y-1.5">
          {(day.items ?? []).map((item, index) => {
            const itemKey = itineraryItemKey(day, item, index);
            const incomingLeg = incomingLegFor(item);
            const transferFacts = [routeModeLabel(route?.mode), durationSecondsText(incomingLeg?.durationSeconds), distanceText(incomingLeg?.distanceMeters)].filter(Boolean);
            const visitDuration = durationText(item.durationMinutes);
            return (
              <div key={itemKey} data-itinerary-item={itemKey}>
                {incomingLeg && transferFacts.length > 0 && (
                  <div className="ml-4 flex min-h-7 items-center gap-2 border-l border-dashed border-cyan/30 pl-3 text-[10px] text-cyan/90" aria-label={`Transfer to ${item.title}`}>
                    <span aria-hidden>↓</span>
                    <span>{transferFacts.join(" · ")}</span>
                  </div>
                )}
                <article className="flex gap-2.5 rounded-lg border border-white/8 bg-black/20 p-2.5 backdrop-blur-md transition hover:border-cyan/25">
                  <div className="w-[3.35rem] shrink-0 pt-0.5 text-right font-mono text-[11px] text-cyan">
                    {item.time || "time tbd"}
                  </div>
                  <span className={`mt-0.5 h-8 w-0.5 shrink-0 rounded ${itineraryKindColor(item.kind)}`} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-start justify-between gap-x-2 gap-y-0.5">
                      <div className="min-w-0 text-[13px] font-medium text-ice">
                        {item.link ? (
                          <a href={item.link} target="_blank" rel="noreferrer" className="hover:text-cyan">
                            {item.title} ↗
                          </a>
                        ) : (
                          item.title
                        )}
                      </div>
                      {visitDuration && <span className="shrink-0 rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-slate">allow {visitDuration}</span>}
                    </div>
                    <div className="mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] text-slate">
                      {item.kind && <span className="uppercase tracking-wider">{item.kind.replace(/_/g, " ")}</span>}
                      {item.source && <span>{item.source}</span>}
                      {item.note && <span>{item.note}</span>}
                    </div>
                  </div>
                </article>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

type EditableDayStop = { name: string; time: string };

/**
 * A compact, owner-operated editor for the active day. It sends semantic
 * actions back through the normal protected tools route; it never writes a
 * calendar event or mutates a route client-side.
 */
export function TripDayControls({
  day,
  availableActivities,
  busy,
  onSelectDay,
  onSave,
  onLock,
}: {
  day: ItineraryDay;
  availableActivities: Array<{ name: string }>;
  busy: boolean;
  onSelectDay: (date: string) => void;
  onSave: (payload: { activities: string[]; times: string[]; transport_mode: string }) => void;
  onLock: (locked: boolean) => void;
}) {
  const signature = JSON.stringify({
    date: day.date,
    routeMode: day.route?.mode,
    items: (day.items ?? []).filter((item) => item.kind === "activity").map((item) => [item.placeId ?? item.title, item.time ?? ""]),
  });
  const initialRows = (): EditableDayStop[] =>
    (day.items ?? [])
      .filter((item) => item.kind === "activity")
      .map((item) => ({ name: item.placeId ?? item.title, time: item.time ?? "" }));
  const [rows, setRows] = useState<EditableDayStop[]>(initialRows);
  const [mode, setMode] = useState(day.route?.mode ?? "walking");
  const [addName, setAddName] = useState("");

  useEffect(() => {
    setRows(initialRows());
    setMode(day.route?.mode ?? "walking");
    setAddName("");
    // `signature` is deliberately a compact value rather than the whole day
    // object so unrelated reactive provider updates do not reset this editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  const locked = day.status === "locked";
  const choices = availableActivities.filter((activity) => !rows.some((row) => row.name === activity.name));
  const updateRow = (index: number, patch: Partial<EditableDayStop>) =>
    setRows((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row));
  const move = (index: number, direction: -1 | 1) =>
    setRows((current) => {
      const target = index + direction;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });

  return (
    <section aria-label="Edit active itinerary day" className={`${GLASS} space-y-2.5 p-2.5`}>
      <div className="flex flex-wrap items-end justify-between gap-2">
        <label className="grid gap-1 text-[9px] uppercase tracking-wider text-slate">
          Plan date
          <input
            aria-label="Plan date"
            type="date"
            value={day.date}
            onChange={(event) => onSelectDay(event.target.value)}
            className="rounded-md border border-white/10 bg-black/25 px-2 py-1 text-[11px] text-ice outline-none focus:border-cyan/50"
          />
        </label>
        <label className="grid gap-1 text-[9px] uppercase tracking-wider text-slate">
          Transport
          <select
            aria-label="Transport mode"
            value={mode}
            disabled={busy || locked}
            onChange={(event) => setMode(event.target.value)}
            className="rounded-md border border-white/10 bg-black/25 px-2 py-1 text-[11px] text-ice outline-none focus:border-cyan/50 disabled:opacity-45"
          >
            <option value="walking">walk</option>
            <option value="bicycling">cycle</option>
            <option value="driving">drive</option>
            <option value="transit">transit</option>
          </select>
        </label>
      </div>

      <div className="space-y-1.5">
        {rows.map((row, index) => (
          <div key={row.name} className="flex items-center gap-1.5 rounded-lg border border-white/8 bg-black/20 px-2 py-1.5">
            <input
              aria-label={`Time for ${row.name}`}
              type="time"
              value={row.time}
              disabled={busy || locked}
              onChange={(event) => updateRow(index, { time: event.target.value })}
              className="w-[4.8rem] rounded bg-black/30 px-1 py-0.5 font-mono text-[10px] text-cyan outline-none ring-1 ring-white/10 disabled:opacity-45"
            />
            <span className="min-w-0 flex-1 truncate text-[11px] text-ice">{row.name}</span>
            <button type="button" aria-label={`Move ${row.name} earlier`} disabled={busy || locked || index === 0} onClick={() => move(index, -1)} className="rounded px-1 text-slate hover:text-cyan disabled:opacity-25">↑</button>
            <button type="button" aria-label={`Move ${row.name} later`} disabled={busy || locked || index === rows.length - 1} onClick={() => move(index, 1)} className="rounded px-1 text-slate hover:text-cyan disabled:opacity-25">↓</button>
            <button type="button" aria-label={`Remove ${row.name}`} disabled={busy || locked} onClick={() => setRows((current) => current.filter((_, rowIndex) => rowIndex !== index))} className="rounded px-1 text-slate hover:text-red-300 disabled:opacity-25">×</button>
          </div>
        ))}
        {!rows.length && <div className="rounded-lg border border-dashed border-white/10 px-2 py-2 text-[10px] text-slate">Add mapped places to route this day.</div>}
      </div>

      {choices.length > 0 && (
        <div className="flex gap-1.5">
          <select
            aria-label="Add activity to active day"
            value={addName}
            disabled={busy || locked}
            onChange={(event) => setAddName(event.target.value)}
            className="min-w-0 flex-1 rounded-md border border-white/10 bg-black/25 px-2 py-1 text-[10px] text-ice outline-none focus:border-cyan/50 disabled:opacity-45"
          >
            <option value="">add a mapped place…</option>
            {choices.map((activity) => <option key={activity.name} value={activity.name}>{activity.name}</option>)}
          </select>
          <button
            type="button"
            disabled={busy || locked || !addName}
            onClick={() => {
              if (!addName) return;
              setRows((current) => [...current, { name: addName, time: "" }]);
              setAddName("");
            }}
            className="rounded-md bg-white/5 px-2 text-[10px] text-ice ring-1 ring-white/10 hover:text-cyan disabled:opacity-35"
          >
            add
          </button>
        </div>
      )}

      <div className="flex flex-wrap gap-1.5 border-t border-white/8 pt-2">
        {locked ? (
          <button type="button" disabled={busy} onClick={() => onLock(false)} className="rounded-md border border-amber/30 bg-amber/10 px-2 py-1 text-[10px] text-amber hover:bg-amber/15 disabled:opacity-40">unlock day</button>
        ) : (
          <>
            <button
              type="button"
              disabled={busy || rows.length === 0}
              onClick={() => onSave({ activities: rows.map((row) => row.name), times: rows.map((row) => row.time), transport_mode: mode })}
              className="rounded-md bg-cyan/15 px-2 py-1 text-[10px] text-cyan ring-1 ring-cyan/35 hover:bg-cyan/25 disabled:opacity-35"
            >
              save route & times
            </button>
            <button type="button" disabled={busy || rows.length === 0} onClick={() => onLock(true)} className="rounded-md bg-white/5 px-2 py-1 text-[10px] text-ice ring-1 ring-white/10 hover:text-cyan disabled:opacity-35">lock day</button>
          </>
        )}
        <span className="ml-auto self-center text-right text-[9px] text-slate">Calendar remains separate and requires protected approval.</span>
      </div>
    </section>
  );
}

export default function TripView({ value }: { value: string }) {
  let creationId = "";
  try {
    creationId = JSON.parse(value)?.creationId ?? "";
  } catch {
    /* noop */
  }
  const row = useJarvisQuery(api.creations.get, creationId ? { id: creationId as never } : "skip") as any;
  const doc: TripDoc | null = useMemo(() => {
    try {
      return row?.data ? JSON.parse(row.data) : null;
    } catch {
      return null;
    }
  }, [row?.data]);

  const [tab, setTab] = useState<"stays" | "flights" | "activities" | "plan">("stays");
  const [selected, setSelected] = useState<string | null>(null);
  const [activePlanDate, setActivePlanDate] = useState<string | null>(null);
  const [maxNight, setMaxNight] = useState<number>(0);
  const [minRating, setMinRating] = useState<number>(0);
  const [freeCancel, setFreeCancel] = useState(false);
  const [amenity, setAmenity] = useState("");
  const [sortBy, setSortBy] = useState<"value" | "price" | "rating">("value");
  const [busy, setBusy] = useState("");
  const [actionError, setActionError] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  const itineraryDays = useMemo(
    () =>
      Array.isArray(doc?.itinerary)
        ? doc.itinerary.filter(
            (day: unknown): day is ItineraryDay =>
              Boolean(day) && typeof day === "object" && typeof (day as ItineraryDay).date === "string" && Array.isArray((day as ItineraryDay).items),
          )
        : [],
    [doc?.itinerary],
  );
  const activePlanDay = useMemo(
    () => itineraryDays.find((day) => day.date === activePlanDate) ?? itineraryDays[0] ?? null,
    [activePlanDate, itineraryDays],
  );

  const markers: Marker[] = useMemo(() => {
    if (!doc) return [];
    const ms: Marker[] = [];
    const addMarker = (marker: Marker) => {
      if (!ms.some((existing) => existing.lat === marker.lat && existing.lng === marker.lng && existing.kind === marker.kind)) ms.push(marker);
    };
    for (const s of doc.stays ?? [])
      if (validLatLng(s.lat, s.lng)) addMarker({ key: `stay:${s.name}`, lat: s.lat, lng: s.lng, kind: "stay", name: s.name, locked: doc.locked?.stay?.name === s.name });
    for (const a of doc.activities ?? [])
      if (validLatLng(a.lat, a.lng))
        addMarker({ key: `act:${a.name}`, lat: a.lat, lng: a.lng, kind: "activity", name: a.name, locked: (doc.locked?.activities ?? []).includes(a.name) });
    if (validLatLng(doc.airport?.lat, doc.airport?.lng)) addMarker({ key: "airport", lat: doc.airport.lat, lng: doc.airport.lng, kind: "airport", name: doc.airport.name });
    for (const day of itineraryDays) {
      day.items.forEach((item, index) => {
        const lat = Number(item.lat);
        const lng = Number(item.lng);
        if (!validLatLng(lat, lng)) return;
        const kind: Marker["kind"] = item.kind === "flight" ? "airport" : item.kind === "hotel" || item.kind === "stay" ? "stay" : "activity";
        addMarker({
          key: `it:${itineraryItemKey(day, item, index)}`,
          lat,
          lng,
          kind,
          name: item.title,
          locked: item.source === "confirmed" || doc.status === "planned",
        });
      });
    }
    return ms;
  }, [doc, itineraryDays]);

  if (!doc)
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-slate">
        <span className="mr-2 h-2 w-2 animate-ping rounded-full bg-cyan" /> loading trip…
      </div>
    );

  const act = async (label: string, action: string, extra: Record<string, unknown> = {}) => {
    setBusy(label);
    setActionError("");
    try {
      await tripTool(creationId, action, extra);
    } catch (error: any) {
      setActionError(String(error?.message ?? error));
    } finally {
      setBusy("");
    }
  };

  const stays = (doc.stays ?? [])
    .filter(
      (s: any) =>
        (!maxNight || (s.priceGbp ?? 9e9) <= maxNight) &&
        (!minRating || (s.rating ?? 0) >= minRating) &&
        (!freeCancel || s.freeCancellation) &&
        (!amenity || (s.amenities ?? []).join(" ").toLowerCase().includes(amenity.toLowerCase())),
    )
    .sort((a: any, b: any) =>
      sortBy === "price"
        ? (a.priceGbp ?? 9e9) - (b.priceGbp ?? 9e9)
        : sortBy === "rating"
          ? (b.rating ?? 0) - (a.rating ?? 0)
          : (b.rating ?? 3) ** 2 / (b.priceGbp ?? 200) - (a.rating ?? 3) ** 2 / (a.priceGbp ?? 200),
    );
  const totals = doc.totals ?? { total: 0, flights: 0, stay: 0, activitiesEst: 0 };
  const projectedTotal = totals.projectedTotal ?? totals.total ?? 0;
  const lockedTotal = totals.lockedTotal ?? 0;
  const over = projectedTotal > doc.budgetGbp;
  const nights = Math.max(1, Math.round((Date.parse(doc.returnDate || doc.departDate) - Date.parse(doc.departDate)) / 86_400_000)) || 1;
  const providerEntries = Object.entries(doc.providers ?? {}) as [string, any][];
  const searchingProviders = providerEntries.filter(([, provider]) => ["queued", "searching"].includes(provider.status));
  const failedProviders = providerEntries.filter(([, provider]) => provider.status === "error");
  const searchFinished = providerEntries.length > 0 && providerEntries.every(([, provider]) => ["ready", "error", "skipped"].includes(provider.status));
  const steps = [
    { label: "Search", done: searchFinished, active: !searchFinished },
    { label: "Stay", done: Boolean(doc.locked?.stay), active: searchFinished && !doc.locked?.stay },
    { label: "Flight", done: doc.includeFlights === false || Boolean(doc.locked?.flight), active: Boolean(doc.locked?.stay) && doc.includeFlights !== false && !doc.locked?.flight },
    { label: "Plan", done: doc.status === "planned", active: Boolean(doc.locked?.stay) && (doc.includeFlights === false || Boolean(doc.locked?.flight)) && doc.status !== "planned" },
  ];

  const onMapSelect = (key: string) => {
    setSelected(key);
    if (key.startsWith("stay:")) setTab("stays");
    else if (key.startsWith("act:")) setTab("activities");
    else if (key.startsWith("it:")) setTab("plan");
    const name = key.split(":").slice(1).join(":");
    setTimeout(() => {
      const target = key.startsWith("it:")
        ? listRef.current?.querySelector(`[data-itinerary-item="${CSS.escape(name)}"]`)
        : listRef.current?.querySelector(`[data-name="${CSS.escape(name)}"]`);
      target?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 60);
  };

  const glass = GLASS;
  return (
    <div className="flex min-h-0 flex-1 flex-col @min-[760px]:flex-row">
      {/* the map */}
      <div className="relative h-[30dvh] shrink-0 border-b border-white/5 @min-[760px]:h-auto @min-[760px]:w-[44%] @min-[760px]:border-b-0 @min-[760px]:border-r">
        <MapView center={doc.center ?? { lat: 51.5074, lng: -0.1278 }} markers={markers} route={activePlanDay?.route} selected={selected} onSelect={onMapSelect} />
        <div className="pointer-events-none absolute left-3 top-3 rounded-lg bg-black/50 px-2 py-1 backdrop-blur">
          <div className="text-sm font-semibold text-ice">{doc.destination}</div>
          <div className="hud-label !text-[9px]">
            {doc.departDate || "dates tbd"}{doc.returnDate ? ` → ${doc.returnDate}` : ""} · {doc.adults} adults
          </div>
        </div>
        {activePlanDay?.route && (
          <div className="pointer-events-none absolute right-3 top-3 max-w-[52%] rounded-lg border border-white/10 bg-black/55 px-2 py-1.5 text-right backdrop-blur">
            <div className="text-[10px] font-medium text-ice">{activePlanDay.label ?? activePlanDay.date}</div>
            <div className="mt-0.5 text-[9px] uppercase tracking-wider text-cyan">
              {[routeModeLabel(activePlanDay.route.mode), routeStatusText(activePlanDay.route)].filter(Boolean).join(" · ")}
            </div>
            {[durationSecondsText(activePlanDay.route.durationSeconds), distanceText(activePlanDay.route.distanceMeters)].filter(Boolean).length > 0 && (
              <div className="mt-0.5 text-[10px] text-slate">
                {[durationSecondsText(activePlanDay.route.durationSeconds), distanceText(activePlanDay.route.distanceMeters)].filter(Boolean).join(" · ")}
              </div>
            )}
          </div>
        )}
        <div className="pointer-events-none absolute bottom-2 left-3 flex gap-3 rounded-lg bg-black/50 px-2 py-1 text-[9px] uppercase tracking-widest text-slate backdrop-blur">
          <span><span className="mr-1 inline-block h-2 w-2 rounded-full align-middle" style={{ background: KIND_COLOR.stay }} />stays</span>
          <span><span className="mr-1 inline-block h-2 w-2 rounded-full align-middle" style={{ background: KIND_COLOR.activity }} />activities</span>
          <span><span className="mr-1 inline-block h-2 w-2 rounded-full align-middle" style={{ background: KIND_COLOR.airport }} />airport</span>
        </div>
      </div>

      {/* the workspace */}
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="border-b border-white/5 px-3 py-2">
          <div className="flex items-center gap-1.5 overflow-x-auto">
            {steps.map((step, index) => (
              <div key={step.label} className={`flex shrink-0 items-center gap-1 text-[9px] uppercase tracking-wider ${step.done ? "text-emerald-400" : step.active ? "text-cyan" : "text-slate/60"}`}>
                <span className={`grid h-4 w-4 place-items-center rounded-full border text-[8px] ${step.done ? "border-emerald-400/50 bg-emerald-400/10" : step.active ? "border-cyan/50 bg-cyan/10" : "border-white/10"}`}>
                  {step.done ? "✓" : index + 1}
                </span>
                {step.label}
                {index < steps.length - 1 && <span className="mx-0.5 text-white/10">›</span>}
              </div>
            ))}
          </div>
          {providerEntries.length > 0 && (
            <div className="mt-1.5 flex flex-wrap items-center gap-1">
              {providerEntries.map(([name, provider]) => (
                <span
                  key={name}
                  title={provider.error || `${provider.source}${provider.checkedAt ? ` · checked ${new Date(provider.checkedAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}` : ""}`}
                  className={`flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[8px] uppercase tracking-wider ${provider.status === "error" ? "border-red-400/30 text-red-300" : provider.status === "searching" || provider.status === "queued" ? "border-cyan/25 text-cyan" : provider.status === "skipped" ? "border-white/8 text-slate" : "border-emerald-400/25 text-emerald-300"}`}
                >
                  <span className={`h-1 w-1 rounded-full ${provider.status === "error" ? "bg-red-400" : provider.status === "searching" || provider.status === "queued" ? "animate-pulse bg-cyan" : provider.status === "skipped" ? "bg-slate" : "bg-emerald-400"}`} />
                  {name} · {provider.status}{provider.count != null ? ` ${provider.count}` : ""}
                </span>
              ))}
              {searchingProviders.length > 0 && <span className="ml-auto animate-pulse text-[9px] text-cyan">results arriving live…</span>}
              {failedProviders.length > 0 && (
                <button
                  type="button"
                  disabled={Boolean(busy)}
                  onClick={() => {
                    setBusy("retrying providers");
                    setActionError("");
                    void retryTrip(creationId, doc)
                      .catch((error: any) => setActionError(String(error?.message ?? error)))
                      .finally(() => setBusy(""));
                  }}
                  className="ml-auto text-[9px] uppercase tracking-wider text-red-300 hover:text-red-200 disabled:opacity-40"
                >
                  retry failed
                </button>
              )}
            </div>
          )}
          {actionError && <div className="mt-1.5 rounded border border-red-400/20 bg-red-400/5 px-2 py-1 text-[10px] text-red-300">{actionError}</div>}
        </div>
        <div className="border-b border-white/5 px-3 pb-2 pt-2.5">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
            <span className="text-ice">
              {gbp(projectedTotal)} <span className="text-slate">projected of {gbp(doc.budgetGbp)}</span>
              <span className="ml-2 text-xs text-cyan">{gbp(lockedTotal)} locked</span>
              <span className="ml-2 text-xs text-slate">≈ {gbp(Math.round((doc.budgetGbp || 0) / nights))}/day budget</span>
            </span>
            <span className={`text-xs ${over ? "text-red-400" : "text-cyan"}`}>
              {over ? `${gbp(projectedTotal - doc.budgetGbp)} over` : `${gbp(doc.budgetGbp - projectedTotal)} headroom`}
            </span>
          </div>
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/5">
            <div
              className={`h-full rounded-full transition-all duration-700 ${over ? "bg-red-400" : "bg-gradient-to-r from-cyan/50 to-cyan"}`}
              style={{ width: `${Math.min(100, (projectedTotal / Math.max(1, doc.budgetGbp)) * 100)}%` }}
            />
          </div>
        </div>
        <div className="flex items-center gap-1 overflow-x-auto border-b border-white/5 px-2 py-1.5">
          {(["stays", "flights", "activities", "plan"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`shrink-0 rounded-full px-3 py-1 text-[11px] uppercase tracking-widest transition ${tab === t ? "bg-cyan/15 text-cyan ring-1 ring-cyan/40" : "text-slate hover:text-ice"}`}
            >
              {t}
              {t === "stays" ? ` ${stays.length}` : t === "flights" ? ` ${(doc.flights ?? []).length}` : t === "activities" ? ` ${(doc.activities ?? []).length}` : ""}
            </button>
          ))}
          {busy && <span className="ml-auto shrink-0 animate-pulse text-[10px] text-cyan">{busy}…</span>}
        </div>

        <div ref={listRef} key={tab} className="rise scrollbar-thin min-h-0 flex-1 space-y-2.5 overflow-auto p-3">
          {tab === "stays" && (
            <>
              <div className="flex flex-wrap items-center gap-2 pb-1 text-[11px] text-slate">
                <label className="flex items-center gap-1">
                  ≤£
                  <input
                    type="number"
                    value={maxNight || ""}
                    placeholder="night"
                    onChange={(e) => setMaxNight(Number(e.target.value) || 0)}
                    className="w-16 rounded bg-black/30 px-1.5 py-0.5 text-ice outline-none ring-1 ring-white/10"
                  />
                </label>
                <select value={minRating} onChange={(e) => setMinRating(Number(e.target.value))} className="rounded bg-black/30 px-1.5 py-0.5 text-ice outline-none ring-1 ring-white/10">
                  <option value={0}>any ★</option>
                  <option value={4}>4.0+</option>
                  <option value={4.4}>4.4+</option>
                  <option value={4.7}>4.7+</option>
                </select>
                <button onClick={() => setFreeCancel(!freeCancel)} className={`rounded px-1.5 py-0.5 ring-1 ${freeCancel ? "text-cyan ring-cyan/50" : "ring-white/10"}`}>
                  free cancel
                </button>
                <input
                  value={amenity}
                  onChange={(e) => setAmenity(e.target.value)}
                  placeholder="amenity: pool…"
                  className="w-26 rounded bg-black/30 px-1.5 py-0.5 text-ice outline-none ring-1 ring-white/10"
                />
                <select value={sortBy} onChange={(e) => setSortBy(e.target.value as never)} className="ml-auto rounded bg-black/30 px-1.5 py-0.5 text-ice outline-none ring-1 ring-white/10">
                  <option value="value">best value</option>
                  <option value="price">cheapest</option>
                  <option value="rating">top rated</option>
                </select>
              </div>
              {!doc.stays?.length && ["queued", "searching"].includes(doc.providers?.stays?.status) && (
                <div className={`${glass} animate-pulse p-5 text-center text-sm text-cyan`}>Searching stays — the first page will appear here as soon as it lands…</div>
              )}
              {!doc.stays?.length && doc.providers?.stays?.status === "error" && (
                <div className={`${glass} border-red-400/20 p-5 text-center text-sm text-red-300`}>Stay search failed: {doc.providers.stays.error ?? "provider unavailable"}. Use retry above.</div>
              )}
              {!doc.stays?.length && doc.providers?.stays?.status === "ready" && (
                <div className={`${glass} p-5 text-center text-sm text-slate`}>No stays matched this budget. Raise the nightly cap or ask JARVIS to widen the search.</div>
              )}
              {!!doc.stays?.length && !stays.length && (
                <div className={`${glass} p-5 text-center text-sm text-slate`}>No stays match these filters. Clear one or more filters to see the full shortlist.</div>
              )}
              {stays.map((s: any) => {
                const locked = doc.locked?.stay?.name === s.name;
                const sel = selected === `stay:${s.name}`;
                return (
                  <div key={s.name} data-name={s.name} className={`${glass} card-lift flex gap-3 p-2.5 ${locked ? "ring-1 ring-cyan/60" : sel ? "ring-1 ring-white/30" : ""}`}>
                    {s.image || s.thumb ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={s.image ?? s.thumb} alt="" className="h-24 w-32 shrink-0 rounded-lg object-cover" />
                    ) : (
                      <div className="flex h-24 w-32 shrink-0 items-center justify-center rounded-lg bg-cyan/5 text-2xl">🏨</div>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="truncate text-[13px] font-semibold text-ice">{s.name}</span>
                        <span className="shrink-0 text-[13px] text-cyan">
                          {gbp(s.priceGbp)}<span className="text-slate">/n</span> · {gbp(s.totalGbp)} <span className="text-slate">total</span>
                        </span>
                      </div>
                      <div className="mt-0.5 text-[11px] text-slate">
                        ★{s.rating ? Math.round(s.rating * 10) / 10 : "?"} {s.hotelClass ? "· " + "⭑".repeat(s.hotelClass) : ""} {s.propertyType ? `· ${s.propertyType}` : ""} {s.freeCancellation ? "· free cancellation" : ""}
                      </div>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {(s.amenities ?? []).map((a: string) => (
                          <span key={a} className="rounded bg-cyan/10 px-1.5 py-px text-[10px] text-cyan/90">{a}</span>
                        ))}
                      </div>
                      <div className="mt-1.5 flex gap-2">
                        <a href={s.link} target="_blank" rel="noreferrer" className="rounded-lg bg-white/5 px-2 py-1 text-[11px] text-ice ring-1 ring-white/10 transition hover:text-cyan">
                          book on Booking ↗
                        </a>
                        {s.googleLink && (
                          <a href={s.googleLink} target="_blank" rel="noreferrer" className="rounded-lg bg-white/5 px-2 py-1 text-[11px] text-slate ring-1 ring-white/10 transition hover:text-cyan">
                            details ↗
                          </a>
                        )}
                        <button
                          onClick={() => void act(`locking ${s.name}`, "lock_stay", { stay: s.name })}
                          className={`ml-auto rounded-lg px-3 py-1 text-[11px] font-medium ${locked ? "bg-cyan/20 text-cyan ring-1 ring-cyan/50" : "bg-white/5 text-slate ring-1 ring-white/10 hover:text-ice"}`}
                        >
                          {locked ? "locked ✓" : "lock in"}
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </>
          )}

          {tab === "flights" && (
            <>
              {!(doc.flights ?? []).length && ["queued", "searching"].includes(doc.providers?.flights?.status) && (
                <div className={`${glass} animate-pulse p-5 text-center text-sm text-cyan`}>Searching return fares…</div>
              )}
              {!(doc.flights ?? []).length && doc.providers?.flights?.status === "error" && (
                <div className={`${glass} border-red-400/20 p-5 text-center text-sm text-red-300`}>Flight search failed: {doc.providers.flights.error ?? "provider unavailable"}. Use retry above.</div>
              )}
              {!(doc.flights ?? []).length && doc.providers?.flights?.status === "skipped" && (
                <div className={`${glass} p-5 text-center text-sm text-slate`}>Flights were intentionally left out of this trip.</div>
              )}
              {!(doc.flights ?? []).length && doc.providers?.flights?.status === "ready" && (
                <div className={`${glass} p-5 text-center text-sm text-slate`}>No return fares were found for these airports and dates.</div>
              )}
              {(doc.flights ?? []).map((f: any, i: number) => {
                const locked = doc.locked?.flight && doc.locked.flight.departTime === f.departTime && doc.locked.flight.priceGbp === f.priceGbp;
                return (
                  <div key={i} className={`${glass} card-lift flex items-center gap-3 p-3 ${locked ? "ring-1 ring-cyan/60" : ""}`}>
                    {f.airlineLogo ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={f.airlineLogo} alt="" className="h-10 w-10 shrink-0 rounded bg-white/90 object-contain p-0.5" />
                    ) : (
                      <span className="text-xl">✈</span>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between">
                        <span className="truncate text-[13px] font-semibold text-ice">{f.airline ?? "flight"} · {f.stops === 0 ? "direct" : `${f.stops} stop`}</span>
                        <span className="text-[13px] text-cyan">{gbp(f.priceGbp)}<span className="text-slate">/pp</span></span>
                      </div>
                      <div className="text-[11px] text-slate">
                        {f.departTime} → {f.arriveTime} · {Math.round(((f.durationMin ?? 0) / 60) * 10) / 10}h
                      </div>
                      {f.roundTrip && <div className="text-[10px] text-amber">return fare · outbound schedule shown</div>}
                      <div className="mt-1 flex gap-2">
                        <a href={f.bookLink} target="_blank" rel="noreferrer" className="rounded-lg bg-white/5 px-2 py-1 text-[11px] text-ice ring-1 ring-white/10 transition hover:text-cyan">
                          book ↗
                        </a>
                        <button
                          onClick={() => void act("locking flight", "lock_flight", { flight_index: i + 1 })}
                          className={`ml-auto rounded-lg px-3 py-1 text-[11px] font-medium ${locked ? "bg-cyan/20 text-cyan ring-1 ring-cyan/50" : "bg-white/5 text-slate ring-1 ring-white/10 hover:text-ice"}`}
                        >
                          {locked ? "locked ✓" : "lock in"}
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </>
          )}

          {tab === "activities" && (
            <>
              {!(doc.activities ?? []).length && ["queued", "searching"].includes(doc.providers?.activities?.status) && (
                <div className={`${glass} animate-pulse p-5 text-center text-sm text-cyan`}>Finding useful places and visual highlights…</div>
              )}
              {!(doc.activities ?? []).length && doc.providers?.activities?.status === "error" && (
                <div className={`${glass} border-red-400/20 p-5 text-center text-sm text-red-300`}>Activity search failed: {doc.providers.activities.error ?? "provider unavailable"}. Use retry above.</div>
              )}
              {!(doc.activities ?? []).length && doc.providers?.activities?.status === "ready" && (
                <div className={`${glass} p-5 text-center text-sm text-slate`}>No activities were returned for this destination.</div>
              )}
              {(doc.activities ?? []).map((a: any) => {
              const picked = (doc.locked?.activities ?? []).includes(a.name);
              const sel = selected === `act:${a.name}`;
              return (
                <div key={a.name} data-name={a.name} className={`${glass} card-lift flex items-center gap-3 p-2.5 ${picked ? "ring-1 ring-sky-400/60" : sel ? "ring-1 ring-white/30" : ""}`}>
                  {a.photo ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={a.photo} alt="" className="h-20 w-28 shrink-0 rounded-lg object-cover" />
                  ) : (
                    <span className="flex h-20 w-28 shrink-0 items-center justify-center rounded-lg bg-sky-400/10 text-xl">📍</span>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-semibold text-ice">{a.name}</div>
                    <div className="text-[11px] text-slate">★{a.rating ? Math.round(a.rating * 10) / 10 : "?"} ({(a.ratings ?? 0).toLocaleString("en-GB")} reviews)</div>
                    {a.address && <div className="truncate text-[10px] text-slate/70">{a.address}</div>}
                    <div className="mt-1 flex gap-2">
                      <a href={a.mapsLink} target="_blank" rel="noreferrer" className="rounded-lg bg-white/5 px-2 py-1 text-[11px] text-ice ring-1 ring-white/10 transition hover:text-cyan">
                        maps ↗
                      </a>
                      <button
                        onClick={() => void act(picked ? "removing" : "adding", "toggle_activity", { activity: a.name })}
                        className={`ml-auto rounded-lg px-3 py-1 text-[11px] font-medium ${picked ? "bg-sky-400/20 text-sky-300 ring-1 ring-sky-400/50" : "bg-white/5 text-slate ring-1 ring-white/10 hover:text-ice"}`}
                      >
                        {picked ? "in plan ✓" : "+ add"}
                      </button>
                    </div>
                  </div>
                </div>
              );
              })}
            </>
          )}

          {tab === "plan" && (
            <>
              <div className={`${glass} p-3 text-[13px]`}>
                <div className="hud-label mb-1.5">locked in</div>
                <div className="space-y-1 text-ice">
                  <div>✈ {doc.locked?.flight ? `${doc.locked.flight.airline} ${gbp(doc.locked.flight.priceGbp)}/pp · ${doc.locked.flight.departTime}` : <span className="text-slate">no flight locked</span>}</div>
                  <div>🏨 {doc.locked?.stay ? `${doc.locked.stay.name} · ${gbp(doc.locked.stay.totalGbp)} total` : <span className="text-slate">no stay locked</span>}</div>
                  {doc.transfer && (
                    <div>🚕 airport → hotel: {doc.transfer.durationText} · {doc.transfer.distanceText}{doc.transfer.fareText ? ` · ${doc.transfer.fareText}` : ""}</div>
                  )}
                  <div>📍 {(doc.locked?.activities ?? []).length ? doc.locked.activities.join(", ") : <span className="text-slate">no activities picked</span>}</div>
                </div>
                <div className="mt-2 grid grid-cols-4 gap-1.5 text-center text-[11px]">
                  <div className={glass + " py-1.5"}><div className="text-ice">{gbp(totals.flights)}</div><div className="text-slate">flights</div></div>
                  <div className={glass + " py-1.5"}><div className="text-ice">{gbp(totals.stay)}</div><div className="text-slate">stay</div></div>
                  <div className={glass + " py-1.5"}><div className="text-ice">{gbp(totals.activitiesEst)}</div><div className="text-slate">activities</div></div>
                  <div className={glass + " py-1.5"}><div className={over ? "text-red-400" : "text-cyan"}>{gbp(projectedTotal)}</div><div className="text-slate">projected · {gbp(Math.round(projectedTotal / nights))}/day</div></div>
                </div>
                {doc.status !== "planned" && (
                  <>
                    <button
                      onClick={() => void act("finalizing", "finalize")}
                      disabled={Boolean(busy) || !doc.locked?.stay || (doc.includeFlights !== false && (doc.flights ?? []).length > 0 && !doc.locked?.flight)}
                      className="mt-2 w-full rounded-lg bg-cyan/15 py-2 text-[13px] font-medium text-cyan ring-1 ring-cyan/40 transition hover:bg-cyan/25 disabled:opacity-40"
                    >
                      finalize reviewed plan · calendar untouched
                    </button>
                    <div className="mt-1 text-center text-[10px] text-slate">Individual Google Calendar events can be prepared separately for protected approval.</div>
                    {doc.includeFlights !== false && (doc.flights ?? []).length > 0 && !doc.locked?.flight && (
                      <div className="mt-1 text-center text-[10px] text-amber">Lock a specific flight before finalizing.</div>
                    )}
                  </>
                )}
                {doc.status === "planned" && (
                  <div className="mt-2 rounded-lg border border-emerald-400/20 bg-emerald-400/5 px-2.5 py-2 text-center text-[11px] text-emerald-300">
                    Plan finalized{doc.calendarSyncedAt ? ` · calendar synced ${new Date(doc.calendarSyncedAt).toLocaleString("en-GB")}` : " · calendar untouched"}
                  </div>
                )}
              </div>
              {activePlanDay && (
                <TripDayControls
                  day={activePlanDay}
                  availableActivities={(doc.activities ?? []).map((activity: any) => ({ name: String(activity.name ?? "") })).filter((activity: { name: string }) => activity.name)}
                  busy={Boolean(busy)}
                  onSelectDay={setActivePlanDate}
                  onSave={(payload) => void act("routing day", "schedule_day", { date: activePlanDay.date, ...payload })}
                  onLock={(locked) => void act(locked ? "locking day" : "unlocking day", locked ? "lock_day" : "unlock_day", { date: activePlanDay.date })}
                />
              )}
              <TripTimeline days={itineraryDays} activeDate={activePlanDay?.date ?? null} onSelectDay={setActivePlanDate} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
