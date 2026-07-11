"use client";
// Live mode: browser-direct WebRTC to OpenAI Realtime (mic, playback, VAD and
// barge-in handled natively — this is what makes live conversation actually
// work). Vercel only mints the ephemeral token. Tools execute via /api/tools;
// finished turns are mirrored into Convex history.

import { RealtimeAgent, RealtimeSession, tool, OpenAIRealtimeWebRTC } from "@openai/agents-realtime";

export type LiveState = "connecting" | "live" | "off" | "error";
export type LiveHandlers = {
  onState: (s: LiveState, detail?: string) => void;
  onCaption: (who: "you" | "jarvis", text: string, done: boolean) => void;
  onTurnDone: (role: "user" | "assistant", text: string) => void;
  onEnergy: (e: number) => void;
};

let session: RealtimeSession | null = null;
let audioEl: HTMLAudioElement | null = null;
let energyRaf = 0;
let energyCtx: AudioContext | null = null;

async function clientTools() {
  const defs: { name: string; description: string; parameters: any }[] = await (await fetch("/api/tools")).json();
  return defs.map((d) =>
    tool({
      name: d.name,
      description: d.description,
      parameters: { ...d.parameters, additionalProperties: false },
      strict: false,
      execute: async (args: unknown) => {
        const r = await fetch("/api/tools", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: d.name, args }),
        });
        const j = await r.json().catch(() => ({ result: "tool bridge failed" }));
        return String(j.result ?? "done");
      },
    }),
  );
}

// Analysis-only tap on the remote stream for the orb. CRITICAL: never route the
// element through WebAudio (createMediaElementSource) — that double-plays the
// audio ("two voices") and breaks browser echo cancellation, which kills
// barge-in because the session hears itself instead of Daniel. The element
// keeps playing natively; we read amplitude from a parallel stream source
// that is NOT connected to the destination.
function hookEnergy(el: HTMLAudioElement, onEnergy: (e: number) => void) {
  const arm = () => {
    if (!session) return; // live ended before audio arrived
    const stream = el.srcObject as MediaStream | null;
    if (!stream || !stream.getAudioTracks().length) {
      energyRaf = requestAnimationFrame(arm);
      return;
    }
    try {
      energyCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      void energyCtx.resume();
      const src = energyCtx.createMediaStreamSource(stream);
      const analyser = energyCtx.createAnalyser();
      analyser.fftSize = 256;
      src.connect(analyser); // analysis only — no destination
      const data = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (const v of data) {
          const n = (v - 128) / 128;
          sum += n * n;
        }
        onEnergy(Math.min(1, Math.sqrt(sum / data.length) * 3));
        energyRaf = requestAnimationFrame(tick);
      };
      tick();
    } catch {
      /* orb just won't pulse */
    }
  };
  arm();
}

export function isLive() {
  return session !== null;
}

export function interruptLive() {
  try {
    session?.interrupt();
  } catch {
    /* ignore */
  }
}

// Voice an out-of-band line (agent finding, proactive insight) mid-conversation.
const NUDGE = "[Background update — tell Daniel this naturally in one short spoken sentence, then carry on]: ";
export function nudgeLive(text: string) {
  try {
    session?.sendMessage(NUDGE + text);
  } catch {
    /* ignore */
  }
}

// Typed input while live is on goes INTO the live session — one brain, one
// voice, instead of a parallel text-lane answer being re-spoken as a paraphrase.
export function sendLiveText(text: string): boolean {
  if (!session) return false;
  try {
    session.sendMessage(text);
    return true;
  } catch {
    return false;
  }
}

let starting = false;
export async function startLive(h: LiveHandlers) {
  if (session || starting) return; // double-tap = one session, never two voices
  starting = true;
  h.onState("connecting");
  try {
    const tk = await (await fetch("/api/realtime-token", { method: "POST" })).json();
    if (!tk.token) throw new Error(tk.error ?? "no token");

    audioEl = document.createElement("audio");
    audioEl.autoplay = true;
    document.body.appendChild(audioEl);
    const transport = new OpenAIRealtimeWebRTC({ audioElement: audioEl });

    const agent = new RealtimeAgent({
      name: "JARVIS",
      // Instructions + persona + context are baked into the minted session
      // server-side; keep the client agent instruction-free so it doesn't clobber them.
      instructions: "",
      tools: await clientTools(),
    });
    session = new RealtimeSession(agent, { transport, model: tk.model || "gpt-realtime-mini" });

    const mirrored = new Set<string>();
    session.on("history_updated", (history: any[]) => {
      for (const item of history) {
        if (item?.type !== "message") continue;
        const role = item.role === "user" ? "user" : "assistant";
        const text = (item.content ?? [])
          .map((c: any) => c?.transcript ?? c?.text ?? "")
          .join(" ")
          .trim();
        if (!text || text.startsWith(NUDGE.slice(0, 20))) continue; // internal nudges stay invisible
        const done = item.status === "completed";
        h.onCaption(role === "user" ? "you" : "jarvis", text, done);
        if (done && !mirrored.has(item.itemId)) {
          mirrored.add(item.itemId);
          h.onTurnDone(role, text);
        }
      }
    });
    session.on("error", (e: any) => {
      console.error("live error", e);
    });

    await session.connect({ apiKey: tk.token });
    hookEnergy(audioEl, h.onEnergy);
    starting = false;
    h.onState("live");
  } catch (e: any) {
    starting = false;
    stopLive();
    h.onState("error", String(e?.message ?? e));
  }
}

export function stopLive() {
  try {
    session?.close();
  } catch {
    /* ignore */
  }
  session = null;
  cancelAnimationFrame(energyRaf);
  try {
    void energyCtx?.close();
  } catch {
    /* ignore */
  }
  energyCtx = null;
  if (audioEl) {
    try {
      audioEl.pause();
      audioEl.srcObject = null;
    } catch {
      /* ignore */
    }
    audioEl.remove();
    audioEl = null;
  }
}
