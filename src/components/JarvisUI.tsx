"use client";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { usePaginatedQuery } from "convex/react";
import dynamic from "next/dynamic";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { useJarvisQuery } from "@/lib/secure-convex";
import { clientMutation } from "@/lib/client-mutation";
import {
  forgetMicrophoneGrant,
  readJarvisPermissions,
  rememberMicrophoneGrant,
  watchMicrophonePermission,
  type JarvisPermissionState,
} from "@/lib/permissions";
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
import { nextVoiceLoopAction, shouldMaintainLiveHeartbeat, type VoiceCaptureOutcome } from "@/lib/voice-loop";
import {
  liveVoiceRetryDelay,
  scheduleAutoLiveBootstrap,
  shouldAutoStartLiveVoice,
  speechServiceRetryDelay,
} from "@/lib/live-voice-bootstrap";
import {
  LIVE_SPEAKER_TAIL_MS,
  LIVE_BARGE_SAMPLE_MS,
  advanceLiveVad,
  createLiveVadState,
  shouldCloseLiveUtterance,
  shouldDeferLiveCapture,
  shouldStartLiveResearchPreview,
  spectrumBandLevel,
  type LiveVadState,
} from "@/lib/live-vad";
import { BookingsView, CalendarView, CanvasView, LaunchView, PdfView, CreationsView, StructuredListView, CandlesView, MarketChartLoading, VideoListView, GoalModeLauncherView, FeedView, WeatherView, TodosView, Briefing2View, ShopView, DocView, WebResultsView, PlacesView, RankingView, PanelUnavailable } from "./Views";
import { parseFastChartIntent, parseFastNetWorthIntent, type FastChartIntent, type FastNetWorthIntent } from "@/lib/fast-intents";
import { parseWorkModelTier, workModelLabel } from "@/lib/work-models";
import { isMeaningfulSpeechTranscript, isRecentVoiceDuplicate, shouldIgnoreHandsFreeTranscript } from "@/lib/transcript";
import {
  completeSpeechPrefix,
  isSpeaking as isTtsActuallySpeaking,
  unlockSpeechPlayback,
  type TtsRuntimeStatus,
} from "@/lib/tts";
import { NarrationLedger, narrationClaim } from "@/lib/narration";
import { resolveEmbedLayoutMode, resolvePanelRoute } from "@/lib/panel-contract";
import { parseFastAgentDispatch, type FastAgentDispatch } from "@/lib/fast-agent-dispatch";
import { needsHostContext, visibleTurnText, withHostContext, type JarvisHostContext } from "@/lib/host-context";
import { parseEmbeddedHostIntent, type JarvisHostAction } from "@/lib/host-actions";
import { JARVIS_MAC_ENTRY_URL, macShortcutUrl } from "@/lib/mac-shortcut";
import { viewerFetch, viewerFetchWithTimeout } from "@/lib/viewer-request";
import { normalizeIncidentSignature } from "@/lib/incident-signature";
import { isForegroundBusy } from "@/lib/foreground-state";
import { FleetCommandCenter } from "./CompactWorkBar";
import { isGuestViewerSession, useViewerSession } from "@/lib/viewer-session";
import { GuestSafeAttachment } from "./GuestSafeAttachment";
import {
  authoritativeCancellationReceipt,
  FOREGROUND_AUTO_RECOVERY_MS,
  foregroundRecoveryBudgetAfterSignal,
  foregroundRecoveryWatchdogDisposition,
  foregroundTurnPhase,
  latestRecoverableForegroundTurn,
  mergeRecoveredAssistant,
} from "@/lib/foreground-recovery";
import {
  advanceFinalDelivery,
  finalNarrationStillCurrent,
  type FinalDeliveryCursor,
} from "@/lib/final-delivery";
import { withClientDeadline } from "@/lib/client-deadline";
import { resolveTrustedJarvisEmbedOrigin } from "@/lib/embed-origin";
import {
  SpeechRecognitionRequestError,
  transcriptFromSttResponse,
  transcribeRecordedAudio,
} from "@/lib/stt-client";
import {
  reconcileEmbeddedThreadReadiness,
  stableEmbeddedActorKey,
  type EmbeddedThreadContext,
} from "@/lib/embed-command-handoff";
import { ChatFilePicker } from "./chat-files/ChatFilePicker";
import { GuestChatFileAccess } from "./chat-files/GuestChatFileAccess";
import { ChatFilePendingMonitor, type ChatFileNotice } from "./chat-files/ChatFilePendingMonitor";
import type { ChatFileManifest } from "@/lib/chat-files";
import { buildSpeculativeResearchQuery } from "@/lib/speculative-research";
import {
  chooseLiveTranscriptSource,
  isStableBrowserSpeechRevision,
  recoverLiveTranscriptFromBrowser,
  type BrowserSpeechPreview,
} from "@/lib/browser-speech-preview";
import {
  compactChatFeedback,
  foregroundUiProgress,
  shouldOfferForegroundRecovery,
  type CompactFeedbackPhase,
} from "@/lib/chat-ui-feedback";
import {
  buildVoiceTurnMetric,
  shouldRecordVoiceTurnMetric,
  type VoiceTurnTrace,
} from "@/lib/voice-turn-metrics";

const EMBED_COMMAND_TTL_MS = 30_000;
const MAX_PENDING_EMBED_COMMANDS = 4;

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
type LiveMicrophoneResources = {
  stream: MediaStream;
  context: AudioContext;
  analyser: AnalyserNode;
  aecEnabled: boolean;
};
type Msg = {
  _id: string;
  role: string;
  text: string;
  status: string;
  model?: string;
  delivery?: "foreground" | "notification";
  parentMessageId?: string;
  attachment?: Attachment;
  files?: ChatFileManifest[];
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
type BrowserSpeechRecognitionAlternative = { transcript?: string; confidence?: number };
type BrowserSpeechRecognitionResult = {
  readonly length: number;
  readonly isFinal?: boolean;
  readonly [index: number]: BrowserSpeechRecognitionAlternative;
};
type BrowserSpeechRecognitionEvent = {
  readonly resultIndex?: number;
  readonly results: {
    readonly length: number;
    readonly [index: number]: BrowserSpeechRecognitionResult;
  };
};
type BrowserSpeechRecognizer = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: BrowserSpeechRecognitionEvent) => void) | null;
  onerror: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort?: () => void;
};
type BrowserSpeechRecognizerConstructor = new () => BrowserSpeechRecognizer;
type StreamingSpeechState = {
  id: string;
  scheduledChars: number;
  spokenChars: number;
  failed: boolean;
  chain: Promise<void>;
  timer: ReturnType<typeof setTimeout> | null;
  pendingPrefix: string;
  pendingCaption: string;
};
type SubmitOptions = {
  requestId?: string;
  researchReceipt?: string;
  interruptCurrent?: boolean;
  hostContext?: JarvisHostContext | null;
  voiceTrace?: VoiceTurnTrace;
};
type LiveResearchResponse = {
  receipt: string;
  query: string;
  sources: Array<{ title: string; url: string }>;
  expiresAt: number;
};
type LiveResearchState = {
  phase: "idle" | "researching" | "ready";
  sourceCount: number;
};
type CodingProvider = "codex" | "claude";
type LocalCodingProviderStatus = {
  provider: CodingProvider;
  targetRuntime: "vps_codex" | "vps_claude";
  updatedAt: number;
};

function parseLocalCodingProviderStatus(value: unknown): LocalCodingProviderStatus | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const provider = record.provider;
  if (provider !== "codex" && provider !== "claude") return null;
  const updatedAt = typeof record.updatedAt === "number" && Number.isFinite(record.updatedAt)
    ? Math.max(0, record.updatedAt)
    : 0;
  return {
    provider,
    targetRuntime: provider === "claude" ? "vps_claude" : "vps_codex",
    updatedAt,
  };
}

function validCodingProviderRequestId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{8,160}$/.test(value);
}

