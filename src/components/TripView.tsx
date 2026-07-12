"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import * as THREE from "three";

// The trip planner panel: a holographic globe (left) zoomed on the destination
// with every found stay/activity as a clickable marker + flight arc from home,
// and the plan workspace (right): filterable stays, flights, activities, and
// the locked plan with budget bar, transfer and itinerary. Fully interactive —
// lock buttons call the same trip_update tool the brain uses, and the panel
// re-renders reactively from the trip's creations row.

type TripDoc = any;

const LHR = { lat: 51.47, lng: -0.4543 };

function ll2v(lat: number, lng: number, r: number): THREE.Vector3 {
  const phi = ((90 - lat) * Math.PI) / 180;
  const theta = ((lng + 180) * Math.PI) / 180;
  return new THREE.Vector3(-r * Math.sin(phi) * Math.cos(theta), r * Math.cos(phi), r * Math.sin(phi) * Math.sin(theta));
}

type Marker = { key: string; lat: number; lng: number; kind: "stay" | "activity" | "airport"; name: string; locked?: boolean };

function Globe({
  center,
  markers,
  selected,
  onSelect,
}: {
  center: { lat: number; lng: number };
  markers: Marker[];
  selected: string | null;
  onSelect: (key: string) => void;
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef<{ onSelect: typeof onSelect; selected: string | null }>({ onSelect, selected });
  stateRef.current = { onSelect, selected };
  const markersRef = useRef(markers);
  markersRef.current = markers;

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const W = () => mount.clientWidth || 1;
    const H = () => mount.clientHeight || 1;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    renderer.setSize(W(), H());
    mount.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(38, W() / H(), 0.1, 1000);

    const R = 100;
    // holographic globe: graticule wireframe + soft core + atmosphere
    const core = new THREE.Mesh(
      new THREE.SphereGeometry(R - 0.6, 48, 48),
      new THREE.MeshBasicMaterial({ color: 0x061018, transparent: true, opacity: 0.92 }),
    );
    scene.add(core);
    const grid = new THREE.LineSegments(
      new THREE.WireframeGeometry(new THREE.SphereGeometry(R, 36, 24)),
      new THREE.LineBasicMaterial({ color: 0x00ff88, transparent: true, opacity: 0.09 }),
    );
    scene.add(grid);
    const glow = new THREE.Mesh(
      new THREE.SphereGeometry(R * 1.02, 48, 48),
      new THREE.MeshBasicMaterial({ color: 0x00ff88, transparent: true, opacity: 0.035, side: THREE.BackSide }),
    );
    scene.add(glow);

    // City-scale spread: exaggerate marker offsets from the centre so a city's
    // hotels don't collapse into one pixel on a planet.
    const spread = (() => {
      const ms = markersRef.current.filter((m) => m.kind !== "airport");
      const dLat = Math.max(0.02, ...ms.map((m) => Math.abs(m.lat - center.lat)));
      const dLng = Math.max(0.02, ...ms.map((m) => Math.abs(m.lng - center.lng)));
      return Math.min(60, 7 / Math.max(dLat, dLng));
    })();
    const place = (lat: number, lng: number, r: number) =>
      ll2v(center.lat + (lat - center.lat) * spread, center.lng + (lng - center.lng) * spread, r);

    const KIND_COLOR: Record<string, number> = { stay: 0x00ff88, activity: 0x5cc8ff, airport: 0xffb454 };
    const markerGroup = new THREE.Group();
    scene.add(markerGroup);
    const dots: { mesh: THREE.Mesh; m: Marker }[] = [];
    const buildMarkers = () => {
      markerGroup.clear();
      dots.length = 0;
      for (const m of markersRef.current) {
        const isSel = stateRef.current.selected === m.key;
        const size = m.locked ? 2.2 : isSel ? 1.9 : m.kind === "airport" ? 1.8 : 1.15;
        const dot = new THREE.Mesh(
          new THREE.SphereGeometry(size, 12, 12),
          new THREE.MeshBasicMaterial({ color: m.locked ? 0xffffff : KIND_COLOR[m.kind], transparent: true, opacity: isSel || m.locked ? 1 : 0.85 }),
        );
        dot.position.copy(place(m.lat, m.lng, R + 1.2));
        (dot as any).userData = m;
        markerGroup.add(dot);
        dots.push({ mesh: dot, m });
        // stalk
        const stalk = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([place(m.lat, m.lng, R), place(m.lat, m.lng, R + (m.locked ? 6 : 3))]),
          new THREE.LineBasicMaterial({ color: KIND_COLOR[m.kind], transparent: true, opacity: 0.5 }),
        );
        markerGroup.add(stalk);
        if (m.locked || isSel) {
          const ring = new THREE.Mesh(
            new THREE.RingGeometry(size + 1, size + 1.7, 24),
            new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7, side: THREE.DoubleSide }),
          );
          ring.position.copy(place(m.lat, m.lng, R + 1.4));
          ring.lookAt(0, 0, 0);
          markerGroup.add(ring);
        }
      }
    };
    buildMarkers();

    // flight arc: home → destination
    const arcPts: THREE.Vector3[] = [];
    const a = ll2v(LHR.lat, LHR.lng, R);
    const b = ll2v(center.lat, center.lng, R);
    for (let i = 0; i <= 60; i++) {
      const t = i / 60;
      const p = a.clone().lerp(b, t).normalize().multiplyScalar(R + Math.sin(Math.PI * t) * 18);
      arcPts.push(p);
    }
    scene.add(
      new THREE.Line(new THREE.BufferGeometry().setFromPoints(arcPts), new THREE.LineBasicMaterial({ color: 0xffb454, transparent: true, opacity: 0.8 })),
    );

    // camera aimed at the destination patch
    let dist = R * 2.1;
    let rotY = 0; // user drag offsets
    let rotX = 0;
    const centerDir = ll2v(center.lat, center.lng, 1).normalize();
    const positionCamera = () => {
      const base = centerDir.clone();
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rotX, rotY, 0, "YXZ"));
      camera.position.copy(base.applyQuaternion(q).multiplyScalar(dist));
      camera.lookAt(0, 0, 0);
    };
    positionCamera();

    // manual controls: drag rotates, wheel zooms, click selects markers
    let dragging = false;
    let moved = 0;
    let px = 0,
      py = 0;
    const onDown = (e: PointerEvent) => {
      dragging = true;
      moved = 0;
      px = e.clientX;
      py = e.clientY;
    };
    const onMove = (e: PointerEvent) => {
      if (!dragging) return;
      const dx = e.clientX - px;
      const dy = e.clientY - py;
      moved += Math.abs(dx) + Math.abs(dy);
      px = e.clientX;
      py = e.clientY;
      rotY -= dx * 0.005;
      rotX = Math.max(-1.2, Math.min(1.2, rotX - dy * 0.005));
      positionCamera();
    };
    const ray = new THREE.Raycaster();
    const onUp = (e: PointerEvent) => {
      dragging = false;
      if (moved > 6) return; // was a drag, not a click
      const rect = renderer.domElement.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      ray.params.Points = { threshold: 3 } as any;
      const hits = ray.intersectObjects(dots.map((d) => d.mesh));
      if (hits[0]) stateRef.current.onSelect(((hits[0].object as any).userData as Marker).key);
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      dist = Math.max(R * 1.15, Math.min(R * 3.4, dist + e.deltaY * 0.12));
      positionCamera();
    };
    renderer.domElement.addEventListener("pointerdown", onDown);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    renderer.domElement.addEventListener("wheel", onWheel, { passive: false });

    let raf = 0;
    let disposed = false;
    const tick = () => {
      if (disposed) return;
      grid.rotation.y += 0.0004;
      renderer.render(scene, camera);
      raf = requestAnimationFrame(tick);
    };
    tick();
    const onResize = () => {
      camera.aspect = W() / H();
      camera.updateProjectionMatrix();
      renderer.setSize(W(), H());
    };
    window.addEventListener("resize", onResize);
    const rebuild = setInterval(buildMarkers, 900); // reflect lock/select changes

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      clearInterval(rebuild);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      renderer.dispose();
      mount.removeChild(renderer.domElement);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [center.lat, center.lng]);

  return <div ref={mountRef} className="h-full w-full cursor-grab active:cursor-grabbing" />;
}

