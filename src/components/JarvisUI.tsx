"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import ThreeOrb from "./ThreeOrb";
import { isToolGarbage, sanitizeAssistantText } from "../lib/sanitize";
import { CalendarView, CanvasView, LaunchView, PdfView, CreationsView, CandlesView, VideoListView, FleetView, FeedView, WeatherView, TodosView, Briefing2View, ShopView, DocView, WebResultsView, PlacesView, RankingView } from "./Views";
import TripView from "./TripView";
import BoardView from "./BoardView";

type Attachment = { type: string; value: string; title?: string };
type Msg = {
  _id: string;
  role: string;
  text: string;
  status: string;
  model?: string;
  attachment?: Attachment;
  createdAt: number;
};
type Job = { _id: string; task: string; model?: string; status: string; progress?: string; log?: string; startedAt: number };
type Caption = { who: "you" | "jarvis"; text: string } | null;

const ytId = (s: string) => {
  const m = String(s).match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([\w-]{11})/);
  return m ? m[1] : null;
};

// One speaking tab per Daniel — everyone else stays quiet (voice election).
function clientId(): string {
  try {
    let id = sessionStorage.getItem("jarvis_client");
    if (!id) {
      id = Math.random().toString(36).slice(2, 10);
      sessionStorage.setItem("jarvis_client", id);
    }
    return id;
  } catch {
    return "anon";
  }
}

// Minimal, safe markdown for result panels: escape everything, then linkify
// [title](url) + headers + bold. No raw HTML ever passes through.
function mdToHtml(src: string): string {
  const esc = src.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return esc
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer" class="text-cyan underline decoration-cyan/40 hover:decoration-cyan">$1</a>')
    .replace(/^###? (.+)$/gm, '<div class="mb-2 mt-1 text-base font-semibold text-ice">$1</div>')
    .replace(/^(\d+)\. (.*)$/gm, '<span class="text-cyan/70">$1.</span> $2')
    .replace(/^[-•] (.*)$/gm, '<span class="text-cyan/70">›</span> $1')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\n/g, "<br/>");
}

const WIDGET_ICON: Record<string, string> = {
  weather: "🌤",
  stats: "📊",
  market: "📈",
  timer: "⏱",
  briefing: "📋",
  briefing2: "📋",
  todos: "☑",
  calendar: "📅",
  candles: "📈",
  videos: "📺",
  shop: "🛍",
  doc: "📝",
  ranking: "🏆",
};

// Persistent media card in the stream — click to put it back on the big screen.
function MediaCard({ a, onShow }: { a: Attachment; onShow: (a: Attachment) => void }) {
  const id = a.type === "video" ? ytId(a.value) : null;
  const ext = id ? `https://www.youtube.com/watch?v=${id}` : a.value;
  let widgetKind = "";
  if (a.type === "widget") {
    try {
      widgetKind = JSON.parse(a.value)?.kind ?? "";
    } catch {
      /* generic icon */
    }
  }
  return (
    <span className="glass card-lift inline-flex max-w-[88%] items-center gap-2 overflow-hidden rounded-xl p-1.5 pr-2 text-left">
      <button onClick={() => onShow(a)} className="flex min-w-0 items-center gap-2" title="show on screen">
        {id ? (
          <img src={`https://img.youtube.com/vi/${id}/mqdefault.jpg`} alt="" className="h-12 w-20 shrink-0 rounded-lg object-cover" />
        ) : a.type === "image" ? (
          <img src={a.value} alt="" className="h-12 w-20 shrink-0 rounded-lg object-cover" />
        ) : (
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-cyan/10 text-lg">
            {a.type === "widget"
              ? WIDGET_ICON[widgetKind] ?? "🧩"
              : a.type === "url" || a.type === "site"
                ? "🌐"
                : a.type === "code"
                  ? "‹›"
                  : a.type === "pdf"
                    ? "📕"
                    : a.type === "canvas"
                      ? "🕸"
                      : a.type === "trip"
                        ? "🌍"
                        : "📄"}
          </span>
        )}
        <span className="min-w-0">
          <span className="block truncate text-xs text-ice">{a.title || a.value}</span>
          <span className="hud-label !text-[8px] !text-cyan-dim">{a.type} · tap to view</span>
        </span>
      </button>
      {(a.type === "url" || a.type === "video" || a.type === "image") && (
        <a href={ext} target="_blank" rel="noreferrer" className="shrink-0 text-xs text-slate hover:text-cyan" title="open in tab">
          ↗
        </a>
      )}
    </span>
  );
}

// Content-aware stage sizing: small things present as centered cards, dense
// things take the whole stage — the overlay reshuffles itself per content.
function panelSize(panel: { type: string; value: string }): string {
  let kind = panel.type;
  if (kind === "widget") {
    try {
      kind = "w:" + (JSON.parse(panel.value)?.kind ?? "");
    } catch {
      /* raw */
    }
  }
  switch (kind) {
    case "launch":
      return "w-[min(560px,94%)] h-[400px]";
    case "w:timer":
      return "w-[min(500px,94%)] h-[460px]";
    case "w:weather":
      return "w-[min(880px,80%)] h-[min(640px,90%)]";
    case "w:market":
      return "w-[min(960px,80%)] h-[min(540px,88%)]";
    case "image":
      return "w-[min(1100px,97%)] h-[min(760px,97%)]";
    case "w:candles":
      return "w-[min(1360px,98%)] h-[min(780px,96%)]";
    case "w:stats":
      return "w-[min(1080px,81%)] h-[min(680px,92%)]";
    case "w:videos":
    case "w:feed":
      return "w-[min(1340px,82%)] h-[min(740px,92%)]";
    case "w:shop":
      return "w-[min(1340px,82%)] h-[min(700px,92%)]";
    case "w:webresults":
      return "w-[min(1340px,84%)] h-[min(720px,92%)]";
    case "w:places":
      return "w-[min(1200px,90%)] h-[min(760px,94%)]";
    case "w:ranking":
      return "w-[min(1180px,88%)] h-[min(780px,94%)]";
    case "w:calc":
      return "w-[min(560px,94%)] h-[min(360px,80%)]";
    case "markdown":
      return "w-[min(980px,97%)] h-full";
    case "doc":
      return "w-[min(880px,80%)] h-[min(800px,94%)]";
    default:
      return "h-full w-full";
  }
}

function Clock() {
  const [now, setNow] = useState("");
  useEffect(() => {
    const f = () =>
      setNow(new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
    f();
    const t = setInterval(f, 1000);
    return () => clearInterval(t);
  }, []);
  return <span className="font-mono text-xs tabular-nums text-slate">{now}</span>;
}

function ModelBadge({ model }: { model?: string | null }) {
  if (!model) return null;
  const c =
    model === "opus"
      ? "text-purple-300"
      : model === "haiku"
        ? "text-slate"
        : model === "live"
          ? "text-cyan"
          : "text-sky-300";
  return <span className={`hud-label !text-[9px] ${c}`}>{model}</span>;
}

// Ambient arc-reactor HUD ring — concentric SVG rings (a segmented outer ring,
// a counter-rotating scanner, radial ticks) framing the orb when the stage is
// clear. Subtle by default; brightens when JARVIS is engaged.
// A calculation, shown big: the expression small on top, the answer huge.
function CalcView({ w }: { w: any }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      {w.label && <div className="hud-label !text-cyan">{w.label}</div>}
      <div className="font-mono text-lg text-slate">{w.expression}</div>
      <div className="h-px w-24 bg-gradient-to-r from-transparent via-cyan/40 to-transparent" />
      <div className="font-display text-6xl font-bold tracking-tight text-ice md:text-7xl" style={{ textShadow: "0 0 40px rgba(0,255,136,0.25)" }}>
        {w.result}
      </div>
    </div>
  );
}

