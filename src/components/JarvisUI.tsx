"use client";
import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import ThreeOrb from "./ThreeOrb";

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
    .replace(/^## (.+)$/gm, '<div class="mb-2 mt-1 text-base font-semibold text-ice">$1</div>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\n/g, "<br/>");
}

// Persistent media card in the stream — click to put it back on the big screen.
function MediaCard({ a, onShow }: { a: Attachment; onShow: (a: Attachment) => void }) {
  const id = a.type === "video" ? ytId(a.value) : null;
  const ext = id ? `https://www.youtube.com/watch?v=${id}` : a.value;
  return (
    <span className="glass inline-flex max-w-[88%] items-center gap-2 overflow-hidden rounded-xl p-1.5 pr-2 text-left">
      <button onClick={() => onShow(a)} className="flex min-w-0 items-center gap-2" title="show on screen">
        {id ? (
          <img src={`https://img.youtube.com/vi/${id}/mqdefault.jpg`} alt="" className="h-12 w-20 shrink-0 rounded-lg object-cover" />
        ) : a.type === "image" ? (
          <img src={a.value} alt="" className="h-12 w-20 shrink-0 rounded-lg object-cover" />
        ) : (
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-cyan/10 text-lg">
            {a.type === "url" ? "🌐" : a.type === "code" ? "‹›" : "📄"}
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

// Native widget panels (weather now; more kinds arrive via self_improve).
function WidgetView({ value }: { value: string }) {
  let w: any = null;
  try {
    w = JSON.parse(value);
  } catch {
    /* fall through */
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
    }
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
    const onErr = (e: ErrorEvent) => {
      if (e.message === "Script error." || !e.message) return; // cross-origin iframe noise, unactionable
      report(`client:${String(e.message).slice(0, 80)}`, `${e.message} @ ${e.filename}:${e.lineno}`);
    };
    const onRej = (e: PromiseRejectionEvent) =>
      report(`client:rejection:${String(e.reason).slice(0, 80)}`, `Unhandled rejection: ${String(e.reason).slice(0, 400)}`);
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
    if (panel && !panelFull) setPanelMin(true); // new message → viewport folds away, orb returns
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
          <h1 className="font-display text-xl font-bold tracking-[0.42em] text-yellow-400" style={{ fontFamily: "var(--font-chakra)" }}>
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

      <div className="mx-auto grid w-full max-w-7xl flex-1 gap-4 p-4 pt-2 md:grid-cols-[1.15fr_1fr]">
        {/* the stage: orb / viewport / agent view */}
        <div className="brackets relative min-h-[42vh] md:min-h-[70vh]">
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
        <div className="glass flex h-[52vh] flex-col overflow-hidden rounded-2xl md:h-[76vh]">
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
                    {m.text || (m.status === "streaming" ? "…" : "")}
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
      </div>

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
