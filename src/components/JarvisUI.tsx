"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { usePaginatedQuery } from "convex/react";
import dynamic from "next/dynamic";
import { api } from "../../convex/_generated/api";
import { useJarvisQuery } from "@/lib/secure-convex";
import { clientMutation } from "@/lib/client-mutation";
import { primeMicrophone, readJarvisPermissions, type JarvisPermissionState } from "@/lib/permissions";
import { registerSW, subscribePush } from "@/lib/push";
import { isToolGarbage, sanitizeAssistantText } from "../lib/sanitize";
import { createOrbMotionFrame, deriveOrbVisual, type OrbMotionFrame } from "@/lib/orb-motion";
import {
  cacheCompactWorkSnapshot,
  visibleWorkSnapshot,
  type CompactJobDetail,
  type CompactWorkCache,
  type CompactWorkSnapshot,
} from "@/lib/active-work";
import { inferConversationMood, MOOD_COLORS, type OrbMood } from "@/lib/conversation-mood";
import { instantSocialReply } from "@/lib/quick-replies";
import { isPanelFollowUp } from "@/lib/panel-relevance";
import { nextVoiceLoopAction, type VoiceCaptureOutcome } from "@/lib/voice-loop";
import {
  LIVE_SPEAKER_TAIL_MS,
  advanceLiveVad,
  createLiveVadState,
  shouldCloseLiveUtterance,
  shouldDeferLiveCapture,
  shouldPrefetchLiveTranscript,
  spectrumBandLevel,
  type LiveVadState,
} from "@/lib/live-vad";
import { CalendarView, CanvasView, LaunchView, PdfView, CreationsView, StructuredListView, CandlesView, MarketChartLoading, VideoListView, GoalModeLauncherView, FeedView, WeatherView, TodosView, Briefing2View, ShopView, DocView, WebResultsView, PlacesView, RankingView, PanelUnavailable } from "./Views";
import { parseFastChartIntent, parseFastNetWorthIntent, type FastChartIntent, type FastNetWorthIntent } from "@/lib/fast-intents";
import { parseWorkModelTier, workModelLabel } from "@/lib/work-models";
import { isMeaningfulSpeechTranscript, isRecentVoiceDuplicate, shouldIgnoreHandsFreeTranscript } from "@/lib/transcript";
import { completeSpeechPrefix, isSpeaking as isTtsActuallySpeaking, unlockSpeechPlayback } from "@/lib/tts";
import { NarrationLedger, narrationClaim } from "@/lib/narration";
import { resolvePanelRoute } from "@/lib/panel-contract";
import { parseFastAgentDispatch, type FastAgentDispatch } from "@/lib/fast-agent-dispatch";
import { needsHostContext, visibleTurnText, withHostContext, type JarvisHostContext } from "@/lib/host-context";
import { parseEmbeddedHostIntent, type JarvisHostAction } from "@/lib/host-actions";
import { JARVIS_MAC_ENTRY_URL, macShortcutUrl } from "@/lib/mac-shortcut";
import { viewerFetch } from "@/lib/viewer-request";
import { normalizeIncidentSignature } from "@/lib/incident-signature";
import { FleetCommandCenter } from "./CompactWorkBar";
import { useViewerSession } from "@/lib/viewer-session";

const ThreeOrb = dynamic(() => import("./ThreeOrb"), { ssr: false });

const TripView = dynamic(() => import("./TripView"), {
  ssr: false,
  loading: () => <div className="flex min-h-0 flex-1 items-center justify-center text-xs text-cyan">loading travel workspace…</div>,
});
const BoardView = dynamic(() => import("./BoardView"), {
  ssr: false,
  loading: () => <div className="flex min-h-0 flex-1 items-center justify-center text-xs text-cyan">loading drawing workspace…</div>,
});
const VisualSceneView = dynamic(() => import("./VisualSceneView"), {
  ssr: false,
  loading: () => <div className="flex min-h-0 flex-1 items-center justify-center text-xs text-cyan">assembling visual workspace…</div>,
});

type Attachment = { type: string; value: string; title?: string };
type JarvisPrefs = { reduceMotion: boolean; liveDefault: boolean };
type Msg = {
  _id: string;
  role: string;
  text: string;
  status: string;
  model?: string;
  delivery?: "foreground" | "notification";
  parentMessageId?: string;
  attachment?: Attachment;
  createdAt: number;
};
type Caption = {
  who: "you" | "jarvis";
  text: string;
  phase?: "streaming" | "ready" | "speaking";
  exiting?: boolean;
} | null;
type StagePanel = { type: string; value: string; title?: string; updatedAt: number };
type HostActionResult = { ok: boolean; detail?: string };
type StreamingSpeechState = {
  id: string;
  queuedChars: number;
  chain: Promise<void>;
  timer: ReturnType<typeof setTimeout> | null;
  pendingPrefix: string;
  pendingCaption: string;
};