async function tripTool(action: string, extra: Record<string, unknown> = {}) {
  await fetch("/api/tools", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: action === "finalize" ? "trip_finalize" : "trip_update", args: action === "finalize" ? {} : { action, ...extra } }),
  }).catch(() => {});
}

const gbp = (n?: number) => (n != null ? `£${Math.round(n).toLocaleString("en-GB")}` : "£?");

export default function TripView({ value }: { value: string }) {
  let creationId = "";
  try {
    creationId = JSON.parse(value)?.creationId ?? "";
  } catch {
    /* noop */
  }
  const row = useQuery(api.creations.get, creationId ? { id: creationId as any } : "skip") as any;
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
  const [busy, setBusy] = useState("");
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

  if (!doc)
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-slate">
        <span className="h-2 w-2 animate-ping rounded-full bg-cyan mr-2" /> loading trip…
      </div>
    );

  const act = async (label: string, action: string, extra: Record<string, unknown> = {}) => {
    setBusy(label);
    await tripTool(action, extra);
    setBusy("");
  };

  const stays = (doc.stays ?? []).filter(
    (s: any) =>
      (!maxNight || (s.priceGbp ?? 9e9) <= maxNight) &&
      (!minRating || (s.rating ?? 0) >= minRating) &&
      (!freeCancel || s.freeCancellation) &&
      (!amenity || (s.amenities ?? []).join(" ").toLowerCase().includes(amenity.toLowerCase())),
  );
  const totals = doc.totals ?? { total: 0, flights: 0, stay: 0, activitiesEst: 0 };
  const over = totals.total > doc.budgetGbp;

  const onGlobeSelect = (key: string) => {
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
      {/* globe side */}
      <div className="relative h-[34vh] shrink-0 border-b border-white/5 md:h-auto md:w-[42%] md:border-b-0 md:border-r">
        <Globe center={doc.center} markers={markers} selected={selected} onSelect={onGlobeSelect} />
        <div className="pointer-events-none absolute left-3 top-3">
          <div className="text-sm font-semibold text-ice">{doc.destination}</div>
          <div className="hud-label !text-[9px]">
            {doc.departDate} → {doc.returnDate} · {doc.adults} adults
          </div>
        </div>
        <div className="pointer-events-none absolute bottom-3 left-3 flex gap-3 text-[9px] uppercase tracking-widest text-slate">
          <span><span className="mr-1 inline-block h-2 w-2 rounded-full bg-cyan align-middle" />stays</span>
          <span><span className="mr-1 inline-block h-2 w-2 rounded-full bg-sky-400 align-middle" />activities</span>
          <span><span className="mr-1 inline-block h-2 w-2 rounded-full bg-amber align-middle" />airport</span>
        </div>
      </div>

      {/* plan side */}
      <div className="flex min-h-0 flex-1 flex-col">
        {/* budget bar */}
        <div className="border-b border-white/5 px-3 pb-2 pt-2.5">
          <div className="flex items-baseline justify-between text-xs">
            <span className="text-ice">
              {gbp(totals.total)} <span className="text-slate">of {gbp(doc.budgetGbp)} budget</span>
            </span>
            <span className={over ? "text-red-400" : "text-cyan"}>
              {over ? `£${(totals.total - doc.budgetGbp).toLocaleString("en-GB")} over` : `£${(doc.budgetGbp - totals.total).toLocaleString("en-GB")} left`}
            </span>
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/5">
            <div
              className={`h-full rounded-full transition-all duration-700 ${over ? "bg-red-400" : "bg-gradient-to-r from-cyan/50 to-cyan"}`}
              style={{ width: `${Math.min(100, (totals.total / Math.max(1, doc.budgetGbp)) * 100)}%` }}
            />
          </div>
        </div>
        {/* tabs */}
        <div className="flex items-center gap-1 border-b border-white/5 px-2 py-1.5">
          {(["stays", "flights", "activities", "plan"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`rounded-full px-2.5 py-0.5 text-[10px] uppercase tracking-widest transition ${tab === t ? "bg-cyan/15 text-cyan ring-1 ring-cyan/40" : "text-slate hover:text-ice"}`}
            >
              {t}
              {t === "stays" ? ` ${stays.length}` : t === "flights" ? ` ${(doc.flights ?? []).length}` : t === "activities" ? ` ${(doc.activities ?? []).length}` : ""}
            </button>
          ))}
          {busy && <span className="ml-auto text-[10px] text-cyan animate-pulse">{busy}…</span>}
        </div>

        <div ref={listRef} className="scrollbar-thin min-h-0 flex-1 space-y-2 overflow-auto p-2.5">
          {tab === "stays" && (
            <>
              <div className="flex flex-wrap items-center gap-2 pb-1 text-[10px] text-slate">
                <label className="flex items-center gap-1">
                  ≤£
                  <input
                    type="number"
                    value={maxNight || ""}
                    placeholder="night"
                    onChange={(e) => setMaxNight(Number(e.target.value) || 0)}
                    className="w-14 rounded bg-black/30 px-1.5 py-0.5 text-ice outline-none ring-1 ring-white/10"
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
                  className="w-24 rounded bg-black/30 px-1.5 py-0.5 text-ice outline-none ring-1 ring-white/10"
                />
              </div>
              {stays.map((s: any) => {
                const locked = doc.locked?.stay?.name === s.name;
                const sel = selected === `stay:${s.name}`;
                return (
                  <div key={s.name} data-name={s.name} className={`${glass} flex gap-2 p-2 ${locked ? "ring-1 ring-cyan/60" : sel ? "ring-1 ring-white/30" : ""}`}>
                    {s.thumb ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={s.thumb} alt="" className="h-16 w-20 shrink-0 rounded-lg object-cover" />
                    ) : (
                      <div className="flex h-16 w-20 shrink-0 items-center justify-center rounded-lg bg-cyan/5">🏨</div>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="truncate text-xs font-semibold text-ice">{s.name}</span>
                        <span className="shrink-0 text-xs text-cyan">
                          {gbp(s.priceGbp)}<span className="text-slate">/n</span> · {gbp(s.totalGbp)} <span className="text-slate">total</span>
                        </span>
                      </div>
                      <div className="mt-0.5 text-[10px] text-slate">
                        ★{s.rating ?? "?"} {s.hotelClass ? "· " + "⭑".repeat(s.hotelClass) : ""} {s.freeCancellation ? "· free cancel" : ""}
                      </div>
                      <div className="mt-0.5 flex flex-wrap gap-1">
                        {(s.amenities ?? []).slice(0, 4).map((a: string) => (
                          <span key={a} className="rounded bg-cyan/10 px-1 py-px text-[9px] text-cyan/90">{a}</span>
                        ))}
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-col items-end justify-between">
                      <a href={s.link} target="_blank" rel="noreferrer" className="text-xs text-slate hover:text-cyan">↗</a>
                      <button
                        onClick={() => void act(`locking ${s.name}`, "lock_stay", { stay: s.name })}
                        className={`rounded-lg px-2 py-1 text-[10px] ${locked ? "bg-cyan/20 text-cyan ring-1 ring-cyan/50" : "bg-white/5 text-slate hover:text-ice"}`}
                      >
                        {locked ? "locked ✓" : "lock in"}
                      </button>
                    </div>
                  </div>
                );
              })}
            </>
          )}

          {tab === "flights" &&
            (doc.flights ?? []).map((f: any, i: number) => {
              const locked = doc.locked?.flight && doc.locked.flight.departTime === f.departTime && doc.locked.flight.priceGbp === f.priceGbp;
              return (
                <div key={i} className={`${glass} flex items-center gap-2 p-2 ${locked ? "ring-1 ring-cyan/60" : ""}`}>
                  {f.airlineLogo ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={f.airlineLogo} alt="" className="h-8 w-8 shrink-0 rounded bg-white/90 object-contain p-0.5" />
                  ) : (
                    <span className="text-lg">✈</span>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between">
                      <span className="truncate text-xs font-semibold text-ice">{f.airline ?? "flight"} · {f.stops === 0 ? "direct" : `${f.stops} stop`}</span>
                      <span className="text-xs text-cyan">{gbp(f.priceGbp)}<span className="text-slate">/pp</span></span>
                    </div>
                    <div className="text-[10px] text-slate">
                      {f.departTime} → {f.arriveTime} · {Math.round((f.durationMin ?? 0) / 60 * 10) / 10}h
                    </div>
                  </div>
                  <button
                    onClick={() => void act("locking flight", "lock_flight", { flight_index: i + 1 })}
                    className={`shrink-0 rounded-lg px-2 py-1 text-[10px] ${locked ? "bg-cyan/20 text-cyan ring-1 ring-cyan/50" : "bg-white/5 text-slate hover:text-ice"}`}
                  >
                    {locked ? "locked ✓" : "lock in"}
                  </button>
                </div>
              );
            })}

          {tab === "activities" &&
            (doc.activities ?? []).map((a: any) => {
              const picked = (doc.locked?.activities ?? []).includes(a.name);
              const sel = selected === `act:${a.name}`;
              return (
                <div key={a.name} data-name={a.name} className={`${glass} flex items-center gap-2 p-2 ${picked ? "ring-1 ring-sky-400/60" : sel ? "ring-1 ring-white/30" : ""}`}>
                  {a.photo ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={a.photo} alt="" className="h-12 w-16 shrink-0 rounded-lg object-cover" />
                  ) : (
                    <span className="flex h-12 w-16 shrink-0 items-center justify-center rounded-lg bg-sky-400/10">📍</span>
                  )}
                  <div className="min-w-0 flex-1">
                    <a href={a.mapsLink} target="_blank" rel="noreferrer" className="block truncate text-xs font-semibold text-ice hover:text-cyan">
                      {a.name} ↗
                    </a>
                    <div className="text-[10px] text-slate">★{a.rating ?? "?"} ({(a.ratings ?? 0).toLocaleString("en-GB")})</div>
                  </div>
                  <button
                    onClick={() => void act(picked ? "removing" : "adding", "toggle_activity", { activity: a.name })}
                    className={`shrink-0 rounded-lg px-2 py-1 text-[10px] ${picked ? "bg-sky-400/20 text-sky-300 ring-1 ring-sky-400/50" : "bg-white/5 text-slate hover:text-ice"}`}
                  >
                    {picked ? "in plan ✓" : "+ add"}
                  </button>
                </div>
              );
            })}

          {tab === "plan" && (
            <>
              <div className={`${glass} p-2.5 text-xs`}>
                <div className="hud-label mb-1.5">locked in</div>
                <div className="space-y-1 text-ice">
                  <div>✈ {doc.locked?.flight ? `${doc.locked.flight.airline} ${gbp(doc.locked.flight.priceGbp)}/pp · ${doc.locked.flight.departTime}` : <span className="text-slate">no flight locked</span>}</div>
                  <div>🏨 {doc.locked?.stay ? `${doc.locked.stay.name} · ${gbp(doc.locked.stay.totalGbp)} total` : <span className="text-slate">no stay locked</span>}</div>
                  {doc.transfer && (
                    <div>🚕 airport → hotel: {doc.transfer.durationText} · {doc.transfer.distanceText}{doc.transfer.fareText ? ` · ${doc.transfer.fareText}` : ""}</div>
                  )}
                  <div>📍 {(doc.locked?.activities ?? []).length ? doc.locked.activities.join(", ") : <span className="text-slate">no activities picked</span>}</div>
                </div>
                <div className="mt-2 grid grid-cols-4 gap-1 text-center text-[10px]">
                  <div className={glass + " py-1"}><div className="text-ice">{gbp(totals.flights)}</div><div className="text-slate">flights</div></div>
                  <div className={glass + " py-1"}><div className="text-ice">{gbp(totals.stay)}</div><div className="text-slate">stay</div></div>
                  <div className={glass + " py-1"}><div className="text-ice">{gbp(totals.activitiesEst)}</div><div className="text-slate">activities</div></div>
                  <div className={glass + " py-1"}><div className={over ? "text-red-400" : "text-cyan"}>{gbp(totals.total)}</div><div className="text-slate">total</div></div>
                </div>
                {doc.status !== "planned" && (
                  <button
                    onClick={() => void act("finalizing", "finalize")}
                    disabled={!doc.locked?.stay}
                    className="mt-2 w-full rounded-lg bg-cyan/15 py-1.5 text-xs font-medium text-cyan ring-1 ring-cyan/40 transition hover:bg-cyan/25 disabled:opacity-40"
                  >
                    finalize → itinerary + calendar + trip map
                  </button>
                )}
              </div>
              {(doc.itinerary ?? []).map((day: any) => (
                <div key={day.date} className={`${glass} p-2.5`}>
                  <div className="hud-label mb-1">{day.label}</div>
                  <div className="space-y-1">
                    {day.items.map((it: any, i: number) => (
                      <div key={i} className="flex gap-2 text-xs">
                        <span className="w-11 shrink-0 font-mono text-cyan">{it.time || "—"}</span>
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
