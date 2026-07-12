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

const KIND_ICON: Record<string, string> = { canvas: "🕸", chart: "📊", image: "🖼", pdf: "📕", doc: "📄" };

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