const EMBEDDED_OPERATIONAL_LOG_LINE = /^\s*(?:```(?:json|text|log)?\s*)?(?:[⚠️🚨❌]\s*)?(?:error(?:\[[^\]]+\])?:|(?:type|reference|syntax|range|network|abort|tool)[_ ]?error\b|traceback\b|npm err!|(?:stdout|stderr)\s*:|at\s+\S.*\([^)]*:\d+:\d+\)|.*:\s*error\s+TS\d+\b|\{\s*["']?(?:error|stack|code)["']?\s*:|\{\s*["']?type["']?\s*:\s*["']error["']|\[(?:error|debug|warn|info|tool)\])/i;

/** Keep implementation diagnostics in telemetry, never in the compact host UI. */
export function safeEmbeddedMessageText(args: {
  role: string;
  text: string;
  status?: string;
}): string {
  if (args.role === "user") return visibleTurnText(args.text);
  const sanitized = sanitizeAssistantText(args.text);
  const lines = sanitized.split(/\r?\n/);
  const logLine = lines.findIndex((line) => EMBEDDED_OPERATIONAL_LOG_LINE.test(line));
  const summary = (logLine >= 0 ? lines.slice(0, logLine) : lines).join("\n").trim();
  if (args.status === "error" || args.status === "failed" || logLine === 0 || !summary) {
    return "That reply hit a technical problem. Use recover or retry.";
  }
  return summary;
}

function MessageFileBadges({ files, align = "left" }: { files?: ChatFileManifest[]; align?: "left" | "right" }) {
  if (!files?.length) return null;
  return (
    <div className={`mt-1 flex flex-wrap gap-1 ${align === "right" ? "justify-end" : "justify-start"}`} aria-label="Files used by this message">
      {files.map((file) => {
        const ready = file.status === "ready" || file.status === "stored_only";
        const label = <><span aria-hidden="true">{file.mimeType.startsWith("image/") ? "▧" : "▤"}</span> <span className="max-w-40 truncate">{file.name}</span>{!ready && <span className="text-amber-300"> · {file.status}</span>}</>;
        return ready ? (
          <a key={file.fileId} href={`/api/files/${encodeURIComponent(file.fileId)}`} target="_blank" rel="noreferrer" className="inline-flex max-w-52 items-center gap-1 rounded-full border border-cyan/20 bg-cyan/[0.05] px-2 py-1 text-[10px] text-cyan/80 hover:border-cyan/45 hover:text-cyan" title={file.relativePath || file.name}>{label}</a>
        ) : (
          <span key={file.fileId} className="inline-flex max-w-52 items-center gap-1 rounded-full border border-white/10 bg-white/[0.025] px-2 py-1 text-[10px] text-slate-400" title={file.relativePath || file.name}>{label}</span>
        );
      })}
    </div>
  );
}

function ChatHistoryArchive({ threadId }: { threadId: string }) {
  const viewerToken = useViewerSession();
  const guest = isGuestViewerSession(viewerToken);
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
        <GuestSafeAttachment
          guest={guest}
          attachment={message.attachment}
          renderAttachment={(attachment) => <div className="truncate text-ice">{attachment.title ?? attachment.type}</div>}
        >
          <div className="line-clamp-3 whitespace-pre-wrap text-ice/85">{message.role === "user" ? visibleTurnText(message.text) : sanitizeAssistantText(message.text)}</div>
        </GuestSafeAttachment>
        {message.role === "user" && <MessageFileBadges files={message.files} />}
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
  prefs, setPref, permissions, permissionBusy, onEnableMicrophone, live, locOn, onLocation, onClose, onToggleLive, onMood, onClearMood, onOpenLibrary, onOpenGoals, onMacSetup,
}: {
  prefs: JarvisPrefs;
  setPref: (k: keyof JarvisPrefs, v: string | boolean) => void;
  permissions: JarvisPermissionState;
  permissionBusy: boolean;
  onEnableMicrophone: () => void;
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
          <Row label="Live microphone" hint={`microphone ${permissionText(permissions.microphone)} · remembered by this browser`}>
            <button
              type="button"
              disabled={permissionBusy || permissions.microphone === "granted"}
              onClick={onEnableMicrophone}
              className={`rounded-lg px-3 py-1 text-[11px] transition disabled:opacity-70 ${permissions.microphone === "granted" ? "bg-emerald-400/10 text-emerald-300 ring-1 ring-emerald-400/30" : "border border-cyan/30 text-cyan hover:bg-cyan/10"}`}
            >
              {permissionBusy ? "enabling…" : permissions.microphone === "granted" ? "ready ✓" : permissions.microphone === "denied" ? "browser settings" : "enable once"}
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
          <Row label="Live by default" hint="asks once on first use, then starts automatically with this browser's saved permission">
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
}: {
  active: boolean;
  aside: boolean;
  hidden: boolean;
  motionRef: { current: OrbMotionFrame };
  reduceMotion: boolean;
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
      <svg viewBox="0 0 500 500" className="h-[min(82vmin,760px)] w-[min(82vmin,760px)]">
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
  if (w?.kind === "bookings") return <BookingsView value={value} />;
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
    <div
      data-jarvis-panel-frame
      data-panel-presentation={route.presentation}
      className="@container materialize frost-shell relative flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden rounded-2xl"
    >
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
        <img src={panel.value} alt={panel.title ?? ""} className="h-full min-h-0 w-full max-w-full flex-1 object-contain" />
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

function LiveResearchIndicator({ state }: { state: LiveResearchState }) {
  if (state.phase === "idle") return null;
  const ready = state.phase === "ready";
  return (
    <div
      data-jarvis-live-research={state.phase}
      className="glass flex items-center gap-2 rounded-full border border-cyan/20 px-3 py-1.5 font-mono text-[9px] uppercase tracking-[0.12em] text-cyan shadow-[0_0_28px_rgba(34,211,238,0.12)]"
      aria-live="polite"
    >
      <span className={`h-1.5 w-1.5 rounded-full ${ready ? "bg-emerald-300" : "animate-pulse bg-cyan"}`} aria-hidden="true" />
      {ready
        ? `${state.sourceCount} source${state.sourceCount === 1 ? "" : "s"} ready`
        : "checking sources while you finish"}
    </div>
  );
}

export default function JarvisUI({ embedded = false }: { embedded?: boolean }) {
  const orbMotionRef = useRef<OrbMotionFrame>(createOrbMotionFrame());
  const viewerToken = useViewerSession();
  const [parentOrigin, setParentOrigin] = useState<string | null>(null);
  useEffect(() => {
    if (!embedded) {
      setParentOrigin(null);
      return;
    }
    setParentOrigin(resolveTrustedJarvisEmbedOrigin({
      declaredOrigin: new URLSearchParams(window.location.search).get("hostOrigin"),
      referrer: document.referrer,
      ancestorOrigin: window.location.ancestorOrigins?.[0] ?? null,
    }));
  }, [embedded]);
  // Embed host resolution scopes postMessage traffic only. It must not demote
  // the signed owner session or hide Jarvis when referrer metadata is blocked.
  const guest = isGuestViewerSession(viewerToken);
  const postToParent = (message: Record<string, unknown>) => {
    if (!embedded || !parentOrigin || window.parent === window) return;
    window.parent.postMessage(message, parentOrigin);
  };
  const hideEmbedded = () => {
    if (!embedded || window.parent === window) return;
    // `hide` carries no owner data, so it remains available even when the
    // browser withholds referrer metadata and no reply origin can be resolved.
    window.parent.postMessage({ jarvis: "hide" }, parentOrigin ?? "*");
  };
  const connectEmbeddedOwner = async () => {
    // Guest issuance has been retired. A stale pre-migration viewer can recover
    // by reloading into the automatic owner bootstrap; no storage-access prompt
    // or pairing popup is required.
    window.location.reload();
  };
  useEffect(() => {
    if (!embedded) return;
    document.documentElement.classList.add("jarvis-embedded-document");
    document.body.classList.add("jarvis-embedded-document");
    return () => {
      document.documentElement.classList.remove("jarvis-embedded-document");
      document.body.classList.remove("jarvis-embedded-document");
    };
  }, [embedded]);
  const activeThreadQuery = useJarvisQuery(api.ui.getActiveThread, guest ? "skip" : {});
  // A guest never reads the shared UI row. Its conversation query derives a
  // private guest:<id> thread server-side, so "main" is only a local label.
  const activeThreadReady = guest || activeThreadQuery !== undefined;
  const thread = (guest ? "main" : activeThreadQuery ?? "main") as string;
  const threads = (useJarvisQuery(api.ui.getThreads, embedded || guest ? "skip" : {}) ?? []) as { id: string; title: string; at: number }[];
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
  const embeddedThreadContextRef = useRef<EmbeddedThreadContext | null>(null);
  const pendingEntryCommands = useRef<Array<{ text: string; at: number }>>([]);
  const hostContextRef = useRef<JarvisHostContext | null>(null);
  const hostActionWaiters = useRef(new Map<string, (result: HostActionResult) => void>());
  const embeddedActorKey = stableEmbeddedActorKey(parentOrigin, viewerToken);
  // The signed viewer session is sufficient to hydrate chat. Parent origin is
  // only a postMessage destination and may legitimately be unavailable when a
  // privacy-focused browser strips referrer/ancestor metadata.
  const embeddedThreadHydrated = activeThreadReady;
  useLayoutEffect(() => {
    const nextContext: EmbeddedThreadContext = {
      actorKey: embeddedActorKey,
      threadId: embeddedThreadHydrated ? thread : null,
      hydrated: embeddedThreadHydrated,
    };
    const transition = reconcileEmbeddedThreadReadiness(
      embeddedThreadContextRef.current,
      nextContext,
      threadReadyRef.current,
    );
    embeddedThreadContextRef.current = nextContext;
    threadReadyRef.current = transition.ready;
    if (transition.discardPending) pendingEntryCommands.current = [];
    threadRef.current = thread;
    if (!embeddedThreadHydrated) return;
    threadReadyRef.current = true;
    const now = Date.now();
    const queued = pendingEntryCommands.current.splice(0)
      .filter((command) => now - command.at <= EMBED_COMMAND_TTL_MS);
    for (const command of queued) void submit(command.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [embeddedActorKey, embeddedThreadHydrated, thread]);
  function submitEntryCommand(command: string) {
    if (!threadReadyRef.current) {
      pendingEntryCommands.current.push({ text: command, at: Date.now() });
      if (pendingEntryCommands.current.length > MAX_PENDING_EMBED_COMMANDS) {
        pendingEntryCommands.current.splice(
          0,
          pendingEntryCommands.current.length - MAX_PENDING_EMBED_COMMANDS,
        );
      }
      return;
    }
    void submit(command);
  }
  const fullMessages = useJarvisQuery(api.chatQueue.listMessages, embedded ? "skip" : { threadId: thread });
  const embeddedMessages = useJarvisQuery(
    api.chatQueue.listRecentMessages,
    embedded ? { threadId: thread } : "skip",
  );
  const remoteMessages = ((embedded ? embeddedMessages : fullMessages) ?? []) as Msg[];
  const [recoveredAssistant, setRecoveredAssistant] = useState<(Msg & { threadId: string }) | null>(null);
  const recoveredForThread = recoveredAssistant?.threadId === thread ? recoveredAssistant : null;
  const messages = mergeRecoveredAssistant(remoteMessages, recoveredForThread);
  const messagesHydrated = (embedded ? embeddedMessages : fullMessages) !== undefined;
  const remotePanel = useJarvisQuery(api.ui.getPanel, guest ? "skip" : {}) as
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
  // Guests have no panel, work, capability, or control plane. Keeping these
  // as local no-ops avoids turning harmless UI transitions into rejected
  // privileged requests while their voice/text lane stays available.
  const privateMutation = <T,>(path: string, args: Record<string, unknown>) =>
    guest ? Promise.resolve(undefined as T) : clientMutation<T>(path, args);
  const clearPanel = (args: Record<string, unknown>) => privateMutation("ui:clearPanel", args);
  const setPanel = (args: Record<string, unknown>) => privateMutation("ui:setPanel", args);
  const logTurn = (args: { threadId?: string; role: string; text: string; model?: string }) =>
    viewerFetch("/api/client-state", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "log_turn", ...args }),
    });
  const saveSub = (args: Record<string, unknown>) => privateMutation("push:saveSub", args);
  const claimVoice = (args: Record<string, unknown>) => privateMutation("ui:claimVoice", args);
  const electVoice = (args: Record<string, unknown>) => privateMutation<boolean>("ui:electVoice", args);
  const setLiveOn = (args: Record<string, unknown>) => privateMutation<boolean>("ui:setLiveOn", args);
  const voiceRow = useJarvisQuery(api.ui.getVoice, guest ? "skip" : {}) as { value: string; updatedAt: number } | null | undefined;
  const liveOnRow = useJarvisQuery(api.ui.getLiveOn, guest ? "skip" : {}) as { value: string; updatedAt: number } | null | undefined;
  const hostActionRow = useJarvisQuery(api.ui.getHostAction, embedded && !guest ? {} : "skip") as
    | { value: string; updatedAt: number }
    | null
    | undefined;
  const commandSnapshot = useJarvisQuery(
    api.commandCenter.snapshot,
    embedded || guest || !activeThreadReady ? "skip" : { threadId: thread },
  ) as CompactWorkSnapshot | undefined;
  const [workDetailJobId, setWorkDetailJobId] = useState<string | null>(null);
  const workDetail = useJarvisQuery(
    api.jobs.detail,
    !guest && workDetailJobId ? { jobId: workDetailJobId as never } : "skip",
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
    postToParent({ jarvis: "notify", text: sanitizeAssistantText(latest.text).slice(0, 240) });
  }, [embedded, messages, parentOrigin]);
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
    postToParent({ jarvis: "host-action", action: { ...action, id } });
  }, [embedded, hostActionRow, parentOrigin]);

  const [input, setInput] = useState("");
  const [embeddedExpanded, setEmbeddedExpanded] = useState(false);
  const [panelFull, setPanelFull] = useState(false);
  // Start folded: the first Convex snapshot may be hours old. Only content
  // created during this browser session is allowed to expand itself.
  const [panelMin, setPanelMin] = useState(true);
  const panelFullRef = useRef(false);
  useEffect(() => {
    panelFullRef.current = panelFull;
  }, [panelFull]);
  const [openAttachmentAfterExpand, setOpenAttachmentAfterExpand] = useState(false);
  useEffect(() => {
    if (!embedded || !parentOrigin || window.parent === window) return;
    // The trusted host owns the iframe dimensions. Send only semantic state so
    // every host applies the same audited desktop/mobile sizing policy.
    const mode = resolveEmbedLayoutMode({
      expanded: embeddedExpanded,
      panelVisible: Boolean(panel && !panelMin),
      panelFull,
      presentation: panelRoute?.presentation,
    });
    window.parent.postMessage({ jarvis: "layout", mode, expanded: mode !== "compact" }, parentOrigin);
  }, [embedded, embeddedExpanded, panel, panelFull, panelMin, panelRoute?.presentation, parentOrigin]);
  useEffect(() => {
    if (!embedded || !embeddedExpanded || !openAttachmentAfterExpand || guest) return;
    const frame = window.requestAnimationFrame(() => {
      const trigger = document.getElementById("jarvis-attachment-trigger") as HTMLButtonElement | null;
      trigger?.click();
      trigger?.focus();
      setOpenAttachmentAfterExpand(false);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [embedded, embeddedExpanded, guest, openAttachmentAfterExpand]);
  const openCompactAttachmentComposer = () => {
    unlockSpeechPlayback();
    setOpenAttachmentAfterExpand(true);
    setEmbeddedExpanded(true);
  };
  const [selectedFileIds, setSelectedFileIds] = useState<string[]>([]);
  const [pendingFileIds, setPendingFileIds] = useState<string[]>([]);
  const [fileNotice, setFileNotice] = useState<ChatFileNotice>(null);
  useEffect(() => {
    setSelectedFileIds([]);
    setPendingFileIds([]);
    setFileNotice(null);
  }, [thread]);
  const [speaking, setSpeaking] = useState(false);
  const [ttsRuntimeStatus, setTtsRuntimeStatus] = useState<TtsRuntimeStatus>("ready");
  useEffect(() => {
    const receive = (event: Event) => {
      const status = (event as CustomEvent<{ status?: string }>).detail?.status;
      if (
        status === "loading" || status === "ready" || status === "buffering"
        || status === "speaking" || status === "blocked" || status === "unavailable"
      ) {
        setTtsRuntimeStatus(status);
      }
    };
    window.addEventListener("jarvis:tts-status", receive);
    return () => window.removeEventListener("jarvis:tts-status", receive);
  }, []);
  useEffect(() => {
    if (ttsRuntimeStatus !== "blocked") return;
    const resume = () => unlockSpeechPlayback();
    window.addEventListener("pointerdown", resume, { capture: true });
    window.addEventListener("keydown", resume, { capture: true });
    return () => {
      window.removeEventListener("pointerdown", resume, { capture: true });
      window.removeEventListener("keydown", resume, { capture: true });
    };
  }, [ttsRuntimeStatus]);
  const speakingRef = useRef(false);
  const wasSpeakingRef = useRef(false);
  const confirmedBargeAtRef = useRef(0);
  const ttsQuietUntilRef = useRef(0);
  const keyboardQuietUntilRef = useRef(0);
  const lastKeyboardActivityRef = useRef(0);
  useEffect(() => {
    speakingRef.current = speaking;
    if (wasSpeakingRef.current && !speaking) {
      const now = Date.now();
      const tailMs = now - confirmedBargeAtRef.current < 1_000 ? 120 : LIVE_SPEAKER_TAIL_MS;
      ttsQuietUntilRef.current = Math.max(ttsQuietUntilRef.current, now + tailMs);
    }
    wasSpeakingRef.current = speaking;
  }, [speaking]);
  const [sending, setSending] = useState(false);
  const [recording, setRecording] = useState(false);
  const [live, setLive] = useState<"off" | "connecting" | "live">("off");
  const [liveResearch, setLiveResearch] = useState<LiveResearchState>({ phase: "idle", sourceCount: 0 });
  useEffect(() => {
    if (!embedded || window.parent === window) return;
    postToParent({ jarvis: speaking ? "speech-start" : "speech-end" });
  }, [embedded, speaking, parentOrigin]);
  useEffect(() => {
    if (!embedded || window.parent === window) return;
    postToParent({ jarvis: live === "off" ? "live-end" : "live-start" });
  }, [embedded, live, parentOrigin]);
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
  const finalDeliveryCursor = useRef<FinalDeliveryCursor>({ threadId: "", initialized: false, lastMessageId: null });
  const finalNarrationGenerationRef = useRef(0);
  const finalNarrationMessageRef = useRef("");
  const lastSpokenText = useRef<{ text: string; ts: number }>({ text: "", ts: 0 });
  const streamingSpeechRef = useRef<StreamingSpeechState>({
    id: "",
    scheduledChars: 0,
    spokenChars: 0,
    failed: false,
    chain: Promise.resolve(),
    timer: null,
    pendingPrefix: "",
    pendingCaption: "",
  });
  const narrationLedgerRef = useRef(new NarrationLedger());
  const activeVoiceTraceRef = useRef<VoiceTurnTrace | null>(null);
  const voiceReplayRef = useRef<{
    text: string;
    captionText: string;
    final: boolean;
    claim: string;
  } | null>(null);
  const [voiceReplayReady, setVoiceReplayReady] = useState(false);
  const mutedNarrationParentsRef = useRef(new Set<string>());
  const captionRef = useRef<Caption>(null);
  const energyRef = useRef(0);
  const recRef = useRef<MediaRecorder | null>(null);
  const liveMicRef = useRef<LiveMicrophoneResources | null>(null);
  const liveMicOpeningRef = useRef<Promise<LiveMicrophoneResources> | null>(null);
  const liveSessionEpoch = useRef(0);
  const liveInterruptionEpoch = useRef(0);
  const voiceInterruptionPendingRef = useRef(false);
  const sttAbortRef = useRef<AbortController | null>(null);
  const lastVoiceInput = useRef<{ text: string; at: number } | null>(null);
  const liveRef = useRef(false);
  const me = useRef("");
  const voiceRef = useRef<{ value: string; updatedAt: number } | null>(null);
  const localVoiceLeaseUntilRef = useRef(0);
  const localVoiceClaimedAtRef = useRef(0);
  const ownVoice = () => {
    if (guest) return Promise.resolve(undefined);
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
  const activeDurableTurn = useRef<{
    messageId: Id<"chatMessages">;
    threadId: string;
    text: string;
    visibleText: string;
    fileIds: string[];
  } | null>(null);
  const durableSubmissionInFlight = useRef(false);
  const failedSubmissionRef = useRef<{
    text: string;
    visibleText: string;
    fileIds: string[];
    options: Pick<SubmitOptions, "requestId" | "researchReceipt" | "voiceTrace">;
  } | null>(null);
  const [submissionRetryReady, setSubmissionRetryReady] = useState(false);
  const lastSubmittedParentId = useRef<string | undefined>(undefined);
  const durableRecoveryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const durableAutoRecoveries = useRef(0);
  const durableCancellationFence = useRef<{
    messageId: string;
    forRetry: boolean;
    receipt?: string;
  } | null>(null);
  const [durableRecovery, setDurableRecovery] = useState<
    "idle" | "waiting" | "delayed" | "recovering" | "failed" | "terminal" | "cancelling" | "retry-ready"
  >("idle");
  const durableRetryReady = durableRecovery === "retry-ready" && Boolean(
    activeDurableTurn.current &&
    durableCancellationFence.current?.messageId === activeDurableTurn.current.messageId &&
    durableCancellationFence.current.receipt,
  );
  const [durableTurnEpoch, setDurableTurnEpoch] = useState(0);
  const activeTurnStatus = useJarvisQuery(
    api.chatQueue.turnStatus,
    activeDurableTurn.current
      ? { messageId: activeDurableTurn.current.messageId, threadId: activeDurableTurn.current.threadId }
      : "skip",
  ) as {
    assistant: { _id: string; status: string; text: string; parentMessageId: string } | null;
  } | null | undefined;
  const [wake, setWake] = useState(false);
  const embeddedEndRef = useRef<HTMLDivElement>(null);
  // The colour changes locally on the first keystroke/word, rather than
  // waiting for a streamed model reply or a Convex write. A deliberate manual
  // choice remains authoritative until Daniel returns it to automatic mode.
  const moodRow = useJarvisQuery(api.ui.getMood, guest ? "skip" : {}) as { value: string; title?: string; updatedAt: number } | null | undefined;
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
  const setMoodMut = (args: Record<string, unknown>) => privateMutation("ui:setMood", args);
  const [prefs, setPrefs] = useState<JarvisPrefs>({ reduceMotion: false, liveDefault: true });
  const [permissions, setPermissions] = useState<JarvisPermissionState>({ microphone: "prompt", notifications: "prompt" });
  const [permissionBusy, setPermissionBusy] = useState(false);
  const liveAutoStarted = useRef(false);
  const liveAutoRetryCount = useRef(0);
  const liveAutoRetryTimer = useRef<number | null>(null);
  const liveManuallyStopped = useRef(false);
  const resumeLiveWhenVisible = useRef(false);
  const sttFailureStreak = useRef(0);
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
    let disposed = false;
    let stopWatching: () => void = () => undefined;
    void watchMicrophonePermission((microphone) => {
      setPermissions((current) => ({ ...current, microphone }));
      if (microphone === "denied" && liveRef.current) endFreeVoiceSession();
      if (microphone === "granted") liveAutoStarted.current = false;
    }).then((stop) => {
      if (disposed) stop();
      else stopWatching = stop;
    });
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      disposed = true;
      stopWatching();
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
    if (embedded) postToParent({ jarvis: "wake" });
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
    if (document.hidden) return;
    import("../lib/wakeword").then((m) => {
      if (!m.wakeSupported()) return;
      m.startWake(onWake, (listening) => setWake(listening), onWakeDetected);
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
      if (guest || !liveRef.current) return;
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
  }, [guest]);

  useEffect(() => {
    if (!embedded || !parentOrigin) return;
    const receiveHostMessage = (event: MessageEvent) => {
      if (event.source !== window.parent || !parentOrigin || event.origin !== parentOrigin) return;
      const message = event.data ?? {};
      if (message.jarvis === "host-show") {
        setChatMode("off", false);
        setEmbeddedExpanded(false);
      }
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
      const handoverRequestId = validCodingProviderRequestId(message.id) ? message.id : null;
      const relayCodingProviderStatus = (method: "GET" | "POST", provider?: CodingProvider) => {
        if (!handoverRequestId) return;
        const init: RequestInit = method === "POST"
          ? {
            method,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ provider }),
          }
          : { method, cache: "no-store" };
        void viewerFetch("/api/local-handover", init)
          .then(async (response) => {
            const payload = await response.json().catch(() => null) as { ok?: unknown; status?: unknown } | null;
            const status = payload?.ok === true ? parseLocalCodingProviderStatus(payload.status) : null;
            if (!response.ok || !status) throw new Error("local handover request rejected");
            postToParent({ jarvis: "coding-provider-result", id: handoverRequestId, ok: true, status });
          })
          .catch(() => {
            postToParent({
              jarvis: "coding-provider-result",
              id: handoverRequestId,
              ok: false,
              error: "The handover target could not be updated.",
            });
          });
      };
      if (message.jarvis === "host-coding-provider-status" && handoverRequestId) {
        relayCodingProviderStatus("GET");
      }
      if (
        message.jarvis === "host-coding-provider-set"
        && handoverRequestId
        && (message.provider === "codex" || message.provider === "claude")
      ) {
        relayCodingProviderStatus("POST", message.provider);
      }
      if (message.jarvis === "host-ready-probe" && typeof message.probe === "number") {
        postToParent({ jarvis: "ready", probe: message.probe });
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
    const notifyUnloading = () => postToParent({ jarvis: "unloading" });
    window.addEventListener("pagehide", notifyUnloading);
    postToParent({ jarvis: "ready" });
    return () => {
      window.removeEventListener("message", receiveHostMessage);
      window.removeEventListener("pagehide", notifyUnloading);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [embedded, parentOrigin]);

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
    const localNarrationOwner = Date.now() < localVoiceLeaseUntilRef.current
      || voiceRef.current?.value === me.current;
    if (liveOnRow && Date.now() - liveOnRow.updatedAt < 45_000 && !liveRef.current && !localNarrationOwner) {
      import("../lib/tts").then((m) => m.stopSpeaking());
      setSpeaking(false);
    }
  }, [liveOnRow]);
  // I speak only if I own the voice; when the row is stale, ELECT atomically —
  // two visible tabs used to both optimistically claim and voice the same
  // sentence in stereo.
  async function ensureVoice(): Promise<boolean> {
    if (guest) return true;
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
    const localNarrationOwner = Date.now() < localVoiceLeaseUntilRef.current
      || voiceRef.current?.value === me.current;
    if (document.hidden || (liveAnywhere() && !liveRef.current && !localNarrationOwner)) {
      finishWithoutSpeech();
      return false;
    }
    // Voice ownership and the cached TTS chunk load are independent. On a
    // recovered/stale lease, overlap both waits instead of placing the module
    // fetch after the Convex election round trip.
    const [voiceGranted, { speak }] = await Promise.all([
      ensureVoice(),
      import("../lib/tts"),
    ]);
    if (!voiceGranted) {
      finishWithoutSpeech();
      return false;
    }
    const replay = {
      text,
      captionText,
      final,
      claim: args.claim,
    };
    voiceReplayRef.current = replay;
    setVoiceReplayReady(false);
    const played = await speak(
      text,
      (energy) => (energyRef.current = energy),
      () => {
        const trace = activeVoiceTraceRef.current;
        if (trace && !trace.firstAudioAt) {
          trace.firstAudioAt = performance.now();
          recordVoiceMetric(trace, "audible");
          activeVoiceTraceRef.current = null;
        }
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
    if (voiceReplayRef.current?.claim !== replay.claim) return played;
    if (played) {
      voiceReplayRef.current = null;
      setVoiceReplayReady(false);
      return true;
    }
    if (!played) {
      const trace = activeVoiceTraceRef.current;
      if (trace) recordVoiceMetric(trace, "failed");
      setSpeaking(false);
      setVoiceReplayReady(true);
      showCaption({
        who: "jarvis",
        text: "The reply is ready in chat. Tap the speaker to retry voice playback.",
        phase: "ready",
      });
      return false;
    }
    return played;
  }

  function recordVoiceMetric(trace: VoiceTurnTrace, outcome: "queued" | "audible" | "failed") {
    const metric = buildVoiceTurnMetric(trace, outcome);
    if (!metric || !shouldRecordVoiceTurnMetric(metric)) return;
    // Diagnostics must never delay a reply. The endpoint also rejects arbitrary
    // fields, so only this no-transcript metric shape can be persisted.
    void viewerFetchWithTimeout("/api/voice/metrics", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(metric),
    }, 4_000).catch(() => undefined);
  }

  function retryVoicePlayback() {
    // Keep the first resume call synchronous with the pointer/key gesture.
    unlockSpeechPlayback();
    if (ttsRuntimeStatus === "blocked") return;
    const replay = voiceReplayRef.current;
    if (!replay) return;
    setVoiceReplayReady(false);
    void import("../lib/tts").then(async (module) => {
      module.stopSpeaking();
      unlockSpeechPlayback();
      await narrateText({
        text: replay.text,
        captionText: replay.captionText,
        final: replay.final,
        claim: `${replay.claim}:manual-retry:${Date.now()}`,
      });
    });
  }

  const busy = sending || isForegroundBusy(messages);
  const foregroundProgressStartedAt = useRef<number | null>(null);
  const [foregroundProgressClock, setForegroundProgressClock] = useState(() => Date.now());
  useEffect(() => {
    if (!busy) {
      foregroundProgressStartedAt.current = null;
      return;
    }
    if (foregroundProgressStartedAt.current === null) foregroundProgressStartedAt.current = Date.now();
    const timer = window.setInterval(() => setForegroundProgressClock(Date.now()), 400);
    return () => window.clearInterval(timer);
  }, [busy]);
  const foregroundElapsedMs = foregroundProgressStartedAt.current === null
    ? 0
    : Math.max(0, foregroundProgressClock - foregroundProgressStartedAt.current);

  useEffect(() => {
    // scroll the message CONTAINER only — scrollIntoView reaches into the
    // (possibly translated-off-screen) chat panel and drags the whole PAGE
    // down with it on phones
    const box = endRef.current?.parentElement;
    if (box) box.scrollTo({ top: box.scrollHeight, behavior: "smooth" });
  }, [messages.length, messages[messages.length - 1]?.text, caption?.text]);

  useEffect(() => {
    if (!embedded) return;
    embeddedEndRef.current?.scrollIntoView?.({ block: "end", behavior: "smooth" });
  }, [embedded, messages.length, messages[messages.length - 1]?.text]);

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
  useEffect(() => {
    const latestAssistant = [...messages].reverse().find((message) => message.role === "assistant" && message.delivery !== "notification");
    if (latestAssistant?.status !== "streaming" || !latestAssistant.text) return;
    if (durableStartedAt.current !== null) {
      document.documentElement.dataset.jarvisFirstTokenMs = String(Math.max(0, Math.round(performance.now() - durableStartedAt.current)));
      durableStartedAt.current = null;
      setSending(false);
    }
    showCaption({ who: "jarvis", text: latestAssistant.text, phase: "streaming" });
    if (
      latestAssistant.parentMessageId &&
      mutedNarrationParentsRef.current.has(latestAssistant.parentMessageId)
    ) return;
    const stablePrefix = completeSpeechPrefix(latestAssistant.text);
    if (!stablePrefix) return;
    let streamState = streamingSpeechRef.current;
    if (streamState.id !== latestAssistant._id) {
      if (streamState.timer) clearTimeout(streamState.timer);
      streamState = {
        id: latestAssistant._id,
        scheduledChars: 0,
        spokenChars: 0,
        failed: false,
        chain: Promise.resolve(),
        timer: null,
        pendingPrefix: "",
        pendingCaption: "",
      };
      streamingSpeechRef.current = streamState;
    }
    if (streamState.failed) return;
    if (stablePrefix.length <= Math.max(streamState.scheduledChars, streamState.pendingPrefix.length)) return;
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
      const from = current.scheduledChars;
      if (prefix.length <= from) return;
      const speechChunk = prefix.slice(from).trim();
      current.pendingPrefix = "";
      current.scheduledChars = prefix.length;
      if (!speechChunk) {
        current.spokenChars = Math.max(current.spokenChars, prefix.length);
        return;
      }
      current.chain = current.chain.then(async () => {
        if (streamingSpeechRef.current.id !== latestAssistant._id) return;
        const played = await narrateText({
          text: speechChunk,
          claim: narrationClaim(`turn:${latestAssistant._id}`, prefix, from, prefix.length),
          captionText: current.pendingCaption,
          final: false,
        });
        if (streamingSpeechRef.current.id !== latestAssistant._id) return;
        if (played && current.spokenChars === from) current.spokenChars = prefix.length;
        else if (!played) current.failed = true;
      });
    }, 220);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);

  useEffect(() => {
    if (!messagesHydrated) return;
    if (activeDurableTurn.current?.threadId !== thread) {
      activeDurableTurn.current = null;
      durableCancellationFence.current = null;
      if (durableRecoveryTimer.current) clearTimeout(durableRecoveryTimer.current);
      durableRecoveryTimer.current = null;
      setSending(false);
      setDurableRecovery("idle");
    }
    if (activeDurableTurn.current) return;
    const recoverable = latestRecoverableForegroundTurn(messages.map((message) => ({
      id: message._id,
      role: message.role,
      status: message.status,
      text: message.text,
      parentMessageId: message.parentMessageId,
    })));
    if (!recoverable) return;
    activeDurableTurn.current = {
      messageId: recoverable.messageId as Id<"chatMessages">,
      threadId: thread,
      text: recoverable.text,
      visibleText: visibleTurnText(recoverable.text),
      fileIds: messages.find((message) => message._id === recoverable.messageId)?.files?.map((file) => file.fileId) ?? [],
    };
    lastSubmittedParentId.current = recoverable.messageId;
    durableAutoRecoveries.current = 0;
    setSending(true);
    setDurableRecovery("waiting");
    setDurableTurnEpoch((value) => value + 1);
    armDurableRecoveryWatchdog();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messagesHydrated, messages, thread]);

  useEffect(() => {
    const active = activeDurableTurn.current;
    if (!active || active.threadId !== thread) return;
    const state = foregroundTurnPhase(
      activeTurnStatus?.assistant ? [{ ...activeTurnStatus.assistant, role: "assistant" }] : messages,
      active.messageId,
    );
    if (durableCancellationFence.current?.messageId === active.messageId) return;
    if (state.phase === "queued") return;

    if (state.phase === "streaming") {
      durableAutoRecoveries.current = foregroundRecoveryBudgetAfterSignal(
        durableAutoRecoveries.current,
        "streaming",
      );
      if (state.text) setDurableRecovery("waiting");
      armDurableRecoveryWatchdog();
      return;
    }

    durableStartedAt.current = null;
    if (durableRecoveryTimer.current) clearTimeout(durableRecoveryTimer.current);
    durableRecoveryTimer.current = null;
    if (state.phase === "done") {
      activeDurableTurn.current = null;
      durableCancellationFence.current = null;
      setDurableRecovery("idle");
      setSending(false);
      return;
    }
    setSending(true);
    setDurableRecovery("failed");
    if (state.text) showCaption({
      who: "jarvis",
      text: embedded
        ? safeEmbeddedMessageText({ role: "assistant", status: "error", text: state.text })
        : state.text,
      phase: "ready",
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTurnStatus, messages, thread, durableTurnEpoch]);

  useEffect(() => () => {
    if (durableRecoveryTimer.current) clearTimeout(durableRecoveryTimer.current);
  }, []);

  useEffect(() => {
    const last = [...messages].reverse().find((m) => m.role === "assistant" && m.delivery !== "notification" && m.status === "done" && m.text);
    const delivery = advanceFinalDelivery(finalDeliveryCursor.current, {
      threadId: thread,
      hydrated: messagesHydrated,
      latest: last ? { id: last._id, parentMessageId: last.parentMessageId } : null,
      activeParentMessageId: lastSubmittedParentId.current,
    });
    finalDeliveryCursor.current = delivery.cursor;
    if (!delivery.deliver || !last) return;
    if (!last.text) return;
    if (isToolGarbage(last.text) && !sanitizeAssistantText(last.text)) return;
    // never say the exact same thing twice in a row (root of "sends results twice")
    if (last.text === lastSpokenText.current.text && Date.now() - lastSpokenText.current.ts < 20_000) return;
    lastSpokenText.current = { text: last.text, ts: Date.now() };
    const generation = finalNarrationGenerationRef.current + 1;
    finalNarrationGenerationRef.current = generation;
    finalNarrationMessageRef.current = last._id;
    const narrationFence = {
      generation,
      threadId: thread,
      messageId: last._id,
      parentMessageId: last.parentMessageId,
    };
    // Background findings never interrupt an active voice exchange. Normal
    // Codex replies do speak, then the turn-taking microphone re-arms.
    const spokenText = isToolGarbage(last.text) ? sanitizeAssistantText(last.text) : last.text;
    // Streaming and finalization use the same stable caption node. Put the
    // finished text there before voice ownership/model generation, so it never
    // vanishes during the TTS handoff or when this tab is not the speaker.
    showCaption({ who: "jarvis", text: spokenText, phase: "ready" });
    document.documentElement.dataset.jarvisFinalDeliveryMs = String(Math.round(performance.now()));
    if (last.parentMessageId && mutedNarrationParentsRef.current.has(last.parentMessageId)) {
      mutedNarrationParentsRef.current.delete(last.parentMessageId);
      setSpeaking(false);
      return;
    }
    (async () => {
      const streamed = streamingSpeechRef.current.id === last._id ? streamingSpeechRef.current : null;
      if (streamed?.timer) {
        clearTimeout(streamed.timer);
        streamed.timer = null;
        streamed.pendingPrefix = "";
      }
      if (streamed) await streamed.chain;
      if (!finalNarrationStillCurrent(narrationFence, {
        generation: finalNarrationGenerationRef.current,
        threadId: threadRef.current,
        messageId: finalNarrationMessageRef.current,
        parentMessageId: lastSubmittedParentId.current,
      })) return;
      const from = streamed?.spokenChars ?? 0;
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
    if (!embedded || !parentOrigin || window.parent === window) return null;
    const id = `jarvis-context-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return new Promise((resolve) => {
      const finish = (context: JarvisHostContext | null) => {
        window.removeEventListener("message", receive);
        window.clearTimeout(timer);
        if (context) hostContextRef.current = context;
        resolve(context);
      };
      const receive = (event: MessageEvent) => {
        if (event.source !== window.parent || event.origin !== parentOrigin) return;
        const message = event.data ?? {};
        if (message.jarvis !== "context-response" || message.id !== id) return;
        finish(message.context as JarvisHostContext);
      };
      const timer = window.setTimeout(() => finish(hostContextRef.current), 120);
      window.addEventListener("message", receive);
      postToParent({ jarvis: "context-request", id });
    });
  }

  async function claimEmbeddedBrowserPreview(sessionId: string): Promise<boolean> {
    if (!embedded || !parentOrigin || window.parent === window) return false;
    return new Promise((resolve) => {
      const finish = (granted: boolean) => {
        window.removeEventListener("message", receive);
        window.clearTimeout(timer);
        resolve(granted);
      };
      const receive = (event: MessageEvent) => {
        if (event.source !== window.parent || event.origin !== parentOrigin) return;
        const message = event.data ?? {};
        if (message.jarvis !== "host-preview-grant" || message.sessionId !== sessionId) return;
        finish(true);
      };
      const timer = window.setTimeout(() => finish(false), 220);
      window.addEventListener("message", receive);
      postToParent({ jarvis: "preview-claim", sessionId });
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
      postToParent({ jarvis: "host-action", action: payload });
    });
  }

  async function queueDurableTurn(
    text: string,
    visibleText = text,
    fileIds: string[] = [],
    options: Pick<SubmitOptions, "requestId" | "researchReceipt" | "voiceTrace"> = {},
  ) {
    if (durableSubmissionInFlight.current || activeDurableTurn.current) return;
    const requestId = options.requestId
      ?? globalThis.crypto?.randomUUID?.()
      ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const retryOptions = { requestId, researchReceipt: options.researchReceipt, voiceTrace: options.voiceTrace };
    durableSubmissionInFlight.current = true;
    failedSubmissionRef.current = null;
    setSubmissionRetryReady(false);
    durableStartedAt.current = performance.now();
    setSending(true);
    showCaption({ who: "you", text: visibleText });
    try {
      const request = {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          threadId: threadRef.current,
          text,
          requestId,
          fileIds,
          researchReceipt: options.researchReceipt,
        }),
      } satisfies RequestInit;
      // A single same-ID retry resolves the ambiguous "Convex committed but
      // the HTTP response was lost" case without creating a duplicate turn.
      let response: Response;
      try {
        response = await viewerFetchWithTimeout("/api/chat", request, 15_000);
      } catch {
        response = await viewerFetchWithTimeout("/api/chat", request, 15_000);
      }
      if (!response.ok) throw new Error(`conversation queue rejected (${response.status})`);
      const result = await response.json() as { messageId?: string; researchPrefetchAccepted?: boolean };
      if (!result.messageId) throw new Error("conversation queue returned no turn identity");
      if (options.researchReceipt) {
        document.documentElement.dataset.jarvisResearchPrefetch = result.researchPrefetchAccepted
          ? "promoted"
          : "discarded";
      }
      if (options.voiceTrace) {
        options.voiceTrace.queuedAt = performance.now();
        options.voiceTrace.researchState = options.researchReceipt
          ? (result.researchPrefetchAccepted ? "promoted" : "discarded")
          : (options.voiceTrace.researchState ?? "none");
        activeVoiceTraceRef.current = options.voiceTrace;
        recordVoiceMetric(options.voiceTrace, "queued");
      }
      activeDurableTurn.current = {
        messageId: result.messageId as Id<"chatMessages">,
        threadId: threadRef.current,
        text,
        visibleText,
        fileIds: [...fileIds],
      };
      failedSubmissionRef.current = null;
      setSubmissionRetryReady(false);
      mutedNarrationParentsRef.current.delete(String(result.messageId));
      if (fileIds.length) {
        setSelectedFileIds((current) => current.filter((fileId) => !fileIds.includes(fileId)));
        setFileNotice(null);
      }
      durableSubmissionInFlight.current = false;
      lastSubmittedParentId.current = result.messageId;
      durableAutoRecoveries.current = 0;
      setDurableTurnEpoch((value) => value + 1);
      setDurableRecovery("waiting");
      armDurableRecoveryWatchdog();
      // The terminal-message effect owns `sending=false`. Serializing the
      // foreground lane keeps every retry bound to the exact turn it repairs.
      return;
    } catch (error) {
      if (options.voiceTrace) recordVoiceMetric(options.voiceTrace, "failed");
      durableSubmissionInFlight.current = false;
      durableStartedAt.current = null;
      failedSubmissionRef.current = {
        text,
        visibleText,
        fileIds: [...fileIds],
        options: retryOptions,
      };
      setSubmissionRetryReady(true);
      document.documentElement.dataset.jarvisConversationFailure = String(error).slice(0, 160);
      showCaption({
        who: "jarvis",
        text: "I heard you, but the conversation line failed before it confirmed. Tap retry send—your request ID is preserved.",
        phase: "ready",
      });
      setSending(false);
    }
  }

  function retryFailedSubmission() {
    const retry = failedSubmissionRef.current;
    if (!retry || durableSubmissionInFlight.current || activeDurableTurn.current) return;
    setSubmissionRetryReady(false);
    void queueDurableTurn(
      retry.text,
      retry.visibleText,
      retry.fileIds,
      retry.options,
    );
  }

  function armDurableRecoveryWatchdog() {
    if (durableRecoveryTimer.current) clearTimeout(durableRecoveryTimer.current);
    durableRecoveryTimer.current = null;
    if (!activeDurableTurn.current || durableCancellationFence.current) return;
    if (foregroundRecoveryWatchdogDisposition(durableAutoRecoveries.current) === "pause") {
      setDurableRecovery("terminal");
      setSending(true);
      return;
    }
    durableRecoveryTimer.current = setTimeout(() => {
      durableRecoveryTimer.current = null;
      durableAutoRecoveries.current += 1;
      void requestDurableRecovery(false);
    }, FOREGROUND_AUTO_RECOVERY_MS);
  }

  async function requestDurableRecovery(manual: boolean) {
    const active = activeDurableTurn.current;
    if (!active) return;
    if (manual) durableAutoRecoveries.current = 0;
    setDurableRecovery("recovering");
    try {
      const response = await viewerFetchWithTimeout("/api/chat/recover", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messageId: active.messageId, threadId: active.threadId }),
      }, 12_000);
      if (activeDurableTurn.current?.messageId !== active.messageId) return;
      if (durableCancellationFence.current?.messageId === active.messageId) return;
      if (response.status === 409) {
        if (durableRecoveryTimer.current) clearTimeout(durableRecoveryTimer.current);
        durableRecoveryTimer.current = null;
        void prepareDurableRetry();
        return;
      }
      if (!response.ok) throw new Error(`conversation recovery rejected (${response.status})`);
      const result = await response.json() as { recovery?: string; assistant?: Msg };
      if (result.recovery === "completed") {
        const assistant = result.assistant;
        if (
          !assistant
          || assistant.role !== "assistant"
          || assistant.status !== "done"
          || assistant.parentMessageId !== active.messageId
          || !assistant.text.trim()
        ) throw new Error("completed turn did not include its reply");
        durableAutoRecoveries.current = foregroundRecoveryBudgetAfterSignal(
          durableAutoRecoveries.current,
          "completed",
        );
        setRecoveredAssistant({ ...assistant, threadId: active.threadId });
        activeDurableTurn.current = null;
        if (durableRecoveryTimer.current) clearTimeout(durableRecoveryTimer.current);
        durableRecoveryTimer.current = null;
        setDurableRecovery("idle");
        setSending(false);
      } else if (result.recovery === "active") {
        durableAutoRecoveries.current = foregroundRecoveryBudgetAfterSignal(
          durableAutoRecoveries.current,
          "active",
        );
        setDurableRecovery("delayed");
        armDurableRecoveryWatchdog();
      } else {
        setDurableRecovery("recovering");
        setSending(true);
        armDurableRecoveryWatchdog();
      }
    } catch (error) {
      if (activeDurableTurn.current?.messageId !== active.messageId) return;
      if (durableCancellationFence.current?.messageId === active.messageId) return;
      document.documentElement.dataset.jarvisRecoveryFailure = String(error).slice(0, 160);
      setDurableRecovery(manual ? "failed" : "delayed");
      setSending(true);
      armDurableRecoveryWatchdog();
    }
  }

  async function cancelDurableTurn(forRetry: boolean): Promise<boolean> {
    const active = activeDurableTurn.current;
    if (!active) return true;
    const existingFence = durableCancellationFence.current;
    if (existingFence?.messageId === active.messageId) return false;
    durableCancellationFence.current = { messageId: active.messageId, forRetry };
    if (durableRecoveryTimer.current) clearTimeout(durableRecoveryTimer.current);
    durableRecoveryTimer.current = null;
    setDurableRecovery("cancelling");
    setSending(true);
    try {
      const response = await viewerFetchWithTimeout("/api/chat/cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messageId: active.messageId, threadId: active.threadId }),
      }, 12_000);
      const result = await response.json().catch(() => ({})) as {
        ok?: unknown;
        cancellation?: unknown;
        messageId?: unknown;
        fenceReceipt?: unknown;
      };
      if (response.status === 409 && result.cancellation === "completed") {
        durableCancellationFence.current = null;
        activeDurableTurn.current = null;
        setDurableRecovery("idle");
        setSending(false);
        return true;
      }
      if (!response.ok) throw new Error(`conversation cancellation rejected (${response.status})`);
      const receipt = authoritativeCancellationReceipt(result, active.messageId);
      if (!receipt) throw new Error("conversation cancellation returned no authoritative fence");
      if (activeDurableTurn.current?.messageId !== active.messageId) return activeDurableTurn.current === null;
      durableCancellationFence.current = { messageId: active.messageId, forRetry, receipt };
      if (forRetry) {
        setDurableRecovery("retry-ready");
      } else {
        activeDurableTurn.current = null;
        durableCancellationFence.current = null;
        setDurableRecovery("idle");
        setSending(false);
      }
      return true;
    } catch (error) {
      if (activeDurableTurn.current?.messageId !== active.messageId) return false;
      durableCancellationFence.current = null;
      document.documentElement.dataset.jarvisCancellationFailure = String(error).slice(0, 160);
      setDurableRecovery(forRetry ? "terminal" : "failed");
      setSending(true);
      return false;
    }
  }

  function prepareDurableRetry() {
    const active = activeDurableTurn.current;
    if (!active) return;
    setDurableRecovery("terminal");
    setSending(true);
    void cancelDurableTurn(true);
  }

  function retryDurableTurn() {
    const active = activeDurableTurn.current;
    const fence = durableCancellationFence.current;
    if (
      !durableRetryReady ||
      !active ||
      fence?.messageId !== active.messageId ||
      !fence.receipt
    ) return;
    activeDurableTurn.current = null;
    durableCancellationFence.current = null;
    if (durableRecoveryTimer.current) clearTimeout(durableRecoveryTimer.current);
    durableRecoveryTimer.current = null;
    setDurableRecovery("idle");
    void queueDurableTurn(active.text, active.visibleText, active.fileIds);
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

  async function submit(text: string, options: SubmitOptions = {}) {
    const t = text.trim();
    const fileIds = guest ? [] : [...selectedFileIds];
    if (!guest && pendingFileIds.length) {
      showCaption({
        who: "jarvis",
        text: `I’m still indexing ${pendingFileIds.length} file${pendingFileIds.length === 1 ? "" : "s"}. I’ll keep them with this message and enable send when they’re ready.`,
        phase: "ready",
      });
      return;
    }
    if (!t && !fileIds.length) return;
    const visibleText = t || "Analyze the attached files.";
    if (durableSubmissionInFlight.current || activeDurableTurn.current) {
      if (!options.interruptCurrent || durableSubmissionInFlight.current || !activeDurableTurn.current) {
        showCaption({ who: "jarvis", text: "I’m finishing the current reply first. You can recover or retry it from the status bar." });
        return;
      }
      mutedNarrationParentsRef.current.add(String(activeDurableTurn.current.messageId));
      finalNarrationGenerationRef.current += 1;
      const cancelled = await cancelDurableTurn(false);
      if (!cancelled) {
        showCaption({ who: "jarvis", text: "I heard the interruption, but the previous turn has not stopped safely yet." });
        return;
      }
    }
    // Typed/button calls reach this inside a user gesture. Live/STT calls have
    // already been primed by the control that opened the microphone.
    unlockSpeechPlayback();
    // double-tap / Enter+click within 2.5s = one send, not two
    const sendFingerprint = `${visibleText}\u0000${fileIds.join(",")}`;
    if (sendFingerprint === lastSent.current.text && Date.now() - lastSent.current.ts < 2500) return;
    lastSent.current = { text: sendFingerprint, ts: Date.now() };
    finalNarrationGenerationRef.current += 1;
    finalNarrationMessageRef.current = "";
    voiceReplayRef.current = null;
    setVoiceReplayReady(false);
    if (streamingSpeechRef.current.timer) clearTimeout(streamingSpeechRef.current.timer);
    streamingSpeechRef.current = {
      id: "",
      scheduledChars: 0,
      spokenChars: 0,
      failed: false,
      chain: Promise.resolve(),
      timer: null,
      pendingPrefix: "",
      pendingCaption: "",
    };
    updateConversationMood(visibleText);
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
    const embeddedHostIntent = embedded && !fileIds.length ? parseEmbeddedHostIntent(t) : null;
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
    else if (!guest && panel && !isPanelFollowUp(visibleText, panel)) {
      closedPanelRef.current = {
        key: `${panel.title ?? ""}|${panel.value.slice(0, 160)}`,
        ts: Date.now(),
      };
      setInstantPanel(null);
      setPanelFull(false);
      setPanelMin(true); // hide locally during the authenticated clear round-trip
      void clearPanel({});
    }
    const fastDispatch = guest || fileIds.length ? null : parseFastAgentDispatch(t);
    if (fastDispatch) {
      void openFastAgentDispatch(fastDispatch, t);
      return;
    }
    const fastChart = !guest && !fileIds.length && !liveRef.current ? parseFastChartIntent(t) : null;
    if (fastChart) {
      void openFastChart(fastChart, t);
      return;
    }
    const fastNetWorth = guest || fileIds.length ? null : parseFastNetWorthIntent(t);
    if (fastNetWorth) {
      void openFastNetWorth(fastNetWorth, t);
      return;
    }
    const instant = fileIds.length ? null : instantSocialReply(t);
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
    let modelText = visibleText;
    if (embedded) {
      // Voice turns prewarm this read-only host snapshot while the user is
      // speaking. Typed turns retain the same bounded on-demand fallback.
      const context = options.hostContext !== undefined
        ? options.hostContext
        : await requestHostContext();
      if (context) {
        const bounded = needsHostContext(visibleText)
          ? context
          : { ...context, selection: undefined, text: undefined };
        modelText = withHostContext(visibleText, bounded);
      }
    }
    await queueDurableTurn(modelText, visibleText, fileIds, options);
  }

  function stopTalking() {
    finalNarrationGenerationRef.current += 1;
    finalNarrationMessageRef.current = "";
    if (lastSubmittedParentId.current) mutedNarrationParentsRef.current.add(lastSubmittedParentId.current);
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
  async function ensurePersistentLiveMic(): Promise<LiveMicrophoneResources> {
    const current = liveMicRef.current;
    if (current && current.stream.getAudioTracks().some((track) => track.readyState === "live")) return current;
    // Browsers may leave getUserMedia unresolved while their native permission
    // prompt is open. Share that single request across every caller so an
    // auto-start retry can never create or leak a second capture stream.
    if (liveMicOpeningRef.current) return liveMicOpeningRef.current;
    const opening = (async (): Promise<LiveMicrophoneResources> => {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          // AGC amplifies residual loudspeaker echo and turns it into false VAD.
          autoGainControl: false,
          channelCount: 1,
        },
      });
      rememberMicrophoneGrant();
      // Wake-word/live sessions can begin without a fresh click. Once capture
      // is active browsers permit media playback, so prime the neural player
      // here and keep the later response out of the autoplay dead end.
      unlockSpeechPlayback();
      const context = new AudioContext({ latencyHint: "interactive" });
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.35;
      context.createMediaStreamSource(stream).connect(analyser);
      const aecEnabled = stream.getAudioTracks().some((track) => track.getSettings().echoCancellation === true);
      const resources = { stream, context, analyser, aecEnabled };
      liveMicRef.current = resources;
      stream.getAudioTracks().forEach((track) => {
        track.addEventListener?.("ended", () => {
          if (liveMicRef.current !== resources) return;
          liveMicRef.current = null;
          forgetMicrophoneGrant();
          if (liveRef.current) {
            endFreeVoiceSession();
            showCaption({ who: "jarvis", text: "Microphone access ended. Re-enable it once to resume live voice." });
          }
          void refreshPermissions();
        }, { once: true });
      });
      return resources;
    })();
    liveMicOpeningRef.current = opening;
    try {
      return await opening;
    } finally {
      if (liveMicOpeningRef.current === opening) liveMicOpeningRef.current = null;
    }
  }

  // A live session keeps its AEC microphone open while Jarvis speaks. This
  // monitor never records or submits speaker audio; it only looks for a
  // conservative sustained near-field interruption, then hushes the current
  // narration and lets the normal authenticated capture path collect the new
  // turn. Browsers that cannot confirm AEC retain the explicit hush control.
  useEffect(() => {
    if (live !== "live" || !speaking) return;
    const epoch = ++liveInterruptionEpoch.current;
    let timer: ReturnType<typeof setInterval> | null = null;
    void ensurePersistentLiveMic().then(({ context, analyser, aecEnabled }) => {
      if (!aecEnabled || epoch !== liveInterruptionEpoch.current || live !== "live" || !speakingRef.current) return;
      const spectrum = new Uint8Array(analyser.frequencyBinCount);
      const startedAt = Date.now();
      let vad = createLiveVadState(startedAt);
      timer = setInterval(() => {
        if (epoch !== liveInterruptionEpoch.current || !speakingRef.current) return;
        analyser.getByteFrequencyData(spectrum);
        const level = spectrum.reduce((sum, value) => sum + value, 0) / Math.max(1, spectrum.length);
        const result = advanceLiveVad(vad, {
          level,
          voiceLevel: spectrumBandLevel(spectrum, context.sampleRate, 90, 3_800),
          highFrequencyLevel: spectrumBandLevel(spectrum, context.sampleRate, 4_500, 10_000),
          now: Date.now(),
          startedAt,
          ttsActive: true,
          quietUntil: 0,
          aecEnabled: true,
        });
        vad = result.state;
        if (!result.bargeIn) return;
        document.documentElement.dataset.jarvisBargeDetectedMs = String(Math.round(performance.now()));
        confirmedBargeAtRef.current = Date.now();
        voiceInterruptionPendingRef.current = true;
        stopTalking();
      }, LIVE_BARGE_SAMPLE_MS);
    }).catch(() => undefined);
    return () => {
      liveInterruptionEpoch.current += 1;
      if (timer) clearInterval(timer);
    };
    // `stopTalking` and `ensurePersistentLiveMic` are stable component
    // declarations; only live/speaking transitions own this monitor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, speaking]);
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
    if (!guest) void setLiveOn({ client: me.current, on: false }).catch(() => {});
  }

  function endFreeVoiceSession() {
    liveSessionEpoch.current += 1;
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
    const sessionEpoch = ++liveSessionEpoch.current;
    if (!forceStart && (liveRef.current || live !== "off")) {
      liveManuallyStopped.current = true;
      resumeLiveWhenVisible.current = false;
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
    liveManuallyStopped.current = false;
    unlockSpeechPlayback();
    // Stop the browser wake recognizer and open the persistent stream before a
    // network round-trip. Otherwise the wake mic visibly closes while Convex
    // elects the live owner, then opens again a moment later.
    const { stopWake } = await import("../lib/wakeword");
    if (sessionEpoch !== liveSessionEpoch.current) return false;
    stopWake();
    setWake(false);
    freeLoop.current = true;
    liveRef.current = true;
    setLive("connecting");
    let microphoneError: unknown = null;
    const microphone = ensurePersistentLiveMic().then(
      () => true,
      (error) => {
        microphoneError = error;
        const name = String((error as DOMException | undefined)?.name ?? "");
        if (/NotAllowed|Security/i.test(name)) forgetMicrophoneGrant();
        return false;
      },
    );
    const ownership = guest
      ? Promise.resolve(true)
      : setLiveOn({ client: me.current, on: true });
    let owned = false;
    try {
      owned = await withClientDeadline(ownership, 5_000, "live ownership");
    } catch {
      // A late successful claim must not leave a ghost live owner after this
      // UI has already recovered to standby.
      void ownership.then((claimed) => {
        if (!guest && claimed && !liveRef.current) void setLiveOn({ client: me.current, on: false }).catch(() => {});
      }, () => undefined);
    }
    if (sessionEpoch !== liveSessionEpoch.current || !liveRef.current) {
      void microphone.then((opened) => { if (opened && !liveRef.current) closePersistentLiveMic(); });
      if (!guest && owned && !liveRef.current) void setLiveOn({ client: me.current, on: false }).catch(() => {});
      return false;
    }
    if (owned === false) {
      freeLoop.current = false;
      liveRef.current = false;
      setLive("off");
      closePersistentLiveMic();
      void microphone.then((opened) => { if (opened && !liveRef.current) closePersistentLiveMic(); });
      showCaption({ who: "jarvis", text: "I could not start live listening. Check the connection, then tap the mic to retry." });
      rearmWake();
      return false;
    }
    // Do not time out a browser-owned permission prompt. A timeout cannot
    // cancel getUserMedia and previously caused auto-start to issue overlapping
    // capture requests. Manual Stop still advances the session epoch and the
    // late stream is closed by the guard below.
    const microphoneReady = await microphone;
    if (sessionEpoch !== liveSessionEpoch.current || !liveRef.current) {
      if (microphoneReady && !liveRef.current) closePersistentLiveMic();
      return false;
    }
    if (!microphoneReady) {
      freeLoop.current = false;
      liveRef.current = false;
      setLive("off");
      releaseLive();
      const errorName = String((microphoneError as DOMException | undefined)?.name ?? "");
      showCaption({
        who: "jarvis",
        text: /NotAllowed|Security/i.test(errorName)
          ? "Microphone access is blocked. Allow it once in this site's browser settings, then tap Enable live voice."
          : "I could not open the microphone yet. Tap Enable live voice to retry.",
      });
      void refreshPermissions();
      rearmWake();
      return false;
    }
    void ownVoice();
    import("../lib/tts").then((m) => m.stopSpeaking());
    if (sessionEpoch !== liveSessionEpoch.current || !liveRef.current) return false;
    setLive("live");
    void refreshPermissions();
    if (liveBeat.current) clearInterval(liveBeat.current);
    if (shouldMaintainLiveHeartbeat({ guest, visible: !document.hidden, live: liveRef.current })) {
      liveBeat.current = setInterval(() => {
        if (!shouldMaintainLiveHeartbeat({ guest, visible: !document.hidden, live: liveRef.current })) return;
        void setLiveOn({ client: me.current, on: true }).catch(() => {});
      }, 20_000);
    }
    if (captureImmediately) void freeVoiceTurn();
    return true;
  }

  useEffect(() => () => {
    liveSessionEpoch.current += 1;
    liveRef.current = false;
    cancelFreeRearm();
    closePersistentLiveMic();
  }, []);

  useEffect(() => {
    const releaseHiddenLiveSession = () => {
      if (!document.hidden) {
        rearmWake();
        if (resumeLiveWhenVisible.current && !liveManuallyStopped.current) {
          resumeLiveWhenVisible.current = false;
          liveAutoStarted.current = true;
          void toggleLive(true).then((started) => {
            if (!started) liveAutoStarted.current = false;
          });
        }
        return;
      }
      if (!liveRef.current) return;
      resumeLiveWhenVisible.current = !liveManuallyStopped.current;
      endFreeVoiceSession();
    };
    document.addEventListener("visibilitychange", releaseHiddenLiveSession);
    return () => document.removeEventListener("visibilitychange", releaseHiddenLiveSession);
    // Voice/session state is ref-backed so this listener remains stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function enableMicrophone() {
    if (permissionBusy) return;
    if (permissions.microphone === "denied") {
      alert("Microphone access is blocked. Open this site's browser settings, set Microphone to Allow, then return here.");
      return;
    }
    setPermissionBusy(true);
    unlockSpeechPlayback();
    liveAutoStarted.current = true;
    const started = await toggleLive(true).catch(() => false).finally(() => setPermissionBusy(false));
    const current = await readJarvisPermissions().catch(() => permissions);
    setPermissions(current);
    if (started) {
      setPref("liveDefault", true);
      liveAutoStarted.current = true;
    } else {
      liveAutoStarted.current = false;
    }
    if (!started && current.microphone === "denied") {
      alert("Microphone access is blocked. Open this site's browser settings and allow it once.");
    }
  }

  useEffect(() => {
    if (!shouldAutoStartLiveVoice({
      embedded,
      visible: !document.hidden,
      liveDefault: prefs.liveDefault,
      permission: permissions.microphone,
      attempted: liveAutoStarted.current,
      manuallyStopped: liveManuallyStopped.current,
    })) return;
    let disposed = false;
    const attempt = async () => {
      if (disposed || liveRef.current || liveManuallyStopped.current || document.hidden) return;
      const started = await toggleLive(true);
      if (disposed) return;
      if (started) {
        liveAutoRetryCount.current = 0;
        return;
      }
      const current = await readJarvisPermissions();
      if (disposed) return;
      setPermissions(current);
      if (current.microphone === "denied" || current.microphone === "unsupported" || liveManuallyStopped.current) return;
      liveAutoRetryCount.current += 1;
      const delay = liveVoiceRetryDelay(liveAutoRetryCount.current);
      if (delay == null) return;
      liveAutoRetryTimer.current = window.setTimeout(() => void attempt(), delay);
    };
    const cancelBootstrap = scheduleAutoLiveBootstrap(
      attempt,
      (attempted) => { liveAutoStarted.current = attempted; },
    );
    return () => {
      disposed = true;
      cancelBootstrap();
      if (liveAutoRetryTimer.current) window.clearTimeout(liveAutoRetryTimer.current);
      liveAutoRetryTimer.current = null;
    };
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
    // A guest conversation is intentionally text/voice only. Keep this guard
    // alongside the hidden control so a stale event handler cannot upload a
    // camera frame during a session transition.
    if (guest || camSeeing) return;
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
    // Screen frames are an owner capability: they are persisted to R2 before
    // the foreground worker can inspect them.
    if (guest || seeing) return;
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
    const voiceRequestId = globalThis.crypto?.randomUUID?.()
      ?? `voice-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const voiceTrace: VoiceTurnTrace = { turnId: voiceRequestId, startedAt: performance.now() };
    let outcome: VoiceCaptureOutcome = "failure";
    let recoveryDelayMs = 900;
    let pendingSttController: AbortController | null = null;
    let browserPreview: BrowserSpeechPreview | null = null;
    let previousBrowserPreview: BrowserSpeechPreview | null = null;
    let previewRecognizer: BrowserSpeechRecognizer | null = null;
    let browserPreviewCaptureOpen = false;
    const researchState: {
      controller: AbortController | null;
      promise: Promise<LiveResearchResponse | null> | null;
      result: LiveResearchResponse | null;
    } = { controller: null, promise: null, result: null };
    let researchStarted = false;
    // Embedded context is cheap, local and read-only. Starting this bounded
    // parent handshake now removes its former 120ms post-transcription stall.
    const hostContextPromise = embedded
      ? requestHostContext()
      : Promise.resolve<JarvisHostContext | null>(null);
    setLiveResearch({ phase: "idle", sourceCount: 0 });
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
        for (let attempt = 0; attempt < 2; attempt += 1) {
          let failure: SpeechRecognitionRequestError | null = null;
          try {
            const response = await viewerFetchWithTimeout("/api/stt", {
              method: "POST",
              headers: {
                "content-type": mime,
                "x-jarvis-continuous-live": "1",
                "x-jarvis-stt-attempt": String(attempt + 1),
                "x-jarvis-voice-frames": String(evidence.acceptedFrames),
                "x-jarvis-speech-span-ms": String(Math.round(speechSpanMs)),
                "x-jarvis-peak-voice-margin": String(Math.round(evidence.peakVoiceMargin * 10) / 10),
              },
              body: blob,
              signal: controller.signal,
            }, 30_000);
            const transcript = await transcriptFromSttResponse(response);
            sttFailureStreak.current = 0;
            return transcript;
          } catch (error) {
            if (error instanceof DOMException && error.name === "AbortError") throw error;
            failure = error instanceof SpeechRecognitionRequestError
              ? error
              : new SpeechRecognitionRequestError("Speech recognition connection failed", {
                status: 0,
                code: "stt_network_error",
              });
          }
          if (!failure.retryable || attempt === 1) throw failure;

          const browserRecovery = recoverLiveTranscriptFromBrowser({
            previous: previousBrowserPreview,
            preview: browserPreview,
            sessionId: voiceRequestId,
            currentVoiceAt: evidence.lastVoice,
            sessionActive: freeLoop.current && sessionEpoch === liveSessionEpoch.current,
          });
          if (browserRecovery) {
            voiceTrace.transcriptSource = "browser-final";
            document.documentElement.dataset.jarvisAuthoritativeStt = "browser-recovery";
            return browserRecovery;
          }

          recoveryDelayMs = speechServiceRetryDelay(sttFailureStreak.current + 1, failure.retryAfterMs);
          showCaption({
            who: "jarvis",
            text: `I kept your recording. Speech recognition is reconnecting and will retry it in ${Math.ceil(recoveryDelayMs / 1_000)} seconds.`,
          });
          await new Promise<void>((resolve, reject) => {
            const timer = window.setTimeout(resolve, recoveryDelayMs);
            const abort = () => {
              window.clearTimeout(timer);
              reject(new DOMException("Voice session ended", "AbortError"));
            };
            if (controller.signal.aborted) abort();
            else controller.signal.addEventListener("abort", abort, { once: true });
          });
        }
        throw new SpeechRecognitionRequestError("Speech recognition retry exhausted", {
          status: 502,
          code: "stt_retry_exhausted",
        });
      };
      const startLiveResearch = (currentPartial: string, previousPartial: string) => {
        if (researchStarted || !buildSpeculativeResearchQuery(currentPartial)) return;
        if (!shouldStartLiveResearchPreview({
          authoritativePartialTranscript: currentPartial,
          previousAuthoritativePartialTranscript: previousPartial,
          alreadyStarted: researchStarted,
        })) return;
        researchStarted = true;
        const controller = new AbortController();
        researchState.controller = controller;
        const startedAt = performance.now();
        document.documentElement.dataset.jarvisResearchPrefetch = "researching";
        setLiveResearch({ phase: "researching", sourceCount: 0 });
        researchState.promise = viewerFetchWithTimeout("/api/chat/prefetch", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            partialText: currentPartial,
            threadId: threadRef.current,
            requestId: voiceRequestId,
          }),
          signal: controller.signal,
        }, 6_000).then(async (response) => {
          if (!response.ok) return null;
          const payload = await response.json() as Partial<LiveResearchResponse>;
          if (
            typeof payload.receipt !== "string" || !payload.receipt ||
            typeof payload.query !== "string" ||
            !Array.isArray(payload.sources) ||
            typeof payload.expiresAt !== "number"
          ) return null;
          const result = payload as LiveResearchResponse;
          if (!freeLoop.current || sessionEpoch !== liveSessionEpoch.current) return null;
          document.documentElement.dataset.jarvisResearchPrefetch = "ready";
          document.documentElement.dataset.jarvisResearchPrefetchMs = String(Math.round(performance.now() - startedAt));
          document.documentElement.dataset.jarvisResearchPrefetchSources = String(result.sources.length);
          setLiveResearch({ phase: "ready", sourceCount: result.sources.length });
          voiceTrace.researchState = "ready";
          voiceTrace.researchSourceCount = result.sources.length;
          researchState.result = result;
          return result;
        }).catch(() => null);
      };
      recRef.current = rec;
      const t0 = Date.now();
      let vad = createLiveVadState(t0);
      browserPreviewCaptureOpen = true;
      // Wake recognition is already stopped for a standalone live session.
      // An embedded live session explicitly asks its trusted host to stop its
      // recognizer before this iframe starts one, preventing dual ownership.
      const startBrowserPreview = () => {
        if (
          previewRecognizer
          || !browserPreviewCaptureOpen
          || !freeLoop.current
          || sessionEpoch !== liveSessionEpoch.current
        ) return;
        const speechWindow = window as typeof window & {
          SpeechRecognition?: BrowserSpeechRecognizerConstructor;
          webkitSpeechRecognition?: BrowserSpeechRecognizerConstructor;
        };
        const BrowserRecognizer = speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
        if (BrowserRecognizer) {
          try {
            const recognizer = new BrowserRecognizer();
            previewRecognizer = recognizer;
            recognizer.lang = "en-GB";
            recognizer.continuous = true;
            recognizer.interimResults = true;
            recognizer.maxAlternatives = 1;
            recognizer.onresult = (event) => {
              if (!freeLoop.current || sessionEpoch !== liveSessionEpoch.current) return;
              const segments: string[] = [];
              let allFinal = event.results.length > 0;
              let finalConfidence = 1;
              for (let index = 0; index < event.results.length; index += 1) {
                const result = event.results[index];
                const alternative = result?.[0];
                const segment = String(alternative?.transcript ?? "").trim();
                if (segment) segments.push(segment);
                allFinal = allFinal && result?.isFinal === true;
                if (result?.isFinal) {
                  const confidence = Number(alternative?.confidence ?? 0);
                  finalConfidence = Number.isFinite(confidence) && confidence > 0
                    ? Math.min(finalConfidence, confidence)
                    : 0;
                }
              }
              const text = segments.join(" ").trim();
              if (!text) return;
              const candidate: BrowserSpeechPreview = {
                sessionId: voiceRequestId,
                text,
                isFinal: allFinal,
                confidence: allFinal ? finalConfidence : 0,
                observedVoiceAt: vad.lastVoice,
              };
              const previous = browserPreview;
              if (
                previous?.text === candidate.text
                && previous.isFinal === candidate.isFinal
                && previous.confidence === candidate.confidence
              ) return;
              previousBrowserPreview = previous;
              browserPreview = candidate;
              document.documentElement.dataset.jarvisBrowserSpeechPreview = allFinal ? "final" : "interim";
              if (isStableBrowserSpeechRevision(previousBrowserPreview, candidate)) {
                startLiveResearch(candidate.text, previousBrowserPreview?.text ?? "");
              }
            };
            recognizer.onerror = () => {
              document.documentElement.dataset.jarvisBrowserSpeechPreview = "unavailable";
            };
            recognizer.start();
          } catch {
            previewRecognizer = null;
            document.documentElement.dataset.jarvisBrowserSpeechPreview = "unavailable";
          }
        }
      };
      if (wakeOwnedByHost()) {
        void claimEmbeddedBrowserPreview(voiceRequestId).then((granted) => {
          if (granted) startBrowserPreview();
        });
      } else {
        startBrowserPreview();
      }
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
          energyRef.current = Math.min(1, level / 90);
          if (!listeningCaptionShown) {
            listeningCaptionShown = true;
            showCaption({ who: "you", text: "Listening…" });
          }
        }
        if (result.bargeIn) {
          void import("../lib/tts").then((m) => m.stopSpeaking());
          setSpeaking(false);
        }
        if (
          shouldCloseLiveUtterance(vad, now, browserPreview?.text)
          || (!vad.spoke && now - t0 > 8000)
          || now - t0 > 25_000
        ) {
          clearInterval(poll);
          if (rec.state === "recording") rec.stop();
        }
      }, 90);
      await new Promise<void>((resolve) => {
        rec.onstop = () => {
          browserPreviewCaptureOpen = false;
          try { previewRecognizer?.stop(); } catch { /* browser preview already ended */ }
          resolve();
        };
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
      voiceTrace.speechClosedAt = speechClosedAt;
      document.documentElement.dataset.jarvisSpeechClosedMs = String(Math.round(speechClosedAt));
      showCaption({ who: "you", text: "Processing…" });
      const transcriptSource = chooseLiveTranscriptSource({
        preview: browserPreview,
        sessionId: voiceRequestId,
        currentVoiceAt: vad.lastVoice,
        sessionActive: freeLoop.current && sessionEpoch === liveSessionEpoch.current,
      });
      let text: string;
      if (transcriptSource.source === "browser-final") {
        text = transcriptSource.text;
        voiceTrace.transcriptSource = "browser-final";
        document.documentElement.dataset.jarvisAuthoritativeStt = "browser-final";
      } else {
        const controller = new AbortController();
        pendingSttController = controller;
        sttAbortRef.current = controller;
        text = await requestTranscript(blob, controller, { ...vad });
        if (!voiceTrace.transcriptSource) {
          voiceTrace.transcriptSource = "server";
          document.documentElement.dataset.jarvisAuthoritativeStt = "server";
        }
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
        showCaption({ who: "you", text: "Listening…" });
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
      voiceTrace.transcriptReadyAt = performance.now();
      document.documentElement.dataset.jarvisTranscriptionMs = String(Math.round(performance.now() - speechClosedAt));
      const researchResult = researchState.result;
      if (researchState.promise && !researchResult) {
        // The rolling checkpoints give preview research seconds of useful
        // overlap. Never add a fixed tail wait after the final transcript; a
        // late optional preview is discarded and the authoritative turn starts.
        researchState.controller?.abort();
        voiceTrace.researchState = "discarded";
        document.documentElement.dataset.jarvisResearchPrefetch = "late-or-discarded";
      }
      const prewarmedHostContext = embedded ? await hostContextPromise : undefined;
      showCaption({ who: "you", text: cleanedText });
      outcome = "speech";
      const interruptCurrent = voiceInterruptionPendingRef.current;
      voiceInterruptionPendingRef.current = false;
      setLiveResearch({ phase: "idle", sourceCount: 0 });
      void submit(cleanedText, {
        requestId: voiceRequestId,
        researchReceipt: researchResult?.receipt,
        interruptCurrent,
        hostContext: prewarmedHostContext,
        voiceTrace,
      });
    } catch (error) {
      const aborted = error instanceof DOMException && error.name === "AbortError";
      outcome = aborted ? "empty" : "failure";
      if (!aborted) {
        document.documentElement.dataset.jarvisVoiceRecovery = String(error).slice(0, 160);
        if (error instanceof SpeechRecognitionRequestError) {
          if (error.retryable) {
            sttFailureStreak.current += 1;
            recoveryDelayMs = speechServiceRetryDelay(sttFailureStreak.current, error.retryAfterMs);
            document.documentElement.dataset.jarvisSttRecoveryDelayMs = String(recoveryDelayMs);
            showCaption({
              who: "jarvis",
              text: `I could not recover that recording. Speech recognition will reconnect in ${Math.ceil(recoveryDelayMs / 1_000)} seconds; then I’m listening again.`,
            });
          } else {
            outcome = "empty";
            endFreeVoiceSession();
            if (error.status === 401 || error.status === 403) {
              showCaption({ who: "jarvis", text: "The voice session expired. I’m refreshing it now." });
              window.setTimeout(() => window.location.reload(), 600);
            } else {
              showCaption({
                who: "jarvis",
                text: "Speech recognition is not configured right now. Live listening has stopped instead of retrying in a loop.",
              });
            }
          }
        } else {
          closePersistentLiveMic();
          showCaption({ who: "jarvis", text: "The microphone capture stopped unexpectedly. I’m reopening it now." });
        }
      }
    } finally {
      // Also fences a delayed embedded ownership grant after cancellation.
      browserPreviewCaptureOpen = false;
      try { (previewRecognizer as BrowserSpeechRecognizer | null)?.abort?.(); } catch { /* preview already stopped */ }
      pendingSttController?.abort();
      researchState.controller?.abort();
      if (outcome !== "speech") voiceInterruptionPendingRef.current = false;
      setLiveResearch({ phase: "idle", sourceCount: 0 });
      recRef.current = null;
      energyRef.current = 0;
      freeBusy.current = false;
      const action = nextVoiceLoopAction({
        outcome,
        persistentLive: liveRef.current,
        loopRequested: freeLoop.current,
      });
      if (action === "listen") scheduleFreeVoiceTurn(outcome === "speech" ? 90 : outcome === "failure" ? recoveryDelayMs : 180);
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
    unlockSpeechPlayback();
    // barge-in: JARVIS shuts up the moment Daniel reaches for the mic, so the
    // recording can't capture his voice as input
    import("../lib/tts").then((m) => m.stopSpeaking());
    setSpeaking(false);
    void ownVoice();
    const voiceRequestId = globalThis.crypto?.randomUUID?.()
      ?? `voice-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const voiceTrace: VoiceTurnTrace = { turnId: voiceRequestId, startedAt: performance.now() };
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
    const startedAt = performance.now();
    let context: AudioContext | null = null;
    let vadTimer: number | null = null;
    try {
      const captureContext = new AudioContext({ latencyHint: "interactive" });
      context = captureContext;
      if (captureContext.state === "suspended") void captureContext.resume().catch(() => {});
      const analyser = captureContext.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.35;
      captureContext.createMediaStreamSource(stream).connect(analyser);
      const spectrum = new Uint8Array(analyser.frequencyBinCount);
      let vad = createLiveVadState(startedAt);
      vadTimer = window.setInterval(() => {
        if (rec.state !== "recording") return;
        analyser.getByteFrequencyData(spectrum);
        const now = performance.now();
        vad = advanceLiveVad(vad, {
          level: spectrumBandLevel(spectrum, captureContext.sampleRate, 85, 1_500),
          voiceLevel: spectrumBandLevel(spectrum, captureContext.sampleRate, 85, 1_500),
          highFrequencyLevel: spectrumBandLevel(spectrum, captureContext.sampleRate, 3_200, 7_500),
          now,
          startedAt,
          quietUntil: 0,
          ttsActive: false,
        }).state;
        if (shouldCloseLiveUtterance(vad, now)) rec.stop();
      }, 72);
    } catch {
      // Recording and the bounded hard stop still work when Web Audio is not
      // available; only silence auto-close is omitted on that browser.
    }
    const hardStopTimer = window.setTimeout(() => rec.state === "recording" && rec.stop(), 20_000);
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = async () => {
      if (vadTimer !== null) window.clearInterval(vadTimer);
      window.clearTimeout(hardStopTimer);
      stream.getTracks().forEach((t) => t.stop());
      void context?.close().catch(() => {});
      setRecording(false);
      voiceTrace.speechClosedAt = performance.now();
      const blob = new Blob(chunks, { type: mime });
      if (blob.size < 2000) {
        showCaption({ who: "jarvis", text: "I did not catch enough speech. Tap the microphone and try again.", phase: "ready" });
        return;
      }
      try {
        showCaption({ who: "you", text: "Processing…" });
        const text = await transcribeRecordedAudio(blob, mime);
        voiceTrace.transcriptSource = "server";
        if (isMeaningfulSpeechTranscript(text)) {
          const { isEchoOfTts } = await import("../lib/tts");
          if (isEchoOfTts(text)) return; // that was JARVIS's own voice leaking in
          const cleaned = text;
          const previousVoice = lastVoiceInput.current;
          if (isRecentVoiceDuplicate(cleaned, previousVoice)) return;
          lastVoiceInput.current = { text: cleaned, at: Date.now() };
          voiceTrace.transcriptReadyAt = performance.now();
          showCaption({ who: "you", text: cleaned });
          void submit(cleaned, { requestId: voiceRequestId, voiceTrace });
        } else {
          showCaption({ who: "jarvis", text: "I could not make out that request. Tap the microphone and try again.", phase: "ready" });
        }
      } catch (error) {
        document.documentElement.dataset.jarvisSttFailure = String(error).slice(0, 160);
        showCaption({
          who: "jarvis",
          text: error instanceof SpeechRecognitionRequestError
            ? error.retryable
              ? "Speech recognition is temporarily unavailable. Tap the microphone to retry."
              : error.status === 401 || error.status === 403
                ? "The voice session expired. Refresh Jarvis once, then try again."
                : "Speech recognition is not configured right now."
            : "The recording could not be processed. Tap the microphone to retry.",
          phase: "ready",
        });
      }
    };
    recRef.current = rec;
    setRecording(true);
    rec.start();
  }

  const hostAssistant = [...messages]
    .reverse()
    .find((message) => message.role === "assistant" && message.delivery !== "notification");
  const latestUserMessage = [...messages]
    .reverse()
    .find((message) => message.role === "user" && message.delivery !== "notification");
  const status: CompactFeedbackPhase =
    live === "connecting"
      ? "connecting"
      : speaking || ttsRuntimeStatus === "speaking"
        ? "speaking"
        : ttsRuntimeStatus === "buffering"
          ? "buffering"
          : ttsRuntimeStatus === "blocked"
            ? "voice paused"
            : ttsRuntimeStatus === "unavailable" && voiceReplayReady
              ? "voice unavailable"
          : hostAssistant?.status === "streaming" && Boolean(hostAssistant.text)
            ? "responding"
            : busy
              ? "thinking"
              : liveResearch.phase !== "idle"
                ? "researching"
                : recording || live === "live"
                  ? "listening"
                  : "online";
  const hostPhase = status;
  const hostProgress = foregroundUiProgress({
    phase: hostPhase,
    elapsedMs: foregroundElapsedMs,
    streamedChars: hostAssistant?.status === "streaming" ? hostAssistant.text.length : 0,
    researchReady: liveResearch.phase === "ready",
    recovery: durableRecovery,
  });
  useEffect(() => {
    if (!embedded || !parentOrigin || window.parent === window) return;
    postToParent({ jarvis: "status", phase: hostPhase, progress: hostProgress });
    // Stream length is intentionally reduced to a bounded progress bucket;
    // no private transcript text crosses into the surrounding app.
  }, [embedded, parentOrigin, hostPhase, hostProgress]);
  const orbState =
    speaking || ttsRuntimeStatus === "speaking"
      ? "speaking"
      : busy || liveResearch.phase !== "idle"
        ? "thinking"
        : recording || live === "live"
          ? "listening"
          : "idle";
  const compactFeedbackText = compactChatFeedback({
    phase: hostPhase,
    caption: caption ? { who: caption.who, text: caption.text } : null,
    latestUser: latestUserMessage?.text ? visibleTurnText(latestUserMessage.text) : undefined,
    latestAssistant: hostAssistant?.text ? safeEmbeddedMessageText(hostAssistant) : undefined,
    assistantStreaming: hostAssistant?.status === "streaming",
  });
  const foregroundRecoveryVisible = submissionRetryReady || shouldOfferForegroundRecovery({
    elapsedMs: foregroundElapsedMs,
    hasActiveTurn: Boolean(activeDurableTurn.current),
    recovery: durableRecovery,
  });
  const foregroundRecoveryMessage = submissionRetryReady
    ? "Send was not confirmed. Retry keeps the same request ID."
    : durableRecovery === "waiting"
      ? "Still working on this reply."
      : durableRecovery === "cancelling"
        ? "Stopping and securing this exact reply…"
        : durableRecovery === "retry-ready"
          ? "That reply is safely stopped. Retry is ready."
          : durableRecovery === "recovering"
            ? "Reconnecting this reply…"
            : durableRecovery === "terminal"
              ? "That reply stopped after recovery attempts."
              : "That reply stopped before it finished.";
  const foregroundRecoveryAction = submissionRetryReady
    ? retryFailedSubmission
    : durableRetryReady
      ? retryDurableTurn
      : durableRecovery === "terminal"
        ? prepareDurableRetry
        : () => void requestDurableRecovery(true);
  const foregroundRecoveryActionLabel = submissionRetryReady
    ? "retry send"
    : durableRetryReady
      ? "retry"
      : durableRecovery === "waiting"
        ? "check"
        : durableRecovery === "terminal" || durableRecovery === "retry-ready"
          ? "secure retry"
          : "recover";
  const foregroundRecoveryActionDisabled = durableRecovery === "recovering"
    || durableRecovery === "cancelling"
    || (durableRecovery === "retry-ready" && !durableRetryReady);
  const voiceRecoveryVisible = ttsRuntimeStatus === "blocked" || voiceReplayReady;

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
  const embeddedWorkspacePanel = embedded
    && overlayUp
    && (panelFull || panelRoute?.presentation !== "compact");

  if (embedded && !embeddedExpanded) {
    return (
      <div
        data-jarvis-embed-surface
        data-jarvis-embed-expanded="false"
        data-voice-state={orbState}
        className="relative flex h-dvh w-full flex-col justify-between gap-2 overflow-hidden rounded-2xl border border-white/10 bg-[#05070d]/95 p-2.5 shadow-2xl backdrop-blur-xl"
      >
        <div className="flex min-w-0 items-start gap-2 pr-16">
          <button
            type="button"
            onClick={() => speaking ? stopTalking() : void toggleLive()}
            aria-label={speaking ? "Interrupt Jarvis" : live === "live" ? "Stop Jarvis live listening" : "Start Jarvis live listening"}
            className={`mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-full ring-1 ${
              live === "live" || orbState === "listening"
                ? "bg-cyan/20 text-cyan ring-cyan/50"
                : orbState === "thinking"
                  ? "bg-amber/15 text-amber ring-amber/40"
                  : "bg-cyan/10 text-cyan ring-cyan/25"
            }`}
          >
            <span className={`h-2.5 w-2.5 rounded-full bg-current ${orbState === "idle" ? "" : "animate-pulse"}`} />
          </button>
          <div className="min-w-0 flex-1">
            <div className="hud-label flex items-center gap-2 text-cyan">
              <span>JARVIS</span>
              <span className="truncate text-slate">{status}</span>
            </div>
            <p className="mt-1 line-clamp-1 text-xs leading-relaxed text-ice/80">{compactFeedbackText}</p>
          </div>
        </div>
        <div className="absolute right-2 top-2 flex items-center gap-1">
          <button
            type="button"
            onClick={() => setEmbeddedExpanded(true)}
            aria-label="Open Jarvis chat"
            title="Open chat"
            className="grid h-8 w-8 place-items-center rounded-full text-sm text-slate ring-1 ring-white/10 transition hover:bg-white/10 hover:text-cyan"
          >
            ↗
          </button>
          <button
            type="button"
            onClick={hideEmbedded}
            aria-label="Close Jarvis"
            className="grid h-8 w-8 place-items-center rounded-full text-lg text-slate ring-1 ring-white/10 transition hover:bg-white/10 hover:text-cyan"
          >
            ×
          </button>
        </div>
        {hostProgress > 0 && (
          <div
            role="progressbar"
            aria-label={`Jarvis ${status} progress`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(hostProgress * 100)}
            className="h-1 overflow-hidden rounded-full bg-white/8"
          >
            <span
              className="block h-full rounded-full bg-gradient-to-r from-cyan/70 to-amber/80 transition-[width] duration-300 ease-out"
              style={{ width: `${Math.round(hostProgress * 100)}%` }}
            />
          </div>
        )}
        {liveResearch.phase !== "idle" && <LiveResearchIndicator state={liveResearch} />}
        {foregroundRecoveryVisible && (
          <div className="flex items-center justify-between gap-2 rounded-lg bg-amber/[0.06] px-2 py-1 text-[10px] text-slate ring-1 ring-amber/20">
            <span className="min-w-0 truncate">{foregroundRecoveryMessage}</span>
            <button
              type="button"
              onClick={foregroundRecoveryAction}
              disabled={foregroundRecoveryActionDisabled}
              className="shrink-0 text-amber disabled:opacity-40"
            >
              {foregroundRecoveryActionLabel}
            </button>
          </div>
        )}
        <div className="flex min-w-0 gap-2">
          {!guest && (
            <button
              type="button"
              data-jarvis-compact-attachment
              onClick={openCompactAttachmentComposer}
              aria-label="Attach files, images, documents, or folders"
              title="Attach files or open saved private files"
              className="grid h-9 w-9 shrink-0 place-items-center rounded-xl text-sm text-slate ring-1 ring-white/10 transition hover:bg-white/10 hover:text-cyan"
            >
              <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="m20.5 11.5-8.9 8.9a6 6 0 0 1-8.5-8.5l9.6-9.6a4 4 0 0 1 5.7 5.7l-9.7 9.7a2 2 0 0 1-2.8-2.8l9-9" />
              </svg>
            </button>
          )}
          {voiceRecoveryVisible && (
            <button
              type="button"
              onClick={retryVoicePlayback}
              aria-label="Resume Jarvis voice playback"
              title="Resume voice"
              className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-amber/10 text-amber ring-1 ring-amber/30"
            >
              ◖
            </button>
          )}
          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && submit(input)}
            placeholder={busy ? "Jarvis is working…" : "Message Jarvis…"}
            className="min-w-0 flex-1 rounded-xl bg-black/35 px-3 py-2 text-xs text-ice outline-none ring-1 ring-white/10 focus:ring-cyan/50"
          />
          <button
            type="button"
            onClick={() => void submit(input)}
            disabled={sending || !input.trim()}
            aria-label="Send message"
            className="grid w-9 shrink-0 place-items-center rounded-xl bg-cyan/15 text-cyan ring-1 ring-cyan/40 disabled:opacity-40"
          >
            ↑
          </button>
        </div>
        <span className="sr-only" aria-live="polite">Jarvis is {status}</span>
      </div>
    );
  }

  if (embedded) {
    return (
      <div
        data-jarvis-embed-surface
        data-jarvis-embed-expanded="true"
        data-voice-state={orbState}
        className="relative flex h-dvh w-full flex-col overflow-hidden bg-[#05070d]"
      >
        {!guest && (
          <ChatFilePendingMonitor
            threadId={thread}
            pendingFileIds={pendingFileIds}
            selectedFileIds={selectedFileIds}
            onPendingChange={setPendingFileIds}
            onSelectionChange={setSelectedFileIds}
            onNotice={setFileNotice}
          />
        )}
        <button
          type="button"
          onClick={() => {
            if (liveRef.current) void toggleLive();
            setPanelFull(false);
            hideEmbedded();
          }}
          aria-label="Close Jarvis"
          className="absolute right-3 top-3 z-[70] grid h-9 w-9 place-items-center rounded-full bg-black/35 text-xl text-white/60 ring-1 ring-white/10 transition hover:bg-white/10 hover:text-cyan"
        >
          ×
        </button>
        <button
          type="button"
          onClick={() => {
            setPanelFull(false);
            setEmbeddedExpanded(false);
          }}
          aria-label="Collapse Jarvis"
          title="Collapse to the quick launcher"
          className="absolute right-14 top-3 z-[70] grid h-9 w-9 place-items-center rounded-full bg-black/35 text-sm text-white/60 ring-1 ring-white/10 transition hover:bg-white/10 hover:text-cyan"
        >
          ↙
        </button>
        {guest && (
          <button
            type="button"
            onClick={() => void connectEmbeddedOwner()}
            className="absolute left-3 top-3 z-[70] rounded-full bg-black/35 px-2.5 py-1 text-[10px] text-slate ring-1 ring-white/10 transition hover:text-cyan"
            title="Connect your signed-in Jarvis session for private tools and overlays"
          >
            connect tools
          </button>
        )}
        <div className={`relative min-h-0 ${embeddedWorkspacePanel ? "flex-1" : "flex-[1.15]"}`}>
          {panel && !panelMin ? (
            <div className={`absolute z-30 ${embeddedWorkspacePanel ? "inset-1 pt-10 sm:inset-2" : "inset-2 pt-8"}`}>
              <Viewport
                panel={panel}
                onClose={closeStage}
                onMinimize={() => {
                  setPanelFull(false);
                  setPanelMin(true);
                }}
                full={panelFull}
                onToggleFull={() => setPanelFull((value) => !value)}
              />
            </div>
          ) : (
            <>
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
            </>
          )}
          {liveResearch.phase !== "idle" && (
            <div className="pointer-events-none absolute inset-x-2 top-3 z-50 flex justify-center px-3">
              <LiveResearchIndicator state={liveResearch} />
            </div>
          )}
          {caption && (
            <div className="pointer-events-none absolute inset-x-2 bottom-2 z-50 flex justify-center px-3">
              <SpokenCaption caption={caption} />
            </div>
          )}
          <span className="sr-only" aria-live="polite">Jarvis is {status}</span>
        </div>

        {!embeddedWorkspacePanel && <div className="relative z-50 flex min-h-0 flex-1 flex-col border-t border-white/10 bg-black/35 backdrop-blur-md">
          <div className="scrollbar-thin min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-2.5">
            {messages.length === 0 && (
              <p className="pt-3 text-center text-xs text-slate">Ask Jarvis anything.</p>
            )}
            {messages
              .slice(-8)
              .map((message) => {
                return message.text
                  ? { ...message, text: safeEmbeddedMessageText(message) }
                  : message;
              })
              .filter((message) => message.text || message.status === "streaming")
              .map((message) => (
                <div key={message._id} className={message.role === "user" ? "text-right" : "text-left"}>
                  <span className={`inline-block max-w-[90%] whitespace-pre-wrap rounded-xl px-3 py-1.5 text-xs leading-relaxed ${
                    message.role === "user" ? "bg-amber/10 text-amber" : "bg-cyan/[0.08] text-ice"
                  }`}>
                    {message.text || (
                      <span className="typing-dots inline-flex gap-1"><span /><span /><span /></span>
                    )}
                  </span>
                  {message.role === "user" && <MessageFileBadges files={message.files} align="right" />}
                </div>
              ))}
            <div ref={embeddedEndRef} aria-hidden="true" />
          </div>
          {foregroundRecoveryVisible && (
            <div className="flex items-center justify-between gap-2 border-t border-amber/15 px-3 py-1.5 text-[11px] text-slate">
              <span>{foregroundRecoveryMessage}</span>
              <div className="flex items-center gap-2">
                {!submissionRetryReady && !durableRetryReady && (
                  <button
                    type="button"
                    onClick={() => void cancelDurableTurn(false)}
                    disabled={durableRecovery === "cancelling"}
                    className="text-slate disabled:opacity-40"
                  >
                    cancel
                  </button>
                )}
                <button
                  type="button"
                  onClick={foregroundRecoveryAction}
                  disabled={foregroundRecoveryActionDisabled}
                  className="rounded border border-amber/30 px-2 py-0.5 text-amber disabled:opacity-40"
                >
                  {foregroundRecoveryActionLabel}
                </button>
              </div>
            </div>
          )}
          <div className="border-t border-white/10 p-2">
            <div className="flex gap-2">
              {guest ? (
                <GuestChatFileAccess embedded onRequestOwnerAccess={() => void connectEmbeddedOwner()} />
              ) : (
                <ChatFilePicker
                  threadId={thread}
                  selectedFileIds={selectedFileIds}
                  pendingFileIds={pendingFileIds}
                  onSelectionChange={setSelectedFileIds}
                  onPendingChange={setPendingFileIds}
                  notice={fileNotice}
                  onNotice={setFileNotice}
                />
              )}
            {voiceRecoveryVisible && (
              <button
                type="button"
                onClick={retryVoicePlayback}
                aria-label="Resume Jarvis voice playback"
                title="Resume voice"
                className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-amber/10 text-amber ring-1 ring-amber/30"
              >
                ◖
              </button>
            )}
            <button
              type="button"
              onClick={() => speaking ? stopTalking() : void toggleLive()}
              className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl text-xs ring-1 ${live === "live" ? "bg-cyan/20 text-cyan ring-cyan/40" : "bg-white/5 text-slate ring-white/10"}`}
              aria-label={live === "live" ? "Stop live listening" : "Start live listening"}
            >
              {speaking ? "■" : "●"}
            </button>
            <input
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && submit(input)}
              placeholder={pendingFileIds.length ? "Indexing files before send…" : "Message Jarvis…"}
              className="min-w-0 flex-1 rounded-xl bg-black/35 px-3 text-sm text-ice outline-none ring-1 ring-white/10 focus:ring-cyan/50"
            />
            <button
              type="button"
              onClick={() => void submit(input)}
              disabled={sending || Boolean(pendingFileIds.length) || (!input.trim() && !selectedFileIds.length)}
              className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-cyan/15 text-cyan ring-1 ring-cyan/40 disabled:opacity-40"
              aria-label={pendingFileIds.length ? "Send waits for file indexing" : "Send message"}
            >
              ↑
            </button>
            </div>
          </div>
        </div>}
      </div>
    );
  }

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      {!guest && (
        <ChatFilePendingMonitor
          threadId={thread}
          pendingFileIds={pendingFileIds}
          selectedFileIds={selectedFileIds}
          onPendingChange={setPendingFileIds}
          onSelectionChange={setSelectedFileIds}
          onNotice={setFileNotice}
        />
      )}
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
              onClick={hideEmbedded}
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
          onEnableMicrophone={() => void enableMicrophone()}
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

      <div className={`relative mx-auto flex w-full flex-1 flex-col overflow-clip p-3 pt-2 sm:p-4 ${chatMode === "bar" ? "pb-24" : ""}`}>
        {/* the stage is ALWAYS full-bleed; the chat floats over it and slides
            away on pure transforms — compositor-only, 120fps-smooth */}
        <div ref={stageRef} className={`brackets relative min-h-0 flex-1 transition-[margin] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] ${chatMode === "full" ? "xl:mr-[416px]" : ""}`}>
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
            <div className={`absolute inset-x-0 top-0 bottom-[64px] z-20 flex min-h-0 min-w-0 items-center p-1 ${panelRoute?.presentation === "compact" ? "justify-center xl:justify-start xl:pl-10 xl:pr-[28%]" : "justify-center"}`}>
              <div className={`min-h-0 min-w-0 max-h-full max-w-full will-change-transform transition-all duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] ${panelRoute?.presentation === "compact" ? "xl:max-w-[72%]" : ""} ${stagePanelSize}`}>
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
          {/* arc-reactor HUD ring + orb — for a compact overlay they glide into
              the right corner (orb stays visible, small); a full-bleed panel
              hides them entirely. On phones there's no room for a corner, so a
              compact overlay hides them too (md:opacity-100 brings them back). */}
          <ReactorRing
            active={live === "live" || orbState === "thinking" || orbState === "listening"}
            aside={compactAside || (commandExpanded && !overlayUp)}
            hidden={fullBleed}
            motionRef={orbMotionRef}
            reduceMotion={prefs.reduceMotion}
          />
          <div
            className={`h-full w-full transition-opacity duration-500 ${
              fullBleed ? "pointer-events-none opacity-0" : compactAside || (commandExpanded && !overlayUp) ? "pointer-events-none opacity-0 md:opacity-100" : "opacity-100"
            }`}
          >
            <ThreeOrb
              state={orbState}
              energyRef={energyRef}
              moodColor={moodColor}
              motionRef={orbMotionRef}
              aside={compactAside || (commandExpanded && !overlayUp)}
              reduceMotion={prefs.reduceMotion}
            />
          </div>
          {!overlayUp && live === "off" && prefs.liveDefault && permissions.microphone !== "granted" && permissions.microphone !== "unsupported" && (
            <button
              type="button"
              data-jarvis-enable-live-voice
              onClick={() => void enableMicrophone()}
              disabled={permissionBusy}
              className="glass absolute bottom-[16%] left-1/2 z-30 -translate-x-1/2 rounded-full border-cyan/30 px-4 py-2 text-xs text-cyan shadow-[0_0_28px_rgba(103,232,249,.12)] transition hover:border-cyan/60 hover:bg-cyan/10 disabled:opacity-60"
            >
              {permissionBusy ? "enabling live voice…" : permissions.microphone === "denied" ? "allow microphone in site settings" : "enable live voice once"}
            </button>
          )}
          {speaking && !fullBleed && (
            <button
              type="button"
              aria-label="Interrupt Jarvis"
              title="Tap the orb to interrupt"
              onClick={stopTalking}
              className={compactAside || (commandExpanded && !overlayUp)
                ? "absolute bottom-[25%] left-[69%] right-[3%] top-[25%] z-20 hidden rounded-full bg-transparent md:block"
                : "absolute inset-[28%] z-20 rounded-full bg-transparent"}
            />
          )}
          {liveResearch.phase !== "idle" && !fullBleed && (
            <div className="pointer-events-none absolute inset-x-0 top-[45%] z-30 flex justify-center px-6">
              <LiveResearchIndicator state={liveResearch} />
            </div>
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
          className={`absolute inset-x-1 bottom-1 top-[34dvh] z-30 will-change-transform motion-reduce:transition-none transition-all duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] xl:inset-x-auto xl:bottom-2 xl:right-4 xl:top-2 xl:w-[min(400px,45vw)] ${overlayUp ? "max-xl:pointer-events-none max-xl:translate-y-[calc(100%+24px)] max-xl:opacity-0" : ""} ${
            chatMode === "full"
              ? "translate-x-0 translate-y-0 opacity-100"
              : "pointer-events-none translate-y-[calc(100%+24px)] opacity-0 xl:translate-x-[calc(100%+32px)] xl:translate-y-0"
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
              // A guest never receives a card through the normal worker path,
              // but do not materialize one if a legacy row is ever present.
              .filter((m) => m.text || (!guest && m.attachment) || m.status === "streaming")
              .map((m) => (
              <div key={m._id} className={`rise ${m.role === "user" ? "text-right" : "text-left"}`}>
                <GuestSafeAttachment
                  guest={guest}
                  attachment={m.attachment}
                  renderAttachment={(attachment) => (
                    <MediaCard
                      a={attachment}
                      onShow={(a) => {
                        setPanelMin(false);
                        void setPanel({ type: a.type, value: a.value, title: a.title });
                      }}
                    />
                  )}
                >
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
                </GuestSafeAttachment>
                {m.role === "user" && <MessageFileBadges files={m.files} align="right" />}
                {m.role === "assistant" && m.model && (
                  <div className="mt-0.5 pl-1">
                    <ModelBadge model={m.model} />
                  </div>
                )}
              </div>
            ))}
            <div ref={endRef} />
          </div>

          {foregroundRecoveryVisible && (
            <div className="flex items-center justify-between gap-3 border-t border-amber/15 bg-amber/[0.04] px-3 py-2 text-xs text-slate">
              <span>{foregroundRecoveryMessage}</span>
              <div className="flex shrink-0 items-center gap-2">
                {!submissionRetryReady && !durableRetryReady && (
                  <button
                    type="button"
                    onClick={() => void cancelDurableTurn(false)}
                    disabled={durableRecovery === "cancelling"}
                    className="rounded-lg px-2 py-1 text-slate transition hover:bg-white/5 disabled:opacity-40"
                  >
                    cancel
                  </button>
                )}
                <button
                  type="button"
                  onClick={foregroundRecoveryAction}
                  disabled={foregroundRecoveryActionDisabled}
                  className="rounded-lg border border-amber/30 px-2 py-1 text-amber transition hover:bg-amber/10 disabled:opacity-40"
                >
                  {foregroundRecoveryActionLabel}
                </button>
              </div>
            </div>
          )}

          {/* composer */}
          <div className="safe-composer relative min-w-0 max-w-full border-t border-white/5 p-2 sm:p-3">
            <div className="flex min-w-0 max-w-full items-stretch gap-1.5 sm:gap-2">
              {chatMode === "full" && (guest ? (
                <GuestChatFileAccess embedded={false} onRequestOwnerAccess={() => window.location.reload()} />
              ) : (
                <ChatFilePicker
                  threadId={thread}
                  selectedFileIds={selectedFileIds}
                  pendingFileIds={pendingFileIds}
                  onSelectionChange={setSelectedFileIds}
                  onPendingChange={setPendingFileIds}
                  notice={fileNotice}
                  onNotice={setFileNotice}
                />
              ))}
            {voiceRecoveryVisible && (
              <button
                type="button"
                onClick={retryVoicePlayback}
                aria-label="Resume Jarvis voice playback"
                className="shrink-0 rounded-xl bg-amber/10 px-2 text-amber ring-1 ring-amber/30 sm:px-3"
              >
                ◖
              </button>
            )}
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
            {!guest && <>
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
            </>}
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
              placeholder={pendingFileIds.length ? "Indexing files before send…" : busy ? "Ask another thing while I work…" : "Talk to me…"}
              className="w-0 min-w-0 flex-1 rounded-xl bg-black/30 px-3 py-2.5 text-sm text-ice outline-none ring-1 ring-white/10 transition focus:ring-cyan/50 sm:w-auto sm:px-4"
            />
            <button
              onClick={() => submit(input)}
              disabled={sending || Boolean(pendingFileIds.length) || (!input.trim() && !selectedFileIds.length)}
              aria-label={pendingFileIds.length ? "Send waits for file indexing" : "Send message"}
              className="grid w-10 shrink-0 place-items-center rounded-xl bg-cyan/15 px-0 py-2 text-sm font-medium text-cyan ring-1 ring-cyan/40 transition hover:bg-cyan/25 disabled:opacity-40 sm:w-auto sm:px-4"
            >
              <span className="sm:hidden">↑</span><span className="max-sm:hidden">send</span>
            </button>
            </div>
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
          {foregroundRecoveryVisible && (
            <div className="mx-auto mb-1 flex w-fit items-center gap-2 rounded-full border border-amber/20 bg-black/75 px-3 py-1 text-[11px] text-slate backdrop-blur">
              <span>{foregroundRecoveryMessage}</span>
              {!submissionRetryReady && !durableRetryReady && (
                <button
                  type="button"
                  onClick={() => void cancelDurableTurn(false)}
                  disabled={durableRecovery === "cancelling"}
                  className="text-slate disabled:opacity-40"
                >
                  cancel
                </button>
              )}
              <button
                type="button"
                onClick={foregroundRecoveryAction}
                disabled={foregroundRecoveryActionDisabled}
                className="text-amber disabled:opacity-40"
              >
                {foregroundRecoveryActionLabel}
              </button>
            </div>
          )}
          <div className="glass flex min-w-0 max-w-full items-stretch gap-2 overflow-hidden rounded-2xl p-2 shadow-2xl">
            <button
              onClick={() => setChatMode("full")}
              title="expand chat"
              className="hud-label shrink-0 rounded-xl px-2 hover:text-cyan"
            >
              ▲
            </button>
            {guest && chatMode === "bar" ? (
              <GuestChatFileAccess embedded={false} onRequestOwnerAccess={() => window.location.reload()} />
            ) : !guest && (
              <button
                type="button"
                onClick={() => setChatMode("full")}
                title={pendingFileIds.length ? `indexing ${pendingFileIds.length} private files` : "add or review private files"}
                aria-label={pendingFileIds.length ? `Review ${pendingFileIds.length} files still indexing` : "Add or review private files"}
                className={`shrink-0 rounded-xl px-2 text-xs ${pendingFileIds.length ? "bg-amber/15 text-amber ring-1 ring-amber/30" : selectedFileIds.length ? "bg-cyan/15 text-cyan ring-1 ring-cyan/30" : "text-slate hover:text-cyan"}`}
              >
                ▤{selectedFileIds.length + pendingFileIds.length ? ` ${selectedFileIds.length + pendingFileIds.length}` : ""}
              </button>
            )}
            {voiceRecoveryVisible && (
              <button
                type="button"
                onClick={retryVoicePlayback}
                aria-label="Resume Jarvis voice playback"
                className="shrink-0 rounded-xl bg-amber/10 px-2.5 text-amber ring-1 ring-amber/30"
              >
                ◖
              </button>
            )}
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
              placeholder={pendingFileIds.length ? "Indexing files before send…" : busy ? "Ask another thing while I work…" : "Talk to me…"}
              className="w-0 min-w-0 flex-1 rounded-xl bg-black/30 px-3 py-2 text-sm text-ice outline-none ring-1 ring-white/10 transition focus:ring-cyan/50 sm:w-auto sm:px-4"
            />
            <button
              onClick={() => submit(input)}
              disabled={sending || Boolean(pendingFileIds.length) || (!input.trim() && !selectedFileIds.length)}
              aria-label={pendingFileIds.length ? "Send waits for file indexing" : "Send message"}
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
        <div className="fixed inset-0 z-50 flex min-h-0 min-w-0 flex-col bg-black/80 p-2 backdrop-blur-sm sm:p-4 lg:p-6">
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
