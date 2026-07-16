"use client";
// Live mode: browser-direct WebRTC to OpenAI Realtime (mic, playback, VAD and
// barge-in handled natively — this is what makes live conversation actually
// work). Vercel only mints the ephemeral token. Tools execute via /api/tools;
// finished turns are mirrored into Convex history.

import { RealtimeAgent, RealtimeSession, tool, OpenAIRealtimeWebRTC } from "@openai/agents-realtime";
import { STT_PROMPT } from "./sttvocab";
import { extractFunctionCalls, sanitizeAssistantText, isToolGarbage } from "./sanitize";

export type LiveState = "connecting" | "live" | "off" | "error";
export type LiveHandlers = {
  onState: (s: LiveState, detail?: string) => void;
  onCaption: (who: "you" | "jarvis", text: string, done: boolean) => void;
  onTurnDone: (role: "user" | "assistant", text: string) => void;
  onEnergy: (e: number) => void;
  onExitRequest?: () => void; // Daniel said "turn off live mode" — model calls exit_live_mode
  clientId?: string; // cross-device live lock identity
};

let session: RealtimeSession | null = null;
let audioEl: HTMLAudioElement | null = null;
let energyRaf = 0;
let energyCtx: AudioContext | null = null;

type LiveToolDef = { name: string; description: string; parameters: any };
const definitionCache = new Map<string, Promise<LiveToolDef[]>>();

function toolDefinitions(belt: string) {
  let promise = definitionCache.get(belt);
  if (!promise) {
    promise = fetch(`/api/tools?live=${encodeURIComponent(belt)}`).then(async (response) => {
      if (!response.ok) throw new Error(`tool belt ${belt} failed`);
      return (await response.json()) as LiveToolDef[];
    });
    definitionCache.set(belt, promise);
  }
  return promise;
}

export function preloadLive() {
  void toolDefinitions("core").catch(() => definitionCache.delete("core"));
}

