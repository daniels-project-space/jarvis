"use client";
import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import ThreeOrb from "./ThreeOrb";

const THREAD = "main";
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

function Viewport({
  panel,
  onClose,
  onMinimize,
}: {
  panel: { type: string; value: string; title?: string };
  onClose: () => void;
  onMinimize: () => void;
}) {
  return (
    <div className="materialize glass relative flex h-full flex-col overflow-hidden rounded-2xl">
      <div className="flex items-center justify-between border-b border-white/5 px-3 py-2">
        <span className="hud-label truncate !text-cyan-dim">{panel.title ?? panel.type}</span>
        <span className="flex shrink-0 gap-1">
          <button onClick={onMinimize} className="hud-label rounded px-2 py-1 hover:text-cyan" title="fold away, keep handy">
            ▾ orb
          </button>
          <button onClick={onClose} className="hud-label rounded px-2 py-1 hover:text-cyan">
            close
          </button>
        </span>
      </div>
      {panel.type === "url" || panel.type === "video" ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <iframe
            src={panel.value}
            className={`w-full flex-1 ${panel.type === "video" ? "bg-black" : "bg-white"}`}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-presentation"
            allow="autoplay; encrypted-media; picture-in-picture"
          />
          {panel.type === "url" && (
            <a href={panel.value} target="_blank" rel="noreferrer" className="p-2 text-center text-xs text-cyan/80">
              open in a tab ↗ (blank means the site blocks embedding)
            </a>
          )}
        </div>
      ) : panel.type === "image" ? (
        <img src={panel.value} alt={panel.title ?? ""} className="min-h-0 flex-1 object-contain" />
      ) : panel.type === "code" ? (
        <pre className="scrollbar-thin min-h-0 flex-1 overflow-auto whitespace-pre p-4 font-mono text-xs leading-relaxed text-cyan/90">
          {panel.value}
        </pre>
      ) : (
        <pre className="scrollbar-thin min-h-0 flex-1 overflow-auto whitespace-pre-wrap p-4 text-sm leading-relaxed text-ice">
          {panel.value}
        </pre>
      )}
    </div>
  );
}

export default function JarvisUI() {
  const messages = (useQuery(api.chatQueue.listMessages, { threadId: THREAD }) ?? []) as Msg[];
  const panel = useQuery(api.ui.getPanel, {}) as
    | { type: string; value: string; title?: string; updatedAt: number }
    | null
    | undefined;
  const clearPanel = useMutation(api.ui.clearPanel);
  const setPanel = useMutation(api.ui.setPanel);
  const logTurn = useMutation(api.chatQueue.logTurn);
  const saveSub = useMutation(api.push.saveSub);
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
    if (last.model === "live") return;
    if (liveRef.current) {
      import("../lib/realtime").then((m) => m.nudgeLive(last.text));
      return;
    }
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
    import("../lib/tts").then((m) => m.warm());
    setInput("");
    if (panel) setPanelMin(true); // new message → viewport folds away, orb returns
    setSending(true);
    try {
      await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ threadId: THREAD, text: t }),
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

  async function toggleLive() {
    const rt = await import("../lib/realtime");
    if (liveRef.current || live !== "off") {
      rt.stopLive();
      liveRef.current = false;
      setLive("off");
      setCaption(null);
      return;
    }
    import("../lib/tts").then((m) => m.stopSpeaking());
    await rt.startLive({
      onState: (s, detail) => {
        if (s === "live") {
          liveRef.current = true;
          setLive("live");
        } else if (s === "connecting") setLive("connecting");
        else {
          liveRef.current = false;
          setLive("off");
          setCaption(null);
          if (s === "error") alert(`Live mode couldn't start: ${detail ?? "unknown error"}`);
        }
      },
      onCaption: (who, text, done) => setCaption(done ? null : { who, text }),
      onTurnDone: (role, text) => {
        void logTurn({ threadId: THREAD, role, text, model: role === "assistant" ? "live" : undefined });
        if (role === "user") setPanelMin((min) => min || lastPanelAt.current < Date.now() - 8000);
        if (role === "user") lastLiveUser.current = text;
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
    });
  }

  // One-shot voice input: record → Groq Whisper → send. Works on iOS too.
  async function toggleMic() {
    if (recording) {
      recRef.current?.stop();
      return;
    }
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
          <h1 className="font-display text-xl font-bold tracking-[0.42em] text-cyan" style={{ fontFamily: "var(--font-chakra)" }}>
            JARVIS
          </h1>
          <span className="hud-label hidden sm:inline">personal ai · online</span>
        </div>
        <div className="flex items-center gap-4">
          <span className="flex items-center gap-1.5">
            <span className={`h-1.5 w-1.5 rounded-full ${live === "live" ? "bg-cyan" : "bg-emerald-400"} breathe`} />
            <span className="hud-label">{status}</span>
          </span>
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
          {panel && !panelMin ? (
            <div className="absolute inset-0 z-20 p-1">
              <Viewport panel={panel} onClose={() => clearPanel({})} onMinimize={() => setPanelMin(true)} />
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
          <div className="scrollbar-thin flex-1 space-y-3 overflow-y-auto p-4">
            {messages.length === 0 && (
              <p className="mt-10 text-center text-sm text-slate">Say the word, sir.</p>
            )}
            {messages.slice(-80).map((m) => (
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
              onClick={toggleLive}
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
    </div>
  );
}