function ChatHistoryArchive({ threadId }: { threadId: string }) {
  const viewerToken = useViewerSession();
  const { results, status, loadMore } = usePaginatedQuery(
    api.chatQueue.paginatedMessages,
    viewerToken ? { threadId, viewerToken } : "skip",
    { initialNumItems: 20 },
  );
  const rows = [...(results as Msg[])].reverse();
  return <section aria-label="Paginated chat history" className="mt-2 border-t border-white/5 pt-2">
    <div className="hud-label px-2 text-slate">current chat history</div>
    <ol className="mt-1 space-y-1 px-2">
      {rows.map((message) => <li key={message._id} data-history-message={message._id} data-parent-message={message.parentMessageId ?? undefined} className="rounded-lg border border-white/[0.05] bg-black/15 px-2 py-1.5 text-[10px] text-slate">
        <div className="font-mono text-[7px] uppercase tracking-[0.1em] text-cyan/60">{message.role}</div>
        {message.attachment
          ? <div className="truncate text-ice">{message.attachment.title ?? message.attachment.type}</div>
          : <div className="line-clamp-3 whitespace-pre-wrap text-ice/85">{message.role === "user" ? visibleTurnText(message.text) : sanitizeAssistantText(message.text)}</div>}
      </li>)}
    </ol>
    {status === "CanLoadMore" && <button type="button" onClick={() => loadMore(20)} className="mx-2 mt-2 w-[calc(100%-16px)] rounded-lg border border-cyan/20 px-2 py-1 text-[9px] text-cyan">load older messages</button>}
    {status === "LoadingMore" && <div className="px-2 py-2 text-center text-[9px] text-cyan">loading older messages…</div>}
  </section>;
}

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
                      : a.type === "scene"
                        ? "✦"
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
  const tier = parseWorkModelTier(model);
  const c =
    tier === "sol"
      ? "text-purple-300"
      : tier === "luna"
        ? "text-slate"
        : model === "live"
          ? "text-cyan"
          : "text-sky-300";
  const label = tier ? `Codex · ${workModelLabel(tier)}` : model;
  return <span className={`hud-label !text-[9px] ${c}`}>{label}</span>;
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
  prefs, setPref, permissions, permissionBusy, onEnablePermissions, live, locOn, onLocation, onClose, onToggleLive, onMood, onClearMood, onOpenLibrary, onOpenGoals, onMacSetup,
}: {
  prefs: JarvisPrefs;
  setPref: (k: keyof JarvisPrefs, v: string | boolean) => void;
  permissions: JarvisPermissionState;
  permissionBusy: boolean;
  onEnablePermissions: () => void;
  live: string;
  locOn: boolean;
  onLocation: () => void;
  onClose: () => void;
  onToggleLive: () => void;
  onMood: (m: string) => void;
  onClearMood: () => void;
  onOpenLibrary: () => void;
  onOpenGoals: () => void;
  onMacSetup: () => void;
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
  const permissionText = (value: JarvisPermissionState["microphone"]) =>
    value === "granted" ? "ready" : value === "denied" ? "blocked" : value === "unsupported" ? "unavailable" : "not enabled";
  return (
    <>
      <div className="fixed inset-0 z-[55]" onClick={onClose} />
      <div className="scrollbar-thin absolute right-3 top-14 z-[56] max-h-[calc(100dvh-5rem)] w-[min(340px,92vw)] overflow-y-auto rounded-2xl border border-white/12 bg-[rgba(14,22,38,0.72)] p-4 shadow-2xl backdrop-blur-2xl md:right-5">
        <div className="mb-1 flex items-center justify-between">
          <span className="hud-label !text-cyan">options</span>
          <button onClick={onClose} className="hud-label hover:text-cyan">close</button>
        </div>
        <div className="divide-y divide-white/5">
          <Row label="Agent intelligence" hint="Codex CLI via ChatGPT subscription · foreground and agents">
            <span className="rounded-lg border border-cyan/25 bg-cyan/[0.07] px-2.5 py-1 font-mono text-[9px] uppercase tracking-wider text-cyan">Codex CLI · adaptive</span>
          </Row>
          <Row label="Voice" hint="private neural speech · free no-silence fallback">
            <span className="rounded-lg border border-cyan/25 bg-cyan/[0.07] px-2.5 py-1 text-[11px] text-cyan">Jarvis · private neural</span>
          </Row>
          <Row
            label="Voice & alerts"
            hint={`microphone ${permissionText(permissions.microphone)} · notifications ${permissionText(permissions.notifications)}`}
          >
            <button
              type="button"
              disabled={permissionBusy || (permissions.microphone === "granted" && permissions.notifications === "granted")}
              onClick={onEnablePermissions}
              className={`rounded-lg px-3 py-1 text-[11px] transition disabled:opacity-70 ${permissions.microphone === "granted" && permissions.notifications === "granted" ? "bg-emerald-400/10 text-emerald-300 ring-1 ring-emerald-400/30" : "border border-cyan/30 text-cyan hover:bg-cyan/10"}`}
            >
              {permissionBusy ? "enabling…" : permissions.microphone === "granted" && permissions.notifications === "granted" ? "ready ✓" : "enable once"}
            </button>
          </Row>
          <Row label="Speaking voice" hint="Free streamed en-GB-RyanNeural">
            <span className="rounded-lg border border-white/10 bg-black/20 px-2.5 py-1 text-[11px] text-ice">Jarvis</span>
          </Row>
          <Row label="Saved work" hint="projects, inquiries, notes, emails, boards, maps and files">
            <button onClick={onOpenLibrary} className="rounded-lg border border-cyan/30 px-3 py-1 text-[11px] text-cyan transition hover:bg-cyan/10">
              open library
            </button>
          </Row>
          <Row label="Goal Mode" hint="Sol plan → Terra/high build → Sol deep validation · durable for days">
            <button onClick={onOpenGoals} className="rounded-lg border border-cyan/30 px-3 py-1 text-[11px] text-cyan transition hover:bg-cyan/10">
              command deck
            </button>
          </Row>
          <Row label="Mac shortcut" hint="global keyboard/voice entry · local actions always need your click">
            <button onClick={onMacSetup} className="rounded-lg border border-cyan/30 px-3 py-1 text-[11px] text-cyan transition hover:bg-cyan/10">
              set up
            </button>
          </Row>
          <Row label="Live conversation" hint={live !== "off" ? "on now" : "listen → answer → listen, with no self-echo"}>
            <button onClick={onToggleLive} className={`rounded-lg px-3 py-1 text-[11px] transition ${live !== "off" ? "bg-cyan/20 text-cyan ring-1 ring-cyan/50" : "border border-white/10 text-slate hover:text-ice"}`}>
              {live === "connecting" ? "…" : live !== "off" ? "stop" : "start"}
            </button>
          </Row>
          <Row label="Live by default" hint="starts on load once this browser has microphone permission">
            <button onClick={() => setPref("liveDefault", !prefs.liveDefault)} className={`h-5 w-9 rounded-full p-0.5 transition ${prefs.liveDefault ? "bg-cyan/60" : "bg-white/15"}`}>
              <span className={`block h-4 w-4 rounded-full bg-white transition-transform ${prefs.liveDefault ? "translate-x-4" : ""}`} />
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
function ReactorRing({
  active,
  aside,
  hidden,
  motionRef,
  reduceMotion,
  compact = false,
}: {
  active: boolean;
  aside: boolean;
  hidden: boolean;
  motionRef: { current: OrbMotionFrame };
  reduceMotion: boolean;
  compact?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const ringRef = useRef<SVGGElement>(null);
  const firstStopRef = useRef<SVGStopElement>(null);
  const middleStopRef = useRef<SVGStopElement>(null);
  const lastStopRef = useRef<SVGStopElement>(null);
  const ticks = useMemo(
    () =>
      Array.from({ length: 60 }, (_, i) => {
        const a = (i / 60) * Math.PI * 2;
        const r1 = 232, r2 = i % 5 === 0 ? 214 : 223;
        return { x1: 250 + r1 * Math.cos(a), y1: 250 + r1 * Math.sin(a), x2: 250 + r2 * Math.cos(a), y2: 250 + r2 * Math.sin(a), major: i % 5 === 0 };
      }),
    [],
  );
  const initialVisual = deriveOrbVisual(motionRef.current, reduceMotion);
  const opacity = hidden ? 0 : (active ? 0.52 : 0.24) * (1 - 0.38 * initialVisual.aside);
  useEffect(() => {
    const ring = ringRef.current;
    const container = containerRef.current;
    if (!ring || !container) return;
    let frame = 0;
    const paint = () => {
      const motion = motionRef.current;
      const visual = deriveOrbVisual(motion, reduceMotion);
      ring.style.transform = visual.rotation ? `rotate(${visual.rotation}rad)` : "none";
      // The ring reads the orb's own eased aside value instead of running a
      // second CSS clock. Translation, scale, colour and rotation therefore
      // cannot lag behind or snap in a different direction.
      container.style.transform = `translateX(${visual.translateXPercent}%) translateY(-4.5%) scale(${visual.scale})`;
      container.style.opacity = String(hidden ? 0 : (active ? 0.52 : 0.24) * (1 - 0.38 * visual.aside));
      firstStopRef.current?.setAttribute("stop-color", visual.color);
      middleStopRef.current?.setAttribute("stop-color", visual.accent);
      lastStopRef.current?.setAttribute("stop-color", visual.color);
      // Reduced motion freezes rotation but still follows the orb's slowly
      // changing conversation colour.
      frame = requestAnimationFrame(paint);
    };
    paint();
    return () => cancelAnimationFrame(frame);
  }, [active, hidden, motionRef, reduceMotion]);
  return (
    <div
      ref={containerRef}
      className="pointer-events-none absolute inset-0 grid place-items-center will-change-transform"
      style={{ opacity, transform: `translateX(${initialVisual.translateXPercent}%) translateY(-4.5%) scale(${initialVisual.scale})` }}
    >
      <svg viewBox="0 0 500 500" className={compact ? "h-full w-full md:h-[min(82vmin,760px)] md:w-[min(82vmin,760px)]" : "h-[min(82vmin,760px)] w-[min(82vmin,760px)]"}>
        <defs>
          <linearGradient id="jarvis-orb-gradient" x1="65" y1="65" x2="435" y2="435" gradientUnits="userSpaceOnUse">
            <stop ref={firstStopRef} offset="0" stopColor="#00ff88" />
            <stop ref={middleStopRef} offset="0.48" stopColor="#8affc5" />
            <stop ref={lastStopRef} offset="1" stopColor="#00ff88" />
          </linearGradient>
        </defs>
        <g
          ref={ringRef}
          fill="none"
          stroke="url(#jarvis-orb-gradient)"
          style={{ transformBox: "fill-box", transformOrigin: "center", willChange: reduceMotion ? undefined : "transform" }}
        >
          <circle cx="250" cy="250" r="244" strokeWidth="1" strokeOpacity="0.25" strokeDasharray="40 20" />
          <circle cx="250" cy="250" r="200" strokeWidth="1.5" strokeOpacity="0.18" />
          <path d="M250 62 A188 188 0 0 1 438 250" strokeWidth="2" strokeOpacity="0.75" strokeLinecap="round" />
          <path d="M250 438 A188 188 0 0 1 62 250" strokeWidth="1.2" strokeOpacity="0.38" strokeLinecap="round" />
          <g strokeOpacity="0.35">
            {ticks.map((t, i) => (
              <line key={i} x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2} strokeWidth={t.major ? 1.6 : 0.8} strokeOpacity={t.major ? 0.5 : 0.28} />
            ))}
          </g>
          <circle cx="250" cy="250" r="170" strokeWidth="1" strokeOpacity="0.12" strokeDasharray="2 8" />
        </g>
      </svg>
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

function MacShortcutAction({ w }: { w: any }) {
  const name = String(w.shortcut ?? "").trim();
  const input = String(w.input ?? "").trim();
  const url = macShortcutUrl(name, input);
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
      <div className="hud-label !text-cyan">Mac action ready · approval required</div>
      <div className="text-2xl font-semibold text-ice">{name || "Apple Shortcut"}</div>
      {input && <div className="glass max-w-lg rounded-xl px-4 py-3 text-sm text-slate">{input}</div>}
      {w.reason && <div className="max-w-lg text-xs leading-relaxed text-slate">{String(w.reason)}</div>}
      <a
        href={url}
        className="rounded-xl bg-cyan/15 px-6 py-3 text-sm font-medium text-cyan ring-1 ring-cyan/50 transition hover:bg-cyan/25"
      >
        Run on this Mac
      </a>
      <div className="max-w-md text-[10px] leading-relaxed text-slate/75">
        Jarvis never opens this link automatically. macOS runs it only after you click and only if that named Shortcut exists.
      </div>
    </div>
  );
}

function MacSetupWidget() {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(JARVIS_MAC_ENTRY_URL);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };
  return (
    <div className="scrollbar-thin min-h-0 flex-1 overflow-auto p-5">
      <div className="hud-label !text-cyan">Jarvis on your Mac</div>
      <div className="mt-2 text-xl font-semibold text-ice">One shortcut, available everywhere</div>
      <ol className="mt-5 space-y-3 text-sm text-ice">
        <li className="glass rounded-xl p-3"><span className="mr-2 text-cyan">01</span>In Apple Shortcuts, create <b>Talk to Jarvis</b> with <b>Dictate Text</b>.</li>
        <li className="glass rounded-xl p-3"><span className="mr-2 text-cyan">02</span>Add <b>URL Encode</b>, then append its result to the Jarvis entry URL below.</li>
        <li className="glass rounded-xl p-3"><span className="mr-2 text-cyan">03</span>Add <b>Open URLs</b>. In Details, choose <b>Add Keyboard Shortcut</b> for a global key combination.</li>
        <li className="glass rounded-xl p-3"><span className="mr-2 text-cyan">04</span>In Safari, open Project Hub and choose <b>File → Add to Dock</b>; allow microphone and notifications once.</li>
      </ol>
      <div className="mt-4 flex flex-wrap gap-2">
        <button onClick={() => void copy()} className="rounded-lg border border-cyan/35 px-3 py-2 text-xs text-cyan transition hover:bg-cyan/10">
          {copied ? "copied ✓" : "copy entry URL"}
        </button>
        <a href="shortcuts://create-shortcut" className="rounded-lg border border-white/10 px-3 py-2 text-xs text-ice transition hover:border-cyan/35">
          open Shortcuts
        </a>
      </div>
      <div className="mt-3 break-all rounded-lg bg-black/25 p-2 font-mono text-[10px] text-slate">{JARVIS_MAC_ENTRY_URL}[URL Encoded Dictated Text]</div>
      <p className="mt-4 text-[11px] leading-relaxed text-slate">
        For Mac-only actions, create named Apple Shortcuts (for example “Add to Notes”). Jarvis can prepare those actions, but the on-screen Run button is deliberately the final approval boundary.
      </p>
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
  if (w?.kind === "mac_action") return <MacShortcutAction w={w} />;
  if (w?.kind === "mac_setup") return <MacSetupWidget />;
  if (w?.kind === "calendar") return <CalendarView value={value} />;
  if (w?.kind === "chart_loading") return <MarketChartLoading asset={w.asset ?? "Market"} interval={w.interval ?? "1d"} />;
  if (w?.kind === "net_worth_loading") {
    return (
      <div className="flex min-h-0 flex-1 flex-col justify-center p-5">
        <div className="hud-label mb-3">live wealth ledger</div>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(145px,1fr))] gap-3">
          {["net worth", "cashflow /mo", "expenses /mo", "rental /mo"].map((label, index) => (
            <div key={label} className="glass rounded-xl px-3 py-4 text-center">
              <div className="mx-auto h-8 w-24 animate-pulse rounded bg-cyan/10" style={{ animationDelay: `${index * 80}ms` }} />
              <div className="hud-label mt-2">{label}</div>
            </div>
          ))}
        </div>
        <div className="mt-5 flex h-28 items-end gap-2">
          {[42, 74, 55, 92, 63, 35].map((height, index) => (
            <div key={index} className="flex-1 animate-pulse rounded-t bg-gradient-to-t from-cyan/10 to-cyan/35" style={{ height: `${height}%`, animationDelay: `${index * 70}ms` }} />
          ))}
        </div>
      </div>
    );
  }
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
        <div className="grid grid-cols-[repeat(auto-fit,minmax(145px,1fr))] gap-3">
          {(w.kpis ?? []).map((k: any, i: number) => (
            <div key={i} className="glass min-w-0 overflow-hidden rounded-xl px-3 py-4 text-center">
              <div className="truncate text-xl font-semibold text-ice md:text-2xl xl:text-3xl" title={`${k.prefix ?? ""}${k.value}${k.suffix ?? ""}`}>
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
        <div className="text-sm text-ice">This widget is not supported by the current visual bundle.</div>
        <div className="max-w-sm text-xs text-slate">Ask Jarvis to recreate it as a structured list or visual workspace.</div>
      </div>
    );
  }
  return <PanelUnavailable label="widget" />;
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
  const route = resolvePanelRoute(panel);
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
      {route.renderer === "site" ? (
        <SiteView url={panel.value} />
      ) : route.renderer === "widget" ? (
        <WidgetView value={panel.value} />
      ) : route.renderer === "canvas" ? (
        <CanvasView value={panel.value} />
      ) : route.renderer === "trip" ? (
        <TripView value={panel.value} />
      ) : route.renderer === "doc" ? (
        <DocView value={panel.value} />
      ) : route.renderer === "launch" ? (
        <LaunchView value={panel.value} />
      ) : route.renderer === "pdf" ? (
        <PdfView url={panel.value} title={panel.title} />
      ) : route.renderer === "creations" ? (
        <CreationsView value={panel.value} />
      ) : route.renderer === "fleet" ? (
        <GoalModeLauncherView />
      ) : route.renderer === "board" ? (
        <BoardView value={panel.value} />
      ) : route.renderer === "scene" ? (
        <VisualSceneView value={panel.value} />
      ) : route.renderer === "iframe" ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <iframe
            src={panel.value}
            className={`w-full flex-1 ${panel.type === "video" ? "bg-black" : "bg-white"}`}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-presentation"
            allow="autoplay; encrypted-media; picture-in-picture"
          />
        </div>
      ) : route.renderer === "image" ? (
        <img src={panel.value} alt={panel.title ?? ""} className="min-h-0 flex-1 object-contain" />
      ) : route.renderer === "code" ? (
        <pre className="scrollbar-thin min-h-0 flex-1 overflow-auto whitespace-pre p-4 font-mono text-xs leading-relaxed text-cyan/90">
          {panel.value}
        </pre>
      ) : route.renderer === "list" ? (
        <StructuredListView value={panel.value} />
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

// The spoken caption. Short text just shows; a long reply that overflows the
// field scrolls top→bottom over the narration's estimated duration (teleprompter),
// so Daniel can read along with the voice instead of it clipping.
function SpokenCaption({ caption }: { caption: NonNullable<Caption> }) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = boxRef.current;
    if (!el || caption.exiting) return;
    el.scrollTop = 0;
    if (caption.phase === "streaming") {
      // Follow the newest streamed words without repeatedly restarting the
      // narration animation from the top.
      el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
      return;
    }
    if (caption.phase !== "speaking") return;
    const overflow = el.scrollHeight - el.clientHeight;
    if (overflow <= 4) return; // fits — no scroll
    // pace to the narration: ~2.7 spoken words/sec, with a lead-in and tail so it
    // doesn't start or finish jammed against an edge
    const words = caption.text.trim().split(/\s+/).length;
    const durMs = Math.max(1800, (words / 2.7) * 1000);
    const lead = 550, tail = 800;
    let raf = 0, start = 0;
    const step = (ts: number) => {
      if (!start) start = ts;
      const t = ts - start;
      const p = Math.min(1, Math.max(0, (t - lead) / Math.max(1, durMs - lead - tail)));
      el.scrollTop = overflow * p;
      if (t < durMs) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [caption.text, caption.phase, caption.exiting]);
  return (
    <div
      ref={boxRef}
      data-jarvis-caption
      data-caption-phase={caption.phase ?? "ready"}
      className={`${caption.exiting ? "cap-fade-out" : "cap-bloom"} max-h-[26vh] max-w-[min(820px,88%)] overflow-hidden text-center text-xl font-semibold leading-snug tracking-tight md:text-[1.7rem] lg:text-[1.95rem] ${caption.who === "you" ? "text-amber" : "text-ice"}`}
    >
      {caption.text}
    </div>
  );
}

export default function JarvisUI({ embedded = false }: { embedded?: boolean }) {
  const orbMotionRef = useRef<OrbMotionFrame>(createOrbMotionFrame());
  useEffect(() => {
    if (!embedded) return;
    document.documentElement.classList.add("jarvis-embedded-document");
    document.body.classList.add("jarvis-embedded-document");
    return () => {
      document.documentElement.classList.remove("jarvis-embedded-document");
      document.body.classList.remove("jarvis-embedded-document");
    };
  }, [embedded]);
  const activeThreadQuery = useJarvisQuery(api.ui.getActiveThread, {});
  const activeThreadReady = activeThreadQuery !== undefined;
  const thread = (activeThreadQuery ?? "main") as string;
  const threads = (useJarvisQuery(api.ui.getThreads, embedded ? "skip" : {}) ?? []) as { id: string; title: string; at: number }[];
  const setActiveThread = (args: { thread: string; title?: string }) =>
    viewerFetch("/api/client-state", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "set_active_thread", ...args }),
    });
  const clearThread = (args: { threadId?: string }) =>
    viewerFetch("/api/client-state", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "clear_thread", ...args }),
    });
  const threadRef = useRef("main");
  const threadReadyRef = useRef(false);
  const pendingEntryCommands = useRef<string[]>([]);
  const hostContextRef = useRef<JarvisHostContext | null>(null);
  const hostActionWaiters = useRef(new Map<string, (result: HostActionResult) => void>());
  useEffect(() => {
    threadRef.current = thread;
    if (!activeThreadReady) return;
    threadReadyRef.current = true;
    const queued = pendingEntryCommands.current.splice(0);
    for (const command of queued) void submit(command);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeThreadReady, thread]);
  function submitEntryCommand(command: string) {
    if (!threadReadyRef.current) {
      pendingEntryCommands.current.push(command);
      return;
    }
    void submit(command);
  }
  const fullMessages = useJarvisQuery(api.chatQueue.listMessages, embedded ? "skip" : { threadId: thread });
  const embeddedMessages = useJarvisQuery(api.chatQueue.listRecentMessages, embedded ? { threadId: thread } : "skip");
  const messages = ((embedded ? embeddedMessages : fullMessages) ?? []) as Msg[];
  const remotePanel = useJarvisQuery(api.ui.getPanel, embedded ? "skip" : {}) as
    | StagePanel
    | null
    | undefined;
  // A direct market request paints its visual shell locally before Convex has
  // had a chance to round-trip the completed widget. The remote panel remains
  // the source of truth; this small optimistic layer only removes visual lag.
  const [instantPanel, setInstantPanel] = useState<StagePanel | null>(null);
  const panel = instantPanel ?? remotePanel;
  const panelRoute = useMemo(() => (panel ? resolvePanelRoute(panel) : null), [panel]);
  const stagePanelSize = panelRoute?.size ?? "";
  const clearPanel = (args: Record<string, unknown>) => clientMutation("ui:clearPanel", args);
  const setPanel = (args: Record<string, unknown>) => clientMutation("ui:setPanel", args);
  const logTurn = (args: { threadId?: string; role: string; text: string; model?: string }) =>
    viewerFetch("/api/client-state", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "log_turn", ...args }),
    });
  const saveSub = (args: Record<string, unknown>) => clientMutation("push:saveSub", args);
  const claimVoice = (args: Record<string, unknown>) => clientMutation("ui:claimVoice", args);
  const electVoice = (args: Record<string, unknown>) => clientMutation("ui:electVoice", args);
  const setLiveOn = (args: Record<string, unknown>) => clientMutation("ui:setLiveOn", args);
  const voiceRow = useJarvisQuery(api.ui.getVoice, {}) as { value: string; updatedAt: number } | null | undefined;
  const liveOnRow = useJarvisQuery(api.ui.getLiveOn, {}) as { value: string; updatedAt: number } | null | undefined;
  const hostActionRow = useJarvisQuery(api.ui.getHostAction, embedded ? {} : "skip") as
    | { value: string; updatedAt: number }
    | null
    | undefined;
  const commandSnapshot = useJarvisQuery(
    api.commandCenter.snapshot,
    embedded || !activeThreadReady ? "skip" : { threadId: thread },
  ) as CompactWorkSnapshot | undefined;
  const [workDetailJobId, setWorkDetailJobId] = useState<string | null>(null);
  const workDetail = useJarvisQuery(
    api.jobs.detail,
    workDetailJobId ? { jobId: workDetailJobId as never } : "skip",
  ) as CompactJobDetail | null | undefined;
  useEffect(() => setWorkDetailJobId(null), [thread]);
  const compactWorkCache = useRef<CompactWorkCache>(null);
  useEffect(() => {
    compactWorkCache.current = cacheCompactWorkSnapshot(compactWorkCache.current, thread, commandSnapshot);
  }, [commandSnapshot, thread]);
  const visibleCommandSnapshot = visibleWorkSnapshot(compactWorkCache.current, thread, commandSnapshot);
  const lastHostNotificationId = useRef<string | null>(null);
  useEffect(() => {
    if (!embedded) return;
    const latest = [...messages].reverse().find((message) => message.role === "assistant" && message.delivery !== "notification" && message.status === "done" && message.text);
    if (!latest) return;
    if (lastHostNotificationId.current === null) {
      lastHostNotificationId.current = latest._id;
      return;
    }
    if (latest._id === lastHostNotificationId.current) return;
    lastHostNotificationId.current = latest._id;
    if (Date.now() - latest.createdAt > 60_000) return;
    window.parent.postMessage({ jarvis: "notify", text: sanitizeAssistantText(latest.text).slice(0, 240) }, "*");
  }, [embedded, messages]);
  const lastRelayedHostAction = useRef<string | null>(null);
  useEffect(() => {
    if (!embedded || !hostActionRow || Date.now() - hostActionRow.updatedAt > 20_000) return;
    let action: JarvisHostAction;
    try {
      action = JSON.parse(hostActionRow.value) as JarvisHostAction;
    } catch {
      return;
    }
    const currentHostId = hostContextRef.current?.hostId;
    if (!action.hostId || !currentHostId || action.hostId !== currentHostId) return;
    const id = action.id || String(hostActionRow.updatedAt);
    if (lastRelayedHostAction.current === id) return;
    try {
      if (sessionStorage.getItem("jarvis_host_action") === id) return;
      sessionStorage.setItem("jarvis_host_action", id);
    } catch {
      /* private mode */
    }
    lastRelayedHostAction.current = id;
    window.parent.postMessage({ jarvis: "host-action", action: { ...action, id } }, "*");
  }, [embedded, hostActionRow]);

  const [input, setInput] = useState("");
  const [speaking, setSpeaking] = useState(false);
  const speakingRef = useRef(false);
  const wasSpeakingRef = useRef(false);
  const ttsQuietUntilRef = useRef(0);
  const keyboardQuietUntilRef = useRef(0);
  const lastKeyboardActivityRef = useRef(0);
  useEffect(() => {
    speakingRef.current = speaking;
    if (wasSpeakingRef.current && !speaking) {
      ttsQuietUntilRef.current = Math.max(ttsQuietUntilRef.current, Date.now() + LIVE_SPEAKER_TAIL_MS);
    }
    wasSpeakingRef.current = speaking;
  }, [speaking]);
  const [sending, setSending] = useState(false);
  const [recording, setRecording] = useState(false);
  const [live, setLive] = useState<"off" | "connecting" | "live">("off");
  useEffect(() => {
    if (!embedded || window.parent === window) return;
    window.parent.postMessage({ jarvis: speaking ? "speech-start" : "speech-end" }, "*");
  }, [embedded, speaking]);
  useEffect(() => {
    if (!embedded || window.parent === window) return;
    window.parent.postMessage({ jarvis: live === "off" ? "live-end" : "live-start" }, "*");
  }, [embedded, live]);
  const [caption, setCaption] = useState<Caption>(null);
  // Soft dismiss: mark the caption `exiting` so it fades out slowly (CSS), then
  // unmount after the fade. A fresh caption cancels a pending fade.
  const captionHoldTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const captionExitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const captionEpoch = useRef(0);
  const clearCaptionTimers = () => {
    if (captionHoldTimer.current) clearTimeout(captionHoldTimer.current);
    if (captionExitTimer.current) clearTimeout(captionExitTimer.current);
    captionHoldTimer.current = null;
    captionExitTimer.current = null;
  };
  const fadeCaption = (onlyText?: string, holdMs = 1400) => {
    clearCaptionTimers();
    const epoch = captionEpoch.current;
    captionHoldTimer.current = setTimeout(() => {
      if (epoch !== captionEpoch.current) return;
      setCaption((c) => (c && (!onlyText || c.text === onlyText) ? { ...c, exiting: true } : c));
      captionExitTimer.current = setTimeout(() => {
        if (epoch !== captionEpoch.current) return;
        setCaption((c) => (c?.exiting && (!onlyText || c.text === onlyText) ? null : c));
      }, 900);
    }, holdMs);
  };
  const showCaption = (c: Caption) => {
    captionEpoch.current += 1;
    clearCaptionTimers();
    setCaption((current) => {
      if (!c) return null;
      // Preserve one DOM surface while streamed text grows and when that same
      // text hands over to TTS. Replacing the keyed element per token was the
      // visible flash-to-transparent bug.
      if (current?.who === c.who) return { ...current, ...c, phase: c.phase ?? "ready", exiting: false };
      return { ...c, phase: c.phase ?? "ready", exiting: false };
    });
  };
  useEffect(() => () => clearCaptionTimers(), []);
  const [commandExpanded, setCommandExpanded] = useState(false);
  // Viewport minimize: keep talking and the panel folds into a pill; the orb
  // comes back. Fresh panel content pops it open again.
  // Start folded: the first Convex snapshot may be hours old. Only content
  // created during this browser session is allowed to expand itself.
  const [panelMin, setPanelMin] = useState(true);
  const lastPanelAt = useRef(0);
  // Daniel closed it = it stays closed. If the exact same panel content comes
  // back within 30s of an explicit close (a live-session loop re-showing the
  // bikini search, say), kill it server-side instead of displaying it.
  const closedPanelRef = useRef<{ key: string; ts: number } | null>(null);
  const closeStage = () => {
    if (panel) closedPanelRef.current = { key: `${panel.title ?? ""}|${panel.value.slice(0, 160)}`, ts: Date.now() };
    setInstantPanel(null);
    setPanelFull(false);
    void clearPanel({});
  };
  useEffect(() => {
    if (!instantPanel || !remotePanel) return;
    if (remotePanel.title === instantPanel.title && remotePanel.value === instantPanel.value) setInstantPanel(null);
  }, [instantPanel, remotePanel]);
  useEffect(() => {
    panelTypeRef.current = panel?.type ?? null;
    if (panel && panel.updatedAt !== lastPanelAt.current) {
      if (lastPanelAt.current === 0 && !instantPanel && Date.now() - panel.updatedAt > 60_000) {
        lastPanelAt.current = panel.updatedAt;
        prevPanelRef.current = null;
        setPanelMin(true);
        void clearPanel({});
        return;
      }
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
  const streamingSpeechRef = useRef<StreamingSpeechState>({
    id: "",
    queuedChars: 0,
    chain: Promise.resolve(),
    timer: null,
    pendingPrefix: "",
    pendingCaption: "",
  });
  const narrationLedgerRef = useRef(new NarrationLedger());
  const captionRef = useRef<Caption>(null);
  const energyRef = useRef(0);
  const recRef = useRef<MediaRecorder | null>(null);
  const liveMicRef = useRef<{ stream: MediaStream; context: AudioContext; analyser: AnalyserNode } | null>(null);
  const liveSessionEpoch = useRef(0);
  const sttAbortRef = useRef<AbortController | null>(null);
  const lastVoiceInput = useRef<{ text: string; at: number } | null>(null);
  const liveRef = useRef(false);
  const me = useRef("");
  const voiceRef = useRef<{ value: string; updatedAt: number } | null>(null);
  const localVoiceLeaseUntilRef = useRef(0);
  const localVoiceClaimedAtRef = useRef(0);
  const ownVoice = () => {
    // A direct interaction is authoritative locally. Waiting for the Convex
    // subscription to echo this claim back added ~650 ms before buffered
    // audio could start.
    const now = Date.now();
    voiceRef.current = { value: me.current, updatedAt: now };
    localVoiceClaimedAtRef.current = now;
    // Covers only the subscription echo race. Once Convex confirms this claim
    // (or a newer tab claims afterward), the authoritative row takes over.
    localVoiceLeaseUntilRef.current = now + 8_000;
    return claimVoice({ client: me.current }).catch(() => undefined);
  };
  const lastSent = useRef<{ text: string; ts: number }>({ text: "", ts: 0 });
  const durableStartedAt = useRef<number | null>(null);
  const [wake, setWake] = useState(false);
  const [panelFull, setPanelFull] = useState(false);
  const panelFullRef = useRef(false);
  useEffect(() => {
    panelFullRef.current = panelFull;
  }, [panelFull]);

  // The colour changes locally on the first keystroke/word, rather than
  // waiting for a streamed model reply or a Convex write. A deliberate manual
  // choice remains authoritative until Daniel returns it to automatic mode.
  const moodRow = useJarvisQuery(api.ui.getMood, {}) as { value: string; title?: string; updatedAt: number } | null | undefined;
  const [contextMood, setContextMood] = useState<OrbMood>("calm");
  const manualMood = moodRow?.title === "manual" && moodRow.value in MOOD_COLORS ? (moodRow.value as OrbMood) : null;
  const activeMood = manualMood ?? contextMood;
  const moodColor = MOOD_COLORS[activeMood];
  const updateConversationMood = (text: string) => setContextMood((previous) => inferConversationMood(text, previous));

  // Orbit bubbles: when a new panel takes the stage, the previous one shrinks
  // into a bobbing bubble beside the orb — tap to bring it back.
  const [bubbles, setBubbles] = useState<{ type: string; value: string; title?: string }[]>([]);
  const prevPanelRef = useRef<{ type: string; value: string; title?: string; updatedAt: number } | null>(null);

  // Speech deliberately has no engine or voice switch: every device uses the
  // same neural Jarvis identity.
  const [optionsOpen, setOptionsOpen] = useState(false);
  const setMoodMut = (args: Record<string, unknown>) => clientMutation("ui:setMood", args);
  const [prefs, setPrefs] = useState<JarvisPrefs>({ reduceMotion: false, liveDefault: true });
  const [permissions, setPermissions] = useState<JarvisPermissionState>({ microphone: "prompt", notifications: "prompt" });
  const [permissionBusy, setPermissionBusy] = useState(false);
  const liveAutoStarted = useRef(false);
  useEffect(() => {
    // Settings left by the superseded speech engines made different browsers
    // silently select different Jarvis voices.
    localStorage.removeItem("jarvis_voice");
    localStorage.removeItem("jarvis_tts");
    localStorage.removeItem("jarvis_kokoro_voice");
    setPrefs({
      reduceMotion: localStorage.getItem("jarvis_reduce_motion") === "1",
      liveDefault: localStorage.getItem("jarvis_live_default") !== "0",
    });
    // Greeting synthesis is never run on mount. It competes with wake-word
    // recognition and makes an assistant speak before Daniel has asked.
  }, []);
  useEffect(() => {
    // There is no browser voice model now. This only warms the authenticated
    // Vercel route bundle so the first reply can go straight to Edge speech.
    const idleWindow = window as typeof window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    const start = () => void import("../lib/tts").then((module) => module.warm());
    if (idleWindow.requestIdleCallback) {
      const id = idleWindow.requestIdleCallback(start, { timeout: embedded ? 2_000 : 900 });
      return () => idleWindow.cancelIdleCallback?.(id);
    }
    const id = window.setTimeout(start, embedded ? 1_200 : 500);
    return () => window.clearTimeout(id);
  }, [embedded]);
  useEffect(() => {
    // Capture the browser activation itself. Waiting for Codex/Trigger to
    // answer before calling play() is too late and used to leave fully-loaded
    // MP3s silent with NotAllowedError, particularly in the Project Hub embed.
    const unlock = () => unlockSpeechPlayback();
    const keyboardActivity = () => {
      // Physical key taps are close to the laptop microphone and can resemble
      // voiced transients to a generic VAD. DOM input gives us deterministic
      // evidence, so mute capture briefly rather than asking STT to guess.
      lastKeyboardActivityRef.current = Date.now();
      keyboardQuietUntilRef.current = Math.max(keyboardQuietUntilRef.current, Date.now() + 1_100);
      unlock();
    };
    window.addEventListener("pointerdown", unlock, { capture: true });
    window.addEventListener("keydown", keyboardActivity, { capture: true });
    window.addEventListener("keyup", keyboardActivity, { capture: true });
    return () => {
      window.removeEventListener("pointerdown", unlock, { capture: true });
      window.removeEventListener("keydown", keyboardActivity, { capture: true });
      window.removeEventListener("keyup", keyboardActivity, { capture: true });
    };
  }, []);
  const setPref = (k: keyof JarvisPrefs, v: string | boolean) => {
    setPrefs((p) => ({ ...p, [k]: v }));
    const key = k === "reduceMotion" ? "jarvis_reduce_motion" : "jarvis_live_default";
    localStorage.setItem(key, typeof v === "boolean" ? (v ? "1" : "0") : String(v));
    if (k === "liveDefault" && v === true) liveAutoStarted.current = false;
  };
  const refreshPermissions = async () => {
    setPermissions(await readJarvisPermissions());
  };
  useEffect(() => {
    void refreshPermissions();
    const refresh = () => void refreshPermissions();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    document.documentElement.classList.toggle("jarvis-reduce-motion", prefs.reduceMotion);
    return () => document.documentElement.classList.remove("jarvis-reduce-motion");
  }, [prefs.reduceMotion]);

  // Location: granted once, then permanent (browser remembers the permission,
  // and we refresh the stored coords on load so "near me" works in both lanes).
  const setLocationMut = (args: { lat: number; lng: number; label?: string }) =>
    viewerFetch("/api/client-state", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "set_location", ...args }),
    });
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
  const videoCmd = useJarvisQuery(api.ui.getVideoCmd, embedded ? "skip" : {}) as { value: string; updatedAt: number } | null | undefined;
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
    if (embedded) {
      setChatMode("off", false);
      return;
    }
    try {
      const saved = localStorage.getItem("jarvis_chat_mode");
      if (saved === "bar" || saved === "off" || saved === "full") setChatMode(saved, false);
    } catch {
      /* private mode */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Standby wake word: "hey jarvis" / "jarvis" starts live mode, Siri-style.
  const wakePreferenceKey = embedded ? "jarvis_embed_wake" : "jarvis_wake";
  const wakeOwnedByHost = () => embedded && window.parent !== window;
  const wakeIsEnabled = () => embedded
    ? localStorage.getItem(wakePreferenceKey) !== "0"
    : localStorage.getItem(wakePreferenceKey) === "1";
  const onWakeDetected = () => {
    setWake(false);
    setChatMode(embedded ? "off" : "full", false);
    showCaption({ who: "you", text: "Listening…" });
    unlockSpeechPlayback();
    // Show the Hub overlay and begin the neural voice load immediately, while
    // SpeechRecognition is still collecting a same-breath command.
    if (embedded) window.parent.postMessage({ jarvis: "wake" }, "*");
    void import("../lib/tts").then((module) => module.warm());
  };
  const onWake = (transcript: string) => {
    import("../lib/wakeword").then((m) => {
      setWake(false);
      setChatMode(embedded ? "off" : "full", false);
      const command = m.commandAfterWake(transcript);
      void (async () => {
        // A wake activation becomes one persistent conversation session. The
        // old one-shot path closed the device after every turn and dropped
        // back into browser SpeechRecognition, which looked like the mic was
        // switching itself on and off every few seconds.
        const started = await toggleLive(true, false);
        if (!started) return;
        if (command) {
          void ownVoice();
          submitEntryCommand(command);
          scheduleFreeVoiceTurn(120);
        } else {
          showCaption({ who: "you", text: "Listening…" });
          void freeVoiceTurn();
        }
      })();
    });
  };
  const rearmWake = () => {
    // A cross-origin iframe cannot reliably obtain microphone permission.
    // Project Hub owns recognition at the top level and sends commands here.
    if (wakeOwnedByHost()) return;
    if (!wakeIsEnabled()) return;
    import("../lib/wakeword").then((m) => {
      if (!m.wakeSupported()) return;
      m.startWake(onWake, (listening) => setWake(listening), onWakeDetected);
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
        localStorage.setItem(wakePreferenceKey, "0");
        m.stopWake();
        setWake(false);
      } else {
        localStorage.setItem(wakePreferenceKey, "1");
        rearmWake();
      }
    });
  }
  // Zen mode = always listening: the wake word is forced on while chat is
  // hidden, regardless of the manual wake toggle.
  useEffect(() => {
    if (wakeOwnedByHost()) return;
    if (chatMode !== "off") return;
    import("../lib/wakeword").then((m) => {
      if (!m.wakeSupported() || liveRef.current) return;
      m.startWake(onWake, (listening) => setWake(listening), onWakeDetected);
      setWake(true);
    });
    return () => {
      if (!wakeIsEnabled()) {
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
      const body = JSON.stringify({ path: "ui:setLiveOn", args: { client: me.current, on: false } });
      void viewerFetch("/api/client-mutation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        keepalive: true,
      }).catch(() => {});
    };
    window.addEventListener("pagehide", bye);
    return () => window.removeEventListener("pagehide", bye);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!embedded || !activeThreadReady) return;
    const receiveHostMessage = (event: MessageEvent) => {
      if (event.source !== window.parent) return;
      const message = event.data ?? {};
      if (message.jarvis === "host-show") setChatMode("off", false);
      if (message.jarvis === "host-hide" && liveRef.current) void toggleLive();
      if (message.jarvis === "host-wake-state") setWake(message.listening === true);
      if ((message.jarvis === "host-context" || message.jarvis === "context-response") && message.context) {
        hostContextRef.current = message.context as JarvisHostContext;
      }
      if (message.jarvis === "host-action-result" && typeof message.id === "string") {
        const finish = hostActionWaiters.current.get(message.id);
        if (finish) {
          hostActionWaiters.current.delete(message.id);
          finish({ ok: message.ok === true, detail: typeof message.detail === "string" ? message.detail : undefined });
        }
      }
      if (message.jarvis === "host-interrupt") stopTalking();
      if (message.jarvis === "host-wake-detected") {
        setWake(true);
        setChatMode("off", false);
        showCaption({ who: "you", text: "Listening…" });
        unlockSpeechPlayback();
        void import("../lib/tts").then((module) => module.warm());
      }
      if (message.jarvis === "host-transcript" && typeof message.text === "string") {
        const transcript = message.text.trim().slice(0, 4000);
        if (transcript) showCaption({ who: "you", text: transcript });
      }
      if (message.jarvis === "host-command" && typeof message.text === "string") {
        const command = message.text.trim().slice(0, 4000);
        if (command) {
          setWake(false);
          setChatMode("off", false);
          submitEntryCommand(command);
        }
      }
    };
    window.addEventListener("message", receiveHostMessage);
    window.parent.postMessage({ jarvis: "ready" }, "*");
    return () => window.removeEventListener("message", receiveHostMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeThreadReady, embedded]);

  useEffect(() => {
    me.current = clientId();
  }, []);
  useEffect(() => {
    voiceRef.current = voiceRow ?? null;
    if (
      voiceRow
      && localVoiceLeaseUntilRef.current > 0
      && (
        voiceRow.value === me.current
        || voiceRow.updatedAt >= localVoiceClaimedAtRef.current - 2_000
      )
    ) {
      localVoiceLeaseUntilRef.current = 0;
    }
  }, [voiceRow]);
  const liveOnRef = useRef<{ value: string; updatedAt: number } | null>(null);
  useEffect(() => {
    liveOnRef.current = liveOnRow ?? null;
  }, [liveOnRow]);
  // A fresh live session anywhere = narrated TTS is forbidden everywhere.
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
    if (Date.now() < localVoiceLeaseUntilRef.current) return true;
    const v = voiceRef.current;
    if (v && Date.now() - v.updatedAt <= 3 * 60 * 1000) return v.value === me.current;
    try {
      return (await electVoice({ client: me.current })) !== false;
    } catch {
      return true; // convex hiccup: better one voice too many than silence
    }
  }

  async function narrateText(args: {
    text: string;
    claim: string;
    captionText?: string;
    final?: boolean;
  }): Promise<boolean> {
    const text = args.text.trim();
    const final = args.final !== false;
    const captionText = args.captionText ?? text;
    if (!text || !narrationLedgerRef.current.claim(args.claim)) return false;
    const finishWithoutSpeech = () => {
      if (!final) return;
      fadeCaption(captionText, 3_200);
      finishOneShotVoiceTurn();
    };
    if (document.hidden || (liveAnywhere() && !liveRef.current) || !(await ensureVoice())) {
      finishWithoutSpeech();
      return false;
    }
    const { speak } = await import("../lib/tts");
    await speak(
      text,
      (energy) => (energyRef.current = energy),
      () => {
        setSpeaking(true);
        setCaption((current) => current?.who === "jarvis" && current.text.length >= captionText.length
          ? { ...current, phase: "speaking", exiting: false }
          : { who: "jarvis", text: captionText, phase: "speaking", exiting: false });
      },
      () => {
        setSpeaking(false);
        if (final) {
          fadeCaption(captionText, 1_800);
          finishOneShotVoiceTurn();
        }
      },
    );
    return true;
  }

  const busy = sending || messages.some((m) => m.status === "pending" || (m.role === "assistant" && m.status === "streaming"));

  useEffect(() => {
    // scroll the message CONTAINER only — scrollIntoView reaches into the
    // (possibly translated-off-screen) chat panel and drags the whole PAGE
    // down with it on phones
    const box = endRef.current?.parentElement;
    if (box) box.scrollTo({ top: box.scrollHeight, behavior: "smooth" });
  }, [messages.length, messages[messages.length - 1]?.text, caption?.text]);

  useEffect(() => {
    void registerSW().then(() => {
      if (typeof Notification !== "undefined" && Notification.permission === "granted") {
        void subscribePush(saveSub).then(() => refreshPermissions());
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Self-healing: uncaught client errors feed the incident pipeline (max 3
  // distinct per session so an error storm can't spam it).
  useEffect(() => {
    const seen = new Set<string>();
    const report = (sig: string, msg: string) => {
      const stableSignature = normalizeIncidentSignature(sig);
      if (seen.size >= 3 || seen.has(stableSignature)) return;
      seen.add(stableSignature);
      void viewerFetch("/api/incident", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ signature: stableSignature, message: msg }),
      }).catch(() => {});
    };
    // A ChunkLoadError means this tab is holding HTML from a PREVIOUS deploy:
    // its hashed dynamic-import chunks (wakeword/tts/push/three…) were
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

  // Speak new finalized assistant messages with the one streamed neural voice.
  const lastSpokenThread = useRef<string>("");
  useEffect(() => {
    const latestAssistant = [...messages].reverse().find((message) => message.role === "assistant" && message.delivery !== "notification");
    if (latestAssistant?.status !== "streaming" || !latestAssistant.text) return;
    if (durableStartedAt.current !== null) {
      document.documentElement.dataset.jarvisFirstTokenMs = String(Math.max(0, Math.round(performance.now() - durableStartedAt.current)));
      durableStartedAt.current = null;
      setSending(false);
    }
    showCaption({ who: "jarvis", text: latestAssistant.text, phase: "streaming" });
    const stablePrefix = completeSpeechPrefix(latestAssistant.text);
    if (!stablePrefix) return;
    let streamState = streamingSpeechRef.current;
    if (streamState.id !== latestAssistant._id) {
      if (streamState.timer) clearTimeout(streamState.timer);
      streamState = {
        id: latestAssistant._id,
        queuedChars: 0,
        chain: Promise.resolve(),
        timer: null,
        pendingPrefix: "",
        pendingCaption: "",
      };
      streamingSpeechRef.current = streamState;
    }
    if (stablePrefix.length <= Math.max(streamState.queuedChars, streamState.pendingPrefix.length)) return;
    streamState.pendingPrefix = stablePrefix;
    streamState.pendingCaption = latestAssistant.text;
    if (streamState.timer) clearTimeout(streamState.timer);
    // Give a concise answer a fraction of a second to finalise. Most replies
    // then become one natural neural request rather than sentence-sized MP3s
    // with audible network/decode gaps. Long-running generations still begin
    // with their first stable paragraph instead of waiting indefinitely.
    streamState.timer = setTimeout(() => {
      const current = streamingSpeechRef.current;
      if (current.id !== latestAssistant._id) return;
      current.timer = null;
      const prefix = current.pendingPrefix;
      const from = current.queuedChars;
      if (prefix.length <= from) return;
      const speechChunk = prefix.slice(from).trim();
      current.pendingPrefix = "";
      current.queuedChars = prefix.length;
      if (!speechChunk) return;
      current.chain = current.chain.then(async () => {
        if (streamingSpeechRef.current.id !== latestAssistant._id) return;
        await narrateText({
          text: speechChunk,
          claim: narrationClaim(`turn:${latestAssistant._id}`, prefix, from, prefix.length),
          captionText: current.pendingCaption,
          final: false,
        });
      });
    }, 220);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);

  useEffect(() => {
    const last = [...messages].reverse().find((m) => m.role === "assistant" && m.delivery !== "notification" && m.status === "done" && m.text);
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
    if (!last.text) return;
    if (isToolGarbage(last.text) && !sanitizeAssistantText(last.text)) return;
    // never say the exact same thing twice in a row (root of "sends results twice")
    if (last.text === lastSpokenText.current.text && Date.now() - lastSpokenText.current.ts < 20_000) return;
    lastSpokenText.current = { text: last.text, ts: Date.now() };
    // Background findings never interrupt an active voice exchange. Normal
    // Codex replies do speak, then the turn-taking microphone re-arms.
    const spokenText = isToolGarbage(last.text) ? sanitizeAssistantText(last.text) : last.text;
    // Streaming and finalization use the same stable caption node. Put the
    // finished text there before voice ownership/model generation, so it never
    // vanishes during the TTS handoff or when this tab is not the speaker.
    showCaption({ who: "jarvis", text: spokenText, phase: "ready" });
    document.documentElement.dataset.jarvisFinalDeliveryMs = String(Math.round(performance.now()));
    (async () => {
      const streamed = streamingSpeechRef.current.id === last._id ? streamingSpeechRef.current : null;
      if (streamed?.timer) {
        clearTimeout(streamed.timer);
        streamed.timer = null;
        streamed.pendingPrefix = "";
      }
      if (streamed) await streamed.chain;
      const from = streamed?.queuedChars ?? 0;
      const unsaidText = spokenText.slice(from).trim();
      if (!unsaidText) {
        setSpeaking(false);
        fadeCaption(spokenText, 1800);
        finishOneShotVoiceTurn();
        return;
      }
      await narrateText({
        text: unsaidText,
        claim: narrationClaim(`turn:${last._id}`, spokenText, from, spokenText.length),
        captionText: spokenText,
      });
    })();
  }, [messages]);

  useEffect(() => () => {
    if (streamingSpeechRef.current.timer) clearTimeout(streamingSpeechRef.current.timer);
  }, []);

  async function requestHostContext(): Promise<JarvisHostContext | null> {
    if (!embedded || window.parent === window) return null;
    const id = `jarvis-context-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return new Promise((resolve) => {
      const finish = (context: JarvisHostContext | null) => {
        window.removeEventListener("message", receive);
        window.clearTimeout(timer);
        if (context) hostContextRef.current = context;
        resolve(context);
      };
      const receive = (event: MessageEvent) => {
        if (event.source !== window.parent) return;
        const message = event.data ?? {};
        if (message.jarvis !== "context-response" || message.id !== id) return;
        finish(message.context as JarvisHostContext);
      };
      const timer = window.setTimeout(() => finish(hostContextRef.current), 120);
      window.addEventListener("message", receive);
      window.parent.postMessage({ jarvis: "context-request", id }, "*");
    });
  }

  async function sendHostAction(action: JarvisHostAction): Promise<HostActionResult> {
    if (!embedded || window.parent === window) return { ok: false, detail: "No host page is connected." };
    if (!hostContextRef.current?.hostId) await requestHostContext();
    const id = globalThis.crypto?.randomUUID?.() ?? `host-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const payload: JarvisHostAction = {
      ...action,
      id,
      hostId: action.hostId ?? hostContextRef.current?.hostId,
      expectedUrl: action.expectedUrl ?? hostContextRef.current?.url,
    };
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        hostActionWaiters.current.delete(id);
        resolve({ ok: false, detail: "The host page did not acknowledge the action." });
      }, 1_200);
      hostActionWaiters.current.set(id, (result) => {
        window.clearTimeout(timer);
        resolve(result);
      });
      window.parent.postMessage({ jarvis: "host-action", action: payload }, "*");
    });
  }

  async function queueDurableTurn(text: string, visibleText = text) {
    durableStartedAt.current = performance.now();
    setSending(true);
    showCaption({ who: "you", text: visibleText });
    try {
      const response = await viewerFetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          threadId: threadRef.current,
          text,
          requestId: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        }),
      });
      if (!response.ok) throw new Error(`conversation queue rejected (${response.status})`);
      // The streaming-message effect owns `sending=false`. Keeping it true
      // closes the old request/subscription gap where the orb flashed idle.
      return;
    } catch (error) {
      durableStartedAt.current = null;
      document.documentElement.dataset.jarvisConversationFailure = String(error).slice(0, 160);
      showCaption({
        who: "jarvis",
        text: "I heard you, but the conversation line failed. Please say that once more.",
        phase: "ready",
      });
      setSending(false);
    }
  }

  async function openFastAgentDispatch(intent: FastAgentDispatch, requestedText: string) {
    const narrationId = `dispatch:${Date.now()}`;
    const owner = intent.agentId
      ? ({ paul: "Paul", atlas: "Atlas", iris: "Iris", maya: "Maya", sentry: "Sentry" } as const)[intent.agentId]
      : "the right specialist";
    document.documentElement.dataset.jarvisFirstTokenMs = "0";
    setSending(true);
    showCaption({ who: "you", text: requestedText });
    showCaption({ who: "jarvis", text: `Assigning ${owner}…`, phase: "streaming" });
    try {
      const response = await viewerFetch("/api/tools", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "dispatch_agent",
          args: { task: intent.task, agent_id: intent.agentId },
        }),
      });
      const body = await response.json().catch(() => null);
      const result = String(body?.result ?? "");
      if (!response.ok || !result || /^(?:Tool failed|Tool unavailable|Give me)/i.test(result)) {
        throw new Error(result || "dispatch unavailable");
      }
      const assigned = result.match(/^(Paul|Atlas|Iris|Maya|Sentry)\b/)?.[1] ?? owner;
      const awaitingApproval = /consequential|Needs you|will not execute/i.test(result);
      const reply = awaitingApproval
        ? `${assigned} has the plan ready, but it needs your approval in the work card before anything consequential happens.`
        : `${assigned} is on it. The work is live, and I’m still right here with you.`;
      updateConversationMood(reply);
      lastSpokenText.current = { text: reply, ts: Date.now() };
      showCaption({ who: "jarvis", text: reply, phase: "ready" });
      void logTurn({ threadId: threadRef.current, role: "user", text: requestedText });
      void logTurn({ threadId: threadRef.current, role: "assistant", text: reply, model: "instant-dispatch" });
      await narrateText({ text: reply, claim: narrationClaim(narrationId, reply), captionText: reply });
    } catch {
      showCaption({ who: "jarvis", text: "The fast handoff slipped. I’m retrying it through the durable lane now." });
      await queueDurableTurn(requestedText);
    } finally {
      setSending(false);
    }
  }

  const fastChartRequest = useRef(0);
  async function openFastChart(intent: FastChartIntent, requestedText: string) {
    const request = ++fastChartRequest.current;
    const title = `${intent.asset.toUpperCase()} · ${intent.interval}`;
    const loading: StagePanel = {
      type: "widget",
      title,
      updatedAt: Date.now(),
      value: JSON.stringify({ kind: "chart_loading", asset: intent.asset.toUpperCase(), interval: intent.interval }),
    };
    document.documentElement.dataset.jarvisFirstTokenMs = "0";
    document.documentElement.dataset.jarvisOverlayStartMs = String(performance.now());
    setSending(true);
    setPanelMin(false);
    setInstantPanel(loading);
    showCaption({ who: "you", text: requestedText });
    if (chatModeRef.current === "full") setChatMode("bar", false);
    try {
      const response = await viewerFetch(`/api/market-chart?asset=${encodeURIComponent(intent.asset)}&interval=${intent.interval}`, {
        cache: "no-store",
        headers: { accept: "application/json" },
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body?.widget) throw new Error("market data unavailable");
      if (request !== fastChartRequest.current) return;
      const widget = body.widget as { asset?: string; changePct?: number };
      const ready: StagePanel = { type: "widget", title, value: JSON.stringify(widget), updatedAt: Date.now() };
      setInstantPanel(ready);
      void setPanel({ type: ready.type, value: ready.value, title: ready.title });
      const direction = Number(widget.changePct) >= 0 ? "up" : "down";
      const reply = `${widget.asset ?? intent.asset.toUpperCase()} chart is live — ${direction} ${Math.abs(Number(widget.changePct ?? 0)).toFixed(2)}% on the latest ${intent.interval} candle.`;
      updateConversationMood(reply);
      lastSpokenText.current = { text: reply, ts: Date.now() };
      void logTurn({ threadId: threadRef.current, role: "user", text: requestedText });
      void logTurn({ threadId: threadRef.current, role: "assistant", text: reply, model: "instant" });
      showCaption({ who: "jarvis", text: reply, phase: "ready" });
      await narrateText({
        text: reply,
        claim: narrationClaim(`chart:${request}`, reply),
        captionText: reply,
      });
    } catch {
      if (request !== fastChartRequest.current) return;
      setInstantPanel(null);
      showCaption({ who: "jarvis", text: "The live feed slipped. I’m getting the full market read." });
      await queueDurableTurn(requestedText);
    } finally {
      if (request === fastChartRequest.current) setSending(false);
    }
  }

  const fastNetWorthRequest = useRef(0);
  async function openFastNetWorth(intent: FastNetWorthIntent, requestedText: string) {
    const request = ++fastNetWorthRequest.current;
    const loading: StagePanel = {
      type: "widget",
      title: "Net worth",
      updatedAt: Date.now(),
      value: JSON.stringify({ kind: "net_worth_loading" }),
    };
    document.documentElement.dataset.jarvisFirstTokenMs = "0";
    document.documentElement.dataset.jarvisOverlayStartMs = String(performance.now());
    setSending(true);
    setPanelMin(false);
    setInstantPanel(loading);
    showCaption({ who: "you", text: requestedText });
    if (chatModeRef.current === "full") setChatMode("bar", false);
    try {
      const response = await viewerFetch("/api/tools", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "net_worth", args: {} }),
      });
      const body = await response.json().catch(() => null);
      const result = String(body?.result ?? "");
      if (!response.ok || !result || /^(Tool failed|Couldn't reach)/i.test(result)) throw new Error("wealth data unavailable");
      if (request !== fastNetWorthRequest.current) return;
      // executeTool has already published the real animated stats widget to
      // Convex. Reveal that canonical panel instead of maintaining a second
      // client-side copy of financial data.
      setInstantPanel(null);
      if (intent.requiresAnalysis) {
        await queueDurableTurn(requestedText);
        return;
      }
      const detail = result.match(/Net worth dashboard on screen:\s*(.+?)\.\s*One-line/i)?.[1]
        ?? result.replace(/One-line takeaway only\.?/i, "").trim();
      const reply = detail ? `Your net worth is ${detail}.` : "Your live net-worth dashboard is open.";
      updateConversationMood(reply);
      lastSpokenText.current = { text: reply, ts: Date.now() };
      void logTurn({ threadId: threadRef.current, role: "user", text: requestedText });
      void logTurn({ threadId: threadRef.current, role: "assistant", text: reply, model: "instant-tool" });
      showCaption({ who: "jarvis", text: reply, phase: "ready" });
      await narrateText({
        text: reply,
        claim: narrationClaim(`net-worth:${request}`, reply),
        captionText: reply,
      });
    } catch {
      if (request !== fastNetWorthRequest.current) return;
      setInstantPanel(null);
      showCaption({ who: "jarvis", text: "The wealth ledger did not answer. I’m tracing it through the full work lane." });
      await queueDurableTurn(requestedText);
    } finally {
      if (request === fastNetWorthRequest.current) setSending(false);
    }
  }

  async function submit(text: string) {
    const t = text.trim();
    if (!t) return;
    // Typed/button calls reach this inside a user gesture. Live/STT calls have
    // already been primed by the control that opened the microphone.
    unlockSpeechPlayback();
    // double-tap / Enter+click within 2.5s = one send, not two
    if (t === lastSent.current.text && Date.now() - lastSent.current.ts < 2500) return;
    lastSent.current = { text: t, ts: Date.now() };
    if (streamingSpeechRef.current.timer) clearTimeout(streamingSpeechRef.current.timer);
    streamingSpeechRef.current = {
      id: "",
      queuedChars: 0,
      chain: Promise.resolve(),
      timer: null,
      pendingPrefix: "",
      pendingCaption: "",
    };
    updateConversationMood(t);
    void ownVoice();
    // A new request is an immediate barge-in. Cancel queued/playback state
    // before doing anything else; worker inference may finish in the
    // background, but its stale result is discarded by the generation gate.
    void import("../lib/tts").then((m) => {
      m.stopSpeaking();
      void m.warm();
    });
    setSpeaking(false);
    setInput("");
    const embeddedHostIntent = embedded ? parseEmbeddedHostIntent(t) : null;
    if (embeddedHostIntent) {
      showCaption({ who: "you", text: t });
      const result = await sendHostAction(embeddedHostIntent.action);
      if (result.ok) {
        const reply = result.detail || embeddedHostIntent.reply;
        document.documentElement.dataset.jarvisFirstTokenMs = "0";
        lastSpokenText.current = { text: reply, ts: Date.now() };
        updateConversationMood(reply);
        showCaption({ who: "jarvis", text: reply, phase: "ready" });
        void logTurn({ threadId: threadRef.current, role: "user", text: t })
          .then(() => logTurn({ threadId: threadRef.current, role: "assistant", text: reply, model: "instant-host" }))
          .catch(() => {});
        await narrateText({
          text: reply,
          claim: narrationClaim(`host:${lastSent.current.ts}`, reply),
          captionText: reply,
        });
        return;
      }
      // If the parent cannot fulfil a fast path, let the full model inspect its
      // inventory and choose a grounded fallback rather than claiming success.
    }
    // A playing video shrinks to picture-in-picture (keeps playing). A genuine
    // follow-up keeps the current visual; a topic switch clears it immediately
    // instead of leaving a stale chart/widget behind while the next turn runs.
    if (panel?.type === "video") setVideoPip(true);
    else if (panel && !isPanelFollowUp(t, panel)) {
      closedPanelRef.current = {
        key: `${panel.title ?? ""}|${panel.value.slice(0, 160)}`,
        ts: Date.now(),
      };
      setInstantPanel(null);
      setPanelFull(false);
      setPanelMin(true); // hide locally during the authenticated clear round-trip
      void clearPanel({});
    }
    const fastDispatch = parseFastAgentDispatch(t);
    if (fastDispatch) {
      void openFastAgentDispatch(fastDispatch, t);
      return;
    }
    const fastChart = !liveRef.current ? parseFastChartIntent(t) : null;
    if (fastChart) {
      void openFastChart(fastChart, t);
      return;
    }
    const fastNetWorth = parseFastNetWorthIntent(t);
    if (fastNetWorth) {
      void openFastNetWorth(fastNetWorth, t);
      return;
    }
    const instant = instantSocialReply(t);
    if (instant) {
      document.documentElement.dataset.jarvisFirstTokenMs = "0";
      lastSpokenText.current = { text: instant, ts: Date.now() };
      showCaption({ who: "you", text: t });
      updateConversationMood(instant);
      showCaption({ who: "jarvis", text: instant, phase: "ready" });
      // Persistence is bookkeeping, never part of the live response path.
      void logTurn({ threadId: threadRef.current, role: "user", text: t })
        .then(() => logTurn({ threadId: threadRef.current, role: "assistant", text: instant, model: "instant" }))
        .catch(() => {});
      void (async () => {
        await narrateText({
          text: instant,
          claim: narrationClaim(`instant:${lastSent.current.ts}`, instant),
          captionText: instant,
        });
      })();
      return;
    }
    let modelText = t;
    if (embedded) {
      const context = await requestHostContext();
      if (context) {
        const bounded = needsHostContext(t)
          ? context
          : { ...context, selection: undefined, text: undefined };
        modelText = withHostContext(t, bounded);
      }
    }
    await queueDurableTurn(modelText, t);
  }

  function stopTalking() {
    import("../lib/tts").then((m) => m.stopSpeaking());
    setSpeaking(false);
    ttsQuietUntilRef.current = Date.now() + 120;
    if (freeLoop.current) {
      showCaption({ who: "you", text: "Listening…" });
      scheduleFreeVoiceTurn(120);
    }
  }

  useEffect(() => {
    const interrupt = (event: KeyboardEvent) => {
      if (event.key === "Escape" && speakingRef.current) stopTalking();
    };
    window.addEventListener("keydown", interrupt);
    return () => window.removeEventListener("keydown", interrupt);
    // The interruption path is ref-backed and intentionally stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const liveBeat = useRef<ReturnType<typeof setInterval> | null>(null);
  const freeLoop = useRef(false);
  const freeBusy = useRef(false);
  const freeRearmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function finishOneShotVoiceTurn() {
    if (!freeLoop.current || liveRef.current) return;
    freeLoop.current = false;
    cancelFreeRearm();
    closePersistentLiveMic();
    window.setTimeout(rearmWake, 650);
  }
  async function ensurePersistentLiveMic() {
    const current = liveMicRef.current;
    if (current && current.stream.getAudioTracks().some((track) => track.readyState === "live")) return current;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        // AGC amplifies residual loudspeaker echo and turns it into false VAD.
        autoGainControl: false,
        channelCount: 1,
      },
    });
    // Wake-word/live sessions can begin without a fresh click. Once capture
    // is active browsers permit media playback, so prime the neural player
    // here and keep the later response out of the autoplay dead end.
    unlockSpeechPlayback();
    const context = new AudioContext({ latencyHint: "interactive" });
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.35;
    context.createMediaStreamSource(stream).connect(analyser);
    const resources = { stream, context, analyser };
    liveMicRef.current = resources;
    return resources;
  }
  function closePersistentLiveMic() {
    liveSessionEpoch.current += 1;
    sttAbortRef.current?.abort();
    sttAbortRef.current = null;
    const resources = liveMicRef.current;
    liveMicRef.current = null;
    resources?.stream.getTracks().forEach((track) => track.stop());
    void resources?.context.close().catch(() => {});
    recRef.current = null;
  }
  function cancelFreeRearm() {
    if (freeRearmTimer.current) clearTimeout(freeRearmTimer.current);
    freeRearmTimer.current = null;
  }
  function scheduleFreeVoiceTurn(delayMs = 300) {
    cancelFreeRearm();
    freeRearmTimer.current = setTimeout(() => {
      freeRearmTimer.current = null;
      if (freeLoop.current) void freeVoiceTurn();
    }, delayMs);
  }
  function releaseLive() {
    cancelFreeRearm();
    closePersistentLiveMic();
    if (liveBeat.current) clearInterval(liveBeat.current);
    liveBeat.current = null;
    captionRef.current = null;
    void setLiveOn({ client: me.current, on: false }).catch(() => {});
  }

  function endFreeVoiceSession() {
    freeLoop.current = false;
    cancelFreeRearm();
    if (liveRef.current) {
      liveRef.current = false;
      setLive("off");
      releaseLive();
    } else {
      closePersistentLiveMic();
    }
    rearmWake();
  }

  async function toggleLive(forceStart = false, captureImmediately = true): Promise<boolean> {
    if (!forceStart && (liveRef.current || live !== "off")) {
      freeLoop.current = false;
      cancelFreeRearm();
      if (recRef.current?.state === "recording") recRef.current.stop();
      liveRef.current = false;
      setLive("off");
      setCaption(null);
      releaseLive();
      rearmWake();
      return false;
    }
    if (liveRef.current) return true;
    // Stop the browser wake recognizer and open the persistent stream before a
    // network round-trip. Otherwise the wake mic visibly closes while Convex
    // elects the live owner, then opens again a moment later.
    const { stopWake } = await import("../lib/wakeword");
    stopWake();
    setWake(false);
    freeLoop.current = true;
    liveRef.current = true;
    setLive("connecting");
    const microphone = ensurePersistentLiveMic().then(() => true, () => false);
    const ownership = setLiveOn({ client: me.current, on: true }).catch(() => true);
    const owned = await ownership;
    if (owned === false) {
      freeLoop.current = false;
      liveRef.current = false;
      setLive("off");
      closePersistentLiveMic();
      showCaption({ who: "jarvis", text: "Jarvis is already live on another device." });
      rearmWake();
      return false;
    }
    if (!(await microphone)) {
      freeLoop.current = false;
      liveRef.current = false;
      setLive("off");
      releaseLive();
      showCaption({ who: "jarvis", text: "I could not open this microphone. Check its browser permission." });
      rearmWake();
      return false;
    }
    void ownVoice();
    import("../lib/tts").then((m) => m.stopSpeaking());
    setLive("live");
    void refreshPermissions();
    if (liveBeat.current) clearInterval(liveBeat.current);
    liveBeat.current = setInterval(() => void setLiveOn({ client: me.current, on: true }).catch(() => {}), 20_000);
    if (captureImmediately) void freeVoiceTurn();
    return true;
  }

  useEffect(() => () => {
    cancelFreeRearm();
    closePersistentLiveMic();
  }, []);

  async function enableDevicePermissions() {
    if (permissionBusy) return;
    setPermissionBusy(true);
    // Both permission-gated calls begin in the same click. The browser owns
    // the durable decision; Jarvis only records and displays the real state.
    const [microphone, push] = await Promise.all([
      primeMicrophone().catch(() => "prompt" as const),
      subscribePush(saveSub).catch(() => "failed"),
    ]).finally(() => setPermissionBusy(false));
    await refreshPermissions().catch(() => undefined);
    if (microphone === "granted") {
      setPref("liveDefault", true);
      liveAutoStarted.current = true;
      if (!liveRef.current && live === "off") void toggleLive(true);
    }
    if (microphone === "denied" || push === "denied") {
      alert("One permission is blocked. Open this site's browser settings to re-enable microphone or notifications.");
    } else if (push === "unsupported") {
      alert("Voice is ready. For notifications on iPhone, add JARVIS to the Home Screen and open it there once.");
    } else if (push === "failed" || push === "no-key") {
      alert("Voice is ready, but browser alerts could not be configured yet.");
    }
  }

  useEffect(() => {
    if (embedded || !prefs.liveDefault || permissions.microphone !== "granted" || liveAutoStarted.current) return;
    liveAutoStarted.current = true;
    const timer = window.setTimeout(() => {
      if (!liveRef.current) void toggleLive(true);
    }, 450);
    return () => window.clearTimeout(timer);
    // This is intentionally a once-per-load boot. Stopping live mode manually
    // must not cause the next render to reopen the microphone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [embedded, prefs.liveDefault, permissions.microphone]);

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
      const r = await viewerFetch("/api/see", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ image, question: q, mode: "camera" }),
      });
      const { imageUrl } = await r.json();
      if (imageUrl) {
        setInput("");
        void submit(
          `${q || "Tell me what this is and anything useful about it. Read all relevant visible text."} [JARVIS_IMAGE_URL:${imageUrl}]`,
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
      const r = await viewerFetch("/api/see", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ image, question: q }),
      });
      const { imageUrl } = await r.json();
      if (imageUrl) {
        void submit(
          `${q || "Tell me what is on my screen and help with what looks important."} [JARVIS_IMAGE_URL:${imageUrl}]`,
        );
      }
    } catch {
      /* user cancelled the picker */
    }
    setSeeing(false);
  }

  // One persistent, full-duplex microphone session. MediaRecorder windows turn
  // the continuous stream into utterances, but the physical device remains
  // open. This avoids the browser permission/audio-stack churn that used to
  // make the mic blink every few seconds and lets Daniel interrupt speech.
  async function freeVoiceTurn() {
    if (freeBusy.current || !freeLoop.current) return;
    const beforeCapture = Date.now();
    if (shouldDeferLiveCapture({
      ttsActive: speakingRef.current || isTtsActuallySpeaking(),
      now: beforeCapture,
      quietUntil: ttsQuietUntilRef.current,
      keyboardQuietUntil: keyboardQuietUntilRef.current,
    })) {
      // The physical stream stays open. Only the utterance recorder is held
      // back, so Jarvis cannot transcribe his own output or a keyboard burst.
      scheduleFreeVoiceTurn(180);
      return;
    }
    freeBusy.current = true;
    const sessionEpoch = liveSessionEpoch.current;
    let outcome: VoiceCaptureOutcome = "failure";
    let pendingSttController: AbortController | null = null;
    try {
      void ownVoice();
      const { stream, context, analyser } = await ensurePersistentLiveMic();
      if (!freeLoop.current || sessionEpoch !== liveSessionEpoch.current) return;
      if (context.state === "suspended") await context.resume().catch(() => undefined);
      import("../lib/tts").then((m) => m.warm());
      const buf = new Uint8Array(analyser.frequencyBinCount);
      const mime = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "audio/mp4";
      const rec = new MediaRecorder(stream, { mimeType: mime });
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      const requestTranscript = async (
        blob: Blob,
        controller: AbortController,
        evidence: LiveVadState,
      ): Promise<string> => {
        const speechSpanMs = evidence.voiceStartedAt
          ? Math.max(0, evidence.lastVoice - evidence.voiceStartedAt)
          : 0;
        const response = await viewerFetch("/api/stt", {
          method: "POST",
          headers: {
            "content-type": mime,
            "x-jarvis-continuous-live": "1",
            "x-jarvis-voice-frames": String(evidence.acceptedFrames),
            "x-jarvis-speech-span-ms": String(Math.round(speechSpanMs)),
            "x-jarvis-peak-voice-margin": String(Math.round(evidence.peakVoiceMargin * 10) / 10),
          },
          body: blob,
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`STT failed (${response.status})`);
        const payload = await response.json();
        return String(payload?.text ?? "").trim();
      };
      recRef.current = rec;
      const t0 = Date.now();
      let vad = createLiveVadState(t0);
      const prefetch = {
        lastVoice: -1,
        promise: null as Promise<{ text: string; lastVoice: number } | null> | null,
      };
      let listeningCaptionShown = false;
      let ttsWasActive = speakingRef.current || isTtsActuallySpeaking();
      let contaminatedByOutput = false;
      const poll = setInterval(() => {
        analyser.getByteFrequencyData(buf);
        const level = buf.reduce((a, b) => a + b, 0) / buf.length;
        const voiceLevel = spectrumBandLevel(buf, context.sampleRate, 90, 3_800);
        const highFrequencyLevel = spectrumBandLevel(buf, context.sampleRate, 4_500, 10_000);
        const now = Date.now();
        const ttsActive = speakingRef.current || isTtsActuallySpeaking();
        if (ttsActive) {
          contaminatedByOutput = true;
          ttsQuietUntilRef.current = Math.max(ttsQuietUntilRef.current, now + LIVE_SPEAKER_TAIL_MS);
          clearInterval(poll);
          if (rec.state === "recording") rec.stop();
          return;
        }
        if (ttsWasActive && !ttsActive) {
          ttsQuietUntilRef.current = Math.max(ttsQuietUntilRef.current, now + LIVE_SPEAKER_TAIL_MS);
        }
        ttsWasActive = ttsActive;
        const result = advanceLiveVad(vad, {
          level,
          voiceLevel,
          highFrequencyLevel,
          now,
          startedAt: t0,
          ttsActive,
          quietUntil: Math.max(ttsQuietUntilRef.current, keyboardQuietUntilRef.current),
        });
        vad = result.state;
        if (result.acceptedSpeech) {
          if (prefetch.lastVoice >= 0 && vad.lastVoice !== prefetch.lastVoice) {
            pendingSttController?.abort();
            pendingSttController = null;
            prefetch.promise = null;
            prefetch.lastVoice = -1;
          }
          energyRef.current = Math.min(1, level / 90);
          if (!listeningCaptionShown) {
            listeningCaptionShown = true;
            showCaption({ who: "you", text: "Listening…" });
          }
        }
        if (shouldPrefetchLiveTranscript(vad, now, prefetch.lastVoice)) {
          const lastVoice = vad.lastVoice;
          prefetch.lastVoice = lastVoice;
          const flushRecorder = new Promise<void>((resolve) => {
            let settled = false;
            const finish = () => {
              if (settled) return;
              settled = true;
              rec.removeEventListener("dataavailable", finish);
              resolve();
            };
            rec.addEventListener("dataavailable", finish, { once: true });
            try { rec.requestData(); } catch { finish(); }
            window.setTimeout(finish, 120);
          });
          void flushRecorder.then(() => {
            if (
              rec.state !== "recording"
              || !freeLoop.current
              || sessionEpoch !== liveSessionEpoch.current
              || vad.lastVoice !== lastVoice
            ) return;
            const partial = new Blob([...chunks], { type: mime });
            if (partial.size < 2000) return;
            const controller = new AbortController();
            pendingSttController = controller;
            sttAbortRef.current?.abort();
            sttAbortRef.current = controller;
            prefetch.promise = requestTranscript(partial, controller, { ...vad })
              .then((text) => ({ text, lastVoice }), () => null)
              .finally(() => {
                if (sttAbortRef.current === controller) sttAbortRef.current = null;
                if (pendingSttController === controller) pendingSttController = null;
              });
          });
        }
        if (result.bargeIn) {
          void import("../lib/tts").then((m) => m.stopSpeaking());
          setSpeaking(false);
        }
        if (shouldCloseLiveUtterance(vad, now) || (!vad.spoke && now - t0 > 8000) || now - t0 > 25_000) {
          clearInterval(poll);
          if (rec.state === "recording") rec.stop();
        }
      }, 90);
      await new Promise<void>((resolve) => {
        rec.onstop = () => resolve();
        rec.start(250);
      });
      clearInterval(poll);
      energyRef.current = 0;
      if (!freeLoop.current || sessionEpoch !== liveSessionEpoch.current) {
        outcome = "empty";
        return;
      }
      if (contaminatedByOutput || lastKeyboardActivityRef.current >= t0) {
        outcome = contaminatedByOutput ? "echo" : "empty";
        return;
      }
      const blob = new Blob(chunks, { type: mime });
      if (!vad.spoke || blob.size < 2000) {
        outcome = "silence";
        return;
      }
      const speechClosedAt = performance.now();
      document.documentElement.dataset.jarvisSpeechClosedMs = String(Math.round(speechClosedAt));
      showCaption({ who: "you", text: "Processing…" });
      const pendingPrefetch = prefetch.promise;
      const prefetched = pendingPrefetch && prefetch.lastVoice === vad.lastVoice
        ? await pendingPrefetch
        : null;
      let text = prefetched?.text ?? "";
      if (!text) {
        const controller = new AbortController();
        pendingSttController = controller;
        sttAbortRef.current?.abort();
        sttAbortRef.current = controller;
        text = await requestTranscript(blob, controller, { ...vad });
        if (sttAbortRef.current === controller) sttAbortRef.current = null;
        if (pendingSttController === controller) pendingSttController = null;
      }
      if (!freeLoop.current || sessionEpoch !== liveSessionEpoch.current) {
        outcome = "empty";
        return;
      }
      const { isEchoOfTts } = await import("../lib/tts");
      const cleanedText = text.trim();
      if (!isMeaningfulSpeechTranscript(cleanedText)) {
        outcome = "empty";
        return;
      }
      if (shouldIgnoreHandsFreeTranscript(cleanedText, {
        acceptedFrames: vad.acceptedFrames,
        speechSpanMs: vad.voiceStartedAt ? Math.max(0, vad.lastVoice - vad.voiceStartedAt) : 0,
        peakVoiceMargin: vad.peakVoiceMargin,
      })) {
        outcome = "empty";
        return;
      }
      if (isEchoOfTts(cleanedText)) {
        outcome = "echo";
        return;
      }
      const previousVoice = lastVoiceInput.current;
      if (isRecentVoiceDuplicate(cleanedText, previousVoice)) {
        outcome = "empty";
        return;
      }
      lastVoiceInput.current = { text: cleanedText, at: Date.now() };
      document.documentElement.dataset.jarvisTranscriptionMs = String(Math.round(performance.now() - speechClosedAt));
      showCaption({ who: "you", text: cleanedText });
      outcome = "speech";
      void submit(cleanedText);
    } catch (error) {
      const aborted = error instanceof DOMException && error.name === "AbortError";
      outcome = aborted ? "empty" : "failure";
      if (!aborted) {
        document.documentElement.dataset.jarvisVoiceRecovery = String(error).slice(0, 160);
        closePersistentLiveMic();
      }
    } finally {
      pendingSttController?.abort();
      recRef.current = null;
      energyRef.current = 0;
      freeBusy.current = false;
      const action = nextVoiceLoopAction({
        outcome,
        persistentLive: liveRef.current,
        loopRequested: freeLoop.current,
      });
      if (action === "listen") scheduleFreeVoiceTurn(outcome === "speech" ? 90 : outcome === "failure" ? 900 : 180);
      else if (action === "stop") endFreeVoiceSession();
    }
  }

  async function toggleMic() {
    // Live mode already owns one continuous stream. Never layer a second
    // one-shot recorder on top of it or let this control flicker per window.
    if (liveRef.current) return;
    if (recording) {
      recRef.current?.stop();
      return;
    }
    // barge-in: JARVIS shuts up the moment Daniel reaches for the mic, so the
    // recording can't capture his voice as input
    import("../lib/tts").then((m) => m.stopSpeaking());
    setSpeaking(false);
    void ownVoice();
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      unlockSpeechPlayback();
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
        const r = await viewerFetch("/api/stt", { method: "POST", headers: { "content-type": mime }, body: blob });
        const { text } = await r.json();
        if (isMeaningfulSpeechTranscript(text?.trim() ?? "")) {
          const { isEchoOfTts } = await import("../lib/tts");
          if (isEchoOfTts(text)) return; // that was JARVIS's own voice leaking in
          const cleaned = text.trim();
          const previousVoice = lastVoiceInput.current;
          if (isRecentVoiceDuplicate(cleaned, previousVoice)) return;
          lastVoiceInput.current = { text: cleaned, at: Date.now() };
          void submit(cleaned);
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
  // A deliberately opened visual owns the stage even while durable work is
  // running. The compact work widget stays live underneath and returns when
  // the visual is folded/closed; it must never suppress boards or the library.
  const overlayUp = !!panel && !panelMin;
  const fullBleed = overlayUp && (panelFull || !panelRoute?.keepOrbVisible);
  const compactAside = overlayUp && !fullBleed && panel!.type !== "video";

  if (embedded) {
    return (
      <div
        data-jarvis-embed-surface
        data-voice-state={orbState}
        className="relative h-dvh w-full overflow-hidden bg-transparent"
      >
        <button
          type="button"
          onClick={() => {
            if (liveRef.current) void toggleLive();
            window.parent.postMessage({ jarvis: "hide" }, "*");
          }}
          aria-label="Close Jarvis"
          className="absolute right-3 top-3 z-40 grid h-8 w-8 place-items-center rounded-full text-lg text-white/35 transition hover:bg-white/[0.06] hover:text-cyan"
        >
          ×
        </button>
        <div className="absolute inset-0">
          <ReactorRing
            active={live === "live" || orbState === "thinking" || orbState === "listening"}
            aside={false}
            hidden={false}
            motionRef={orbMotionRef}
            reduceMotion={prefs.reduceMotion}
          />
          <ThreeOrb
            state={orbState}
            energyRef={energyRef}
            moodColor={moodColor}
            motionRef={orbMotionRef}
            reduceMotion={prefs.reduceMotion}
          />
          <button
            type="button"
            aria-label={speaking ? "Interrupt Jarvis" : live === "live" ? "Stop Jarvis live listening" : "Start Jarvis live listening"}
            title={speaking ? "Tap to interrupt" : live === "live" ? "Tap to stop listening" : "Tap to start listening"}
            onClick={() => speaking ? stopTalking() : void toggleLive()}
            className="absolute inset-[20%] z-20 rounded-full bg-transparent"
          />
          {caption && (
            <div className="pointer-events-none absolute inset-x-2 top-[67%] z-30 flex justify-center px-3">
              <SpokenCaption caption={caption} />
            </div>
          )}
          <span className="sr-only" aria-live="polite">Jarvis is {status}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      {/* top HUD strip */}
      <header className="flex items-center justify-between gap-2 px-3 pb-2 pt-3 sm:px-5 sm:pt-4">
        <div className="flex min-w-0 items-baseline gap-2 sm:gap-3">
          <h1 className="font-display shrink-0 text-lg font-bold tracking-[0.32em] text-green-400 sm:text-xl sm:tracking-[0.42em]" style={{ fontFamily: "var(--font-chakra)" }}>
            JARVIS
          </h1>
          <span className="hud-label hidden sm:inline">personal ai · online</span>
        </div>
        <div className="flex min-w-0 items-center gap-2 sm:gap-4">
          <span className="flex items-center gap-1.5">
            <span className={`h-1.5 w-1.5 rounded-full ${live === "live" ? "bg-cyan" : "bg-emerald-400"} breathe`} />
            <span className="hud-label">{status}</span>
          </span>
          <button
            onClick={toggleWake}
            title={wake ? "standby on — say 'hey Jarvis'" : "enable wake word"}
            className={`hud-label rounded px-1 transition ${wake ? "!text-cyan" : "hover:text-cyan"}`}
          >
            <span className="sm:hidden">{wake ? "◉" : "wake"}</span>
            <span className="hidden sm:inline">{wake ? "◉ hey jarvis" : "wake"}</span>
          </button>
          <button
            onClick={() => setChatMode(chatMode === "full" ? "bar" : chatMode === "bar" ? "off" : "full")}
            title="chat layout — full column / type bar / hidden (always listening)"
            className="hud-label rounded px-1 transition hover:text-cyan"
          >
            <span className="sm:hidden">{chatMode === "full" ? "▤" : chatMode === "bar" ? "▁" : "◌"}</span>
            <span className="hidden sm:inline">{chatMode === "full" ? "▤ chat" : chatMode === "bar" ? "▁ bar" : "◌ zen"}</span>
          </button>
          <span className="hidden md:inline"><Clock /></span>
          <button
            onClick={async () => {
              const r = await subscribePush(saveSub);
              await refreshPermissions();
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
            className={`hud-label hidden rounded px-1 hover:text-cyan sm:block ${permissions.notifications === "granted" ? "!text-emerald-300" : ""}`}
          >
            {permissions.notifications === "granted" ? "alerts ✓" : "alerts"}
          </button>
          <button
            onClick={() => setOptionsOpen((o) => !o)}
            title="options"
            className={`rounded px-1 text-sm transition ${optionsOpen ? "text-cyan" : "text-slate hover:text-cyan"}`}
          >
            <span className="inline-block transition-transform duration-500" style={{ transform: optionsOpen ? "rotate(90deg)" : "none" }}>⚙</span>
          </button>
          {embedded && (
            <button
              onClick={() => window.parent.postMessage({ jarvis: "hide" }, "*")}
              title="close Jarvis"
              className="rounded px-1 text-lg leading-none text-slate transition hover:text-cyan"
            >
              ×
            </button>
          )}
        </div>
      </header>
      {optionsOpen && (
        <OptionsPanel
          prefs={prefs}
          setPref={setPref}
          permissions={permissions}
          permissionBusy={permissionBusy}
          onEnablePermissions={() => void enableDevicePermissions()}
          live={live}
          locOn={locOn}
          onLocation={() => void captureLocation(true)}
          onClose={() => setOptionsOpen(false)}
          onToggleLive={() => void toggleLive()}
          onMood={(m) => void setMoodMut({ mood: m, manual: true })}
          onClearMood={() => void setMoodMut({ mood: "calm", manual: false })}
          onOpenLibrary={() => {
            setOptionsOpen(false);
            setPanelFull(false);
            setPanelMin(false);
            void setPanel({ type: "creations", value: JSON.stringify({ kind: null, folder: null }), title: "saved work" });
          }}
          onOpenGoals={() => {
            setOptionsOpen(false);
            setPanelFull(false);
            setPanelMin(false);
            void setPanel({ type: "fleet", value: JSON.stringify({ mode: "goal" }), title: "Goal Mode" });
          }}
          onMacSetup={() => {
            setOptionsOpen(false);
            setPanelFull(false);
            setPanelMin(false);
            void setPanel({ type: "widget", value: JSON.stringify({ kind: "mac_setup" }), title: "Mac shortcut setup" });
          }}
        />
      )}

      <div className={`relative mx-auto flex w-full max-w-[1720px] flex-1 flex-col overflow-clip p-4 pt-2 ${chatMode === "bar" ? "pb-24" : ""}`}>
        {/* the stage is ALWAYS full-bleed; the chat floats over it and slides
            away on pure transforms — compositor-only, 120fps-smooth */}
        <div ref={stageRef} className={`brackets relative min-h-0 flex-1 transition-[margin] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] ${chatMode === "full" ? "md:mr-[416px]" : ""}`}>
          <span className="bk" />
          {/* orbit bubbles — demoted panels bobbing beside the orb */}
          {bubbles.length > 0 && (!panel || panelMin) && (
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
          <FleetCommandCenter
            snapshot={visibleCommandSnapshot}
            detail={workDetail}
            hidden={overlayUp}
            onExpandedChange={setCommandExpanded}
            onSelectedJobChange={setWorkDetailJobId}
          />
          {panel && panel.type !== "video" && !panelMin && !panelFull ? (
            <div data-jarvis-panel-surface className={`jarvis-mobile-orb-safe-panel absolute inset-x-0 top-0 z-20 flex items-center p-1 ${stagePanelSize !== "h-full w-full" ? "justify-center md:justify-start md:pl-10 md:pr-[36%] lg:pl-16" : "justify-center"}`}>
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
          ) : null}
          {/* The reactor and particle core share one mounted surface and the
              ThreeOrb-published motion frame. Kept-visible phone panels use a
              deliberate 152px berth rather than hiding or duplicating either. */}
          <div
            data-jarvis-orb-zone={compactAside ? "compact" : "stage"}
            className={`absolute inset-0 transition-opacity duration-500 ${
              fullBleed ? "pointer-events-none opacity-0" : compactAside ? "jarvis-compact-orb-zone pointer-events-none z-30 overflow-hidden rounded-full border border-cyan/25 bg-[#061019]/85 shadow-[0_0_34px_rgba(0,255,136,.18)] opacity-100 md:overflow-visible md:rounded-none md:border-0 md:bg-transparent md:shadow-none" : commandExpanded && !overlayUp ? "pointer-events-none opacity-0 md:opacity-100" : "opacity-100"
            }`}
          >
            <ReactorRing
              active={live === "live" || orbState === "thinking" || orbState === "listening"}
              aside={compactAside || (commandExpanded && !overlayUp)}
              hidden={fullBleed}
              motionRef={orbMotionRef}
              reduceMotion={prefs.reduceMotion}
              compact={compactAside}
            />
            <ThreeOrb
              state={orbState}
              energyRef={energyRef}
              moodColor={moodColor}
              motionRef={orbMotionRef}
              aside={compactAside || (commandExpanded && !overlayUp)}
              reduceMotion={prefs.reduceMotion}
            />
          </div>
          {speaking && !fullBleed && (
            <button
              type="button"
              aria-label="Interrupt Jarvis"
              title="Tap the orb to interrupt"
              onClick={stopTalking}
              className={compactAside || (commandExpanded && !overlayUp)
                ? "absolute bottom-4 right-4 z-40 hidden h-36 w-36 rounded-full bg-transparent md:bottom-[25%] md:left-[69%] md:right-[3%] md:top-[25%] md:h-auto md:w-auto md:block"
                : "absolute inset-[28%] z-20 rounded-full bg-transparent"}
            />
          )}
          {/* THE ONE caption — one persistent node throughout token streaming,
              finalization and narration. Compact overlays keep it beside their
              visible orb; only a truly full-screen workspace owns the surface. */}
          {caption && !fullBleed && (
            <div className={`pointer-events-none absolute ${compactAside || (commandExpanded && !overlayUp) ? "top-[70%] hidden md:flex md:left-[62%] md:right-0" : "top-[52%] inset-x-0"} z-30 flex justify-center px-6`}>
              <SpokenCaption caption={caption} />
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
              .slice(-20)
              .map((m) => {
                if (m.role === "assistant" && m.text && isToolGarbage(m.text)) return { ...m, text: sanitizeAssistantText(m.text) };
                if (m.role === "user" && m.text) return { ...m, text: visibleTurnText(m.text) };
                return m;
              })
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
          <div className="safe-composer flex min-w-0 max-w-full items-stretch gap-1.5 overflow-hidden border-t border-white/5 p-2 sm:gap-2 sm:p-3">
            <button
              onClick={() => void toggleLive()}
              title="live conversation"
              className={`flex shrink-0 items-center gap-1.5 rounded-xl px-2 text-sm transition sm:px-3 ${
                live !== "off" ? "bg-cyan/20 text-cyan ring-1 ring-cyan/50" : "glass text-slate hover:text-ice"
              }`}
            >
              {live === "connecting" ? (
                <span className="h-1.5 w-1.5 animate-ping rounded-full bg-cyan" />
              ) : live === "live" ? (
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-cyan" />
              ) : null}
              <span className="max-sm:hidden">live</span><span className="sm:hidden">◉</span>
            </button>
            <button
              onClick={toggleMic}
              disabled={live === "live"}
              title={live === "live" ? "Live conversation is continuously listening" : "voice input"}
              className={`shrink-0 rounded-xl px-2 text-sm transition sm:px-3 ${
                live === "live"
                  ? "bg-cyan/10 text-cyan ring-1 ring-cyan/30"
                  : recording
                    ? "bg-amber/20 text-amber ring-1 ring-amber/50"
                    : "glass text-slate hover:text-ice"
              }`}
            >
              <span className="max-sm:hidden">{live === "live" ? "mic on" : recording ? "■ done" : "mic"}</span><span className="sm:hidden">{recording ? "■" : "●"}</span>
            </button>
            <button
              onClick={() => void lookAtScreen()}
              title="show JARVIS your screen (one frame)"
              className={`hidden shrink-0 rounded-xl px-3 text-sm transition sm:block ${seeing ? "bg-cyan/20 text-cyan ring-1 ring-cyan/50 animate-pulse" : "glass text-slate hover:text-ice"}`}
            >
              👁
            </button>
            <button
              onClick={() => void lookAtCamera()}
              title="point your camera at something — JARVIS reads it"
              className={`hidden shrink-0 rounded-xl px-3 text-sm transition sm:block ${camSeeing ? "bg-cyan/20 text-cyan ring-1 ring-cyan/50 animate-pulse" : "glass text-slate hover:text-ice"}`}
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
              placeholder={busy ? "Ask another thing while I work…" : "Talk to me…"}
              className="w-0 min-w-0 flex-1 rounded-xl bg-black/30 px-3 py-2.5 text-sm text-ice outline-none ring-1 ring-white/10 transition focus:ring-cyan/50 sm:w-auto sm:px-4"
            />
            <button
              onClick={() => submit(input)}
              disabled={sending || !input.trim()}
              className="grid w-10 shrink-0 place-items-center rounded-xl bg-cyan/15 px-0 py-2 text-sm font-medium text-cyan ring-1 ring-cyan/40 transition hover:bg-cyan/25 disabled:opacity-40 sm:w-auto sm:px-4"
            >
              <span className="sm:hidden">↑</span><span className="max-sm:hidden">send</span>
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
            {drawerOpen && <ChatHistoryArchive key={thread} threadId={thread} />}
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
          className={`safe-floating-bottom fixed inset-x-0 z-40 mx-auto w-[min(94vw,780px)] will-change-transform motion-reduce:transition-none transition-all duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] ${
            chatMode === "bar" ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-28 opacity-0"
          }`}
        >
          <div className="glass flex min-w-0 max-w-full items-stretch gap-2 overflow-hidden rounded-2xl p-2 shadow-2xl">
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
              <span className="max-sm:hidden">live</span><span className="sm:hidden">◉</span>
            </button>
            <button
              onClick={toggleMic}
              disabled={live === "live"}
              title={live === "live" ? "Live conversation is continuously listening" : "voice input"}
              className={`shrink-0 rounded-xl px-2.5 text-sm transition ${live === "live" ? "bg-cyan/10 text-cyan ring-1 ring-cyan/30" : recording ? "bg-amber/20 text-amber ring-1 ring-amber/50" : "text-slate hover:text-ice"}`}
            >
              <span className="max-sm:hidden">{live === "live" ? "mic on" : recording ? "■" : "mic"}</span><span className="sm:hidden">{recording ? "■" : "●"}</span>
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
              placeholder={busy ? "Ask another thing while I work…" : "Talk to me…"}
              className="w-0 min-w-0 flex-1 rounded-xl bg-black/30 px-3 py-2 text-sm text-ice outline-none ring-1 ring-white/10 transition focus:ring-cyan/50 sm:w-auto sm:px-4"
            />
            <button
              onClick={() => submit(input)}
              disabled={sending || !input.trim()}
              className="grid w-10 shrink-0 place-items-center rounded-xl bg-cyan/15 px-0 py-2 text-sm font-medium text-cyan ring-1 ring-cyan/40 transition hover:bg-cyan/25 disabled:opacity-40 sm:w-auto sm:px-3.5"
            >
              <span className="sm:hidden">↑</span><span className="max-sm:hidden">send</span>
            </button>
          </div>
        </div>
      )}

      {/* zen mode: no chat at all — JARVIS is always listening */}
      <button
        onClick={() => speaking ? stopTalking() : setChatMode("bar")}
        className={`glass fixed bottom-4 right-4 z-40 flex items-center gap-2 rounded-full px-3.5 py-2 text-xs text-slate will-change-transform motion-reduce:transition-none transition-all duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] hover:text-ice ${
          chatMode === "off" && !panelFull ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-20 opacity-0"
        }`}
        title={speaking ? "interrupt Jarvis" : "bring the chat back"}
      >
        <span className={`h-1.5 w-1.5 rounded-full ${speaking ? "bg-red-300 animate-pulse" : live === "live" ? "bg-cyan animate-pulse" : wake ? "bg-cyan breathe" : "bg-slate"}`} />
        {speaking ? "hush" : live === "live" ? "live" : wake ? "listening — say “hey jarvis”" : "tap to chat"}
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
