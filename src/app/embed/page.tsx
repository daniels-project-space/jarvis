"use client";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";

// JARVIS everywhere: the embeddable mini-orb + one-line composer that lives on
// the project hub and any internal app (loaded via /jarvis-embed.js iframe).
// Same brain, same threads — messages land in the main JARVIS chat too.

function clientId(): string {
  try {
    let id = sessionStorage.getItem("jarvis_client");
    if (!id) {
      id = Math.random().toString(36).slice(2, 10);
      sessionStorage.setItem("jarvis_client", id);
    }
    return id;
  } catch {
    return "embed";
  }
}

type Line = { who: "you" | "jarvis"; text: string };

export default function Embed() {
  const [input, setInput] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState<"off" | "connecting" | "live">("off");
  const [wake, setWakeState] = useState(false);
  const [recording, setRecording] = useState(false);
  const [open, setOpen] = useState(false);
  const me = useRef("");
  const liveRef = useRef(false);
  const recRef = useRef<MediaRecorder | null>(null);
  const claimVoice = useMutation(api.ui.claimVoice);
  const setLiveOn = useMutation(api.ui.setLiveOn);
  const liveBeat = useRef<ReturnType<typeof setInterval> | null>(null);
  const voiceRow = useQuery(api.ui.getVoice, {}) as { value: string; updatedAt: number } | null | undefined;
  const voiceRowRef = useRef<{ value: string; updatedAt: number } | null>(null);
  useEffect(() => {
    voiceRowRef.current = voiceRow ?? null;
  }, [voiceRow]);
  const logTurn = (args: { role: string; text: string; model?: string }) =>
    fetch("/api/client-state", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "log_turn", ...args }),
    });
  const liveOnRow = useQuery(api.ui.getLiveOn, {}) as { value: string; updatedAt: number } | null | undefined;
  const liveOnRef = useRef<typeof liveOnRow>(null);
  useEffect(() => {
    liveOnRef.current = liveOnRow;
  }, [liveOnRow]);
  const liveAnywhere = () => !!liveOnRef.current && Date.now() - liveOnRef.current.updatedAt < 45_000;

  useEffect(() => {
    me.current = clientId();
  }, []);

  // Tell the host page how big to draw us / when to summon or dismiss us.
  const post = (msg: Record<string, unknown>) => {
    try {
      window.parent?.postMessage(msg, "*");
    } catch {
      /* not framed */
    }
  };
  const size = (expanded: boolean) => post({ jarvis: "size", h: expanded ? 384 : 72 });
  useEffect(() => {
    size(open || live !== "off" || lines.length > 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, live, lines.length]);

  const push = (l: Line) => setLines((p) => [...p.slice(-7), l]);

  // Wake word: on by default in embeds — JARVIS is listening wherever you are.
  const armWake = () => {
    import("../../lib/wakeword").then((m) => {
      if (!m.wakeSupported() || liveRef.current) return;
      m.startWake(() => {
        setWakeState(false);
        m.chime();
        post({ jarvis: "wake" }); // summon the widget on the host page
        void startLiveMode();
      });
      setWakeState(true);
    });
  };
  useEffect(() => {
    // Listen ONLY while this tab is actually visible — a background hub tab
    // mishearing speech (even JARVIS's own voice from another window) used to
    // silently start a live session and cut TTS everywhere via the live lock.
    const sync = () => {
      import("../../lib/wakeword").then((m) => {
        if (document.visibilityState === "visible" && localStorage.getItem("jarvis_embed_wake") !== "0") {
          if (!m.wakeActive() && !liveRef.current) armWake();
        } else if (!liveRef.current) {
          m.stopWake();
          setWakeState(false);
        }
      });
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => {
      document.removeEventListener("visibilitychange", sync);
      import("../../lib/wakeword").then((m) => m.stopWake());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const toggleWake = () => {
    import("../../lib/wakeword").then((m) => {
      if (wake) {
        localStorage.setItem("jarvis_embed_wake", "0");
        m.stopWake();
        setWakeState(false);
      } else {
        localStorage.setItem("jarvis_embed_wake", "1");
        armWake();
      }
    });
  };

  async function startLiveMode() {
    if (liveRef.current) return;
    import("../../lib/tts").then((m) => m.stopSpeaking()); // wake barge-in cuts any read-out
    const got = await setLiveOn({ client: me.current, on: true }).catch(() => true);
    if (got === false) return; // another device is live — stay quiet (and NO heartbeat)
    // heartbeat, or the lock goes stale in 45s and a second device can start a
    // parallel live session (feedback loop) — main app already does this
    if (liveBeat.current) clearInterval(liveBeat.current);
    liveBeat.current = setInterval(() => void setLiveOn({ client: me.current, on: true }).catch(() => {}), 20_000);
    const rt = await import("../../lib/realtime");
    const { stopWake } = await import("../../lib/wakeword");
    stopWake();
    setWakeState(false);
    await rt.startLive({
      onState: (s) => {
        if (s === "live") {
          liveRef.current = true;
          setLive("live");
        } else if (s === "connecting") setLive("connecting");
        else {
          liveRef.current = false;
          setLive("off");
          if (liveBeat.current) clearInterval(liveBeat.current);
          liveBeat.current = null;
          void setLiveOn({ client: me.current, on: false }).catch(() => {});
          if (localStorage.getItem("jarvis_embed_wake") !== "0") armWake();
        }
      },
      onExitRequest: () => {
        liveRef.current = false;
        setLive("off");
        if (liveBeat.current) clearInterval(liveBeat.current);
        liveBeat.current = null;
        void setLiveOn({ client: me.current, on: false }).catch(() => {});
        if (localStorage.getItem("jarvis_embed_wake") !== "0") armWake();
      },
      onCaption: (who, text, done) => {
        if (!done) setLines((p) => {
          const rest = p[p.length - 1]?.who === who ? p.slice(0, -1) : p;
          return [...rest.slice(-7), { who, text }];
        });
      },
      onTurnDone: (role, text) => {
        void logTurn({ role, text, model: role === "assistant" ? "live" : undefined });
      },
      onEnergy: () => {},
      clientId: me.current,
    });
  }

  async function stopLiveMode() {
    if (liveBeat.current) {
      clearInterval(liveBeat.current);
      liveBeat.current = null;
    }
    const rt = await import("../../lib/realtime");
    rt.stopLive();
    liveRef.current = false;
    setLive("off");
    void setLiveOn({ client: me.current, on: false }).catch(() => {});
    if (localStorage.getItem("jarvis_embed_wake") !== "0") armWake();
  }

  async function submit(text: string) {
    const t = text.trim();
    if (!t || busy) return;
    setInput("");
    push({ who: "you", text: t });
    void claimVoice({ client: me.current });
    if (liveRef.current) {
      const rt = await import("../../lib/realtime");
      if (rt.sendLiveText(t)) return;
    }
    setBusy(true);
    try {
      const r = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: t }),
      });
      const j = await r.json();
      const reply = String(j.text ?? "");
      if (reply) {
        push({ who: "jarvis", text: reply });
        const vr = voiceRowRef.current;
        const owned = !vr || vr.value === me.current || Date.now() - vr.updatedAt > 3 * 60 * 1000;
        if (owned && !liveAnywhere() && !document.hidden) {
          const { speak } = await import("../../lib/tts");
          void speak(reply, () => {}, () => {}, () => {});
        }
      } else if (j.fallback) {
        push({ who: "jarvis", text: "On it — answer's coming through in the main window." });
      }
    } catch {
      push({ who: "jarvis", text: "Connection hiccup — try that again." });
    }
    setBusy(false);
  }

  async function toggleMic() {
    if (recording) {
      recRef.current?.stop();
      return;
    }
    import("../../lib/tts").then((m) => m.stopSpeaking()); // barge-in
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch {
      push({ who: "jarvis", text: "I need microphone access for that." });
      return;
    }
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
          const { isEchoOfTts } = await import("../../lib/tts");
          if (!isEchoOfTts(text)) void submit(text.trim());
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

  const expanded = open || live !== "off" || lines.length > 0;
  const orbState = live === "live" ? "listening" : busy ? "thinking" : "idle";

  return (
    <div className="flex h-screen flex-col justify-end bg-transparent p-1.5">
      <div className="glass flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl" style={{ display: expanded ? "flex" : "none" }}>
        <div className="flex items-center justify-between border-b border-white/5 px-3 py-1.5">
          <span className="hud-label !text-cyan">jarvis</span>
          <span className="flex items-center gap-2">
            <button onClick={toggleWake} className={`hud-label rounded px-1 ${wake ? "!text-cyan" : "hover:text-cyan"}`} title="wake word">
              {wake ? "◉ listening" : "wake off"}
            </button>
            <a href="/" target="_blank" rel="noreferrer" className="hud-label rounded px-1 hover:text-cyan" title="open full JARVIS">
              ↗
            </a>
            <button
              onClick={() => {
                setLines([]);
                setOpen(false);
                post({ jarvis: "hide" }); // tuck away — wake word keeps listening
              }}
              className="hud-label rounded px-1 hover:text-cyan"
              title="hide (say 'hey jarvis' to bring me back)"
            >
              ▾
            </button>
          </span>
        </div>
        <div className="scrollbar-thin flex-1 space-y-1.5 overflow-y-auto p-2.5">
          {lines.length === 0 && <p className="mt-6 text-center text-xs text-slate">Say the word, sir.</p>}
          {lines.map((l, i) => (
            <div key={i} className={l.who === "you" ? "text-right" : "text-left"}>
              <span className={`inline-block max-w-[92%] rounded-xl px-2.5 py-1 text-xs leading-relaxed ${l.who === "you" ? "bg-amber/10 text-amber" : "bg-cyan/[0.07] text-ice"}`}>
                {l.text}
              </span>
            </div>
          ))}
        </div>
      </div>
      <div className="glass mt-1.5 flex shrink-0 items-stretch gap-1.5 rounded-2xl p-1.5">
        <span className="relative flex w-8 shrink-0 items-center justify-center" title={orbState}>
          <span
            className={`h-3.5 w-3.5 rounded-full ${orbState === "listening" ? "bg-cyan animate-pulse" : orbState === "thinking" ? "bg-amber animate-ping" : "bg-cyan/70 breathe"}`}
            style={{ boxShadow: "0 0 14px rgba(0,255,136,0.6)" }}
          />
        </span>
        <button
          onClick={() => (live === "off" ? void startLiveMode() : void stopLiveMode())}
          className={`shrink-0 rounded-xl px-2 text-xs transition ${live !== "off" ? "bg-cyan/20 text-cyan ring-1 ring-cyan/50" : "text-slate hover:text-ice"}`}
        >
          live
        </button>
        <button
          onClick={toggleMic}
          className={`shrink-0 rounded-xl px-2 text-xs transition ${recording ? "bg-amber/20 text-amber ring-1 ring-amber/50" : "text-slate hover:text-ice"}`}
        >
          {recording ? "■" : "mic"}
        </button>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => e.key === "Enter" && submit(input)}
          placeholder={busy ? "thinking…" : "Talk to me…"}
          className="min-w-0 flex-1 rounded-xl bg-black/30 px-3 py-1.5 text-xs text-ice outline-none ring-1 ring-white/10 focus:ring-cyan/50"
        />
        <button
          onClick={() => submit(input)}
          disabled={busy}
          className="shrink-0 rounded-xl bg-cyan/15 px-2.5 text-xs font-medium text-cyan ring-1 ring-cyan/40 disabled:opacity-40"
        >
          →
        </button>
      </div>
    </div>
  );
}
