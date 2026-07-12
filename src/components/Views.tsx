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
          preserveAspectRatio="none"
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
