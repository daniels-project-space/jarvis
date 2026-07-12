"use client";
import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import ThreeOrb from "./ThreeOrb";
import { CalendarView, CanvasView, LaunchView, PdfView, CreationsView } from "./Views";

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
  calendar: "📅",
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
  if (w?.kind === "weather") {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-5 p-6">
        <div className="hud-label">{w.place}</div>
        <div className="flex items-center gap-5">
          <span className="text-7xl">{w.icon}</span>
          <div>
            <div className="text-6xl font-semibold text-ice">{w.temp}°</div>
            <div className="mt-1 text-sm text-slate">
              {w.desc} · feels {w.feels}° · wind {w.wind} km/h · humidity {w.humidity}%
            </div>
          </div>
        </div>
        <div className="mt-2 flex flex-wrap justify-center gap-2">
          {(w.days ?? []).map((d: any, i: number) => (
            <div key={i} className="glass flex w-[86px] flex-col items-center gap-1 rounded-xl px-2 py-3">
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
      ) : panel.type === "launch" ? (
        <LaunchView value={panel.value} />
      ) : panel.type === "pdf" ? (
        <PdfView url={panel.value} title={panel.title} />
      ) : panel.type === "creations" ? (
        <CreationsView value={panel.value} />
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
    if (panel && panel.updatedAt !== lastPanelAt.current) {
      lastPanelAt.current = panel.updatedAt;
      setPanelMin(false);
      // Content-first moments (briefing, calendar, maps, library, documents,
      // launches): the chat steps aside on its own — expand it back any time.
      let focus = ["canvas", "creations", "pdf", "launch"].includes(panel.type);
      if (panel.type === "widget") {
        try {
          focus = ["briefing", "calendar", "stats"].includes(JSON.parse(panel.value)?.kind);
        } catch {
          /* not json */
        }
      }
      if (focus && chatModeRef.current === "full") setChatMode("bar", false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel]);

  const endRef = useRef<HTMLDivElement>(null);
  const lastSpokenId = useRef<string | null>(null);
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
    endRef.current?.scrollIntoView({ behavior: "smooth" });
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
    if (liveRef.current) {
      // Only voice true background events (agent weaves, insights — untagged rows).
      // Model-tagged rows are replies to someone's typed message and were
      // already delivered where they were asked.
      if (!last.model) import("../lib/realtime").then((m) => m.nudgeLive(last.text));
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
    // new message → viewport folds away, orb returns (only in full chat — in
    // bar/zen the content IS the point, keep it up)
    if (panel && !panelFull && chatModeRef.current === "full") setPanelMin(true);
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
      onCaption: (who, text, done) => setCaption(done ? null : { who, text }),
      onTurnDone: (role, text) => {
        void logTurn({ threadId: threadRef.current, role, text, model: role === "assistant" ? "live" : undefined });
        if (role === "user") {
          void claimVoice({ client: me.current });
          if (!panelFullRef.current) setPanelMin((min) => min || lastPanelAt.current < Date.now() - 8000);
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

  // One-shot voice input: record → Groq Whisper → send. Works on iOS too.
  async function toggleMic() {
    if (recording) {
      recRef.current?.stop();
      return;
    }
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
        if (text?.trim()) void submit(text.trim());
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
    <div className="flex min-h-screen flex-col">
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

      <div
        className={`mx-auto w-full max-w-[1720px] flex-1 gap-4 p-4 pt-2 ${
          chatMode === "full" ? "grid md:grid-cols-[1.6fr_0.95fr]" : `flex flex-col ${chatMode === "bar" ? "pb-24" : ""}`
        }`}
      >
        {/* the stage: orb / viewport / agent view */}
        <div className={`brackets relative ${chatMode === "full" ? "min-h-[46vh] md:min-h-[72vh]" : "min-h-[58vh] flex-1 md:min-h-[78vh]"}`}>
          <span className="bk" />
          {live === "live" && <div className="live-ring pointer-events-none absolute inset-2 rounded-full opacity-60" />}
          {(activeJobs.length > 0 || (panel && panelMin)) && (
            <div className="absolute left-4 right-4 top-4 z-10 flex flex-wrap gap-1.5">
              {panel && panelMin && (
                <button
                  onClick={() => setPanelMin(false)}
                  className="glass flex items-center gap-1.5 rounded-full !border-cyan/40 px-2.5 py-1 text-[10px] text-cyan transition hover:!border-cyan/70"
                  title="reopen"
                >
                  <span>▸</span>
                  <span className="max-w-[160px] truncate">{panel.title ?? panel.type}</span>
                </button>
              )}
              {activeJobs.map((j) => (
                <button
                  key={j._id}
                  onClick={() => setAgentView(agentView === j._id ? null : j._id)}
                  className={`glass flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] transition ${
                    agentView === j._id ? "!border-cyan/60 text-cyan" : "text-slate hover:text-ice"
                  }`}
                >
                  <span className="relative flex h-1.5 w-1.5">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-cyan opacity-60" />
                    <span className="inline-flex h-1.5 w-1.5 rounded-full bg-cyan" />
                  </span>
                  <ModelBadge model={j.model} />
                  <span className="max-w-[130px] truncate">{j.task}</span>
                </button>
              ))}
            </div>
          )}
          {panel && !panelMin && !panelFull ? (
            <div className="absolute inset-0 z-20 p-1">
              <Viewport
                panel={panel}
                onClose={() => clearPanel({})}
                onMinimize={() => setPanelMin(true)}
                full={false}
                onToggleFull={() => setPanelFull(true)}
              />
            </div>
          ) : shownJob ? (
            <div className="absolute inset-0 z-20 p-1">
              <AgentLiveView job={shownJob} now={nowTs} onClose={() => setAgentView(null)} />
            </div>
          ) : null}
          <ThreeOrb state={orbState} energyRef={energyRef} />
          {/* live captions */}
          {caption && (
            <div className="pointer-events-none absolute bottom-10 left-0 right-0 px-8 text-center">
              <span
                className={`inline-block max-w-full rounded-xl px-3 py-1.5 text-sm leading-snug ${
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

        {/* conversation column */}
        {chatMode === "full" && (
        <div className="glass flex h-[52vh] flex-col overflow-hidden rounded-2xl md:h-[78vh]">
          <div className="flex items-center gap-2 border-b border-white/5 px-3 py-1.5">
            <select
              value={thread}
              onChange={(e) => void setActiveThread({ thread: e.target.value })}
              className="hud-label min-w-0 flex-1 cursor-pointer truncate rounded bg-transparent py-0.5 outline-none hover:text-cyan"
              title="chat history"
            >
              {!threads.find((t) => t.id === thread) && <option value={thread}>{thread === "main" ? "main chat" : thread}</option>}
              {threads.map((t) => (
                <option key={t.id} value={t.id} className="bg-abyss text-ice">
                  {t.id === "main" ? "main chat" : t.title}
                </option>
              ))}
            </select>
            <button
              onClick={() => void setActiveThread({ thread: `t${Date.now().toString(36)}` })}
              className="hud-label rounded px-1.5 py-0.5 hover:text-cyan"
              title="start a fresh chat (this one stays in history)"
            >
              + new
            </button>
            <button
              onClick={() => {
                if (confirm("Clear this chat's messages for good?")) void clearThread({ threadId: thread });
              }}
              className="hud-label rounded px-1.5 py-0.5 hover:text-red-300"
              title="wipe this chat"
            >
              clear
            </button>
            <button
              onClick={() => setChatMode("bar")}
              className="hud-label rounded px-1.5 py-0.5 hover:text-cyan"
              title="minimize chat to a type bar — more room for the screen"
            >
              ▁ bar
            </button>
            <button
              onClick={() => setChatMode("off")}
              className="hud-label rounded px-1.5 py-0.5 hover:text-cyan"
              title="hide chat completely — JARVIS keeps listening (say 'hey jarvis')"
            >
              ✕
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
                    className={`inline-block max-w-[88%] whitespace-pre-wrap rounded-2xl px-4 py-2 text-sm leading-relaxed ${
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
        )}
      </div>

      {/* bar mode: chat collapsed to a floating type bar — the screen gets the room */}
      {chatMode === "bar" && !panelFull && (
        <div className="fixed inset-x-0 bottom-3 z-40 mx-auto w-[min(94vw,780px)]">
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
            <button
              onClick={() => setChatMode("off")}
              title="hide completely — JARVIS keeps listening"
              className="hud-label shrink-0 rounded-xl px-2 hover:text-cyan"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {/* zen mode: no chat at all — JARVIS is always listening */}
      {chatMode === "off" && !panelFull && (
        <button
          onClick={() => setChatMode("bar")}
          className="glass fixed bottom-4 right-4 z-40 flex items-center gap-2 rounded-full px-3.5 py-2 text-xs text-slate transition hover:text-ice"
          title="bring the chat back"
        >
          <span className={`h-1.5 w-1.5 rounded-full ${live === "live" ? "bg-cyan animate-pulse" : wake ? "bg-cyan breathe" : "bg-slate"}`} />
          {live === "live" ? "live" : wake ? "listening — say “hey jarvis”" : "tap to chat"}
        </button>
      )}

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