async function clientTools(belt = "core") {
  const defs = await toolDefinitions(belt);
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
let micStream: MediaStream | null = null;
export async function startLive(h: LiveHandlers) {
  if (session || starting) return; // double-tap = one session, never two voices
  starting = true;
  h.onState("connecting");
  try {
    // Begin every user-gesture-gated startup lane together: server context and
    // token minting, microphone permission, and the compact core tool belt.
    const tokenPromise = fetch("/api/realtime-token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client: h.clientId ?? "" }),
    });
    audioEl = document.createElement("audio");
    audioEl.autoplay = true;
    document.body.appendChild(audioEl);
    // Own mic stream with echo cancellation FORCED on: on phones the speaker
    // leaks into the mic, semantic VAD reads JARVIS's own voice as Daniel
    // barging in and cancels speech mid-sentence (and the echo guard then
    // makes the model go silent). AEC at the source kills the loop.
    const micPromise = navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const [res, microphone, coreTools] = await Promise.all([tokenPromise, micPromise, clientTools("core")]);
    micStream = microphone;
    const tk = await res.json();
    if (!res.ok || !tk.token) throw new Error(tk.error ?? "no token");
    const transport = new OpenAIRealtimeWebRTC({ audioElement: audioEl, mediaStream: micStream });

    const exitTool = tool({
      name: "exit_live_mode",
      description:
        "End the live voice conversation. Call when Daniel says to turn off live mode, stop listening, go quiet, go to sleep, or that he's done talking.",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      parameters: { type: "object", properties: {}, required: [], additionalProperties: false } as any,
      strict: false,
      execute: async () => {
        setTimeout(() => {
          stopLive();
          h.onExitRequest?.();
        }, 1800); // let the goodbye line finish speaking first
        return "Say one short goodbye line — the session ends right after.";
      },
    });
    const activeTools = new Map<string, any>();
    for (const bridge of coreTools as any[]) activeTools.set(String(bridge.name), bridge);
    let makeAgent: () => RealtimeAgent;
    const domainTool = tool({
      name: "load_tool_domain",
      description:
        "Load a specialist tool belt only when needed: work for missions/projects/repairs, creative for images/drawing/docs, travel for trip planning, or business for markets/rentals/shopping. After loading, call the requested specialist tool.",
      parameters: {
        type: "object",
        properties: { domain: { type: "string", enum: ["work", "creative", "travel", "business"] } },
        required: ["domain"],
        additionalProperties: false,
      } as any,
      strict: false,
      execute: async (args: any) => {
        const domain = String(args?.domain ?? "");
        if (!["work", "creative", "travel", "business"].includes(domain)) return "Unknown tool domain.";
        const loaded = await clientTools(domain);
        for (const bridge of loaded as any[]) activeTools.set(String(bridge.name), bridge);
        if (session) await session.updateAgent(makeAgent());
        return `${domain} tools loaded. Now call the specific tool Daniel asked for; do not merely describe it.`;
      },
    });
    makeAgent = () => new RealtimeAgent({
      name: "JARVIS",
      // THE CLIENT OWNS THE CONFIG. The SDK's connect sends a session.update
      // built from this agent + SDK defaults, CLOBBERING whatever the server
      // minted — an empty string here silently wiped the entire persona for
      // weeks (and transcription fell back to gpt-4o-mini, noise reduction to
      // null). Everything critical must be set right here.
      instructions:
        String(tk.instructions ?? "") +
        "\n\nYou begin with a compact core tool belt. When Daniel asks for a tool that is not present, call load_tool_domain for work, creative, travel, or business, then immediately use the newly loaded tool. Never claim the action happened after only loading a belt.",
      tools: [...activeTools.values(), domainTool, exitTool],
    });
    const agent = makeAgent();
    session = new RealtimeSession(agent, {
      transport,
      model: tk.model || "gpt-realtime-2.1",
      config: {
        audio: {
          input: {
            transcription: { model: "gpt-4o-transcribe", language: "en", prompt: STT_PROMPT },
            turnDetection: { type: "semantic_vad", eagerness: "high" },
            noiseReduction: { type: "near_field" },
          },
          output: { voice: tk.voice || "ballad" },
        },
      },
    });

    const mirrored = new Set<string>();
    const observed = new Map<string, string>();
    // Foreign-script transcription junk (whisper noise-hallucination) never
    // reaches captions or the chat log — Daniel speaks English.
    const isGarbage = (t: string) => {
      const latin = (t.match(/[a-zA-Z0-9\s.,!?'"£$%()@:;/-]/g) ?? []).length;
      return t.length > 0 && latin / t.length < 0.7;
    };
    // Residual echo: when AEC leaks JARVIS's own voice back through the mic,
    // the VAD hears a "user turn" that is really the assistant's last sentence
    // and the model ANSWERS ITSELF (= "says things twice"). Detect the overlap,
    // cancel the duplicate response and delete the echo item from the session.
    const recentAssistant: { text: string; ts: number }[] = [];
    const tokenOverlap = (a: string, b: string) => {
      const tok = (x: string) =>
        new Set(x.toLowerCase().replace(/[^a-z0-9\s']/g, " ").split(/\s+/).filter((w) => w.length > 2));
      const A = tok(a), B = tok(b);
      if (A.size < 4) return 0; // "yes" / "okay" must never be treated as echo
      let hit = 0;
      for (const w of A) if (B.has(w)) hit++;
      return hit / A.size;
    };
    const echoHandled = new Set<string>();
    const isSelfEcho = (t: string) => {
      const now = Date.now();
      return recentAssistant.some((r) => now - r.ts < 30_000 && tokenOverlap(t, r.text) >= 0.65);
    };
    session.on("history_updated", (history: any[]) => {
      for (const item of history) {
        if (item?.type !== "message") continue;
        const role = item.role === "user" ? "user" : "assistant";
        let text = (item.content ?? [])
          .map((c: any) => c?.transcript ?? c?.text ?? "")
          .join(" ")
          .trim();
        const observation = `${item.status ?? ""}|${text}`;
        if (observed.get(item.itemId) === observation) continue;
        observed.set(item.itemId, observation);
        if (!text || text.startsWith(NUDGE.slice(0, 20))) continue; // internal nudges stay invisible
        if (role === "user" && isGarbage(text)) continue;
        if (role === "user" && !echoHandled.has(item.itemId) && isSelfEcho(text)) {
          echoHandled.add(item.itemId);
          try {
            session?.interrupt(); // stop the model answering its own voice
            transport.sendEvent({ type: "conversation.item.delete", item_id: item.itemId });
          } catch {
            /* ignore */
          }
          continue;
        }
        if (role === "user" && echoHandled.has(item.itemId)) continue;
        const done = item.status === "completed";
        if (role === "assistant" && isToolGarbage(text)) {
          // The model wrote tool syntax / tool JSON as text. Recover the
          // intended call (run it for real) and keep the junk out of
          // captions, history and the next session's prompt.
          if (done && !mirrored.has(item.itemId)) {
            let executed = 0;
            for (const c of extractFunctionCalls(text)) {
              if (c.name === "show" && !c.args?.value) continue; // malformed — don't set a junk panel
              executed++;
              void fetch("/api/tools", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ name: c.name, args: c.args }),
              }).catch(() => {});
            }
            // Nothing recoverable: swallow silently. (An immediate corrective
            // sendMessage here triggered a NEW response mid-flow and could
            // cascade into the session cutting off its own speech.)
            void executed;
          }
          text = sanitizeAssistantText(text);
          if (!text) {
            if (done) mirrored.add(item.itemId);
            continue;
          }
        }
        h.onCaption(role === "user" ? "you" : "jarvis", text, done);
        if (done && !mirrored.has(item.itemId)) {
          mirrored.add(item.itemId);
          if (role === "assistant") {
            recentAssistant.push({ text, ts: Date.now() });
            if (recentAssistant.length > 5) recentAssistant.shift();
          }
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
  try {
    micStream?.getTracks().forEach((t) => t.stop());
  } catch {
    /* ignore */
  }
  micStream = null;
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
