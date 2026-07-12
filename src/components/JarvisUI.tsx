"use client";
import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import ThreeOrb from "./ThreeOrb";
import { CalendarView, CanvasView, LaunchView, PdfView, CreationsView, CandlesView, VideoListView, FleetView, FeedView, WeatherView, TodosView, Briefing2View } from "./Views";
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
type Job = { _id: string; task: string; model?: string; status: string; progress?: string; startedAt: number };
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
      return "w-[min(780px,96%)] h-[min(600px,96%)]";
    case "w:market":
      return "w-[min(880px,96%)] h-[min(500px,90%)]";
    case "image":
      return "w-[min(1100px,97%)] h-[min(760px,97%)]";
    case "w:candles":
      return "w-[min(1360px,98%)] h-[min(780px,96%)]";
    case "w:stats":
      return "w-[min(1000px,97%)] h-[min(640px,94%)]";
    case "w:videos":
    case "w:feed":
      return "h-full w-full";
    case "markdown":
      return "w-[min(980px,97%)] h-full";
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
      <div className="mt-4 flex-1 overflow-auto rounded-xl bg-black/40 p-3 font-mono text-xs leading-relaxed text-cyan/90">
        <span className="mr-1 opacity-60">›</span>
        {job.progress || "starting up…"}
        <span className="ml-0.5 inline-block h-3 w-1.5 animate-pulse bg-cyan/70 align-middle" />
      </div>
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
    <div className="materialize glass relative flex h-full flex-col overflow-hidden rounded-2xl">
      <div className="flex items-center justify-between border-b border-white/5 px-3 py-2">
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
  const clearPanel = useMutation(api.ui.clearPanel);
  const setPanel = useMutation(api.ui.setPanel);
  const logTurn = useMutation(api.chatQueue.logTurn);
  const saveSub = useMutation(api.push.saveSub);
  const claimVoice = useMutation(api.ui.claimVoice);
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
  useEffect(() => {
    panelTypeRef.current = panel?.type ?? null;
    if (panel && panel.updatedAt !== lastPanelAt.current) {
      lastPanelAt.current = panel.updatedAt;
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
          [{ type: prev.type, value: prev.value, title: prev.title }, ...bs.filter((b) => (b.title ?? b.type) !== (prev.title ?? prev.type))].slice(0, 3),
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
  }[];
  const [dismissed, setDismissed] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem("jarvis_dismissed") ?? "[]"));
    } catch {
      return new Set();
    }
  });
  const [expandedFinding, setExpandedFinding] = useState<string | null>(null);
  const popups = findingsRecent
    .filter((f) => Date.now() - f.createdAt < 5 * 60 * 60 * 1000 && !dismissed.has(f._id) && f.spoken)
    .slice(0, 3);
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
    calm: "#00ff88", focused: "#4a9eed", dreamy: "#9775fa", warm: "#ffb454",
    serious: "#8fa3bd", alert: "#ff5470", excited: "#ff7ad9",
  };
  const moodColor =
    moodRow && Date.now() - moodRow.updatedAt < 20 * 60 * 1000 ? MOOD_COLORS[moodRow.value] ?? undefined : undefined;

  // Orbit bubbles: when a new panel takes the stage, the previous one shrinks
  // into a bobbing bubble beside the orb — tap to bring it back.
  const [bubbles, setBubbles] = useState<{ type: string; value: string; title?: string }[]>([]);
  const prevPanelRef = useRef<{ type: string; value: string; title?: string; updatedAt: number } | null>(null);

  // Chat history drawer + intelligent video handling (16:9 stage / PiP corner)
  const [drawerOpen, setDrawerOpen] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const [videoPip, setVideoPip] = useState(false);
  const panelTypeRef = useRef<string | null>(null);
  const videoIframeRef = useRef<HTMLIFrameElement | null>(null);
  const videoCmd = useQuery(api.ui.getVideoCmd, {}) as { value: string; updatedAt: number } | null | undefined;
  const lastVideoCmd = useRef(-1);
  // The brain's video remote: relay play/pause into the YouTube iframe, close kills it.
  useEffect(() => {
    if (!videoCmd) return;
    if (lastVideoCmd.current === -1) {
      lastVideoCmd.current = videoCmd.updatedAt; // stale command from before load
      return;
    }
    if (videoCmd.updatedAt === lastVideoCmd.current) return;
    lastVideoCmd.current = videoCmd.updatedAt;
    if (videoCmd.value === "close") {
      setVideoPip(false);
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
        void toggleLive(true);
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
        void toggleLive(true);
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
  // I speak only if I own the voice (or nobody fresh does — then I claim it).
  function mayISpeak(): boolean {
    const v = voiceRef.current;
    if (!v || Date.now() - v.updatedAt > 3 * 60 * 1000) {
      void claimVoice({ client: me.current });
      return true;
    }
    return v.value === me.current;
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

  // Speak new finalized assistant messages (text lane). Live-lane rows were
  // already spoken by the realtime session; while live is on, nudge the live
  // session to voice out-of-band lines (agent findings) instead of local TTS.
  useEffect(() => {
    const last = [...messages].reverse().find((m) => m.role === "assistant" && m.status === "done" && m.text);
    if (!last || last._id === lastSpokenId.current) return;
    if (lastSpokenId.current === null) {
      lastSpokenId.current = last._id; // don't re-speak history on page load
      return;
    }
    lastSpokenId.current = last._id;
    if (last.model === "live" || !last.text) return;
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
    if (!mayISpeak()) return; // another tab/device owns the voice
    if (document.hidden) return; // background tabs stay silent — one voice, ever
    (async () => {
      const { speak } = await import("../lib/tts");
      await speak(
        last.text,
        (e) => (energyRef.current = e),
        () => setSpeaking(true),
        () => setSpeaking(false),
      );
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
    // new message: a playing video shrinks to picture-in-picture (keeps
    // playing); other panels fold away in full-chat mode only
    if (panel?.type === "video") setVideoPip(true);
    else if (panel && !panelFull && chatModeRef.current === "full") setPanelMin(true);
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
      alert("Live mode is already running on another device — turn it off there first.");
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
          else if (!panelFullRef.current) setPanelMin((min) => min || lastPanelAt.current < Date.now() - 8000);
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
        </div>
      </header>

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
            <div className="absolute left-4 top-1/2 z-10 flex -translate-y-1/2 flex-col gap-4">
              {bubbles.map((b, i) => {
                const yt = b.type === "video" ? (b.value.match(/embed\/([\w-]{11})/)?.[1] ?? null) : null;
                const isImg = b.type === "image";
                return (
                  <button
                    key={(b.title ?? b.type) + i}
                    onClick={() => {
                      setBubbles((bs) => bs.filter((_, j) => j !== i));
                      void setPanel({ type: b.type, value: b.value, title: b.title });
                    }}
                    className="bob glass group relative h-16 w-16 overflow-hidden rounded-full !border-cyan/30 shadow-xl transition-transform duration-300 hover:scale-125 hover:!border-cyan/70"
                    style={{ animationDelay: `${i * 1.4}s` }}
                    title={b.title ?? b.type}
                  >
                    {yt ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={`https://img.youtube.com/vi/${yt}/mqdefault.jpg`} alt="" className="h-full w-full object-cover" />
                    ) : isImg ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={b.value} alt="" className="h-full w-full object-cover" />
                    ) : (
                      <span className="grid h-full w-full place-items-center text-xl">
                        {b.type === "widget" ? "📊" : b.type === "trip" ? "🌍" : b.type === "board" ? "🎨" : b.type === "canvas" ? "🕸" : b.type === "pdf" ? "📕" : "📄"}
                      </span>
                    )}
                    <span className="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-black/70 px-1 py-0.5 text-center text-[8px] text-ice opacity-0 transition group-hover:opacity-100">
                      {b.title ?? b.type}
                    </span>
                  </button>
                );
              })}
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
            <div className="absolute inset-0 z-20 flex items-center justify-center p-1">
              <div className={`will-change-transform transition-all duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] ${panelSize(panel)}`}>
                <Viewport
                  panel={panel}
                  onClose={() => clearPanel({})}
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
          {/* the orb steps back while a panel is up — content stays readable */}
          <div
            className={`h-full w-full transition-opacity duration-700 ${
              panel && !panelMin && !panelFull ? "opacity-[0.14]" : "opacity-100"
            }`}
          >
            <ThreeOrb state={orbState} energyRef={energyRef} moodColor={moodColor} />
          </div>
          {/* live captions */}
          {caption && (
            <div className="pointer-events-none absolute inset-x-0 bottom-[18%] flex justify-center px-8 text-center">
              <span
                className={`inline-block max-w-[820px] rounded-2xl px-5 py-2.5 text-lg font-medium leading-snug md:text-2xl ${
                  caption.who === "you" ? "text-amber" : "text-cyan"
                }`}
                style={{ textShadow: "0 2px 18px rgba(0,0,0,0.9)" }}
              >
                {caption.text}
              </span>
            </div>
          )}
          <div className="pointer-events-none absolute bottom-3 left-0 right-0 text-center">
            <span className="hud-label">{status}</span>
          </div>
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
            {messages.slice(-80).filter((m) => m.text || m.attachment || m.status === "streaming").map((m) => (
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
      {panel && panel.type === "video" && !panelMin && (
        <VideoDock
          panel={panel}
          pip={videoPip}
          setPip={setVideoPip}
          onClose={() => {
            setVideoPip(false);
            void clearPanel({});
          }}
          stageRef={stageRef}
          iframeRef={videoIframeRef}
        />
      )}

      {/* finished-work popups — bottom-left stack, click to read the breakdown */}
      {popups.length > 0 && !panelFull && (
        <div className="fixed bottom-4 left-4 z-40 flex w-[min(340px,88vw)] flex-col-reverse gap-2">
          {popups.map((f) => (
            <div key={f._id} className="rise glass overflow-hidden rounded-xl !border-cyan/25 shadow-2xl">
              <button onClick={() => setExpandedFinding(f._id)} className="block w-full p-3 text-left transition hover:bg-white/[0.03]">
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
                  <div className="whitespace-pre-wrap text-[15px] leading-relaxed text-ice/85">{f.detail}</div>
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
          {(() => {
            const lastReply = [...messages].reverse().find((m) => m.role === "assistant" && m.status === "done" && m.text);
            return lastReply ? (
              <button
                onClick={() => setChatMode("full")}
                className="mx-auto mb-1.5 block max-w-[92%] truncate rounded-full bg-black/50 px-4 py-1 text-xs text-cyan/90 backdrop-blur-md hover:text-cyan"
                title="expand chat"
              >
                {lastReply.text}
              </button>
            ) : null;
          })()}
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
        <div className="fixed inset-0 z-50 flex flex-col bg-black/80 p-3 backdrop-blur-sm md:p-6">
          <div className="min-h-0 flex-1">
            <Viewport
              panel={panel}
              onClose={() => {
                setPanelFull(false);
                void clearPanel({});
              }}
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
