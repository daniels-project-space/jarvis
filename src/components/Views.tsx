"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";

// The richer panel views: frosted-glass calendar, live mind-map canvas,
// app launcher, PDF viewer, creations library.

/* ---------------------------------- calendar ---------------------------------- */

type CalEvent = { title: string; time?: string; kind: string; location?: string };
type CalDay = { date: string; dow: string; inMonth: boolean; today: boolean; events: CalEvent[]; more: number };

const KIND_STYLE: Record<string, string> = {
  event: "bg-cyan/15 text-cyan border-cyan/30",
  pickup: "bg-amber/15 text-amber border-amber/30",
  return: "bg-sky-400/15 text-sky-300 border-sky-400/30",
  away: "bg-white/5 text-slate border-white/10",
};

function EventPill({ e, small }: { e: CalEvent; small?: boolean }) {
  return (
    <div
      className={`truncate rounded-md border px-1.5 ${small ? "py-0 text-[9px]" : "py-0.5 text-[11px]"} ${KIND_STYLE[e.kind] ?? KIND_STYLE.event}`}
      title={`${e.time ? e.time + " · " : ""}${e.title}${e.location ? " · " + e.location : ""}`}
    >
      {e.time && <span className="mr-1 opacity-70">{e.time}</span>}
      {e.title}
    </div>
  );
}

