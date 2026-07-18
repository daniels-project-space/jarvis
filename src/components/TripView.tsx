"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../convex/_generated/api";
import { useJarvisQuery } from "@/lib/secure-convex";
import { viewerFetch } from "@/lib/viewer-request";
import "maplibre-gl/dist/maplibre-gl.css";

// The trip planner panel: a REAL dark 3D map (MapLibre globe projection on
// Carto's dark-matter street basemap — streets appear as you zoom) with every
// stay/activity/airport as a glowing marker, connection lines for the locked
// plan, and the workspace beside it: budget (total AND per day), filterable
// stay cards with galleries/perks/booking links, flights, activities, and the
// finalized day-by-day plan. Lock buttons call the same trip tools the brain
// uses; everything renders reactively from the trip's creations row.

type TripDoc = any;
type Marker = { key: string; lat: number; lng: number; kind: "stay" | "activity" | "airport"; name: string; locked?: boolean };

const KIND_COLOR: Record<string, string> = { stay: "#00ff88", activity: "#5cc8ff", airport: "#ffb454" };

function MapView({
  center,
  markers,
  links,
  selected,
  onSelect,
}: {
  center: { lat: number; lng: number };
  markers: Marker[];
  links: { a: string; b: string }[];
  selected: string | null;
  onSelect: (key: string) => void;
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const markerObjs = useRef<Map<string, any>>(new Map());
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const [mapReady, setMapReady] = useState(false);

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
        map.addSource("plan-links", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        map.addLayer({
          id: "plan-links",
          type: "line",
          source: "plan-links",
          paint: { "line-color": "#ffffff", "line-width": 2, "line-opacity": 0.75, "line-dasharray": [1.5, 1.5] },
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

  // markers + fit + connection lines, reactively
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    (async () => {
      const maplibregl = (await import("maplibre-gl")).default;
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
      // fit once when markers first arrive
      if (markers.length > 2 && !(map as any).__fitted) {
        (map as any).__fitted = true;
        const b = new maplibregl.LngLatBounds();
        markers.forEach((m) => b.extend([m.lng, m.lat]));
        map.fitBounds(b, { padding: 60, pitch: 42, duration: 1600, maxZoom: 13 });
      }
      // locked-plan connection lines
      const byKey = new Map(markers.map((m) => [m.key, m]));
      const feats = links
        .filter((l) => byKey.has(l.a) && byKey.has(l.b))
        .map((l) => ({
          type: "Feature" as const,
          geometry: {
            type: "LineString" as const,
            coordinates: [
              [byKey.get(l.a)!.lng, byKey.get(l.a)!.lat],
              [byKey.get(l.b)!.lng, byKey.get(l.b)!.lat],
            ],
          },
          properties: {},
        }));
      const src = map.getSource("plan-links");
      if (src) (src as any).setData({ type: "FeatureCollection", features: feats });
    })();
  }, [markers, links, selected, mapReady]);

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
  const [maxNight, setMaxNight] = useState<number>(0);
  const [minRating, setMinRating] = useState<number>(0);
  const [freeCancel, setFreeCancel] = useState(false);
  const [amenity, setAmenity] = useState("");
  const [sortBy, setSortBy] = useState<"value" | "price" | "rating">("value");
  const [busy, setBusy] = useState("");
  const [actionError, setActionError] = useState("");
  const [syncCalendar, setSyncCalendar] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const markers: Marker[] = useMemo(() => {
    if (!doc) return [];
    const ms: Marker[] = [];
    for (const s of doc.stays ?? [])
      if (s.lat && s.lng) ms.push({ key: `stay:${s.name}`, lat: s.lat, lng: s.lng, kind: "stay", name: s.name, locked: doc.locked?.stay?.name === s.name });
    for (const a of doc.activities ?? [])
      if (a.lat && a.lng)
        ms.push({ key: `act:${a.name}`, lat: a.lat, lng: a.lng, kind: "activity", name: a.name, locked: (doc.locked?.activities ?? []).includes(a.name) });
    if (doc.airport?.lat) ms.push({ key: "airport", lat: doc.airport.lat, lng: doc.airport.lng, kind: "airport", name: doc.airport.name });
    return ms;
  }, [doc]);

  const links = useMemo(() => {
    if (!doc) return [] as { a: string; b: string }[];
    const out: { a: string; b: string }[] = [];
    const stayKey = doc.locked?.stay?.name ? `stay:${doc.locked.stay.name}` : null;
    if (stayKey && doc.airport?.lat) out.push({ a: "airport", b: stayKey });
    for (const an of doc.locked?.activities ?? []) if (stayKey) out.push({ a: stayKey, b: `act:${an}` });
    return out;
  }, [doc]);

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
    const name = key.split(":").slice(1).join(":");
    setTimeout(() => {
      listRef.current?.querySelector(`[data-name="${CSS.escape(name)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 60);
  };

  const glass = "rounded-xl border border-white/10 bg-white/[0.045] backdrop-blur-xl";
  return (
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      {/* the map */}
      <div className="relative h-[30dvh] shrink-0 border-b border-white/5 md:h-auto md:w-[44%] md:border-b-0 md:border-r">
        <MapView center={doc.center ?? { lat: 51.5074, lng: -0.1278 }} markers={markers} links={links} selected={selected} onSelect={onMapSelect} />
        <div className="pointer-events-none absolute left-3 top-3 rounded-lg bg-black/50 px-2 py-1 backdrop-blur">
          <div className="text-sm font-semibold text-ice">{doc.destination}</div>
          <div className="hud-label !text-[9px]">
            {doc.departDate || "dates tbd"}{doc.returnDate ? ` → ${doc.returnDate}` : ""} · {doc.adults} adults
          </div>
        </div>
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
                    <label className="mt-2 flex cursor-pointer items-center gap-2 rounded-lg border border-white/8 bg-black/15 px-2.5 py-2 text-[11px] text-slate">
                      <input type="checkbox" checked={syncCalendar} onChange={(event) => setSyncCalendar(event.target.checked)} className="accent-cyan" />
                      Sync the reviewed itinerary to my calendar
                    </label>
                    <button
                      onClick={() => void act("finalizing", "finalize", { add_to_calendar: syncCalendar })}
                      disabled={Boolean(busy) || !doc.locked?.stay || (doc.includeFlights !== false && (doc.flights ?? []).length > 0 && !doc.locked?.flight)}
                      className="mt-2 w-full rounded-lg bg-cyan/15 py-2 text-[13px] font-medium text-cyan ring-1 ring-cyan/40 transition hover:bg-cyan/25 disabled:opacity-40"
                    >
                      finalize reviewed plan{syncCalendar ? " + sync calendar" : " · calendar untouched"}
                    </button>
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
              {(doc.itinerary ?? []).map((day: any) => (
                <div key={day.date} className={`${glass} p-3`}>
                  <div className="hud-label mb-1">{day.label}</div>
                  <div className="space-y-1">
                    {day.items.map((it: any, i: number) => (
                      <div key={i} className="flex gap-2 text-[13px]">
                        <span className="w-12 shrink-0 font-mono text-cyan">{it.time || "—"}</span>
                        <span className={`h-4 w-0.5 shrink-0 rounded ${it.kind === "flight" ? "bg-amber" : it.kind === "hotel" ? "bg-cyan" : it.kind === "transfer" ? "bg-slate" : "bg-sky-400"}`} />
                        <span className="min-w-0 flex-1 text-ice">
                          {it.link ? (
                            <a href={it.link} target="_blank" rel="noreferrer" className="hover:text-cyan">{it.title} ↗</a>
                          ) : (
                            it.title
                          )}
                          {it.note && <span className="text-slate"> · {it.note}</span>}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