// Options panel — a frosted-glass sheet dropping from the top right. Voice lane,
// speaking voice, motion, and a manual mood override.
const OPTION_MOODS: { k: string; c: string }[] = [
  { k: "calm", c: "#00ff88" }, { k: "focused", c: "#4a9eed" }, { k: "dreamy", c: "#9775fa" },
  { k: "warm", c: "#ffb454" }, { k: "tender", c: "#ff9ec4" }, { k: "playful", c: "#ff7ad9" },
  { k: "curious", c: "#33e0d0" }, { k: "serious", c: "#8fa3bd" }, { k: "excited", c: "#ff5470" },
];
function OptionsPanel({
  prefs, setPref, live, locOn, onLocation, onClose, onToggleLive, onMood, onClearMood,
}: {
  prefs: { voice: string; tts: string; reduceMotion: boolean };
  setPref: (k: "voice" | "tts" | "reduceMotion", v: string | boolean) => void;
  live: string;
  locOn: boolean;
  onLocation: () => void;
  onClose: () => void;
  onToggleLive: () => void;
  onMood: (m: string) => void;
  onClearMood: () => void;
}) {
  const Row = ({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) => (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <div className="min-w-0">
        <div className="text-[13px] text-ice">{label}</div>
        {hint && <div className="text-[10px] leading-tight text-slate">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
  const Seg = ({ opts, val, on }: { opts: [string, string][]; val: string; on: (v: string) => void }) => (
    <div className="flex overflow-hidden rounded-lg border border-white/10 bg-black/30 text-[11px]">
      {opts.map(([v, lbl]) => (
        <button key={v} onClick={() => on(v)} className={`px-2.5 py-1 transition ${val === v ? "bg-cyan/20 text-cyan" : "text-slate hover:text-ice"}`}>
          {lbl}
        </button>
      ))}
    </div>
  );
  return (
    <>
      <div className="fixed inset-0 z-[55]" onClick={onClose} />
      <div className="absolute right-3 top-14 z-[56] w-[min(340px,92vw)] rounded-2xl border border-white/12 bg-[rgba(14,22,38,0.72)] p-4 shadow-2xl backdrop-blur-2xl md:right-5">
        <div className="mb-1 flex items-center justify-between">
          <span className="hud-label !text-cyan">options</span>
          <button onClick={onClose} className="hud-label hover:text-cyan">close</button>
        </div>
        <div className="divide-y divide-white/5">
          <Row label="Voice" hint="how 'hey Jarvis' talks back">
            <Seg opts={[["free", "Free"], ["realtime", "Live"]]} val={prefs.voice} on={(v) => setPref("voice", v)} />
          </Row>
          <Row label="Speaking voice" hint="Fast = instant on-device · Kokoro/Eleven = richer, slower">
            <Seg opts={[["fast", "Fast"], ["free", "Kokoro"], ["elevenlabs", "Eleven"]]} val={prefs.tts} on={(v) => setPref("tts", v)} />
          </Row>
          <Row label="Live conversation" hint={live !== "off" ? "on now" : "start a realtime voice session"}>
            <button onClick={onToggleLive} className={`rounded-lg px-3 py-1 text-[11px] transition ${live !== "off" ? "bg-cyan/20 text-cyan ring-1 ring-cyan/50" : "border border-white/10 text-slate hover:text-ice"}`}>
              {live === "connecting" ? "…" : live !== "off" ? "stop" : "start"}
            </button>
          </Row>
          <Row label="Location" hint={locOn ? "on — 'near me' works everywhere" : "for 'pizza near me', local hours"}>
            <button onClick={onLocation} className={`rounded-lg px-3 py-1 text-[11px] transition ${locOn ? "bg-cyan/20 text-cyan ring-1 ring-cyan/50" : "border border-white/10 text-slate hover:text-ice"}`}>
              {locOn ? "on" : "enable"}
            </button>
          </Row>
          <Row label="Reduce motion" hint="calmer orb + fewer animations">
            <button onClick={() => setPref("reduceMotion", !prefs.reduceMotion)} className={`h-5 w-9 rounded-full p-0.5 transition ${prefs.reduceMotion ? "bg-cyan/60" : "bg-white/15"}`}>
              <span className={`block h-4 w-4 rounded-full bg-white transition-transform ${prefs.reduceMotion ? "translate-x-4" : ""}`} />
            </button>
          </Row>
          <div className="py-2.5">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[13px] text-ice">Orb mood</span>
              <button onClick={onClearMood} className="text-[10px] text-slate hover:text-cyan">auto</button>
            </div>
            <div className="flex flex-wrap gap-2">
              {OPTION_MOODS.map((m) => (
                <button
                  key={m.k}
                  onClick={() => onMood(m.k)}
                  title={m.k}
                  className="h-6 w-6 rounded-full ring-1 ring-white/20 transition hover:scale-110 hover:ring-white/50"
                  style={{ background: m.c, boxShadow: `0 0 10px ${m.c}66` }}
                />
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

// Ambient arc-reactor ring. Stays mounted and eases WITH the orb: when the orb
// glides aside for an overlay, the ring shrinks toward it and fades; when the
// orb returns to centre, the ring blooms back. Never unmounts (that was the
// abrupt pop). `active` brightens it while JARVIS is engaged.
function ReactorRing({ active, aside, hidden, color }: { active: boolean; aside: boolean; hidden: boolean; color?: string }) {
  const ticks = useMemo(
    () =>
      Array.from({ length: 60 }, (_, i) => {
        const a = (i / 60) * Math.PI * 2;
        const r1 = 232, r2 = i % 5 === 0 ? 214 : 223;
        return { x1: 250 + r1 * Math.cos(a), y1: 250 + r1 * Math.sin(a), x2: 250 + r2 * Math.cos(a), y2: 250 + r2 * Math.sin(a), major: i % 5 === 0 };
      }),
    [],
  );
  const opacity = hidden ? 0 : aside ? 0.1 : active ? 0.5 : 0.22;
  // the ring reads as part of the orb — same mood colour, glowing together
  const c = color || "#00ff88";
  return (
    <div
      className="pointer-events-none absolute inset-0 grid place-items-center transition-all duration-[900ms] ease-[cubic-bezier(0.22,1,0.36,1)]"
      style={{ opacity, transform: aside ? "translateX(58%) translateY(-4.5%) scale(0.5)" : "translateY(-4.5%) scale(1)" }}
    >
      <svg viewBox="0 0 500 500" className="h-[min(78vmin,720px)] w-[min(78vmin,720px)]" style={{ filter: `drop-shadow(0 0 10px ${c}66)`, transition: "filter 1.2s ease" }}>
        <g fill="none" stroke={c} style={{ transition: "stroke 1.2s ease" }}>
          <circle cx="250" cy="250" r="244" strokeWidth="1" strokeOpacity="0.25" strokeDasharray="40 20" style={{ transformOrigin: "center", animation: "reactor-slow 46s linear infinite" }} />
          <circle cx="250" cy="250" r="200" strokeWidth="1.5" strokeOpacity="0.18" />
          <path d="M250 62 A188 188 0 0 1 438 250" strokeWidth="2" strokeOpacity="0.7" strokeLinecap="round" style={{ transformOrigin: "center", animation: "reactor-fast 8s linear infinite reverse" }} />
          <g strokeOpacity="0.35">
            {ticks.map((t, i) => (
              <line key={i} x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2} strokeWidth={t.major ? 1.6 : 0.8} strokeOpacity={t.major ? 0.5 : 0.28} />
            ))}
          </g>
          <circle cx="250" cy="250" r="170" strokeWidth="1" strokeOpacity="0.12" strokeDasharray="2 8" style={{ transformOrigin: "center", animation: "reactor-slow 30s linear infinite reverse" }} />
        </g>
      </svg>
    </div>
  );
}

// The agent's actual CLI session, streamed: tool calls and thoughts scroll in
// live (auto-follows unless Daniel scrolled up to read something).
function LiveSessionLog({ job }: { job: Job }) {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [job.log, job.progress]);
  return (
    <div
      ref={ref}
      onScroll={() => {
        const el = ref.current;
        if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      }}
      className="scrollbar-thin mt-4 flex-1 overflow-auto rounded-xl bg-black/40 p-3 font-mono text-xs leading-relaxed text-cyan/90"
    >
      {job.log ? (
        <pre className="whitespace-pre-wrap break-words">{job.log}</pre>
      ) : (
        <>
          <span className="mr-1 opacity-60">›</span>
          {job.progress || "starting up…"}
        </>
      )}
      {job.status === "running" && <span className="ml-0.5 inline-block h-3 w-1.5 animate-pulse bg-cyan/70 align-middle" />}
    </div>
  );
}

function AgentLiveView({ job, now, onClose }: { job: Job; now: number; onClose: () => void }) {
  const elapsed = Math.max(0, Math.floor((now - job.startedAt) / 1000));
  const pct = job.status === "running" ? Math.min(95, 6 + Math.round((elapsed / 180) * 90)) : 6;
  return (
    <div className="materialize glass relative flex h-full flex-col rounded-2xl p-4 pt-11">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ModelBadge model={job.model} />
          <span className="hud-label">{job.status === "running" ? "working" : "queued"} · {elapsed}s</span>
        </div>
        <button onClick={onClose} className="hud-label rounded px-2 py-1 hover:text-cyan">
          close
        </button>
      </div>
      <div className="mt-3 text-sm text-ice">{job.task}</div>
      <div className="mt-3 h-px w-full overflow-hidden rounded-full bg-white/10">
        <div
          className="h-full bg-gradient-to-r from-cyan to-sky-400 transition-all duration-1000"
          style={{ width: `${pct}%` }}
        />
      </div>
      <LiveSessionLog job={job} />
    </div>
  );
}

// Animated count-up for KPI tiles.
function CountUp({ value, prefix = "", suffix = "" }: { value: number; prefix?: string; suffix?: string }) {
  const [n, setN] = useState(0);
  useEffect(() => {
    const t0 = performance.now();
    let raf = 0;
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / 900);
      setN(Math.round(value * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return (
    <span>
      {prefix}
      {n.toLocaleString("en-GB")}
      {suffix}
    </span>
  );
}

// Live countdown ring — chimes and glows when done.
function TimerWidget({ w }: { w: any }) {
  const [left, setLeft] = useState(() => Math.max(0, w.until - Date.now()));
  const chimed = useRef(false);
  useEffect(() => {
    const t = setInterval(() => {
      const l = Math.max(0, w.until - Date.now());
      setLeft(l);
      if (l === 0 && !chimed.current) {
        chimed.current = true;
        import("../lib/wakeword").then((m) => {
          m.chime();
          setTimeout(m.chime, 500);
          setTimeout(m.chime, 1000);
        });
      }
    }, 250);
    return () => clearInterval(t);
  }, [w.until]);
  const total = Math.max(1, w.total ?? 1);
  const p = Math.min(1, Math.max(0, left / total));
  const R = 84;
  const C = 2 * Math.PI * R;
  const mm = Math.floor(left / 60000);
  const ss = Math.floor((left % 60000) / 1000);
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-6">
      <div className="hud-label">{w.label}</div>
      <div className={`relative ${left === 0 ? "animate-pulse" : ""}`}>
        <svg width="200" height="200" viewBox="0 0 200 200">
          <circle cx="100" cy="100" r={R} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="8" />
          <circle
            cx="100" cy="100" r={R} fill="none"
            stroke="var(--cyan)" strokeWidth="8" strokeLinecap="round"
            strokeDasharray={C} strokeDashoffset={C * (1 - p)}
            transform="rotate(-90 100 100)"
            style={{ transition: "stroke-dashoffset 0.25s linear" }}
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center font-mono text-4xl tabular-nums text-ice">
          {left === 0 ? "done" : `${mm}:${String(ss).padStart(2, "0")}`}
        </div>
      </div>
      {left === 0 && <div className="text-sm text-cyan">Time, sir.</div>}
    </div>
  );
}

// A demoted panel bobbing beside the orb: real mini preview inside (scaled
// live widget / thumbnail / titled chip — never a bare glyph), tap to restore,
// drag left off-screen to dismiss (mobile-friendly).
function OrbitBubble({
  b, delay, onOpen, onDismiss,
}: {
  b: { type: string; value: string; title?: string };
  delay: number;
  onOpen: () => void;
  onDismiss: () => void;
}) {
  const [dx, setDx] = useState(0);
  const startX = useRef<number | null>(null);
  const dragging = useRef(false);
  const yt = b.type === "video" ? (b.value.match(/embed\/([\w-]{11})/)?.[1] ?? null) : null;
  const isImg = b.type === "image";
  const GLYPH: Record<string, string> = { trip: "🌍", board: "🎨", canvas: "🕸", pdf: "📕", fleet: "🚀", site: "🌐", url: "🌐" };
  return (
    <div
      className={`bob group relative ${dx === 0 ? "transition-all duration-300" : ""}`}
      style={{ animationDelay: `${delay}s`, transform: dx ? `translateX(${dx}px)` : undefined, opacity: dx ? Math.max(0.15, 1 - Math.abs(dx) / 90) : undefined }}
    >
      <button
        onClick={(e) => {
          e.stopPropagation();
          onDismiss();
        }}
        className="absolute -right-0.5 -top-0.5 z-10 grid h-5 w-5 place-items-center rounded-full bg-black/85 text-[9px] text-slate ring-1 ring-white/25 transition hover:text-red-300 hover:ring-red-400/50"
        title="close"
      >
        ✕
      </button>
      <button
      onPointerDown={(e) => {
        startX.current = e.clientX;
        dragging.current = false;
        (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (startX.current == null) return;
        const d = e.clientX - startX.current;
        if (Math.abs(d) > 6) dragging.current = true;
        setDx(d);
      }}
      onPointerUp={() => {
        if (startX.current == null) return;
        startX.current = null;
        if (Math.abs(dx) > 52) onDismiss();
        else setDx(0);
        setTimeout(() => (dragging.current = false), 0);
      }}
      onPointerCancel={() => {
        startX.current = null;
        setDx(0);
        dragging.current = false;
      }}
      onClick={() => {
        if (!dragging.current) onOpen();
      }}
      className="glass relative block h-16 w-16 overflow-hidden rounded-full !border-cyan/30 shadow-xl transition-transform duration-300 hover:scale-110 hover:!border-cyan/70"
      style={{ touchAction: "pan-y" }}
      title={`${b.title ?? b.type} — drag away or ✕ to dismiss`}
    >
      {yt ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={`https://img.youtube.com/vi/${yt}/mqdefault.jpg`} alt="" className="h-full w-full object-cover" />
      ) : isImg ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={b.value} alt="" className="h-full w-full object-cover" />
      ) : b.type === "widget" ? (
        <span className="pointer-events-none absolute left-1/2 top-1/2 block h-[240px] w-[240px] origin-center -translate-x-1/2 -translate-y-1/2 scale-[0.27] overflow-hidden rounded-2xl bg-[#0b1220]">
          <span className="flex h-full w-full flex-col">
            <WidgetView value={b.value} />
          </span>
        </span>
      ) : (
        <span className="flex h-full w-full flex-col items-center justify-center gap-0.5 bg-gradient-to-br from-[#152238] to-[#0a1220] px-1.5 text-center">
          <span className="text-sm leading-none">{GLYPH[b.type] ?? "📄"}</span>
          <span className="line-clamp-2 max-w-full text-[7px] leading-tight text-ice/90">{b.title ?? b.type}</span>
        </span>
      )}
      <span className="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-black/70 px-1 py-0.5 text-center text-[8px] text-ice opacity-0 transition group-hover:opacity-100">
        {b.title ?? b.type}
      </span>
      </button>
    </div>
  );
}

// Native widget panels (weather/stats/market/timer/briefing; more via self_improve).
function WidgetView({ value }: { value: string }) {
  let w: any = null;
  try {
    w = JSON.parse(value);
  } catch {
    /* fall through */
  }
  if (w?.kind === "timer") return <TimerWidget w={w} />;
  if (w?.kind === "calendar") return <CalendarView value={value} />;
  if (w?.kind === "candles") return <CandlesView w={w} />;
  if (w?.kind === "videos") return <VideoListView value={value} />;
  if (w?.kind === "feed") return <FeedView value={value} />;
  if (w?.kind === "todos") return <TodosView value={value} />;
  if (w?.kind === "briefing2") return <Briefing2View value={value} />;
  if (w?.kind === "shop") return <ShopView value={value} />;
  if (w?.kind === "webresults") return <WebResultsView value={value} />;
  if (w?.kind === "places") return <PlacesView value={value} />;
  if (w?.kind === "ranking") return <RankingView value={value} />;
  if (w?.kind === "calc") return <CalcView w={w} />;
  if (w?.kind === "market") {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6">
        <div className="hud-label">markets</div>
        <div className="grid w-full max-w-xl grid-cols-2 gap-3 md:grid-cols-3">
          {(w.rows ?? []).map((r: any, i: number) => (
            <div key={i} className="glass rounded-xl px-3 py-4 text-center">
              <div className="hud-label !text-[9px]">{r.label}</div>
              <div className="mt-1 text-xl font-semibold text-ice">
                {r.unit}
                {Number(r.price).toLocaleString("en-GB")}
              </div>
              <div className={`mt-0.5 text-xs ${r.change >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                {r.change >= 0 ? "▲" : "▼"} {Math.abs(r.change)}% 24h
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }
  if (w?.kind === "briefing") {
    return (
      <div className="scrollbar-thin min-h-0 flex-1 overflow-auto p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-lg font-semibold text-ice">{w.date}</div>
            {w.wealth != null && <div className="text-xs text-slate">net worth ≈ £{Number(w.wealth).toLocaleString("en-GB")}</div>}
          </div>
          {w.weather && (
            <div className="glass flex items-center gap-2 rounded-xl px-3 py-2">
              <span className="text-3xl">{w.weather.icon}</span>
              <span className="text-xl text-ice">{w.weather.temp}°</span>
              <span className="text-xs text-slate">{w.weather.desc} · {w.weather.place}</span>
            </div>
          )}
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          {(w.sections ?? []).map((s: any, i: number) => (
            <div key={i} className="glass rounded-xl p-3">
              <div className="hud-label mb-2">{s.title}</div>
              <ul className="space-y-1">
                {(s.lines ?? []).map((l: string, j: number) => (
                  <li key={j} className="flex gap-2 text-sm text-ice">
                    <span className="text-cyan/60">›</span>
                    <span className="min-w-0 flex-1">{l}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    );
  }
  if (w?.kind === "stats") {
    const maxS = Math.max(1, ...(w.series ?? []).map((s: any) => s.value));
    const maxB = Math.max(1, ...(w.bars ?? []).map((b: any) => b.value));
    return (
      <div className="scrollbar-thin min-h-0 flex-1 overflow-auto p-5">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {(w.kpis ?? []).map((k: any, i: number) => (
            <div key={i} className="glass rounded-xl px-3 py-4 text-center">
              <div className="text-2xl font-semibold text-ice md:text-3xl">
                <CountUp value={k.value} prefix={k.prefix ?? ""} suffix={k.suffix ?? ""} />
              </div>
              <div className="hud-label mt-1">{k.label}</div>
            </div>
          ))}
        </div>
        {(w.series ?? []).length > 0 && (
          <div className="mt-5">
            <div className="hud-label mb-2">{w.seriesLabel ?? "trend"}</div>
            <div className="flex h-28 items-end gap-2">
              {w.series.map((s: any, i: number) => (
                <div key={i} className="flex min-w-0 flex-1 flex-col items-center gap-1">
                  <span className="text-[10px] text-cyan/80">{s.value.toLocaleString("en-GB")}</span>
                  <div
                    className="w-full rounded-t bg-gradient-to-t from-cyan/25 to-cyan/70 transition-all duration-700"
                    style={{ height: `${Math.max(4, (s.value / maxS) * 80)}px` }}
                  />
                  <span className="hud-label !text-[8px]">{s.label}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        {(w.bars ?? []).length > 0 && (
          <div className="mt-5 space-y-2">
            <div className="hud-label mb-2">{w.barsLabel ?? "ranking"}</div>
            {w.bars.map((b: any, i: number) => (
              <div key={i}>
                <div className="flex justify-between text-xs">
                  <span className="truncate text-ice">{b.label}</span>
                  <span className="shrink-0 pl-2 text-cyan">£{b.value.toLocaleString("en-GB")} <span className="text-slate">· {b.note}</span></span>
                </div>
                <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-white/5">
                  <div className="h-full rounded-full bg-gradient-to-r from-cyan/40 to-cyan transition-all duration-700" style={{ width: `${(b.value / maxB) * 100}%` }} />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }
  if (w?.kind === "weather") return <WeatherView w={w} />;
  if (w) {
    // Unknown kind = this bundle predates the widget (or a bad payload).
    // NEVER dump raw JSON at Daniel — that is the "collapsed to code" bug.
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
        <span className="text-2xl">{"\u2726"}</span>
        <div className="text-sm text-ice">This view just shipped &mdash; one refresh and it renders properly.</div>
        <button onClick={() => window.location.reload()} className="mt-1 rounded-lg bg-cyan/10 px-3 py-1.5 text-xs text-cyan ring-1 ring-cyan/40 transition hover:bg-cyan/20">refresh</button>
      </div>
    );
  }
  return <pre className="scrollbar-thin min-h-0 flex-1 overflow-auto whitespace-pre-wrap p-4 text-sm text-ice">{value}</pre>;
}

// Scrollable full-page screenshot dressed as a browser — the "embed" that
// works on every site (real iframes are blocked nearly everywhere).
function SiteView({ url }: { url: string }) {
  const [state, setState] = useState<"loading" | "ok" | "fail">("loading");
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[#0d1526]">
      <div className="flex items-center gap-2 border-b border-white/5 px-3 py-1.5">
        <span className="flex gap-1">
          <span className="h-2 w-2 rounded-full bg-red-400/60" />
          <span className="h-2 w-2 rounded-full bg-amber/60" />
          <span className="h-2 w-2 rounded-full bg-emerald-400/60" />
        </span>
        <a href={url} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate rounded bg-black/30 px-2 py-0.5 font-mono text-[10px] text-slate hover:text-cyan" title="open live site">
          {url}
        </a>
      </div>
      <div className="scrollbar-thin min-h-0 flex-1 overflow-auto">
        {state === "loading" && (
          <div className="flex h-full items-center justify-center gap-2 p-10 text-xs text-slate">
            <span className="h-2 w-2 animate-ping rounded-full bg-cyan" /> capturing the page…
          </div>
        )}
        {state === "fail" && (
          <div className="p-10 text-center text-sm text-slate">
            Couldn&apos;t capture that page.{" "}
            <a href={url} target="_blank" rel="noreferrer" className="text-cyan underline">
              Open it in a tab ↗
            </a>
          </div>
        )}
        <img
          src={`/api/snap?url=${encodeURIComponent(url)}`}
          alt=""
          className={`w-full ${state === "ok" ? "" : "hidden"}`}
          onLoad={() => setState("ok")}
          onError={() => setState("fail")}
        />
      </div>
    </div>
  );
}

function Viewport({
  panel,
  onClose,
  onMinimize,
  full,
  onToggleFull,
}: {
  panel: { type: string; value: string; title?: string };
  onClose: () => void;
  onMinimize: () => void;
  full: boolean;
  onToggleFull: () => void;
}) {
  return (
    <div className="materialize frost-shell relative flex h-full flex-col overflow-hidden rounded-2xl">
      <div className="flex items-center justify-between border-b border-white/8 px-3 py-2">
        <span className="hud-label truncate !text-cyan-dim">{panel.title ?? panel.type}</span>
        <span className="flex shrink-0 gap-1">
          <button onClick={onToggleFull} className="hud-label rounded px-2 py-1 hover:text-cyan" title={full ? "shrink" : "full screen"}>
            {full ? "◱ shrink" : "⛶ expand"}
          </button>
          <button onClick={onMinimize} className="hud-label rounded px-2 py-1 hover:text-cyan" title="fold away, keep handy">
            ▾ orb
          </button>
          <button onClick={onClose} className="hud-label rounded px-2 py-1 hover:text-cyan">
            close
          </button>
        </span>
      </div>
      {panel.type === "site" ? (
        <SiteView url={panel.value} />
      ) : panel.type === "widget" ? (
        <WidgetView value={panel.value} />
      ) : panel.type === "canvas" ? (
        <CanvasView value={panel.value} />
      ) : panel.type === "trip" ? (
        <TripView value={panel.value} />
      ) : panel.type === "doc" ? (
        <DocView value={panel.value} />
      ) : panel.type === "launch" ? (
        <LaunchView value={panel.value} />
      ) : panel.type === "pdf" ? (
        <PdfView url={panel.value} title={panel.title} />
      ) : panel.type === "creations" ? (
        <CreationsView value={panel.value} />
      ) : panel.type === "fleet" ? (
        <FleetView value={panel.value} />
      ) : panel.type === "board" ? (
        <BoardView value={panel.value} />
      ) : panel.type === "url" || panel.type === "video" ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <iframe
            src={panel.value}
            className={`w-full flex-1 ${panel.type === "video" ? "bg-black" : "bg-white"}`}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-presentation"
            allow="autoplay; encrypted-media; picture-in-picture"
          />
        </div>
      ) : panel.type === "image" ? (
        <img src={panel.value} alt={panel.title ?? ""} className="min-h-0 flex-1 object-contain" />
      ) : panel.type === "code" ? (
        <pre className="scrollbar-thin min-h-0 flex-1 overflow-auto whitespace-pre p-4 font-mono text-xs leading-relaxed text-cyan/90">
          {panel.value}
        </pre>
      ) : (
        <div
          className="scrollbar-thin min-h-0 flex-1 overflow-auto p-4 text-sm leading-relaxed text-ice"
          dangerouslySetInnerHTML={{ __html: mdToHtml(panel.value) }}
        />
      )}
    </div>
  );
}

// The video window: ONE iframe that never remounts (playback survives), whose
// geometry morphs between "fill the stage, 16:9" and "picture-in-picture pill"
// with a smooth animated transition.
function VideoDock({
  panel,
  pip,
  setPip,
  onClose,
  stageRef,
  iframeRef,
}: {
  panel: { value: string; title?: string };
  pip: boolean;
  setPip: (v: boolean) => void;
  onClose: () => void;
  stageRef: React.RefObject<HTMLDivElement | null>;
  iframeRef: React.MutableRefObject<HTMLIFrameElement | null>;
}) {
  const [rect, setRect] = useState<{ t: number; l: number; w: number; h: number } | null>(null);
  useEffect(() => {
    const upd = () => {
      const el = stageRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setRect((p) => (p && Math.abs(p.t - r.top) < 1 && Math.abs(p.l - r.left) < 1 && Math.abs(p.w - r.width) < 1 && Math.abs(p.h - r.height) < 1 ? p : { t: r.top, l: r.left, w: r.width, h: r.height }));
    };
    upd();
    const ro = new ResizeObserver(upd);
    if (stageRef.current) ro.observe(stageRef.current);
    window.addEventListener("resize", upd);
    window.addEventListener("scroll", upd, true);
    const iv = setInterval(upd, 300); // track the chat-collapse animation
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", upd);
      window.removeEventListener("scroll", upd, true);
      clearInterval(iv);
    };
  }, [stageRef]);
  if (!rect) return null;
  // PiP pins inside the stage's bottom-right corner — never over the chat.
  const style: React.CSSProperties = pip
    ? (() => { const w = Math.min(356, window.innerWidth - 24); return { top: Math.max(8, rect.t + rect.h - 252), left: Math.max(8, rect.l + rect.w - w - 16), width: w, height: Math.round((w * 9) / 16) + 40 }; })()
    : { top: rect.t + 4, left: rect.l + 4, width: rect.w - 8, height: rect.h - 8 };
  return (
    <div className="glass fixed z-40 flex flex-col overflow-hidden rounded-2xl shadow-2xl transition-all duration-500 ease-in-out" style={style}>
      <div className="flex items-center justify-between border-b border-white/5 px-3 py-1.5">
        <span className="hud-label truncate !text-cyan-dim">{panel.title ?? "video"}</span>
        <span className="flex shrink-0 gap-1">
          <button onClick={() => setPip(!pip)} className="hud-label rounded px-2 py-0.5 hover:text-cyan" title={pip ? "back to the big screen" : "shrink to mini player"}>
            {pip ? "⛶ big" : "▾ mini"}
          </button>
          <button onClick={onClose} className="hud-label rounded px-2 py-0.5 hover:text-red-300" title="close video">
            ✕
          </button>
        </span>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center bg-black">
        <iframe
          ref={iframeRef}
          src={panel.value}
          className="block"
          style={{ aspectRatio: "16/9", height: "100%", width: "auto", maxWidth: "100%" }}
          sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"
          allow="autoplay; encrypted-media; picture-in-picture"
          allowFullScreen
        />
      </div>
    </div>
  );
}

export default function JarvisUI() {
  const thread = (useQuery(api.ui.getActiveThread, {}) ?? "main") as string;
  const threads = (useQuery(api.ui.getThreads, {}) ?? []) as { id: string; title: string; at: number }[];
  const setActiveThread = useMutation(api.ui.setActiveThread);
  const clearThread = useMutation(api.chatQueue.clearThread);
  const threadRef = useRef("main");
  useEffect(() => {
    threadRef.current = thread;
  }, [thread]);
  const messages = (useQuery(api.chatQueue.listMessages, { threadId: thread }) ?? []) as Msg[];
  const panel = useQuery(api.ui.getPanel, {}) as
    | { type: string; value: string; title?: string; updatedAt: number }
    | null
    | undefined;
  const sayRow = useQuery(api.ui.getSay, {}) as { value: string; updatedAt: number } | null | undefined;
  const stagePanelSize = useMemo(() => (panel ? panelSize(panel) : ""), [panel]);
  const clearPanel = useMutation(api.ui.clearPanel);
  const setPanel = useMutation(api.ui.setPanel);
  const logTurn = useMutation(api.chatQueue.logTurn);
  const saveSub = useMutation(api.push.saveSub);
  const claimVoice = useMutation(api.ui.claimVoice);
  const electVoice = useMutation(api.ui.electVoice);
  const setLiveOn = useMutation(api.ui.setLiveOn);
  const voiceRow = useQuery(api.ui.getVoice, {}) as { value: string; updatedAt: number } | null | undefined;
  const liveOnRow = useQuery(api.ui.getLiveOn, {}) as { value: string; updatedAt: number } | null | undefined;
  const activeJobs = (useQuery(api.jobs.active, {}) ?? []) as Job[];

  const [input, setInput] = useState("");
  const [speaking, setSpeaking] = useState(false);
  const [sending, setSending] = useState(false);
  const [recording, setRecording] = useState(false);
  const [live, setLive] = useState<"off" | "connecting" | "live">("off");
  const [caption, setCaption] = useState<Caption>(null);
  const [agentView, setAgentView] = useState<string | null>(null);
  const [nowTs, setNowTs] = useState(0);
  // Viewport minimize: keep talking and the panel folds into a pill; the orb
  // comes back. Fresh panel content pops it open again.
  const [panelMin, setPanelMin] = useState(false);
  const lastPanelAt = useRef(0);
  // Daniel closed it = it stays closed. If the exact same panel content comes
  // back within 30s of an explicit close (a live-session loop re-showing the
  // bikini search, say), kill it server-side instead of displaying it.
  const closedPanelRef = useRef<{ key: string; ts: number } | null>(null);
  const closeStage = () => {
    if (panel) closedPanelRef.current = { key: `${panel.title ?? ""}|${panel.value.slice(0, 160)}`, ts: Date.now() };
    setPanelFull(false);
    void clearPanel({});
  };
  useEffect(() => {
    panelTypeRef.current = panel?.type ?? null;
    if (panel && panel.updatedAt !== lastPanelAt.current) {
      lastPanelAt.current = panel.updatedAt;
      const cp = closedPanelRef.current;
      if (cp && cp.key === `${panel.title ?? ""}|${panel.value.slice(0, 160)}` && Date.now() - cp.ts < 12_000) {
        void clearPanel({});
        return;
      }
      setPanelMin(false);
      if (panel.type === "video") setVideoPip(false); // fresh video opens big, 16:9
      // ANYTHING freshly shown takes the screen: the chat always steps aside
      // to the bar (weather used to hide BEHIND the chat sheet on phones while
      // JARVIS claimed it was "on screen"). Expand the chat back any time.
      if (chatModeRef.current === "full") setChatMode("bar", false);
      // previous panel → orbit bubble (still one tap away, out of the way)
      const prev = prevPanelRef.current;
      if (prev && (prev.title ?? prev.type) !== (panel.title ?? panel.type)) {
        setBubbles((bs) =>
          [{ type: prev.type, value: prev.value, title: prev.title }, ...bs.filter((b) => (b.title ?? b.type) !== (prev.title ?? prev.type))].slice(0, 6),
        );
      }
      prevPanelRef.current = { type: panel.type, value: panel.value, title: panel.title, updatedAt: panel.updatedAt };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel]);

  const endRef = useRef<HTMLDivElement>(null);
  const lastSpokenId = useRef<string | null>(null);
  const lastSpokenText = useRef<{ text: string; ts: number }>({ text: "", ts: 0 });
  const nudgeQueue = useRef<string[]>([]);
  const captionRef = useRef<Caption>(null);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushNudges = () => {
    if (flushTimer.current) return;
    flushTimer.current = setTimeout(() => {
      flushTimer.current = null;
      if (!liveRef.current) return;
      if (captionRef.current) {
        flushNudges(); // someone's mid-sentence — check again shortly
        return;
      }
      const text = nudgeQueue.current.shift();
      if (text) import("../lib/realtime").then((m) => m.nudgeLive(text));
      if (nudgeQueue.current.length) flushNudges();
    }, 1800);
  };
  const energyRef = useRef(0);
  const recRef = useRef<MediaRecorder | null>(null);
  const liveRef = useRef(false);
  const lastLiveUser = useRef<string | null>(null);
  const me = useRef("");
  const voiceRef = useRef<{ value: string; updatedAt: number } | null>(null);
  const lastSent = useRef<{ text: string; ts: number }>({ text: "", ts: 0 });
  const [wake, setWake] = useState(false);
  const [panelFull, setPanelFull] = useState(false);
  const panelFullRef = useRef(false);
  useEffect(() => {
    panelFullRef.current = panelFull;
  }, [panelFull]);


  // Finished background work → bottom popup cards (stack of 3, click to expand
  // into the distilled breakdown, auto-gone after 5 hours, dismissable).
  const findingsRecent = (useQuery(api.findings.recent, { limit: 8 }) ?? []) as {
    _id: string;
    spoken: string;
    detail: string;
    source: string;
    createdAt: number;
    bullets?: string[];
    important?: boolean;
  }[];
  const [dismissed, setDismissed] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem("jarvis_dismissed") ?? "[]"));
    } catch {
      return new Set();
    }
  });
  const [expandedFinding, setExpandedFinding] = useState<string | null>(null);
  // Only findings the distiller judged worth an interruption become cards —
  // internal plumbing and dev chatter stay out of Daniel's face.
  const popups = findingsRecent
    .filter((f) => Date.now() - f.createdAt < 5 * 60 * 60 * 1000 && !dismissed.has(f._id) && f.spoken && f.important === true)
    .slice(0, 3);
  const distillTried = useRef<Set<string>>(new Set());
  useEffect(() => {
    const next = findingsRecent.find(
      (f) => Date.now() - f.createdAt < 5 * 60 * 60 * 1000 && !dismissed.has(f._id) && f.important === undefined && !distillTried.current.has(f._id),
    );
    if (!next) return;
    distillTried.current.add(next._id);
    void fetch("/api/distill", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: next._id }),
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findingsRecent]);
  const dismissFinding = (id: string) => {
    setDismissed((d) => {
      const nd = new Set(d);
      nd.add(id);
      try {
        localStorage.setItem("jarvis_dismissed", JSON.stringify([...nd].slice(-60)));
      } catch { /* private mode */ }
      return nd;
    });
    if (expandedFinding === id) setExpandedFinding(null);
  };

  // Orb mood: the brain sets a tone colour; the orb drifts into it slowly.
  const moodRow = useQuery(api.ui.getMood, {}) as { value: string; updatedAt: number } | null | undefined;
  const MOOD_COLORS: Record<string, string> = {
    calm: "#00ff88", focused: "#4a9eed", dreamy: "#9775fa", warm: "#ffb454", playful: "#ff7ad9", tender: "#ff9ec4", curious: "#33e0d0",
    serious: "#8fa3bd", alert: "#ff5470", excited: "#ff7ad9",
  };
  const moodColor =
    moodRow && Date.now() - moodRow.updatedAt < 30 * 60 * 1000 ? MOOD_COLORS[moodRow.value] ?? undefined : undefined;

  // Orbit bubbles: when a new panel takes the stage, the previous one shrinks
  // into a bobbing bubble beside the orb — tap to bring it back.
  const [bubbles, setBubbles] = useState<{ type: string; value: string; title?: string }[]>([]);
  const prevPanelRef = useRef<{ type: string; value: string; title?: string; updatedAt: number } | null>(null);

  // Options panel + persisted preferences (voice lane, TTS voice, wake, motion)
  const [optionsOpen, setOptionsOpen] = useState(false);
  const setMoodMut = useMutation(api.ui.setMood);
  const [prefs, setPrefs] = useState({ voice: "free", tts: "free", reduceMotion: false });
  useEffect(() => {
    // one-time revert: the browser "fast" voice was a regression Daniel hated —
    // migrate anyone still stuck on it back to Kokoro ("free"). Guarded so a
    // deliberate re-pick of "fast" later still sticks.
    if (!localStorage.getItem("jarvis_tts_revert1")) {
      if (localStorage.getItem("jarvis_tts") === "fast") localStorage.setItem("jarvis_tts", "free");
      localStorage.setItem("jarvis_tts_revert1", "1");
    }
    setPrefs({
      voice: localStorage.getItem("jarvis_voice") || "free",
      tts: localStorage.getItem("jarvis_tts") || "free",
      reduceMotion: localStorage.getItem("jarvis_reduce_motion") === "1",
    });
  }, []);
  const setPref = (k: "voice" | "tts" | "reduceMotion", v: string | boolean) => {
    setPrefs((p) => ({ ...p, [k]: v }));
    const key = k === "voice" ? "jarvis_voice" : k === "tts" ? "jarvis_tts" : "jarvis_reduce_motion";
    localStorage.setItem(key, typeof v === "boolean" ? (v ? "1" : "0") : String(v));
  };

  // Location: granted once, then permanent (browser remembers the permission,
  // and we refresh the stored coords on load so "near me" works in both lanes).
  const setLocationMut = useMutation(api.ui.setLocation);
  const [locOn, setLocOn] = useState(false);
  const captureLocation = (announce = false): Promise<boolean> =>
    new Promise((resolve) => {
      if (!navigator.geolocation) {
        if (announce) alert("This device can't share location.");
        return resolve(false);
      }
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          void setLocationMut({ lat: pos.coords.latitude, lng: pos.coords.longitude });
          localStorage.setItem("jarvis_location", "1");
          setLocOn(true);
          resolve(true);
        },
        () => {
          if (announce) alert("Location blocked — allow it in your browser's site settings, then toggle again.");
          resolve(false);
        },
        { enableHighAccuracy: false, timeout: 8000, maximumAge: 5 * 60_000 },
      );
    });
  useEffect(() => {
    // silently refresh coords on load if he's already granted it once
    if (localStorage.getItem("jarvis_location") === "1") void captureLocation(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Chat history drawer + intelligent video handling (16:9 stage / PiP corner)
  const [drawerOpen, setDrawerOpen] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const [videoPip, setVideoPip] = useState(false);
  // The currently-playing video, DECOUPLED from the stage panel slot: once it's
  // in the mini player it keeps playing even when a new overlay takes the stage
  // or the panel is cleared. Only an explicit close (✕ / "close the video") or a
  // brand-new video stops it.
  const [activeVideo, setActiveVideo] = useState<{ value: string; title?: string } | null>(null);
  const panelTypeRef = useRef<string | null>(null);
  const videoIframeRef = useRef<HTMLIFrameElement | null>(null);
  const videoCmd = useQuery(api.ui.getVideoCmd, {}) as { value: string; updatedAt: number } | null | undefined;
  const lastVideoCmd = useRef(-1);
  // The brain's video remote: relay play/pause into the YouTube iframe, close kills it.
  const videoMountTs = useRef(Date.now());
  useEffect(() => {
    if (!videoCmd) return;
    if (lastVideoCmd.current === -1) {
      lastVideoCmd.current = videoCmd.updatedAt;
      // only ignore commands issued BEFORE this page existed — the first-ever
      // command used to be swallowed as "stale" and "pause" needed saying twice
      if (videoCmd.updatedAt <= videoMountTs.current) return;
    } else {
      if (videoCmd.updatedAt === lastVideoCmd.current) return;
      lastVideoCmd.current = videoCmd.updatedAt;
    }
    if (videoCmd.value === "close") {
      setVideoPip(false);
      setActiveVideo(null);
      void clearPanel({});
      return;
    }
    const f = videoIframeRef.current;
    if (f?.contentWindow) {
      const func = videoCmd.value === "play" ? "playVideo" : "pauseVideo";
      f.contentWindow.postMessage(JSON.stringify({ event: "listening", id: "jarvis" }), "*");
      f.contentWindow.postMessage(JSON.stringify({ event: "command", func, args: [] }), "*");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoCmd]);

  // Adopt any video panel as THE active video (a new value = a new player). When
  // the stage panel later changes to something else, activeVideo is deliberately
  // NOT cleared here — that's what keeps the mini player alive across topics.
  useEffect(() => {
    if (panel?.type === "video") setActiveVideo({ value: panel.value, title: panel.title });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel?.type === "video" ? panel?.value : null]);

  // Chat presence: full column ↔ floating type bar ↔ hidden ("zen"). Zen keeps
  // JARVIS always listening (wake word forced on) with no chrome in the way.
  const [chatMode, setChatModeRaw] = useState<"full" | "bar" | "off">("full");
  const chatModeRef = useRef<"full" | "bar" | "off">("full");
  const setChatMode = (m: "full" | "bar" | "off", persist = true) => {
    chatModeRef.current = m;
    setChatModeRaw(m);
    if (persist) {
      try {
        localStorage.setItem("jarvis_chat_mode", m);
      } catch {
        /* private mode */
      }
    }
  };
  useEffect(() => {
    try {
      const saved = localStorage.getItem("jarvis_chat_mode");
      if (saved === "bar" || saved === "off" || saved === "full") setChatMode(saved, false);
    } catch {
      /* private mode */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Standby wake word: "hey jarvis" / "jarvis" starts live mode, Siri-style.
  const rearmWake = () => {
    if (localStorage.getItem("jarvis_wake") !== "1") return;
    import("../lib/wakeword").then((m) => {
      if (!m.wakeSupported()) return;
      m.startWake(() => {
        setWake(false);
        m.chime();
        if (voiceMode() === "free") {
          freeLoop.current = true;
          void freeVoiceTurn();
        } else void toggleLive(true);
      });
      setWake(true);
    });
  };
  function toggleWake() {
    import("../lib/wakeword").then((m) => {
      if (!m.wakeSupported()) {
        alert("Wake word needs Chrome/Edge/Safari speech recognition.");
        return;
      }
      if (wake) {
        localStorage.setItem("jarvis_wake", "0");
        m.stopWake();
        setWake(false);
      } else {
        localStorage.setItem("jarvis_wake", "1");
        rearmWake();
      }
    });
  }
  // Zen mode = always listening: the wake word is forced on while chat is
  // hidden, regardless of the manual wake toggle.
  useEffect(() => {
    if (chatMode !== "off") return;
    import("../lib/wakeword").then((m) => {
      if (!m.wakeSupported() || liveRef.current) return;
      m.startWake(() => {
        setWake(false);
        m.chime();
        if (voiceMode() === "free") {
          freeLoop.current = true;
          void freeVoiceTurn();
        } else void toggleLive(true);
      });
      setWake(true);
    });
    return () => {
      if (localStorage.getItem("jarvis_wake") !== "1") {
        import("../lib/wakeword").then((m) => m.stopWake());
        setWake(false);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatMode]);

  useEffect(() => {
    rearmWake(); // resume standby across reloads if Daniel left it on
    // release the live lock instantly if the tab closes mid-session
    const bye = () => {
      if (!liveRef.current) return;
      const url = `${process.env.NEXT_PUBLIC_CONVEX_URL}/api/mutation`;
      const body = JSON.stringify({ path: "ui:setLiveOn", args: { client: me.current, on: false }, format: "json" });
      navigator.sendBeacon?.(url, new Blob([body], { type: "application/json" }));
    };
    window.addEventListener("pagehide", bye);
    return () => window.removeEventListener("pagehide", bye);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    me.current = clientId();
  }, []);
  useEffect(() => {
    voiceRef.current = voiceRow ?? null;
  }, [voiceRow]);
  const liveOnRef = useRef<{ value: string; updatedAt: number } | null>(null);
  useEffect(() => {
    liveOnRef.current = liveOnRow ?? null;
  }, [liveOnRow]);
  // A fresh live session anywhere = local TTS is forbidden everywhere.
  const liveAnywhere = () => {
    const l = liveOnRef.current;
    return !!l && Date.now() - l.updatedAt < 45_000;
  };
  // The instant a live session starts anywhere, cut any local speech mid-word.
  useEffect(() => {
    if (liveOnRow && Date.now() - liveOnRow.updatedAt < 45_000 && !liveRef.current) {
      import("../lib/tts").then((m) => m.stopSpeaking());
      setSpeaking(false);
    }
  }, [liveOnRow]);
  // I speak only if I own the voice; when the row is stale, ELECT atomically —
  // two visible tabs used to both optimistically claim and voice the same
  // sentence in stereo.
  async function ensureVoice(): Promise<boolean> {
    const v = voiceRef.current;
    if (v && Date.now() - v.updatedAt <= 3 * 60 * 1000) return v.value === me.current;
    try {
      return (await electVoice({ client: me.current })) !== false;
    } catch {
      return true; // convex hiccup: better one voice too many than silence
    }
  }

  useEffect(() => {
    if (!activeJobs.length) return;
    setNowTs(Date.now());
    const t = setInterval(() => setNowTs(Date.now()), 1000);
    return () => clearInterval(t);
  }, [activeJobs.length]);

  const shownJob = activeJobs.find((j) => j._id === agentView) ?? null;
  const busy = sending || messages.some((m) => m.role === "assistant" && m.status === "streaming");

  useEffect(() => {
    // scroll the message CONTAINER only — scrollIntoView reaches into the
    // (possibly translated-off-screen) chat panel and drags the whole PAGE
    // down with it on phones
    const box = endRef.current?.parentElement;
    if (box) box.scrollTo({ top: box.scrollHeight, behavior: "smooth" });
  }, [messages.length, messages[messages.length - 1]?.text, caption?.text]);

  useEffect(() => {
    import("../lib/push").then((m) => m.registerSW());
  }, []);

  // Self-healing: uncaught client errors feed the incident pipeline (max 3
  // distinct per session so an error storm can't spam it).
  useEffect(() => {
    const seen = new Set<string>();
    const report = (sig: string, msg: string) => {
      if (seen.size >= 3 || seen.has(sig)) return;
      seen.add(sig);
      void fetch("/api/incident", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ signature: sig, message: msg }),
      }).catch(() => {});
    };
    // A ChunkLoadError means this tab is holding HTML from a PREVIOUS deploy:
    // its hashed dynamic-import chunks (wakeword/tts/realtime/push/three…) were
    // replaced on the CDN by Vercel's auto-deploy, so the lazy fetch 404s. It's
    // not a bug in any module — reload ONCE to pull the fresh chunks. Guarded by
    // a timestamp so a genuinely-missing chunk can't loop forever.
    const isChunkError = (v: unknown) => {
      const s = String((v as { name?: string; message?: string })?.name ?? "") +
        " " + String((v as { message?: string })?.message ?? v ?? "");
      return /ChunkLoadError|Loading chunk [\w-]+ failed|Failed to load chunk/i.test(s);
    };
    const recoverStaleChunks = () => {
      try {
        const last = Number(sessionStorage.getItem("jarvis-chunk-reload") || 0);
        if (Date.now() - last < 10000) return; // just reloaded and it still fails — don't loop
        sessionStorage.setItem("jarvis-chunk-reload", String(Date.now()));
      } catch { /* sessionStorage unavailable — fall through to a single reload */ }
      window.location.reload();
    };
    const onErr = (e: ErrorEvent) => {
      if (isChunkError(e.error ?? e.message)) { recoverStaleChunks(); return; } // stale post-deploy chunk
      if (e.message === "Script error." || !e.message) return; // cross-origin iframe noise, unactionable
      // Benign browser warning, not an app fault: fired as a window error event
      // whenever a ResizeObserver callback schedules layout that triggers another
      // resize in the same frame (our PiP overlay + orb observers do this by
      // design). The spec guarantees the pending notifications are delivered on
      // the next frame — nothing to fix, so keep it out of the incident pipeline.
      if (/^ResizeObserver loop /i.test(e.message)) return;
      report(`client:${String(e.message).slice(0, 80)}`, `${e.message} @ ${e.filename}:${e.lineno}`);
    };
    const onRej = (e: PromiseRejectionEvent) => {
      if (isChunkError(e.reason)) { recoverStaleChunks(); return; } // stale post-deploy chunk
      report(`client:rejection:${String(e.reason).slice(0, 80)}`, `Unhandled rejection: ${String(e.reason).slice(0, 400)}`);
    };
    window.addEventListener("error", onErr);
    window.addEventListener("unhandledrejection", onRej);
    return () => {
      window.removeEventListener("error", onErr);
      window.removeEventListener("unhandledrejection", onRej);
    };
  }, []);

  // Ephemeral progress lines (ui:say): voiced once, never in the transcript.
  const lastSayAt = useRef<number>(-1);
  useEffect(() => {
    if (sayRow === undefined) return;
    const at = sayRow?.updatedAt ?? 0;
    if (lastSayAt.current === -1) {
      lastSayAt.current = at; // mount: never replay an old line
      return;
    }
    if (!sayRow?.value || at === lastSayAt.current) return;
    lastSayAt.current = at;
    if (Date.now() - at > 15_000) return; // stale
    if (liveRef.current || liveAnywhere() || document.hidden) return;
    (async () => {
      if (!(await ensureVoice())) return;
      const { speak } = await import("../lib/tts");
      await speak(
        sayRow.value,
        (e) => (energyRef.current = e),
        () => setSpeaking(true),
        () => setSpeaking(false),
      );
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sayRow]);

  // Speak new finalized assistant messages (text lane). Live-lane rows were
  // already spoken by the realtime session; while live is on, nudge the live
  // session to voice out-of-band lines (agent findings) instead of local TTS.
  const lastSpokenThread = useRef<string>("");
  useEffect(() => {
    const last = [...messages].reverse().find((m) => m.role === "assistant" && m.status === "done" && m.text);
    // hopping threads must never re-voice that thread's old last reply
    if (lastSpokenThread.current !== thread) {
      lastSpokenThread.current = thread;
      lastSpokenId.current = last?._id ?? null;
      return;
    }
    if (!last || last._id === lastSpokenId.current) return;
    if (lastSpokenId.current === null) {
      lastSpokenId.current = last._id; // don't re-speak history on page load
      return;
    }
    lastSpokenId.current = last._id;
    if (last.model === "live" || !last.text) return;
    if (isToolGarbage(last.text) && !sanitizeAssistantText(last.text)) return;
    // never say the exact same thing twice in a row (root of "sends results twice")
    if (last.text === lastSpokenText.current.text && Date.now() - lastSpokenText.current.ts < 20_000) return;
    lastSpokenText.current = { text: last.text, ts: Date.now() };
    if (liveRef.current) {
      // Background weaves NEVER interrupt: queue them and deliver only once the
      // current exchange finishes (caption clear), woven at the end of the talk.
      if (!last.model) {
        nudgeQueue.current.push(last.text);
        flushNudges();
      }
      return;
    }
    // HARD RULE: while a live session exists on ANY device, nothing else may
    // produce speech — the live voice is the only speaker in the house.
    if (liveAnywhere()) return;
    if (document.hidden) return; // background tabs stay silent — one voice, ever
    const spokenText = isToolGarbage(last.text) ? sanitizeAssistantText(last.text) : last.text;
    (async () => {
      if (!(await ensureVoice())) return; // another tab/device owns the voice
      const { speak } = await import("../lib/tts");
      await speak(
        last.text,
        (e) => (energyRef.current = e),
        () => {
          setSpeaking(true);
          // the spoken words bloom under the orb for TYPED turns too, not just
          // live voice — this is the caption overlay Daniel wasn't seeing
          setCaption({ who: "jarvis", text: spokenText });
        },
        () => {
          setSpeaking(false);
          setCaption((c) => (c && c.who === "jarvis" && c.text === spokenText ? null : c));
        },
      );
      // free-voice conversation: keep the loop going until Daniel goes quiet
      if (freeLoop.current && voiceMode() === "free" && !liveRef.current) setTimeout(() => void freeVoiceTurn(), 300);
    })();
  }, [messages]);

  async function submit(text: string) {
    const t = text.trim();
    if (!t) return;
    // double-tap / Enter+click within 2.5s = one send, not two
    if (t === lastSent.current.text && Date.now() - lastSent.current.ts < 2500) return;
    lastSent.current = { text: t, ts: Date.now() };
    void claimVoice({ client: me.current });
    import("../lib/tts").then((m) => m.warm());
    setInput("");
    // new message = new topic: a playing video shrinks to picture-in-picture
    // (keeps playing); ANY other overlay disengages (folds to a bubble) so it
    // doesn't linger on a topic switch — a relevant answer re-materialises its
    // own panel, which auto-restores.
    if (panel?.type === "video") setVideoPip(true);
    else if (panel && !panelFull) setPanelMin(true);
    if (liveRef.current) {
      // Live session is the single brain while it's on — no parallel text answer.
      const rt = await import("../lib/realtime");
      if (rt.sendLiveText(t)) return;
    }
    setSending(true);
    try {
      await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ threadId: threadRef.current, text: t }),
      });
    } catch {
      /* Convex reactivity shows whatever landed; cron lane is the safety net */
    }
    setSending(false);
  }

  function stopTalking() {
    import("../lib/tts").then((m) => m.stopSpeaking());
    if (liveRef.current) import("../lib/realtime").then((m) => m.interruptLive());
    setSpeaking(false);
  }

  const liveBeat = useRef<ReturnType<typeof setInterval> | null>(null);
  function releaseLive() {
    if (liveBeat.current) clearInterval(liveBeat.current);
    liveBeat.current = null;
    // stale queued weaves used to be re-announced by the NEXT session (whose
    // prompt already contains them) — and a stale caption ref made its first
    // nudge spin on "someone's mid-sentence"
    nudgeQueue.current = [];
    if (flushTimer.current) clearTimeout(flushTimer.current);
    flushTimer.current = null;
    captionRef.current = null;
    void setLiveOn({ client: me.current, on: false }).catch(() => {});
  }

  async function toggleLive(forceStart = false) {
    const rt = await import("../lib/realtime");
    if (!forceStart && (liveRef.current || live !== "off")) {
      rt.stopLive();
      liveRef.current = false;
      setLive("off");
      setCaption(null);
      releaseLive();
      rearmWake();
      return;
    }
    if (liveRef.current) return;
    // One live session TOTAL, across every device — the lock refuses seconds.
    const got = await setLiveOn({ client: me.current, on: true }).catch(() => true);
    if (got === false) {
      console.warn("live: another device holds the session"); // never a blocking alert
      rearmWake();
      return;
    }
    void claimVoice({ client: me.current });
    import("../lib/tts").then((m) => m.stopSpeaking());
    const { stopWake } = await import("../lib/wakeword");
    stopWake(); // wake listener and live mic can't share nicely
    await rt.startLive({
      onState: (s, detail) => {
        if (s === "live") {
          liveRef.current = true;
          setLive("live");
          // keep the cross-device lock fresh for as long as we're live
          if (liveBeat.current) clearInterval(liveBeat.current);
          liveBeat.current = setInterval(() => void setLiveOn({ client: me.current, on: true }).catch(() => {}), 20_000);
        } else if (s === "connecting") setLive("connecting");
        else {
          liveRef.current = false;
          setLive("off");
          setCaption(null);
          releaseLive();
          rearmWake();
          if (s === "error") alert(`Live mode couldn't start: ${detail ?? "unknown error"}`);
        }
      },
      onExitRequest: () => {
        liveRef.current = false;
        setLive("off");
        setCaption(null);
        releaseLive();
        rearmWake();
      },
      onCaption: (who, text, done) => {
        const c = done ? null : { who, text } as Caption;
        captionRef.current = c;
        setCaption(c);
      },
      onTurnDone: (role, text) => {
        void logTurn({ threadId: threadRef.current, role, text, model: role === "assistant" ? "live" : undefined });
        if (role === "user") {
          void claimVoice({ client: me.current });
          if (panelTypeRef.current === "video") setVideoPip(true); // talking over a video → mini player
          else if (!panelFullRef.current) setPanelMin((min) => min || lastPanelAt.current < Date.now() - 30_000);
          lastLiveUser.current = text;
        }
        else if (lastLiveUser.current) {
          void fetch("/api/extract", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ user: lastLiveUser.current, assistant: text }),
          });
          lastLiveUser.current = null;
        }
      },
      onEnergy: (e) => (energyRef.current = e),
      clientId: me.current,
    });
  }

  // Screen sight: share a screen/window for ONE frame — JARVIS reads it and
  // answers about what's actually in front of Daniel.
  const [seeing, setSeeing] = useState(false);
  // Camera sight (ported from GauravSingh9356/J.A.R.V.I.S live-OCR idea, upgraded
  // to full scene+text understanding): point the phone/webcam at anything —
  // a document, a label, a whiteboard, a product — and JARVIS reads it.
  const [camSeeing, setCamSeeing] = useState(false);
  async function lookAtCamera() {
    if (camSeeing) return;
    setCamSeeing(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 } },
        audio: false,
      });
      const video = document.createElement("video");
      video.srcObject = stream;
      video.setAttribute("playsinline", "true");
      await video.play();
      await new Promise((r) => setTimeout(r, 500)); // autofocus + first frame
      const canvas = document.createElement("canvas");
      canvas.width = Math.min(1920, video.videoWidth || 1280);
      canvas.height = Math.round(canvas.width * ((video.videoHeight || 720) / (video.videoWidth || 1280)));
      canvas.getContext("2d")!.drawImage(video, 0, 0, canvas.width, canvas.height);
      stream.getTracks().forEach((t) => t.stop());
      const image = canvas.toDataURL("image/jpeg", 0.82);
      const q = input.trim();
      const r = await fetch("/api/see", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ image, question: q, mode: "camera" }),
      });
      const { description } = await r.json();
      if (description) {
        setInput("");
        void submit(
          `(I just pointed my camera at something. It shows: ${description})${q ? `\n\nMy question: ${q}` : "\n\nTell me what this is and anything useful about it."}`,
        );
      }
    } catch {
      /* no camera / cancelled */
    }
    setCamSeeing(false);
  }

  async function lookAtScreen() {
    if (seeing) return;
    setSeeing(true);
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 5 } });
      const track = stream.getVideoTracks()[0];
      const video = document.createElement("video");
      video.srcObject = stream;
      await video.play();
      await new Promise((r) => setTimeout(r, 350)); // let the first real frame land
      const canvas = document.createElement("canvas");
      canvas.width = Math.min(1920, video.videoWidth || 1280);
      canvas.height = Math.round(canvas.width * ((video.videoHeight || 720) / (video.videoWidth || 1280)));
      canvas.getContext("2d")!.drawImage(video, 0, 0, canvas.width, canvas.height);
      track.stop();
      stream.getTracks().forEach((t) => t.stop());
      const image = canvas.toDataURL("image/jpeg", 0.8);
      const q = input.trim();
      const r = await fetch("/api/see", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ image, question: q }),
      });
      const { description } = await r.json();
      if (description) {
        void submit(
          `(I'm sharing my screen with you. It shows: ${description})${q ? `\n\nMy question: ${q}` : "\n\nTell me what you make of it and help with what I'm looking at."}`,
        );
      }
    } catch {
      /* user cancelled the picker */
    }
    setSeeing(false);
  }

  // One-shot voice input: record → STT → send. Works on iOS too.
  // FREE VOICE MODE (default): wake word → listen (auto-stop on silence) →
  // STT → Claude brain → free TTS → listen again for the follow-up. No OpenAI
  // realtime session, no GPT voice. The live button still offers realtime
  // (localStorage jarvis_voice = "realtime" makes the wake word use it too).
  const freeLoop = useRef(false);
  const freeBusy = useRef(false);
  const voiceMode = () => (typeof localStorage !== "undefined" && localStorage.getItem("jarvis_voice")) || "free";
  async function freeVoiceTurn() {
    if (freeBusy.current || liveRef.current) return;
    freeBusy.current = true;
    try {
      import("../lib/tts").then((m) => m.stopSpeaking());
      void claimVoice({ client: me.current });
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      import("../lib/tts").then((m) => m.warm());
      const actx = new AudioContext();
      const an = actx.createAnalyser();
      an.fftSize = 512;
      actx.createMediaStreamSource(stream).connect(an);
      const buf = new Uint8Array(an.frequencyBinCount);
      const mime = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "audio/mp4";
      const rec = new MediaRecorder(stream, { mimeType: mime });
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      setRecording(true);
      recRef.current = rec;
      let spoke = false;
      let lastVoice = Date.now();
      const t0 = Date.now();
      const poll = setInterval(() => {
        an.getByteFrequencyData(buf);
        const level = buf.reduce((a, b) => a + b, 0) / buf.length;
        if (level > 24) {
          spoke = true;
          lastVoice = Date.now();
          energyRef.current = Math.min(1, level / 90);
        }
        if ((spoke && Date.now() - lastVoice > 1500) || (!spoke && Date.now() - t0 > 6500) || Date.now() - t0 > 25_000) {
          clearInterval(poll);
          if (rec.state === "recording") rec.stop();
        }
      }, 140);
      await new Promise<void>((resolve) => {
        rec.onstop = () => resolve();
        rec.start();
      });
      clearInterval(poll);
      stream.getTracks().forEach((t) => t.stop());
      void actx.close().catch(() => {});
      setRecording(false);
      energyRef.current = 0;
      const blob = new Blob(chunks, { type: mime });
      if (!spoke || blob.size < 2000) {
        freeLoop.current = false; // silence — back to wake-word standby
        return;
      }
      const r = await fetch("/api/stt", { method: "POST", headers: { "content-type": mime }, body: blob });
      const { text } = await r.json();
      const { isEchoOfTts } = await import("../lib/tts");
      if (!text?.trim() || isEchoOfTts(text)) {
        freeLoop.current = false;
        return;
      }
      void submit(text.trim()); // the reply speaks via the normal effect; the loop re-arms after it
    } catch {
      setRecording(false);
      freeLoop.current = false;
    } finally {
      freeBusy.current = false;
    }
  }

  async function toggleMic() {
    if (recording) {
      recRef.current?.stop();
      return;
    }
    // barge-in: JARVIS shuts up the moment Daniel reaches for the mic, so the
    // recording can't capture his voice as input
    import("../lib/tts").then((m) => m.stopSpeaking());
    setSpeaking(false);
    void claimVoice({ client: me.current });
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch {
      alert("JARVIS needs the microphone — allow it in your browser settings.");
      return;
    }
    import("../lib/tts").then((m) => m.warm());
    const mime = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "audio/mp4";
    const rec = new MediaRecorder(stream, { mimeType: mime });
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      setRecording(false);
      const blob = new Blob(chunks, { type: mime });
      if (blob.size < 2000) return;
      try {
        const r = await fetch("/api/stt", { method: "POST", headers: { "content-type": mime }, body: blob });
        const { text } = await r.json();
        if (text?.trim()) {
          const { isEchoOfTts } = await import("../lib/tts");
          if (isEchoOfTts(text)) return; // that was JARVIS's own voice leaking in
          void submit(text.trim());
        }
      } catch {
        /* ignore */
      }
    };
    recRef.current = rec;
    setRecording(true);
    rec.start();
    setTimeout(() => rec.state === "recording" && rec.stop(), 20_000);
  }

  const status =
    live === "connecting"
      ? "connecting"
      : live === "live"
        ? "live"
        : speaking
          ? "speaking"
          : busy
            ? "thinking"
            : recording
              ? "listening"
              : "online";
  const orbState =
    speaking || (live === "live" && caption?.who === "jarvis")
      ? "speaking"
      : busy
        ? "thinking"
        : recording || live === "live"
          ? "listening"
          : "idle";

  // How the stage shares with an overlay:
  //  • compactAside — a sized widget (weather/shop/places/ranking/…): the panel
  //    takes the left, the orb SHRINKS INTO THE RIGHT CORNER (still visible).
  //  • fullBleed — a page/video/full panel: it owns everything, orb+ring gone.
  const overlayUp = !!panel && !panelMin;
  const fullBleed = overlayUp && (panelFull || panel!.type === "video" || stagePanelSize === "h-full w-full");
  const compactAside = overlayUp && !fullBleed && panel!.type !== "video";

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      {/* top HUD strip */}
      <header className="flex items-center justify-between px-5 pb-2 pt-4">
        <div className="flex items-baseline gap-3">
          <h1 className="font-display text-xl font-bold tracking-[0.42em] text-green-400" style={{ fontFamily: "var(--font-chakra)" }}>
            JARVIS
          </h1>
          <span className="hud-label hidden sm:inline">personal ai · online</span>
        </div>
        <div className="flex items-center gap-4">
          <span className="flex items-center gap-1.5">
            <span className={`h-1.5 w-1.5 rounded-full ${live === "live" ? "bg-cyan" : "bg-emerald-400"} breathe`} />
            <span className="hud-label">{status}</span>
          </span>
          <button
            onClick={toggleWake}
            title={wake ? "standby on — say 'hey Jarvis'" : "enable wake word"}
            className={`hud-label rounded px-1 transition ${wake ? "!text-cyan" : "hover:text-cyan"}`}
          >
            {wake ? "◉ hey jarvis" : "wake"}
          </button>
          <button
            onClick={() => setChatMode(chatMode === "full" ? "bar" : chatMode === "bar" ? "off" : "full")}
            title="chat layout — full column / type bar / hidden (always listening)"
            className="hud-label rounded px-1 transition hover:text-cyan"
          >
            {chatMode === "full" ? "▤ chat" : chatMode === "bar" ? "▁ bar" : "◌ zen"}
          </button>
          <Clock />
          <button
            onClick={async () => {
              const r = await (await import("../lib/push")).subscribePush(saveSub);
              alert(
                r === "subscribed"
                  ? "Notifications on — JARVIS will ping this device."
                  : r === "unsupported"
                    ? "On iPhone: Share → Add to Home Screen, then open JARVIS from that icon."
                    : r === "denied"
                      ? "Notifications are blocked in browser settings."
                      : "Push isn't available here.",
              );
            }}
            title="notifications"
            className="hud-label rounded px-1 hover:text-cyan"
          >
            ping
          </button>
          <button
            onClick={() => setOptionsOpen((o) => !o)}
            title="options"
            className={`rounded px-1 text-sm transition ${optionsOpen ? "text-cyan" : "text-slate hover:text-cyan"}`}
          >
            <span className="inline-block transition-transform duration-500" style={{ transform: optionsOpen ? "rotate(90deg)" : "none" }}>⚙</span>
          </button>
        </div>
      </header>
      {optionsOpen && (
        <OptionsPanel
          prefs={prefs}
          setPref={setPref}
          live={live}
          locOn={locOn}
          onLocation={() => void captureLocation(true)}
          onClose={() => setOptionsOpen(false)}
          onToggleLive={() => void toggleLive()}
          onMood={(m) => void setMoodMut({ mood: m, manual: true })}
          onClearMood={() => void setMoodMut({ mood: "calm", manual: true })}
        />
      )}

      {/* ALWAYS-VISIBLE activity layer: whenever JARVIS is thinking or agents
          are working, the pills sit right under the header on every screen —
          you can see him working and keep talking. */}
      {(busy || activeJobs.length > 0) && (
        <div className="pointer-events-none fixed left-1/2 top-11 z-50 flex max-w-[96vw] -translate-x-1/2 flex-wrap items-center justify-center gap-1.5">
          {busy && (
            <span className="glass flex items-center gap-1.5 rounded-full !border-cyan/50 px-3 py-1 text-[11px] text-cyan shadow-lg">
              <span className="typing-dots inline-flex gap-1"><span /><span /><span /></span>
              thinking
            </span>
          )}
          {activeJobs.slice(0, 5).map((j) => (
            <button
              key={j._id}
              onClick={() => setAgentView(agentView === j._id ? null : j._id)}
              className={`glass pointer-events-auto flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] shadow-lg transition ${
                agentView === j._id ? "!border-cyan/60 text-cyan" : "text-ice hover:text-cyan"
              }`}
              title={j.task}
            >
              <span className="relative flex h-1.5 w-1.5">
                <span className={`absolute inline-flex h-full w-full rounded-full ${j.status === "running" ? "animate-ping bg-cyan opacity-60" : "bg-amber opacity-60"}`} />
                <span className={`inline-flex h-1.5 w-1.5 rounded-full ${j.status === "running" ? "bg-cyan" : "bg-amber"}`} />
              </span>
              <span className="max-w-[150px] truncate">{(j as { label?: string }).label ?? j.task}</span>
            </button>
          ))}
          {activeJobs.length > 5 && <span className="glass rounded-full px-2 py-1 text-[10px] text-slate">+{activeJobs.length - 5}</span>}
        </div>
      )}

      <div className={`relative mx-auto flex w-full max-w-[1720px] flex-1 flex-col overflow-clip p-4 pt-2 ${chatMode === "bar" ? "pb-24" : ""}`}>
        {/* the stage is ALWAYS full-bleed; the chat floats over it and slides
            away on pure transforms — compositor-only, 120fps-smooth */}
        <div ref={stageRef} className={`brackets relative min-h-0 flex-1 transition-[margin] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] ${chatMode === "full" ? "md:mr-[416px]" : ""}`}>
          <span className="bk" />
          {live === "live" && <div className="live-ring pointer-events-none absolute inset-2 rounded-full opacity-60" />}
          {/* orbit bubbles — demoted panels bobbing beside the orb */}
          {bubbles.length > 0 && (
            <div className="absolute left-1.5 top-1/2 z-30 flex max-h-full -translate-y-1/2 flex-col gap-3 md:left-2.5">
              {bubbles.map((b, i) => (
                <OrbitBubble
                  key={(b.title ?? b.type) + i}
                  b={b}
                  delay={i * 1.4}
                  onOpen={() => {
                    closedPanelRef.current = null; // explicit restore is never a resurrection
                    setBubbles((bs) => bs.filter((_, j) => j !== i));
                    void setPanel({ type: b.type, value: b.value, title: b.title });
                  }}
                  onDismiss={() => setBubbles((bs) => bs.filter((_, j) => j !== i))}
                />
              ))}
            </div>
          )}
          {panel && panelMin && (
            <div className="absolute left-4 top-4 z-10">
              <button
                onClick={() => setPanelMin(false)}
                className="glass flex items-center gap-1.5 rounded-full !border-cyan/40 px-2.5 py-1 text-[10px] text-cyan transition hover:!border-cyan/70"
                title="reopen"
              >
                <span>▸</span>
                <span className="max-w-[160px] truncate">{panel.title ?? panel.type}</span>
              </button>
            </div>
          )}
          {panel && panel.type !== "video" && !panelMin && !panelFull ? (
            <div className={`absolute inset-x-0 top-0 bottom-[64px] z-20 flex items-center p-1 ${stagePanelSize !== "h-full w-full" ? "justify-center md:justify-start md:pl-10 md:pr-[36%] lg:pl-16" : "justify-center"}`}>
              <div className={`will-change-transform transition-all duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] ${stagePanelSize}`}>
                <Viewport
                  panel={panel}
                  onClose={closeStage}
                  onMinimize={() => setPanelMin(true)}
                  full={false}
                  onToggleFull={() => setPanelFull(true)}
                />
              </div>
            </div>
          ) : shownJob ? (
            <div className="absolute inset-0 z-20 p-1">
              <AgentLiveView job={shownJob} now={nowTs} onClose={() => setAgentView(null)} />
            </div>
          ) : null}
          {/* arc-reactor HUD ring + orb — for a compact overlay they glide into
              the right corner (orb stays visible, small); a full-bleed panel
              hides them entirely. On phones there's no room for a corner, so a
              compact overlay hides them too (md:opacity-100 brings them back). */}
          <ReactorRing
            active={live === "live" || orbState === "thinking" || orbState === "listening"}
            aside={compactAside}
            hidden={fullBleed}
            color={moodColor}
          />
          <div
            className={`h-full w-full transition-opacity duration-500 ${
              fullBleed ? "pointer-events-none opacity-0" : compactAside ? "pointer-events-none opacity-0 md:opacity-100" : "opacity-100"
            }`}
          >
            <ThreeOrb state={orbState} energyRef={energyRef} moodColor={moodColor} aside={compactAside} />
          </div>
          {/* THE ONE caption — spoken words, under the orb, one contained field
              that auto-sizes and clamps long text; hidden entirely while an
              overlay owns the screen */}
          {caption && !(panel && !panelMin) && (
            <div className="pointer-events-none absolute inset-x-0 top-[55%] z-30 flex justify-center px-6">
              <span
                key={caption.text}
                className={`cap-bloom line-clamp-4 max-w-[min(820px,88%)] overflow-hidden text-center text-xl font-semibold leading-snug tracking-tight md:text-[1.7rem] lg:text-[1.95rem] ${caption.who === "you" ? "text-amber" : "text-ice"}`}
              >
                {caption.text}
              </span>
            </div>
          )}
        </div>

        {/* conversation panel — on PHONES it's a bottom sheet (orb stays visible
            above it, keyboard pushes it up naturally); on desktop it floats over
            the stage's right edge. Both slide on pure transforms. */}
        <div
          className={`absolute inset-x-1 bottom-1 top-[34dvh] z-30 will-change-transform motion-reduce:transition-none transition-all duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] md:inset-x-auto md:bottom-2 md:right-4 md:top-2 md:w-[min(400px,45vw)] ${
            chatMode === "full"
              ? "translate-x-0 translate-y-0 opacity-100"
              : "pointer-events-none translate-y-[calc(100%+24px)] opacity-0 md:translate-x-[calc(100%+32px)] md:translate-y-0"
          }`}
        >
        <div className="glass flex h-full w-full flex-col overflow-hidden rounded-2xl">
          <div className="flex items-center gap-2 border-b border-white/5 px-3 py-1.5">
            <button
              onClick={() => setDrawerOpen(true)}
              className="hud-label rounded px-1.5 py-0.5 hover:text-cyan"
              title="chat history"
            >
              ☰
            </button>
            <span className="hud-label min-w-0 flex-1 truncate">
              {thread === "main" ? "main chat" : threads.find((t) => t.id === thread)?.title ?? thread}
            </span>
            <button
              onClick={() => setChatMode("bar")}
              className="hud-label rounded px-1.5 py-0.5 hover:text-cyan"
              title="tuck the chat away (▤ in the header brings it back)"
            >
              ▁
            </button>
          </div>
          <div className="scrollbar-thin flex-1 space-y-3 overflow-y-auto p-4">
            {messages.length === 0 && (
              <p className="mt-10 text-center text-sm text-slate">Say the word, sir.</p>
            )}
            {messages
              .slice(-80)
              .map((m) => (m.role === "assistant" && m.text && isToolGarbage(m.text) ? { ...m, text: sanitizeAssistantText(m.text) } : m))
              .filter((m) => m.text || m.attachment || m.status === "streaming")
              .map((m) => (
              <div key={m._id} className={`rise ${m.role === "user" ? "text-right" : "text-left"}`}>
                {m.attachment ? (
                  <MediaCard
                    a={m.attachment}
                    onShow={(a) => {
                      setPanelMin(false);
                      void setPanel({ type: a.type, value: a.value, title: a.title });
                    }}
                  />
                ) : (
                  <span
                    className={`inline-block max-w-[88%] whitespace-pre-wrap rounded-2xl px-4 py-2 text-[15px] leading-relaxed md:text-sm ${
                      m.role === "user"
                        ? "bg-amber/10 text-amber [text-shadow:none]"
                        : "bg-cyan/[0.07] text-ice"
                    }`}
                  >
                    {m.text ||
                      (m.status === "streaming" ? (
                        <span className="typing-dots inline-flex gap-1">
                          <span />
                          <span />
                          <span />
                        </span>
                      ) : (
                        ""
                      ))}
                  </span>
                )}
                {m.role === "assistant" && m.model && (
                  <div className="mt-0.5 pl-1">
                    <ModelBadge model={m.model} />
                  </div>
                )}
              </div>
            ))}
            <div ref={endRef} />
          </div>

          {/* composer */}
          <div className="flex items-stretch gap-2 border-t border-white/5 p-3">
            <button
              onClick={() => void toggleLive()}
              title="live conversation"
              className={`flex shrink-0 items-center gap-1.5 rounded-xl px-3 text-sm transition ${
                live !== "off" ? "bg-cyan/20 text-cyan ring-1 ring-cyan/50" : "glass text-slate hover:text-ice"
              }`}
            >
              {live === "connecting" ? (
                <span className="h-1.5 w-1.5 animate-ping rounded-full bg-cyan" />
              ) : live === "live" ? (
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-cyan" />
              ) : null}
              live
            </button>
            <button
              onClick={toggleMic}
              title="voice input"
              className={`shrink-0 rounded-xl px-3 text-sm transition ${
                recording ? "bg-amber/20 text-amber ring-1 ring-amber/50" : "glass text-slate hover:text-ice"
              }`}
            >
              {recording ? "■ done" : "mic"}
            </button>
            <button
              onClick={() => void lookAtScreen()}
              title="show JARVIS your screen (one frame)"
              className={`shrink-0 rounded-xl px-3 text-sm transition ${seeing ? "bg-cyan/20 text-cyan ring-1 ring-cyan/50 animate-pulse" : "glass text-slate hover:text-ice"}`}
            >
              👁
            </button>
            <button
              onClick={() => void lookAtCamera()}
              title="point your camera at something — JARVIS reads it"
              className={`shrink-0 rounded-xl px-3 text-sm transition ${camSeeing ? "bg-cyan/20 text-cyan ring-1 ring-cyan/50 animate-pulse" : "glass text-slate hover:text-ice"}`}
            >
              📷
            </button>
            {(speaking || (live === "live" && caption?.who === "jarvis")) && (
              <button
                onClick={stopTalking}
                title="stop talking"
                className="shrink-0 rounded-xl bg-red-500/15 px-3 text-sm text-red-300 ring-1 ring-red-500/40"
              >
                hush
              </button>
            )}
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit(input)}
              placeholder={busy ? "thinking…" : "Talk to me…"}
              className="min-w-0 flex-1 rounded-xl bg-black/30 px-4 py-2.5 text-sm text-ice outline-none ring-1 ring-white/10 transition focus:ring-cyan/50"
            />
            <button
              onClick={() => submit(input)}
              disabled={busy}
              className="shrink-0 rounded-xl bg-cyan/15 px-4 py-2 text-sm font-medium text-cyan ring-1 ring-cyan/40 transition hover:bg-cyan/25 disabled:opacity-40"
            >
              send
            </button>
          </div>
        </div>
        </div>
      </div>

      {/* the video window — never remounts, morphs stage ↔ picture-in-picture */}
      {activeVideo && !(panel?.type === "video" && panelMin) && (
        <VideoDock
          key={activeVideo.value}
          panel={activeVideo}
          // big only when this video IS the stage panel; otherwise it lives in the
          // mini player (the stage belongs to whatever overlay is up)
          pip={panel?.type === "video" ? videoPip : true}
          setPip={
            panel?.type === "video"
              ? setVideoPip
              : (v) => {
                  // "big" from a pinned mini player brings the video back to the stage
                  if (!v) void setPanel({ type: "video", value: activeVideo.value, title: activeVideo.title });
                }
          }
          onClose={() => {
            setVideoPip(false);
            setActiveVideo(null);
            if (panel?.type === "video") void clearPanel({});
          }}
          stageRef={stageRef}
          iframeRef={videoIframeRef}
        />
      )}

      {/* finished-work popups — bottom-left stack, click to read the breakdown */}
      {popups.length > 0 && !panelFull && (
        <div className={`fixed bottom-[116px] left-3 z-40 flex w-[min(280px,calc(100vw-104px))] flex-col-reverse gap-1.5 md:bottom-4 md:left-4 md:w-[min(340px,60vw)] ${chatMode === "full" ? "max-md:hidden" : ""}`}>
          {popups.map((f, i) => (
            <div key={f._id} className={`rise glass overflow-hidden rounded-xl !border-cyan/25 shadow-2xl ${i >= 2 ? "hidden md:block" : ""}`}>
              <button onClick={() => setExpandedFinding(f._id)} className="block w-full p-2.5 text-left transition hover:bg-white/[0.03]">
                <div className="mb-1 flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                  <span className="hud-label !text-[8px]">while you were away</span>
                </div>
                <div className="line-clamp-2 text-xs leading-snug text-ice">{f.spoken}</div>
              </button>
              <button
                onClick={() => dismissFinding(f._id)}
                className="absolute right-1.5 top-1.5 rounded px-1 text-[10px] text-slate hover:text-red-300"
                title="dismiss"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
      {expandedFinding && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" onClick={() => setExpandedFinding(null)}>
          {(() => {
            const f = findingsRecent.find((x) => x._id === expandedFinding);
            if (!f) return null;
            return (
              <div onClick={(e) => e.stopPropagation()} className="glass max-h-[80vh] w-[min(720px,94vw)] overflow-hidden rounded-2xl !border-cyan/30">
                <div className="flex items-center justify-between border-b border-white/5 px-5 py-3">
                  <span className="hud-label !text-cyan">work done while you were away</span>
                  <span className="flex gap-2">
                    <button onClick={() => dismissFinding(f._id)} className="hud-label rounded px-1.5 hover:text-red-300">dismiss</button>
                    <button onClick={() => setExpandedFinding(null)} className="hud-label rounded px-1.5 hover:text-cyan">close</button>
                  </span>
                </div>
                <div className="scrollbar-thin max-h-[65vh] overflow-y-auto p-5">
                  <p className="mb-4 text-lg font-medium leading-relaxed text-ice">{f.spoken}</p>
                  {f.bullets?.length ? (
                    <>
                      <ul className="space-y-2.5">
                        {f.bullets.map((b, j) => (
                          <li key={j} className="flex gap-2.5 text-[15px] leading-relaxed text-ice/90">
                            <span className="mt-0.5 text-cyan/70">›</span>
                            <span className="min-w-0 flex-1">{b}</span>
                          </li>
                        ))}
                      </ul>
                      <details className="mt-5">
                        <summary className="hud-label cursor-pointer select-none hover:text-cyan">full log</summary>
                        <div className="mt-2 whitespace-pre-wrap text-[13px] leading-relaxed text-ice/60">{f.detail}</div>
                      </details>
                    </>
                  ) : (
                    <div className="whitespace-pre-wrap text-[15px] leading-relaxed text-ice/85">{f.detail}</div>
                  )}
                </div>
              </div>
            );
          })()}
        </div>
      )}

      {/* threads drawer — chat history in a slide-out */}
      <div
        className={`fixed inset-0 z-50 transition-opacity duration-300 ${drawerOpen ? "opacity-100" : "pointer-events-none opacity-0"}`}
        onClick={() => setDrawerOpen(false)}
      >
        <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
        <div
          onClick={(e) => e.stopPropagation()}
          className={`glass absolute left-0 top-0 flex h-full w-[300px] flex-col rounded-r-2xl transition-transform duration-300 ease-out ${
            drawerOpen ? "translate-x-0" : "-translate-x-full"
          }`}
        >
          <div className="flex items-center justify-between border-b border-white/5 px-4 py-3">
            <span className="hud-label !text-cyan">chats</span>
            <button onClick={() => setDrawerOpen(false)} className="hud-label rounded px-1.5 hover:text-cyan">✕</button>
          </div>
          <div className="scrollbar-thin min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
            {[{ id: "main", title: "main chat", at: 0 }, ...threads.filter((t) => t.id !== "main")].map((t) => (
              <button
                key={t.id}
                onClick={() => {
                  void setActiveThread({ thread: t.id });
                  setDrawerOpen(false);
                }}
                className={`block w-full truncate rounded-lg px-3 py-2 text-left text-sm transition ${
                  thread === t.id ? "bg-cyan/10 text-cyan ring-1 ring-cyan/30" : "text-ice hover:bg-white/5"
                }`}
              >
                {t.title || t.id}
              </button>
            ))}
          </div>
          <div className="flex gap-2 border-t border-white/5 p-3">
            <button
              onClick={() => {
                void setActiveThread({ thread: `t${Date.now().toString(36)}` });
                setDrawerOpen(false);
              }}
              className="flex-1 rounded-xl bg-cyan/15 px-3 py-2 text-xs font-medium text-cyan ring-1 ring-cyan/40 hover:bg-cyan/25"
            >
              + new chat
            </button>
            <button
              onClick={() => {
                if (confirm("Clear this chat's messages for good?")) void clearThread({ threadId: thread });
                setDrawerOpen(false);
              }}
              className="rounded-xl bg-red-500/10 px-3 py-2 text-xs text-red-300 ring-1 ring-red-500/30 hover:bg-red-500/20"
            >
              clear
            </button>
          </div>
        </div>
      </div>

      {/* bar mode: chat collapsed to a floating type bar — the screen gets the room */}
      {!panelFull && (
        <div
          className={`fixed inset-x-0 bottom-3 z-40 mx-auto w-[min(94vw,780px)] will-change-transform motion-reduce:transition-none transition-all duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] ${
            chatMode === "bar" ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-28 opacity-0"
          }`}
        >
          <div className="glass flex items-stretch gap-2 rounded-2xl p-2 shadow-2xl">
            <button
              onClick={() => setChatMode("full")}
              title="expand chat"
              className="hud-label shrink-0 rounded-xl px-2 hover:text-cyan"
            >
              ▲
            </button>
            <button
              onClick={() => void toggleLive()}
              title="live conversation"
              className={`flex shrink-0 items-center gap-1.5 rounded-xl px-2.5 text-sm transition ${
                live !== "off" ? "bg-cyan/20 text-cyan ring-1 ring-cyan/50" : "text-slate hover:text-ice"
              }`}
            >
              {live === "connecting" ? <span className="h-1.5 w-1.5 animate-ping rounded-full bg-cyan" /> : live === "live" ? <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-cyan" /> : null}
              live
            </button>
            <button
              onClick={toggleMic}
              title="voice input"
              className={`shrink-0 rounded-xl px-2.5 text-sm transition ${recording ? "bg-amber/20 text-amber ring-1 ring-amber/50" : "text-slate hover:text-ice"}`}
            >
              {recording ? "■" : "mic"}
            </button>
            {(speaking || (live === "live" && caption?.who === "jarvis")) && (
              <button onClick={stopTalking} title="stop talking" className="shrink-0 rounded-xl bg-red-500/15 px-2.5 text-sm text-red-300 ring-1 ring-red-500/40">
                hush
              </button>
            )}
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit(input)}
              placeholder={busy ? "thinking…" : "Talk to me…"}
              className="min-w-0 flex-1 rounded-xl bg-black/30 px-4 py-2 text-sm text-ice outline-none ring-1 ring-white/10 transition focus:ring-cyan/50"
            />
            <button
              onClick={() => submit(input)}
              disabled={busy}
              className="shrink-0 rounded-xl bg-cyan/15 px-3.5 py-2 text-sm font-medium text-cyan ring-1 ring-cyan/40 transition hover:bg-cyan/25 disabled:opacity-40"
            >
              send
            </button>
          </div>
        </div>
      )}

      {/* zen mode: no chat at all — JARVIS is always listening */}
      <button
        onClick={() => setChatMode("bar")}
        className={`glass fixed bottom-4 right-4 z-40 flex items-center gap-2 rounded-full px-3.5 py-2 text-xs text-slate will-change-transform motion-reduce:transition-none transition-all duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] hover:text-ice ${
          chatMode === "off" && !panelFull ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-20 opacity-0"
        }`}
        title="bring the chat back"
      >
        <span className={`h-1.5 w-1.5 rounded-full ${live === "live" ? "bg-cyan animate-pulse" : wake ? "bg-cyan breathe" : "bg-slate"}`} />
        {live === "live" ? "live" : wake ? "listening — say “hey jarvis”" : "tap to chat"}
      </button>

      {/* full-screen viewport — keeps a floating composer so Daniel can still talk */}
      {panel && panelFull && (
        <div className="fixed inset-y-0 left-0 right-0 z-50 flex flex-col bg-black/80 p-3 backdrop-blur-sm md:right-[236px] md:p-6 md:pr-3">
          <div className="min-h-0 flex-1">
            <Viewport
              panel={panel}
              onClose={closeStage}
              onMinimize={() => {
                setPanelFull(false);
                setPanelMin(true);
              }}
              full
              onToggleFull={() => setPanelFull(false)}
            />
          </div>
          <div className="mx-auto mt-3 flex w-full max-w-2xl gap-2">
            {(speaking || (live === "live" && caption?.who === "jarvis")) && (
              <button onClick={stopTalking} className="shrink-0 rounded-xl bg-red-500/15 px-3 text-sm text-red-300 ring-1 ring-red-500/40">
                hush
              </button>
            )}
            {live === "live" && caption ? (
              <span className={`glass min-w-0 flex-1 truncate rounded-xl px-4 py-2.5 text-sm ${caption.who === "you" ? "text-amber" : "text-cyan"}`}>
                {caption.text}
              </span>
            ) : (
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submit(input)}
                placeholder="Talk to me…"
                className="glass min-w-0 flex-1 rounded-xl px-4 py-2.5 text-sm text-ice outline-none focus:ring-1 focus:ring-cyan/50"
              />
            )}
            <button
              onClick={() => submit(input)}
              className="shrink-0 rounded-xl bg-cyan/15 px-4 py-2 text-sm font-medium text-cyan ring-1 ring-cyan/40"
            >
              send
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