export function CalendarView({ value }: { value: string }) {
  let w: { view: string; label: string; days: CalDay[] } | null = null;
  try {
    w = JSON.parse(value);
  } catch {
    /* noop */
  }
  if (!w) return <pre className="p-4 text-sm text-ice">{value}</pre>;
  const glass = "rounded-xl border border-white/10 bg-white/[0.045] backdrop-blur-xl";

  if (w.view === "month") {
    return (
      <div className="scrollbar-thin min-h-0 flex-1 overflow-auto p-4">
        <div className="mb-3 flex items-baseline justify-between">
          <div className="text-lg font-semibold text-ice">{w.label}</div>
          <div className="hud-label">month</div>
        </div>
        <div className="grid grid-cols-7 gap-1 pb-1">
          {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
            <div key={d} className="hud-label !text-[9px] pb-1 text-center">
              {d}
            </div>
          ))}
          {w.days.map((d) => (
            <div
              key={d.date}
              className={`${glass} min-h-[74px] p-1 ${d.inMonth ? "" : "opacity-35"} ${d.today ? "ring-1 ring-cyan/60" : ""}`}
            >
              <div className={`mb-1 text-right text-[10px] ${d.today ? "font-bold text-cyan" : "text-slate"}`}>
                {Number(d.date.slice(8))}
              </div>
              <div className="space-y-0.5">
                {d.events.map((e, i) => (
                  <EventPill key={i} e={e} small />
                ))}
                {d.more > 0 && <div className="text-[9px] text-slate">+{d.more} more</div>}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (w.view === "week") {
    return (
      <div className="scrollbar-thin min-h-0 flex-1 overflow-auto p-4">
        <div className="mb-3 flex items-baseline justify-between">
          <div className="text-lg font-semibold text-ice">{w.label}</div>
          <div className="hud-label">week</div>
        </div>
        <div className="grid gap-2 md:grid-cols-7">
          {w.days.map((d) => (
            <div key={d.date} className={`${glass} p-2 ${d.today ? "ring-1 ring-cyan/60" : ""}`}>
              <div className="mb-2 flex items-baseline justify-between">
                <span className={`text-xs font-semibold ${d.today ? "text-cyan" : "text-ice"}`}>{d.dow}</span>
                <span className="text-[10px] text-slate">{Number(d.date.slice(8))}</span>
              </div>
              <div className="space-y-1">
                {d.events.length === 0 && <div className="text-[10px] text-slate/60">—</div>}
                {d.events.map((e, i) => (
                  <EventPill key={i} e={e} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  const day = w.days[0];
  return (
    <div className="scrollbar-thin min-h-0 flex-1 overflow-auto p-5">
      <div className="mb-4 flex items-baseline justify-between">
        <div className="text-xl font-semibold text-ice">{w.label}</div>
        <div className="hud-label">day plan</div>
      </div>
      {!day?.events.length && <div className="mt-8 text-center text-sm text-slate">Clear day, sir.</div>}
      <div className="space-y-2">
        {day?.events.map((e, i) => (
          <div key={i} className={`${glass} flex items-center gap-3 p-3`}>
            <span className="w-14 shrink-0 font-mono text-sm text-cyan">{e.time || "—"}</span>
            <span className={`h-8 w-1 shrink-0 rounded-full ${e.kind === "pickup" ? "bg-amber" : e.kind === "return" ? "bg-sky-400" : "bg-cyan"}`} />
            <div className="min-w-0">
              <div className="truncate text-sm text-ice">{e.title}</div>
              {e.location && <div className="truncate text-xs text-slate">{e.location}</div>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------------------------------- tickable to-dos ---------------------------------- */

export function TodosView({ value }: { value: string }) {
  let w: { label: string; items: { text: string; due?: string | null; tags?: string[]; why?: string }[] } | null = null;
  try {
    w = JSON.parse(value);
  } catch {
    /* noop */
  }
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  if (!w) return <pre className="p-4 text-sm text-ice">{value}</pre>;
  const tick = (text: string) => {
    setTicked((t) => new Set(t).add(text));
    void fetch("/api/tools", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "todo_done", args: { match: text.slice(0, 60) } }),
    });
  };
  return (
    <div className="scrollbar-thin min-h-0 flex-1 overflow-auto p-4">
      <div className="hud-label mb-3">{w.label}</div>
      <div className="mx-auto max-w-2xl space-y-2">
        {w.items.map((t, i) => {
          const done = ticked.has(t.text);
          return (
            <div key={i} className="tile rise flex items-start gap-3 p-3" style={{ animationDelay: `${i * 40}ms` }}>
              <button
                onClick={() => !done && tick(t.text)}
                className={`mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-lg border transition-all duration-300 ${
                  done ? "border-cyan bg-cyan text-black" : "border-white/20 hover:border-cyan/60"
                }`}
              >
                {done ? "✓" : ""}
              </button>
              <div className="min-w-0 flex-1">
                <div className={`text-[15px] leading-snug transition-all duration-300 ${done ? "text-slate line-through" : "text-ice"}`}>{t.text}</div>
                <div className="mt-0.5 flex gap-2 text-[10px] text-slate">
                  {t.why && <span className="text-cyan/80">{t.why}</span>}
                  {t.due && <span>due {t.due}</span>}
                  {(t.tags ?? []).map((g) => (
                    <span key={g} className="rounded bg-white/5 px-1">{g}</span>
                  ))}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ---------------------------------- briefing 2.0 ---------------------------------- */

export function Briefing2View({ value }: { value: string }) {
  let w: any = null;
  try {
    w = JSON.parse(value);
  } catch {
    /* noop */
  }
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  if (!w) return <pre className="p-4 text-sm text-ice">{value}</pre>;
  const tick = (text: string) => {
    setTicked((t) => new Set(t).add(text));
    void fetch("/api/tools", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "todo_done", args: { match: text.slice(0, 60) } }),
    });
  };
  const toPct = (hhmm: string) => {
    const [h, m] = String(hhmm).split(":").map(Number);
    return Math.max(0, Math.min(100, (((h || 12) + (m || 0) / 60 - 7) / 15) * 100));
  };
  // Clustered movements used to stack on top of each other: place each card in
  // the first of four vertical slots with >=14% of horizontal clearance.
  const marks = [...(w.rentals ?? [])]
    .map((r: any) => ({ ...r, pct: toPct(r.time) }))
    .sort((a: any, b: any) => a.pct - b.pct);
  const slotLast = [-99, -99, -99, -99];
  const SLOT_TOP = ["-56px", "20px", "-116px", "78px"];
  for (const m of marks) {
    let best = 0, bestGap = -Infinity;
    for (let sl = 0; sl < 4; sl++) {
      const gap = m.pct - slotLast[sl];
      if (gap >= 14) { best = sl; bestGap = Infinity; break; }
      if (gap > bestGap) { bestGap = gap; best = sl; }
    }
    slotLast[best] = m.pct;
    m.slot = best;
  }
  return (
    <div className="scrollbar-thin min-h-0 flex-1 overflow-auto p-5">
      <div className="mx-auto max-w-6xl space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-2xl font-semibold text-ice">{w.date}</div>
            {w.wealth != null && <div className="text-xs text-slate">net worth ≈ £{Number(w.wealth).toLocaleString("en-GB")}</div>}
          </div>
          {w.weather && (
            <div className="tile flex items-center gap-3 px-4 py-2.5">
              <span className="text-4xl">{w.weather.icon}</span>
              <div>
                <div className="text-2xl font-semibold text-ice">{w.weather.temp}°</div>
                <div className="text-[10px] text-slate">{w.weather.desc}</div>
              </div>
              <div className="ml-2 hidden gap-1 sm:flex">
                {(w.weather.hours ?? []).map((h: any, i: number) => (
                  <div key={i} className="flex flex-col items-center px-1 text-[9px] text-slate">
                    <span>{h.h}</span>
                    <span className="text-sm">{h.icon}</span>
                    <span className="text-ice">{h.t}°</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="tile rise p-4 pb-2">
          <div className="hud-label mb-[132px]">rentals today · {w.awayCount} out</div>
          <div className="relative mx-2 mb-[128px] h-1 rounded-full bg-gradient-to-r from-white/5 via-white/15 to-white/5">
            {["07", "10", "13", "16", "19", "22"].map((h, i) => (
              <span key={h} className="absolute top-3 -translate-x-1/2 text-[9px] text-slate/70" style={{ left: `${(i / 5) * 100}%` }}>
                {h}:00
              </span>
            ))}
            {marks.map((r: any, i: number) => (
              <div key={i} className="absolute -translate-x-1/2" style={{ left: `${r.pct}%`, top: SLOT_TOP[r.slot ?? 0] }}>
                <span
                  className={`absolute left-1/2 h-2 w-2 -translate-x-1/2 rounded-full ${r.kind === "pickup" ? "bg-amber" : "bg-sky-400"}`}
                  style={(r.slot ?? 0) % 2 === 0 ? { bottom: "-14px" } : { top: "-14px" }}
                />
                <div className={`tile w-max max-w-[150px] px-2.5 py-1.5 text-center ${r.kind === "pickup" ? "!border-amber/40" : ""}`}>
                  <div className={`text-[9px] font-semibold uppercase tracking-widest ${r.kind === "pickup" ? "text-amber" : "text-sky-300"}`}>
                    {r.kind} · {r.time}
                  </div>
                  <div className="truncate text-[11px] text-ice">{r.name}</div>
                </div>
              </div>
            ))}
            {!marks.length && <div className="absolute inset-x-0 -top-8 text-center text-xs text-slate">no movements today</div>}
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="tile rise p-4" style={{ animationDelay: "60ms" }}>
            <div className="hud-label mb-2">picked for today</div>
            <div className="space-y-2">
              {(w.todos ?? []).map((t: any, i: number) => {
                const done = ticked.has(t.text);
                return (
                  <div key={i} className="flex items-start gap-2.5">
                    <button
                      onClick={() => !done && tick(t.text)}
                      className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-md border text-xs transition-all ${
                        done ? "border-cyan bg-cyan text-black" : "border-white/20 hover:border-cyan/60"
                      }`}
                    >
                      {done ? "✓" : ""}
                    </button>
                    <div className="min-w-0">
                      <div className={`text-[13px] leading-snug ${done ? "text-slate line-through" : "text-ice"}`}>{t.text}</div>
                      {t.why && <div className="text-[10px] text-cyan/70">{t.why}</div>}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="space-y-4">
            <div className="tile rise p-4" style={{ animationDelay: "120ms" }}>
              <div className="hud-label mb-2">coming up</div>
              {(w.calendar ?? []).length ? (
                (w.calendar ?? []).map((e: any, i: number) => (
                  <div key={i} className="flex items-baseline justify-between gap-2 py-1 text-[13px]">
                    <span className="truncate text-ice">{e.title}</span>
                    <span className="shrink-0 text-[11px] text-cyan/80">{e.when}</span>
                  </div>
                ))
              ) : (
                <div className="text-xs text-slate">calendar clear</div>
              )}
            </div>
            <div className="hud-label mb-1">markets</div>
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              {(w.markets ?? []).map((r: any, i: number) => {
                const sp: number[] = Array.isArray(r.spark) ? r.spark : [];
                const min = Math.min(...sp), max = Math.max(...sp);
                // taller chart — the graph is always expanded in the briefing
                const pts = sp.map((v, j) => `${(j / (sp.length - 1)) * 100},${47 - ((v - min) / (max - min || 1)) * 42}`).join(" ");
                const up = r.change >= 0;
                return (
                  <div key={i} className="tile rise flex flex-col px-3.5 py-3" style={{ animationDelay: `${160 + i * 50}ms` }}>
                    <div className="flex items-baseline justify-between">
                      <span className="hud-label !text-[10px]">{r.label}</span>
                      <span className={`text-[11px] ${up ? "text-emerald-400" : "text-red-400"}`}>
                        {up ? "▲" : "▼"} {Math.abs(r.change)}%
                      </span>
                    </div>
                    <div className="mt-0.5 text-lg font-semibold text-ice">
                      {r.unit}
                      {Number(r.price).toLocaleString("en-US")}
                    </div>
                    {sp.length > 1 ? (
                      <svg viewBox="0 0 100 48" preserveAspectRatio="none" className="mt-2 h-20 w-full">
                        <defs>
                          <linearGradient id={`spk${i}`} x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor={up ? "rgba(52,211,153,0.28)" : "rgba(248,113,113,0.28)"} />
                            <stop offset="100%" stopColor="rgba(0,0,0,0)" />
                          </linearGradient>
                        </defs>
                        <polyline points={`0,48 ${pts} 100,48`} fill={`url(#spk${i})`} stroke="none" />
                        <polyline points={pts} fill="none" stroke={up ? "#34d399" : "#f87171"} strokeWidth="1.8" vectorEffect="non-scaling-stroke" />
                      </svg>
                    ) : (
                      <div className="mt-2 flex h-20 items-center justify-center text-[10px] text-slate/60">no chart data</div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------- weather (day · week · live map) ---------------------------------- */

export function WeatherView({ w }: { w: any }) {
  const [showMap, setShowMap] = useState(false);
  if (showMap && w.lat != null)
    return (
      <div className="relative min-h-0 flex-1">
        <iframe
          src={`https://embed.windy.com/embed2.html?lat=${w.lat}&lon=${w.lng}&detailLat=${w.lat}&detailLon=${w.lng}&zoom=8&level=surface&overlay=rain&menu=&message=true&marker=true&type=map&metricWind=km%2Fh&metricTemp=%C2%B0C`}
          className="h-full w-full"
          title="live weather map"
        />
        <button onClick={() => setShowMap(false)} className="absolute right-3 top-3 rounded-full bg-black/70 px-3 py-1 text-[11px] text-ice backdrop-blur hover:text-cyan">
          ← forecast
        </button>
      </div>
    );
  return (
    <div className="scrollbar-thin flex min-h-0 flex-1 flex-col items-center justify-center gap-4 overflow-auto p-5">
      <div className="flex w-full items-center justify-between">
        <span className="hud-label">{w.place}</span>
        {w.lat != null && (
          <button onClick={() => setShowMap(true)} className="hud-label rounded px-1.5 !text-cyan hover:bg-cyan/10">
            🗺 live map
          </button>
        )}
      </div>
      <div className="flex items-center gap-5">
        <span className="text-7xl">{w.icon}</span>
        <div>
          <div className="text-6xl font-semibold text-ice">{w.temp}°</div>
          <div className="mt-1 text-sm text-slate">
            {w.desc} · feels {w.feels}° · wind {w.wind} km/h · humidity {w.humidity}%
          </div>
        </div>
      </div>
      {(w.hours ?? []).length > 0 && (
        <div className="w-full">
          <div className="hud-label mb-1.5">today</div>
          <div className="scrollbar-thin flex gap-1.5 overflow-x-auto pb-1">
            {w.hours.map((h: any, i: number) => (
              <div key={i} className="glass flex w-[64px] shrink-0 flex-col items-center gap-0.5 rounded-lg px-1 py-2">
                <span className="text-[10px] text-slate">{h.h}</span>
                <span className="text-lg">{h.icon}</span>
                <span className="text-xs text-ice">{h.t}°</span>
                <span className="text-[9px] text-cyan/70">{h.rain}%</span>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="w-full">
        <div className="hud-label mb-1.5">the week</div>
        <div className="flex flex-wrap gap-2">
          {(w.days ?? []).map((d: any, i: number) => (
            <div key={i} className="glass flex min-w-[82px] flex-1 flex-col items-center gap-1 rounded-xl px-2 py-3">
              <span className="hud-label">{d.day}</span>
              <span className="text-2xl">{d.icon}</span>
              <span className="text-sm text-ice">
                {d.max}° <span className="text-slate">{d.min}°</span>
              </span>
              <span className="text-[10px] text-cyan/70">{d.rain}% rain</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------- cinematic feed (news / music / videos) ---------------------------------- */

type FeedItem = { image: string; title: string; subtitle?: string; url?: string; video_id?: string };

export function FeedView({ value }: { value: string }) {
  let w: { mode: string; label: string; items: FeedItem[] } | null = null;
  try {
    w = JSON.parse(value);
  } catch {
    /* noop */
  }
  const items = useMemo(() => w?.items ?? [], [w?.items]);
  const [phase, setPhase] = useState<"hero" | "grid">("hero");
  const [idx, setIdx] = useState(0);
  const [page, setPage] = useState(0);
  const setPanel = useMutation(api.ui.setPanel);

  // fresh content = fresh presentation (state survives panel swaps otherwise:
  // a second search used to open on a stale page/grid)
  const label = w?.label;
  useEffect(() => {
    setPhase("hero");
    setIdx(0);
    setPage(0);
  }, [label]);

  // hero presentation: each story holds ~4.2s, fades to the next, then the grid
  useEffect(() => {
    if (phase !== "hero") return;
    if (idx >= Math.min(items.length, 4) - 1) {
      const t = setTimeout(() => setPhase("grid"), 4500);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setIdx((i) => i + 1), 4200);
    return () => clearTimeout(t);
  }, [phase, idx, items.length]);

  if (!w || !items.length) return <div className="flex flex-1 items-center justify-center text-sm text-slate">nothing to show</div>;

  const open = (it: FeedItem) => {
    if (it.video_id) void setPanel({ type: "video", value: `https://www.youtube.com/embed/${it.video_id}?enablejsapi=1&rel=0&autoplay=1`, title: it.title });
    else if (it.url) window.open(it.url, "_blank", "noopener");
  };

  // Videos present as a numbered triptych — three framed picks per page, so
  // Daniel can say "play the second one" without squinting at a grid.
  if (w.mode === "videos") {
    const per = 3;
    const pages = Math.max(1, Math.ceil(items.length / per));
    const cur = Math.min(page, pages - 1);
    const slice = items.slice(cur * per, cur * per + per);
    return (
      <div className="flex min-h-0 flex-1 flex-col p-4">
        <div className="mb-3 flex items-center justify-between">
          <span className="hud-label">{items.length} videos</span>
          <div className="flex items-center gap-2">
            <button disabled={cur === 0} onClick={() => setPage(Math.max(0, cur - 1))} className="hud-label rounded px-2 py-1 transition disabled:opacity-25 hover:text-cyan">
              &lsaquo; prev
            </button>
            <span className="hud-label">{cur + 1}/{pages}</span>
            <button disabled={cur >= pages - 1} onClick={() => setPage(Math.min(pages - 1, cur + 1))} className="hud-label rounded px-2 py-1 transition disabled:opacity-25 hover:text-cyan">
              next &rsaquo;
            </button>
          </div>
        </div>
        <div className="grid flex-1 grid-cols-1 content-center gap-4 md:grid-cols-3">
          {slice.map((it, i) => {
            const n = cur * per + i + 1;
            return (
              <button key={n} onClick={() => open(it)} className="tile rise group text-left" style={{ animationDelay: `${i * 90}ms` }}>
                <div className="relative">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={it.image} alt="" className="aspect-video w-full rounded-t-[13px] object-cover" />
                  <span className="absolute left-2 top-2 grid h-8 w-8 place-items-center rounded-full bg-black/75 font-mono text-sm text-cyan ring-1 ring-cyan/50">{n}</span>
                  <span className="absolute inset-0 grid place-items-center opacity-0 transition group-hover:opacity-100">
                    <span className="grid h-12 w-12 place-items-center rounded-full bg-cyan/90 pl-0.5 text-xl text-black">&#9654;</span>
                  </span>
                </div>
                <div className="p-3.5">
                  <div className="line-clamp-2 text-[15px] font-medium leading-snug text-ice">{it.title}</div>
                  {it.subtitle && <div className="mt-1 truncate text-[11px] text-slate">{it.subtitle}</div>}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  if (phase === "hero") {
    return (
      <div className="relative min-h-0 flex-1 cursor-pointer overflow-hidden" onClick={() => setPhase("grid")} title="tap to browse all">
        {items.slice(0, 4).map((it, i) => (
          <div
            key={i}
            className="absolute inset-0 bg-[radial-gradient(120%_100%_at_50%_0%,rgba(19,32,51,0.9),rgba(6,10,18,0.98))] transition-opacity duration-1000 ease-in-out"
            style={{ opacity: i === idx ? 1 : 0 }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {it.image && <img src={it.image} alt="" loading="lazy" onError={(e)=>{e.currentTarget.style.opacity="0"}} className="h-full w-full object-cover transition-opacity" />}
            <div className="absolute inset-0 bg-gradient-to-t from-black/95 via-black/30 to-black/20" />
            <div className={`absolute bottom-0 left-0 right-0 p-6 transition-transform duration-1000 ${i === idx ? "translate-y-0" : "translate-y-3"}`}>
              <div className="hud-label mb-1 !text-cyan">{w!.label} · {i + 1}/{Math.min(items.length, 4)}</div>
              <div className="max-w-3xl text-xl font-semibold leading-snug text-white md:text-3xl">{it.title}</div>
              {it.subtitle && <div className="mt-1.5 text-sm text-white/70">{it.subtitle}</div>}
            </div>
          </div>
        ))}
        <div className="absolute right-4 top-4 rounded-full bg-black/50 px-3 py-1 text-[10px] uppercase tracking-widest text-white/70 backdrop-blur">
          tap to browse
        </div>
      </div>
    );
  }

  return (
    <div className="scrollbar-thin min-h-0 flex-1 overflow-auto p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="hud-label">{w.label}</span>
        <button onClick={() => { setIdx(0); setPhase("hero"); }} className="hud-label rounded px-1.5 hover:text-cyan">▶ replay</button>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
        {items.map((it, i) => (
          <button key={i} onClick={() => open(it)} className="card-lift glass rise overflow-hidden rounded-xl text-left" style={{ animationDelay: `${i * 45}ms` }}>
            <div className={`relative bg-[radial-gradient(120%_100%_at_50%_0%,rgba(19,32,51,0.9),rgba(6,10,18,0.98))] ${w!.mode === "music" ? "aspect-square" : "aspect-video"}`}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {it.image && <img src={it.image} alt="" loading="lazy" onError={(e)=>{e.currentTarget.style.opacity="0"}} className="absolute inset-0 h-full w-full object-cover transition-opacity" />}
              <span className="absolute left-1.5 top-1.5 rounded bg-black/70 px-1.5 py-0.5 font-mono text-[10px] text-cyan">{i + 1}</span>
              {w!.mode === "music" && (
                <span className="absolute bottom-1.5 right-1.5 grid h-8 w-8 place-items-center rounded-full bg-[#1DB954] pl-0.5 text-sm text-black">▶</span>
              )}
            </div>
            <div className="p-2.5">
              <div className="line-clamp-2 text-[13px] leading-snug text-ice">{it.title}</div>
              {it.subtitle && <div className="mt-1 truncate text-[10px] text-slate">{it.subtitle}</div>}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

/* ---------------------------------- live writing desk ---------------------------------- */

// Paper-styled markdown: dark ink on paper, no raw HTML passes through.
function mdPaper(src: string): string {
  const esc = src.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return esc
    .replace(/^### (.+)$/gm, '<div class="mb-1 mt-4 text-[15px] font-semibold">$1</div>')
    .replace(/^## (.+)$/gm, '<div class="mb-1.5 mt-5 text-lg font-semibold">$1</div>')
    .replace(/^# (.+)$/gm, '<div class="mb-2 mt-2 text-xl font-bold">$1</div>')
    .replace(/^[-•] (.*)$/gm, '<span class="text-neutral-400">&bull;</span> $1')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*\n]+)\*/g, "<em>$1</em>")
    .replace(/\n/g, "<br/>");
}

// A draft JARVIS is writing WITH Daniel: renders the creations doc reactively,
// flashes softly when a revision lands so edits are visible live.
export function DocView({ value }: { value: string }) {
  let creationId = "";
  try {
    creationId = JSON.parse(value)?.creationId ?? "";
  } catch {
    /* noop */
  }
  const doc = useQuery(api.creations.get, creationId ? ({ id: creationId } as any) : "skip") as any;
  const [flash, setFlash] = useState(false);
  const prev = useRef<string>("");
  useEffect(() => {
    const cur = String(doc?.data ?? "");
    if (prev.current && cur && cur !== prev.current) {
      setFlash(true);
      const t = setTimeout(() => setFlash(false), 1200);
      prev.current = cur;
      return () => clearTimeout(t);
    }
    prev.current = cur;
  }, [doc?.data]);
  if (!doc) return <div className="flex flex-1 items-center justify-center text-sm text-slate">opening the draft…</div>;
  const text = String(doc.data ?? "");
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  return (
    <div className="scrollbar-thin min-h-0 flex-1 overflow-auto p-4 md:p-6">
      <div
        className={`mx-auto max-w-2xl rounded-lg bg-[#f6f4ec] p-7 shadow-[0_24px_70px_rgba(0,0,0,0.6)] transition-all duration-500 md:p-10 ${
          flash ? "ring-4 ring-cyan/60" : "ring-1 ring-black/20"
        }`}
      >
        <div className="mb-6 flex items-baseline justify-between gap-3 border-b border-black/10 pb-3">
          <div className="min-w-0 truncate text-lg font-semibold text-neutral-800">{doc.title}</div>
          <div className="shrink-0 text-[10px] uppercase tracking-[0.2em] text-neutral-400">
            {flash ? <span className="text-emerald-600">✎ updating…</span> : `${words} words · live`}
          </div>
        </div>
        <div
          className="font-serif text-[15px] leading-[1.8] text-neutral-800 md:text-base"
          dangerouslySetInnerHTML={{ __html: mdPaper(text) }}
        />
      </div>
    </div>
  );
}

/* ---------------------------------- places near you (dark map) ---------------------------------- */

type Place = {
  name: string; address: string; rating?: number; reviews?: number; openNow?: boolean;
  hoursToday?: string; type?: string; lat: number; lng: number; dist: number | null; mapsUri: string;
};

// A dark interactive map of Daniel's area with the found places pinned, plus a
// scrollable list of place cards — hours, rating, distance, and one-tap
// walk/drive/transit directions from his location.
export function PlacesView({ value }: { value: string }) {
  let w: { query: string; center: { lat: number; lng: number }; items: Place[] } | null = null;
  try {
    w = JSON.parse(value);
  } catch {
    /* noop */
  }
  const mapEl = useRef<HTMLDivElement>(null);
  const mapObj = useRef<any>(null);
  const [sel, setSel] = useState(0);
  const items = w?.items ?? [];
  const center = w?.center;

  useEffect(() => {
    if (!mapEl.current || !center || mapObj.current) return;
    let cancelled = false;
    (async () => {
      const maplibregl = (await import("maplibre-gl")).default;
      await import("maplibre-gl/dist/maplibre-gl.css");
      if (cancelled || !mapEl.current) return;
      const map = new maplibregl.Map({
        container: mapEl.current,
        style: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
        center: [center.lng, center.lat],
        zoom: 13,
        attributionControl: false,
      });
      mapObj.current = map;
      map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
      map.on("load", () => {
        // Daniel's location — pulsing cyan dot
        const you = document.createElement("div");
        you.style.cssText = "width:16px;height:16px;border-radius:9999px;background:#00ff88;box-shadow:0 0 0 6px rgba(0,255,136,0.25),0 0 14px rgba(0,255,136,0.8);";
        new maplibregl.Marker({ element: you }).setLngLat([center.lng, center.lat]).addTo(map);
        const bounds = new maplibregl.LngLatBounds([center.lng, center.lat], [center.lng, center.lat]);
        items.forEach((p, i) => {
          const el = document.createElement("div");
          el.style.cssText = "display:grid;place-items:center;width:26px;height:26px;border-radius:9999px 9999px 9999px 2px;transform:rotate(45deg);background:#0b1220;border:2px solid #00ff88;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,0.6);";
          el.innerHTML = `<span style="transform:rotate(-45deg);color:#00ff88;font:600 11px system-ui;">${i + 1}</span>`;
          el.onclick = () => setSel(i);
          new maplibregl.Marker({ element: el, anchor: "bottom" }).setLngLat([p.lng, p.lat]).addTo(map);
          bounds.extend([p.lng, p.lat]);
        });
        map.fitBounds(bounds, { padding: 70, maxZoom: 15, duration: 600 });
      });
    })();
    return () => {
      cancelled = true;
      mapObj.current?.remove?.();
      mapObj.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  if (!w || !items.length) return <div className="flex flex-1 items-center justify-center text-sm text-slate">nothing near you</div>;
  const dir = (p: Place, mode: string) =>
    `https://www.google.com/maps/dir/?api=1&origin=${center!.lat},${center!.lng}&destination=${p.lat},${p.lng}&travelmode=${mode}`;
  return (
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <div ref={mapEl} className="h-52 w-full shrink-0 md:h-auto md:flex-1" />
      <div className="scrollbar-thin min-h-0 flex-1 overflow-auto p-3 md:w-[380px] md:flex-none">
        <div className="hud-label mb-2">near you · {w.query}</div>
        <div className="space-y-2.5">
          {items.map((p, i) => (
            <div
              key={i}
              onClick={() => {
                setSel(i);
                mapObj.current?.flyTo?.({ center: [p.lng, p.lat], zoom: 16, duration: 500 });
              }}
              className={`frost cursor-pointer p-3 transition ${sel === i ? "!border-cyan/50" : ""}`}
            >
              <div className="flex items-start gap-2">
                <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-cyan/15 font-mono text-[11px] text-cyan ring-1 ring-cyan/40">{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[14px] font-medium text-ice">{p.name}</div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px]">
                    {p.dist != null && <span className="text-cyan/80">{p.dist} km</span>}
                    {p.rating != null && <span className="text-amber">★ {p.rating}{p.reviews ? ` (${p.reviews})` : ""}</span>}
                    {p.openNow != null && <span className={p.openNow ? "text-emerald-400" : "text-red-400"}>{p.openNow ? "open now" : "closed"}</span>}
                  </div>
                  {p.hoursToday && <div className="mt-0.5 text-[11px] text-slate">Today: {p.hoursToday}</div>}
                  <div className="truncate text-[10px] text-slate">{p.address}</div>
                  <div className="mt-2 flex gap-1.5">
                    {[["walking", "🚶"], ["driving", "🚗"], ["transit", "🚆"]].map(([m, ic]) => (
                      <a key={m} href={dir(p, m)} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} title={m} className="rounded-lg bg-white/5 px-2 py-1 text-xs ring-1 ring-white/10 transition hover:bg-cyan/15 hover:ring-cyan/40">
                        {ic}
                      </a>
                    ))}
                    {p.mapsUri && (
                      <a href={p.mapsUri} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="ml-auto rounded-lg px-2 py-1 text-[10px] text-cyan/70 transition hover:text-cyan">
                        maps ↗
                      </a>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------- web result cards ---------------------------------- */

type WebItem = { title: string; url: string; snippet: string; domain: string; image: string; favicon: string };

// Search results as framed tile cards — a live page thumbnail (mShots, favicon
// fallback), three per page with a pager. Modern frosted glass.
export function WebResultsView({ value }: { value: string }) {
  let w: { query: string; answer?: string; items: WebItem[] } | null = null;
  try {
    w = JSON.parse(value);
  } catch {
    /* noop */
  }
  const [page, setPage] = useState(0);
  const label = w?.query;
  useEffect(() => setPage(0), [label]);
  if (!w?.items?.length) return <div className="flex flex-1 items-center justify-center text-sm text-slate">nothing found</div>;
  const per = 3;
  const pages = Math.max(1, Math.ceil(w.items.length / per));
  const cur = Math.min(page, pages - 1);
  const slice = w.items.slice(cur * per, cur * per + per);
  return (
    <div className="flex min-h-0 flex-1 flex-col p-4">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="hud-label truncate">search · {w.query}</span>
        <div className="flex shrink-0 items-center gap-2">
          <button disabled={cur === 0} onClick={() => setPage(Math.max(0, cur - 1))} className="hud-label rounded px-2 py-1 transition disabled:opacity-25 hover:text-cyan">&lsaquo; prev</button>
          <span className="hud-label">{cur + 1}/{pages}</span>
          <button disabled={cur >= pages - 1} onClick={() => setPage(Math.min(pages - 1, cur + 1))} className="hud-label rounded px-2 py-1 transition disabled:opacity-25 hover:text-cyan">next &rsaquo;</button>
        </div>
      </div>
      {w.answer && (
        <div className="mb-3 rounded-xl border border-cyan/20 bg-cyan/[0.06] px-3.5 py-2 text-[13px] leading-snug text-ice">
          <span className="hud-label mr-2 !text-cyan">answer</span>{w.answer}
        </div>
      )}
      <div className="grid flex-1 grid-cols-1 content-start gap-4 md:grid-cols-3">
        {slice.map((it, i) => (
          <a
            key={cur * per + i}
            href={it.url}
            target="_blank"
            rel="noopener noreferrer"
            className="frost rise group flex flex-col overflow-hidden text-left"
            style={{ animationDelay: `${i * 80}ms` }}
          >
            <div className="relative aspect-[16/10] w-full overflow-hidden bg-[#0b1220]">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={it.image}
                alt=""
                loading="lazy"
                className="h-full w-full object-cover object-top transition-transform duration-500 group-hover:scale-[1.04]"
                onError={(e) => {
                  const img = e.currentTarget;
                  if (img.src !== it.favicon) {
                    img.src = it.favicon;
                    img.className = "m-auto h-12 w-12 object-contain opacity-80";
                  }
                }}
              />
              <span className="absolute left-2 top-2 flex items-center gap-1.5 rounded-full bg-black/70 px-2 py-0.5 backdrop-blur">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={it.favicon} alt="" className="h-3.5 w-3.5 rounded-sm" />
                <span className="max-w-[130px] truncate text-[10px] text-ice/90">{it.domain}</span>
              </span>
            </div>
            <div className="flex flex-1 flex-col p-3">
              <div className="line-clamp-2 text-[14px] font-medium leading-snug text-ice">{it.title}</div>
              <div className="mt-1 line-clamp-3 text-[11px] leading-snug text-slate">{it.snippet}</div>
              <span className="mt-auto pt-2 text-[10px] text-cyan/70 opacity-0 transition group-hover:opacity-100">open &nearr;</span>
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}

/* ---------------------------------- shopping frames ---------------------------------- */

type ShopItem = { image: string; title: string; price: string; merchant: string; delivery?: string; rating?: number; reviews?: number; url?: string };

// Three products per page, each presented cut-out style on its own lit frame.
export function ShopView({ value }: { value: string }) {
  let w: { label: string; items: ShopItem[] } | null = null;
  try {
    w = JSON.parse(value);
  } catch {
    /* noop */
  }
  const [page, setPage] = useState(0);
  const label = w?.label;
  useEffect(() => setPage(0), [label]);
  if (!w?.items?.length) return <div className="flex flex-1 items-center justify-center text-sm text-slate">nothing found</div>;
  const per = 3;
  const pages = Math.max(1, Math.ceil(w.items.length / per));
  const cur = Math.min(page, pages - 1);
  const slice = w.items.slice(cur * per, cur * per + per);
  return (
    <div className="flex min-h-0 flex-1 flex-col p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="hud-label">{w.items.length} picks</span>
        <div className="flex items-center gap-2">
          <button disabled={cur === 0} onClick={() => setPage(Math.max(0, cur - 1))} className="hud-label rounded px-2 py-1 transition disabled:opacity-25 hover:text-cyan">
            &lsaquo; prev
          </button>
          <span className="hud-label">{cur + 1}/{pages}</span>
          <button disabled={cur >= pages - 1} onClick={() => setPage(Math.min(pages - 1, cur + 1))} className="hud-label rounded px-2 py-1 transition disabled:opacity-25 hover:text-cyan">
            next &rsaquo;
          </button>
        </div>
      </div>
      <div className="grid flex-1 grid-cols-1 content-center gap-5 md:grid-cols-3">
        {slice.map((it, i) => {
          const n = cur * per + i + 1;
          const fast = it.delivery && /same.day|next.day|tomorrow|\b1 day|\b1-2 day|24 ?h/i.test(it.delivery);
          return (
            <div key={n} className="tile rise group flex flex-col" style={{ animationDelay: `${i * 90}ms` }}>
              <div className="relative m-3 mb-0 grid h-56 place-items-center overflow-hidden rounded-xl bg-[radial-gradient(circle_at_50%_92%,rgba(0,255,136,0.16),transparent_58%),linear-gradient(180deg,rgba(255,255,255,0.06),rgba(255,255,255,0.01))] ring-1 ring-white/10">
                <span className="pointer-events-none absolute inset-x-6 top-0 h-px bg-gradient-to-r from-transparent via-white/40 to-transparent" />
                <span className="pointer-events-none absolute inset-x-10 bottom-2 h-3 rounded-[100%] bg-black/50 blur-md" />
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={it.image} alt="" className="max-h-44 max-w-[85%] object-contain drop-shadow-[0_18px_26px_rgba(0,0,0,0.65)] transition-transform duration-300 group-hover:scale-[1.04]" />
                <span className="absolute left-2 top-2 grid h-7 w-7 place-items-center rounded-full bg-black/75 font-mono text-xs text-cyan ring-1 ring-cyan/50">{n}</span>
                {fast && (
                  <span className="absolute right-2 top-2 rounded-full bg-cyan/15 px-2 py-0.5 text-[9px] uppercase tracking-wider text-cyan ring-1 ring-cyan/40">fast</span>
                )}
              </div>
              <div className="flex flex-1 flex-col p-3">
                <div className="line-clamp-2 text-[13px] leading-snug text-ice">{it.title}</div>
                <div className="mt-1.5 flex items-baseline gap-2">
                  <span className="text-xl font-semibold tracking-tight text-cyan">{it.price}</span>
                  <span className="min-w-0 truncate text-[10px] text-slate">{it.merchant}</span>
                </div>
                <div className="mt-0.5 flex items-center gap-2 text-[10px] text-slate">
                  {it.delivery && <span className="truncate">{it.delivery}</span>}
                  {it.rating != null && <span className="shrink-0 text-amber">&#9733; {it.rating}{it.reviews ? ` (${it.reviews.toLocaleString("en-GB")})` : ""}</span>}
                </div>
                <div className="mt-auto pt-2.5">
                  {it.url && (
                    <a
                      href={it.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block rounded-lg bg-cyan/10 py-1.5 text-center text-xs text-cyan ring-1 ring-cyan/40 transition hover:bg-cyan/20"
                    >
                      view / buy {"↗"}
                    </a>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ---------------------------------- ranked portrait tiles ---------------------------------- */

type RankItem = { rank: number; name: string; note?: string; bio?: string; img?: string; url?: string };

export function RankingView({ value }: { value: string }) {
  let w: { title?: string; items?: RankItem[]; highlight?: number } | null = null;
  try {
    w = JSON.parse(value);
  } catch {
    /* noop */
  }
  const items = w?.items ?? [];
  const highlight = w?.highlight ?? 0;
  const focusRef = useRef<HTMLDivElement | null>(null);
  // when a tile is focused (rank_focus), scroll it into view
  useEffect(() => {
    if (highlight && focusRef.current) focusRef.current.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
  }, [highlight]);
  if (!items.length) return <div className="flex flex-1 items-center justify-center text-sm text-slate">nothing to rank</div>;
  // 3–5 across depending on count so tiles stay portrait, never stretched
  const cols = items.length <= 3 ? "sm:grid-cols-3" : items.length === 4 ? "sm:grid-cols-2 md:grid-cols-4" : "sm:grid-cols-3 md:grid-cols-5";
  return (
    <div className="flex min-h-0 flex-1 flex-col p-4 md:p-5">
      <div className="mb-3 flex items-center gap-2">
        <span className="hud-label shrink-0">{items.length} ranked</span>
        {w?.title && <span className="min-w-0 truncate text-sm font-semibold text-ice">{w.title}</span>}
      </div>
      <div className={`scrollbar-thin grid min-h-0 flex-1 grid-cols-2 content-center gap-3 overflow-y-auto md:gap-4 ${cols}`}>
        {items.map((it, i) => {
          const focused = highlight === it.rank;
          return (
            <div
              key={it.rank}
              ref={focused ? focusRef : undefined}
              className={`tile rise group flex flex-col overflow-hidden transition-all duration-500 ${
                focused ? "tile-pulse !border-cyan/70 ring-2 ring-cyan/60" : highlight ? "opacity-60" : ""
              }`}
              style={{ animationDelay: `${i * 80}ms` }}
            >
              <div className="relative aspect-[3/4] overflow-hidden bg-[radial-gradient(circle_at_50%_28%,rgba(0,255,136,0.15),transparent_62%),linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0.01))]">
                {it.img ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={it.img} alt={it.name} className="h-full w-full object-cover object-top transition-transform duration-500 group-hover:scale-[1.05]" />
                ) : (
                  <div className="grid h-full w-full place-items-center text-4xl font-bold text-cyan/60">{it.name.slice(0, 1).toUpperCase()}</div>
                )}
                <span className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-black/85 to-transparent" />
                <span className={`absolute left-2 top-2 grid h-7 w-7 place-items-center rounded-full font-mono text-sm ring-1 ${focused ? "bg-cyan text-black ring-cyan" : "bg-black/75 text-cyan ring-cyan/50"}`}>{it.rank}</span>
              </div>
              <div className="flex flex-1 flex-col p-2.5">
                <div className="line-clamp-2 text-[13px] font-semibold leading-tight text-ice">{it.name}</div>
                {it.note && <div className="mt-1 line-clamp-1 text-[10px] font-medium uppercase tracking-wide text-cyan/70">{it.note}</div>}
                {/* small bio always sits under the image; expands when focused */}
                {it.bio && <div className={`mt-1 text-[10px] leading-snug text-slate ${focused ? "" : "line-clamp-2"}`}>{it.bio}</div>}
                {it.url && (
                  <a href={it.url} target="_blank" rel="noopener noreferrer" className="mt-auto pt-2 text-[10px] text-cyan/80 transition hover:text-cyan">
                    wiki ↗
                  </a>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ---------------------------------- fleet / mission control ---------------------------------- */

const JOB_DOT: Record<string, string> = {
  pending: "bg-slate/60",
  running: "bg-cyan animate-pulse",
  done: "bg-emerald-400",
  error: "bg-red-400",
};

export function FleetView({ value }: { value: string }) {
  let missionId = "";
  try {
    missionId = JSON.parse(value)?.missionId ?? "";
  } catch {
    /* noop */
  }
  const missions = (useQuery(api.missions.active, {}) ?? []) as any[];
  const m = missions.find((x) => x._id === missionId) ?? missions[0];
  if (!m)
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-slate">
        No fleet in flight right now.
      </div>
    );
  const done = m.jobs.filter((j: any) => j.status === "done").length;
  const glass = "rounded-xl border border-white/10 bg-white/[0.045] backdrop-blur-xl";
  return (
    <div className="scrollbar-thin min-h-0 flex-1 overflow-auto p-5">
      <div className="mx-auto max-w-2xl">
        <div className="text-center">
          <div className="hud-label mb-1">mission</div>
          <div className="text-lg font-semibold leading-snug text-ice">{m.goal}</div>
          <div className="mt-2 flex items-center justify-center gap-2">
            <span className={`h-2 w-2 rounded-full ${m.status === "running" ? "bg-cyan animate-pulse" : m.status === "synthesizing" ? "bg-amber animate-pulse" : m.status === "done" ? "bg-emerald-400" : "bg-red-400"}`} />
            <span className="hud-label">
              {m.status === "synthesizing" ? "synthesizing report" : m.status} · {done}/{m.jobs.length} agents done
            </span>
          </div>
          <div className="mx-auto mt-3 h-1.5 w-64 overflow-hidden rounded-full bg-white/5">
            <div
              className="h-full rounded-full bg-gradient-to-r from-cyan/50 to-cyan transition-all duration-700"
              style={{ width: `${m.status === "done" ? 100 : Math.round((done / Math.max(1, m.jobs.length)) * 92)}%` }}
            />
          </div>
        </div>
        <div className="mt-5 space-y-2">
          {m.jobs.map((j: any) => (
            <div key={j._id} className={`${glass} flex items-center gap-3 p-3`}>
              <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${JOB_DOT[j.status] ?? "bg-slate"}`} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-ice">{j.label}</div>
                {j.status === "running" && j.progress && (
                  <div className="mt-0.5 truncate font-mono text-[10px] text-cyan/80">› {j.progress}</div>
                )}
              </div>
              {j.model && <span className="hud-label shrink-0 !text-[9px]">{j.model}</span>}
              <span className="hud-label shrink-0 !text-[9px]">{j.status}</span>
            </div>
          ))}
        </div>
        {m.summary && (
          <div className={`${glass} mt-4 p-4`}>
            <div className="hud-label mb-2">mission report</div>
            <div className="whitespace-pre-wrap text-sm leading-relaxed text-ice">{m.summary}</div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------------------------------- video selection list ---------------------------------- */

export function VideoListView({ value }: { value: string }) {
  let w: { query: string; items: { id: string; title: string; channel: string; length: string }[] } | null = null;
  try {
    w = JSON.parse(value);
  } catch {
    /* noop */
  }
  const setPanel = useMutation(api.ui.setPanel);
  if (!w) return <pre className="p-4 text-sm text-ice">{value}</pre>;
  return (
    <div className="scrollbar-thin min-h-0 flex-1 overflow-auto p-3">
      <div className="hud-label mb-2">youtube · {w.query}</div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        {w.items.map((v) => (
          <button
            key={v.id}
            onClick={() =>
              // tap = load it READY to watch (paused) — nothing autoplays
              void setPanel({ type: "video", value: `https://www.youtube.com/embed/${v.id}?enablejsapi=1&rel=0`, title: v.title })
            }
            className="card-lift glass group overflow-hidden rounded-xl text-left"
            title={v.title}
          >
            <div className="relative">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`https://img.youtube.com/vi/${v.id}/mqdefault.jpg`} alt="" className="aspect-video w-full object-cover" />
              <span className="absolute bottom-1.5 right-1.5 rounded bg-black/80 px-1.5 py-0.5 font-mono text-[10px] text-ice">{v.length}</span>
              <span className="absolute inset-0 grid place-items-center opacity-0 transition group-hover:opacity-100">
                <span className="grid h-11 w-11 place-items-center rounded-full bg-cyan/90 pl-0.5 text-lg text-black">▶</span>
              </span>
            </div>
            <div className="p-2">
              <div className="line-clamp-2 text-xs leading-snug text-ice">{v.title}</div>
              <div className="hud-label mt-1 !text-[8px]">{v.channel}</div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

/* ---------------------------------- candles (real chart) ---------------------------------- */

type CandleRow = [number, number, number, number, number, number]; // t o h l c v
type CandlesWidget = {
  asset: string;
  interval: string;
  unit: string;
  last: number;
  changePct: number;
  candles: CandleRow[];
  sma20: (number | null)[];
  sma50: (number | null)[];
  sma200: (number | null)[];
  rsi: (number | null)[];
  levels: { price: number; kind: string; touches: number }[];
  notes?: string[];
};

const fmtP = (n: number) =>
  n >= 1000 ? n.toLocaleString("en-US", { maximumFractionDigits: 0 }) : n.toLocaleString("en-US", { maximumFractionDigits: n >= 10 ? 2 : 4 });

export function CandlesView({ w }: { w: CandlesWidget }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 960;
  const H = 540;
  const padR = 74;
  const priceH = 340;
  const volH = 70;
  const rsiH = 70;
  const topPad = 14;
  const n = w.candles.length;
  const xs = (i: number) => ((W - padR) * (i + 0.5)) / n;
  const bw = Math.max(1.5, ((W - padR) / n) * 0.62);

  const { lo, hi } = useMemo(() => {
    let lo = Infinity,
      hi = -Infinity;
    for (const c of w.candles) {
      lo = Math.min(lo, c[3]);
      hi = Math.max(hi, c[2]);
    }
    for (const l of w.levels) {
      lo = Math.min(lo, l.price);
      hi = Math.max(hi, l.price);
    }
    const pad = (hi - lo) * 0.06;
    return { lo: lo - pad, hi: hi + pad };
  }, [w]);
  const ys = (p: number) => topPad + priceH - ((p - lo) / (hi - lo)) * priceH;
  const maxV = useMemo(() => Math.max(1, ...w.candles.map((c) => c[5])), [w]);
  const volY = topPad + priceH + 26;
  const rsiY = volY + volH + 24;

  const maPath = (arr: (number | null)[]) => {
    let d = "";
    arr.forEach((v, i) => {
      if (v == null) return;
      d += `${d ? "L" : "M"}${xs(i).toFixed(1)},${ys(v).toFixed(1)}`;
    });
    return d;
  };
  const rsiPath = useMemo(() => {
    let d = "";
    w.rsi.forEach((v, i) => {
      if (v == null) return;
      d += `${d ? "L" : "M"}${xs(i).toFixed(1)},${(rsiY + rsiH - (v / 100) * rsiH).toFixed(1)}`;
    });
    return d;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [w]);

  const hc = hover != null ? w.candles[hover] : null;
  const dateFmt = (t: number) =>
    new Date(t).toLocaleDateString("en-GB", { day: "2-digit", month: "short", ...(w.interval === "1h" || w.interval === "4h" ? { hour: "2-digit", minute: "2-digit" } : {}) });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-white/5 px-3 py-2">
        <span className="text-sm font-semibold text-ice">{w.asset}</span>
        <span className="hud-label !text-[9px]">{w.interval} · {w.unit}</span>
        <span className="font-mono text-sm text-ice">${fmtP(w.last)}</span>
        <span className={`text-xs ${w.changePct >= 0 ? "text-emerald-400" : "text-red-400"}`}>
          {w.changePct >= 0 ? "▲" : "▼"} {Math.abs(w.changePct)}%
        </span>
        <span className="ml-auto flex gap-2 text-[9px] uppercase tracking-widest">
          <span className="text-amber">— 20</span>
          <span className="text-sky-300">— 50</span>
          <span className="text-pink-400">— 200</span>
        </span>
      </div>
      {w.notes && w.notes[0] && <div className="border-b border-white/5 px-3 py-1 text-[11px] italic text-cyan/80">{w.notes[0]}</div>}
      <div className="scrollbar-thin min-h-0 flex-1 overflow-auto">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="block h-full w-full"
          preserveAspectRatio="xMidYMid meet"
          onMouseMove={(e) => {
            const r = (e.target as SVGElement).closest("svg")!.getBoundingClientRect();
            const i = Math.floor(((e.clientX - r.left) / r.width) * W / ((W - padR) / n));
            setHover(i >= 0 && i < n ? i : null);
          }}
          onMouseLeave={() => setHover(null)}
        >
          {/* grid + price axis */}
          {[0, 0.25, 0.5, 0.75, 1].map((f) => {
            const p = lo + (hi - lo) * f;
            return (
              <g key={f}>
                <line x1={0} x2={W - padR} y1={ys(p)} y2={ys(p)} stroke="rgba(255,255,255,0.05)" />
                <text x={W - padR + 6} y={ys(p) + 3} fontSize="10" fill="#6d7f99" fontFamily="monospace">
                  {fmtP(p)}
                </text>
              </g>
            );
          })}
          {/* levels */}
          {w.levels.map((l, i) => (
            <g key={i}>
              <line
                x1={0}
                x2={W - padR}
                y1={ys(l.price)}
                y2={ys(l.price)}
                stroke={l.kind === "support" ? "rgba(0,255,136,0.45)" : "rgba(255,84,112,0.45)"}
                strokeDasharray="6 5"
                strokeWidth="1.2"
              />
              <text x={4} y={ys(l.price) - 3} fontSize="9" fill={l.kind === "support" ? "#00ff88" : "#ff5470"} opacity="0.9">
                {l.kind[0].toUpperCase()} {fmtP(l.price)} ×{l.touches}
              </text>
            </g>
          ))}
          {/* candles */}
          {w.candles.map((c, i) => {
            const up = c[4] >= c[1];
            const col = up ? "#00e589" : "#ff5470";
            return (
              <g key={i} opacity={hover === null || hover === i ? 1 : 0.75}>
                <line x1={xs(i)} x2={xs(i)} y1={ys(c[2])} y2={ys(c[3])} stroke={col} strokeWidth="1" />
                <rect
                  x={xs(i) - bw / 2}
                  y={ys(Math.max(c[1], c[4]))}
                  width={bw}
                  height={Math.max(1, Math.abs(ys(c[1]) - ys(c[4])))}
                  fill={up ? col : col}
                  opacity={up ? 0.95 : 0.9}
                />
              </g>
            );
          })}
          {/* MAs */}
          <path d={maPath(w.sma20)} fill="none" stroke="#ffb454" strokeWidth="1.4" opacity="0.9" />
          <path d={maPath(w.sma50)} fill="none" stroke="#5cc8ff" strokeWidth="1.4" opacity="0.9" />
          <path d={maPath(w.sma200)} fill="none" stroke="#ff7ad9" strokeWidth="1.6" opacity="0.9" />
          {/* volume */}
          <text x={2} y={volY - 6} fontSize="9" fill="#6d7f99" letterSpacing="2">VOLUME</text>
          {w.candles.map((c, i) => (
            <rect
              key={i}
              x={xs(i) - bw / 2}
              y={volY + volH - (c[5] / maxV) * volH}
              width={bw}
              height={(c[5] / maxV) * volH}
              fill={c[4] >= c[1] ? "rgba(0,229,137,0.5)" : "rgba(255,84,112,0.5)"}
            />
          ))}
          {/* RSI */}
          <text x={2} y={rsiY - 6} fontSize="9" fill="#6d7f99" letterSpacing="2">RSI 14</text>
          {[30, 50, 70].map((g) => (
            <g key={g}>
              <line x1={0} x2={W - padR} y1={rsiY + rsiH - (g / 100) * rsiH} y2={rsiY + rsiH - (g / 100) * rsiH} stroke={g === 50 ? "rgba(255,255,255,0.05)" : "rgba(255,255,255,0.1)"} strokeDasharray={g === 50 ? "2 4" : "4 4"} />
              <text x={W - padR + 6} y={rsiY + rsiH - (g / 100) * rsiH + 3} fontSize="9" fill="#6d7f99" fontFamily="monospace">{g}</text>
            </g>
          ))}
          <path d={rsiPath} fill="none" stroke="#00ff88" strokeWidth="1.3" opacity="0.85" />
          {/* crosshair + tooltip */}
          {hc && (
            <g>
              <line x1={xs(hover!)} x2={xs(hover!)} y1={topPad} y2={rsiY + rsiH} stroke="rgba(255,255,255,0.25)" strokeDasharray="3 3" />
              <rect x={Math.min(xs(hover!) + 8, W - 258)} y={topPad + 2} width={250} height={17} rx={4} fill="rgba(5,10,18,0.92)" stroke="rgba(0,255,136,0.25)" />
              <text x={Math.min(xs(hover!) + 14, W - 252)} y={topPad + 14} fontSize="10" fill="#dbe9f7" fontFamily="monospace">
                {dateFmt(hc[0])}  O {fmtP(hc[1])}  H {fmtP(hc[2])}  L {fmtP(hc[3])}  C {fmtP(hc[4])}
              </text>
            </g>
          )}
        </svg>
      </div>
    </div>
  );
}

/* ---------------------------------- mind map ---------------------------------- */

type CNode = {
  id: string;
  label: string;
  detail?: string;
  parent?: string;
  color?: string;
  url?: string;
  image?: string;
  rows?: string[][];
};
type CEdge = { from: string; to: string; label?: string };

const NODE_COLOR: Record<string, string> = {
  green: "#00ff88",
  amber: "#ffb454",
  blue: "#5cc8ff",
  pink: "#ff7ad9",
  slate: "#8fa3bd",
};

function nodeHeight(n: CNode): number {
  let h = 44;
  if (n.detail) h += 16;
  if (n.image) h += 92;
  if (n.rows?.length) h += 12 + n.rows.length * 17;
  return h;
}

// Tidy left→right tree; multiple roots stack. Orphans (bad parent) become roots.
function layout(nodes: CNode[], _edges: CEdge[]) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const children = new Map<string, CNode[]>();
  const roots: CNode[] = [];
  for (const n of nodes) {
    if (n.parent && byId.has(n.parent) && n.parent !== n.id) {
      const arr = children.get(n.parent) ?? [];
      arr.push(n);
      children.set(n.parent, arr);
    } else roots.push(n);
  }
  const pos = new Map<string, { x: number; y: number; h: number }>();
  const W = 210;
  const GX = 84;
  const GY = 14;
  let cursor = 16;
  const seen = new Set<string>();
  const place = (n: CNode, depth: number): { top: number; bottom: number; mid: number } => {
    if (seen.has(n.id)) {
      const p = pos.get(n.id)!;
      return { top: p.y, bottom: p.y + p.h, mid: p.y + p.h / 2 };
    }
    seen.add(n.id);
    const kids = (children.get(n.id) ?? []).filter((k) => !seen.has(k.id));
    const h = nodeHeight(n);
    if (!kids.length) {
      const y = cursor;
      cursor += h + GY;
      pos.set(n.id, { x: 16 + depth * (W + GX), y, h });
      return { top: y, bottom: y + h, mid: y + h / 2 };
    }
    const spans = kids.map((k) => place(k, depth + 1));
    const mid = (spans[0].mid + spans[spans.length - 1].mid) / 2;
    const y = Math.max(16, mid - h / 2);
    cursor = Math.max(cursor, y + h + GY);
    pos.set(n.id, { x: 16 + depth * (W + GX), y, h });
    return { top: y, bottom: y + h, mid: y + h / 2 };
  };
  for (const r of roots) {
    place(r, 0);
    cursor += 10;
  }
  let maxX = 0,
    maxY = 0;
  for (const p of pos.values()) {
    maxX = Math.max(maxX, p.x + W);
    maxY = Math.max(maxY, p.y + p.h);
  }
  return { pos, W, width: maxX + 24, height: maxY + 24, children };
}

export function CanvasView({ value }: { value: string }) {
  let doc: { title: string; nodes: CNode[]; edges?: CEdge[] } | null = null;
  try {
    doc = JSON.parse(value);
  } catch {
    /* noop */
  }
  const nodes = useMemo(() => doc?.nodes ?? [], [doc?.nodes]);
  const edges = useMemo(() => doc?.edges ?? [], [doc?.edges]);
  const { pos, W, width, height } = useMemo(() => layout(nodes, edges), [nodes, edges]);
  if (!doc) return <pre className="p-4 text-sm text-ice">{value}</pre>;

  const treeLinks: { from: string; to: string; label?: string }[] = [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const n of nodes) if (n.parent && byId.has(n.parent) && n.parent !== n.id) treeLinks.push({ from: n.parent, to: n.id });

  const path = (a: { x: number; y: number; h: number }, b: { x: number; y: number; h: number }) => {
    const x1 = a.x + W,
      y1 = a.y + a.h / 2,
      x2 = b.x,
      y2 = b.y + b.h / 2;
    const dx = Math.max(34, (x2 - x1) / 2);
    return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
  };

  return (
    <div className="scrollbar-thin min-h-0 flex-1 overflow-auto">
      <svg width={Math.max(width, 400)} height={Math.max(height, 240)} className="block">
        {/* tree connectors */}
        {treeLinks.map((l, i) => {
          const a = pos.get(l.from),
            b = pos.get(l.to);
          if (!a || !b) return null;
          return <path key={`t${i}`} d={path(a, b)} fill="none" stroke="rgba(0,255,136,0.35)" strokeWidth="1.6" />;
        })}
        {/* cross connections */}
        {edges.map((l, i) => {
          const a = pos.get(l.from),
            b = pos.get(l.to);
          if (!a || !b) return null;
          const mx = (a.x + W + b.x) / 2;
          const my = (a.y + a.h / 2 + b.y + b.h / 2) / 2;
          return (
            <g key={`x${i}`}>
              <path d={path(a, b)} fill="none" stroke="rgba(255,180,84,0.5)" strokeWidth="1.3" strokeDasharray="5 4" />
              {l.label && (
                <text x={mx} y={my - 4} textAnchor="middle" fontSize="9" fill="#ffb454" style={{ letterSpacing: "0.08em" }}>
                  {l.label}
                </text>
              )}
            </g>
          );
        })}
        {/* nodes */}
        {nodes.map((n) => {
          const p = pos.get(n.id);
          if (!p) return null;
          const accent = NODE_COLOR[n.color ?? ""] ?? NODE_COLOR.green;
          return (
            <foreignObject key={n.id} x={p.x} y={p.y} width={W} height={p.h}>
              <div
                className="mm-node flex h-full flex-col justify-center rounded-xl border bg-[rgba(13,22,38,0.75)] px-3 py-1.5 backdrop-blur-md"
                style={{ borderColor: `${accent}55`, boxShadow: `0 0 18px ${accent}22` }}
              >
                {n.url ? (
                  <a href={n.url} target="_blank" rel="noreferrer" className="truncate text-[13px] font-semibold underline decoration-dotted" style={{ color: accent }}>
                    {n.label} ↗
                  </a>
                ) : (
                  <div className="truncate text-[13px] font-semibold" style={{ color: accent }}>
                    {n.label}
                  </div>
                )}
                {n.detail && <div className="truncate text-[10px] text-slate">{n.detail}</div>}
                {n.image && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={n.image} alt="" className="mt-1 h-[84px] w-full rounded-lg object-cover" />
                )}
                {n.rows && n.rows.length > 0 && (
                  <table className="mt-1 w-full border-collapse">
                    <tbody>
                      {n.rows.map((r, i) => (
                        <tr key={i} className={i === 0 ? "text-[9px] font-semibold text-ice" : "text-[9px] text-slate"}>
                          {r.map((c, j) => (
                            <td key={j} className="border border-white/10 px-1 py-0.5">
                              {c}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </foreignObject>
          );
        })}
      </svg>
    </div>
  );
}

/* ---------------------------------- launcher ---------------------------------- */

export function LaunchView({ value }: { value: string }) {
  let app: { name: string; url: string } | null = null;
  try {
    app = JSON.parse(value);
  } catch {
    /* noop */
  }
  const opened = useRef(false);
  useEffect(() => {
    // best-effort auto-open — if the popup blocker eats it, the button remains
    if (app?.url && !opened.current) {
      opened.current = true;
      try {
        window.open(app.url, "_blank", "noopener");
      } catch {
        /* button fallback */
      }
    }
  }, [app?.url]);
  if (!app) return <pre className="p-4 text-sm text-ice">{value}</pre>;
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-5 p-8 text-center">
      <div className="hud-label">launching</div>
      <div className="text-3xl font-semibold tracking-wide text-ice">{app.name}</div>
      <a
        href={app.url}
        target="_blank"
        rel="noreferrer"
        className="rounded-2xl bg-cyan/15 px-8 py-4 text-lg font-medium text-cyan ring-1 ring-cyan/50 transition hover:bg-cyan/25"
        style={{ boxShadow: "0 0 42px rgba(0,255,136,0.18)" }}
      >
        Open {app.name} ↗
      </a>
      <div className="max-w-xs truncate font-mono text-[11px] text-slate">{app.url}</div>
      <div className="text-xs text-slate/70">Opens in a new tab — I&apos;ll stay right here.</div>
    </div>
  );
}

/* ---------------------------------- pdf ---------------------------------- */

export function PdfView({ url, title }: { url: string; title?: string }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between border-b border-white/5 px-3 py-1.5">
        <span className="truncate text-xs text-ice">{title ?? "document.pdf"}</span>
        <a href={url} target="_blank" rel="noreferrer" className="hud-label shrink-0 rounded px-2 py-0.5 !text-cyan hover:bg-cyan/10">
          ⬇ download
        </a>
      </div>
      <iframe src={url} className="min-h-0 w-full flex-1 bg-white" title={title ?? "pdf"} />
    </div>
  );
}

/* ---------------------------------- creations library ---------------------------------- */

const KIND_ICON: Record<string, string> = { canvas: "🕸", board: "🎨", chart: "📊", image: "🖼", pdf: "📕", doc: "📄", trip: "🌍" };

export function CreationsView({ value }: { value: string }) {
  let filter: { kind: string | null } = { kind: null };
  try {
    filter = JSON.parse(value);
  } catch {
    /* noop */
  }
  const [kind, setKind] = useState<string | null>(filter.kind);
  const rows = (useQuery(api.creations.list, { kind: kind ?? undefined, limit: 60 }) ?? []) as {
    _id: string;
    kind: string;
    title: string;
    data?: string;
    url?: string;
    thumb?: string;
    updatedAt: number;
  }[];
  const setPanel = useMutation(api.ui.setPanel);

  const open = (r: (typeof rows)[number]) => {
    if (r.kind === "image" && r.url) void setPanel({ type: "image", value: r.url, title: r.title });
    else if (r.kind === "pdf" && r.url) void setPanel({ type: "pdf", value: r.url, title: r.title });
    else if (r.kind === "canvas" && r.data) void setPanel({ type: "canvas", value: r.data, title: `map · ${r.title}` });
    else if (r.kind === "board") void setPanel({ type: "board", value: JSON.stringify({ creationId: r._id }), title: `board · ${r.title}` });
    else if (r.kind === "trip") void setPanel({ type: "trip", value: JSON.stringify({ creationId: r._id }), title: `trip · ${r.title}` });
    else if (r.kind === "doc") void setPanel({ type: "doc", value: JSON.stringify({ creationId: r._id }), title: `draft · ${r.title}` });
    else if (r.kind === "chart" && r.data) void setPanel({ type: "widget", value: r.data, title: r.title });
    else if (r.data) void setPanel({ type: "markdown", value: r.data, title: r.title });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1.5 border-b border-white/5 px-3 py-2">
        {[null, "canvas", "chart", "image", "pdf", "doc"].map((k) => (
          <button
            key={k ?? "all"}
            onClick={() => setKind(k)}
            className={`rounded-full px-2.5 py-0.5 text-[10px] uppercase tracking-widest transition ${
              kind === k ? "bg-cyan/15 text-cyan ring-1 ring-cyan/40" : "text-slate hover:text-ice"
            }`}
          >
            {k ?? "all"}
          </button>
        ))}
      </div>
      <div className="scrollbar-thin min-h-0 flex-1 overflow-auto p-3">
        {rows.length === 0 && <div className="mt-10 text-center text-sm text-slate">Nothing here yet — everything I create lands in this library.</div>}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {rows.map((r) => (
            <button
              key={r._id}
              onClick={() => open(r)}
              className="card-lift glass flex flex-col overflow-hidden rounded-xl text-left"
              title={r.title}
            >
              {r.thumb ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={r.thumb} alt="" className="h-24 w-full object-cover" />
              ) : (
                <div className="flex h-24 w-full items-center justify-center bg-cyan/5 text-3xl">{KIND_ICON[r.kind] ?? "✦"}</div>
              )}
              <div className="p-2">
                <div className="truncate text-xs text-ice">{r.title}</div>
                <div className="hud-label !text-[8px]">
                  {r.kind} · {new Date(r.updatedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
