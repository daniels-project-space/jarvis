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
let liveTransport: OpenAIRealtimeWebRTC | null = null;
let audioEl: HTMLAudioElement | null = null;

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

export function isLive() {
  return session !== null && liveTransport?.status === "connected";
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
  if (!session || liveTransport?.status !== "connected") return false;
  try {
    session.sendMessage(text);
    return true;
  } catch {
    return false;
  }
}

export type ReflexState = "connecting" | "ready" | "off" | "error";
export type ReflexHandlers = {
  onState: (state: ReflexState, detail?: string) => void;
  onCaption: (text: string, done: boolean) => void;
  onTurnDone: (role: "user" | "assistant", text: string) => void;
};

let reflexSession: RealtimeSession | null = null;
let reflexTransport: OpenAIRealtimeWebRTC | null = null;
let reflexStarting: Promise<boolean> | null = null;
let reflexAudioContext: AudioContext | null = null;
let reflexSilentStream: MediaStream | null = null;
let reflexHandlers: ReflexHandlers | null = null;
let queuedReflexText: string | null = null;

// The SDK emits the complete local history on every streaming update and its
// own update path scans that array. Keep a useful recent window so a long-lived
// always-available JARVIS session cannot get progressively more expensive on
// every later turn. Durable history/context still lives in Convex and is baked
// into each fresh token.
function compactSessionHistory(target: RealtimeSession | null) {
  if (!target || target.history.length <= 32) return;
  target.updateHistory((history) => history.slice(-24));
}

function silentAudioStream(): MediaStream {
  // The SDK's WebRTC transport requires an audio track to negotiate the peer
  // connection. A disabled MediaStreamDestination track satisfies WebRTC
  // without opening the microphone or sending billable speech content.
  reflexAudioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
  const destination = reflexAudioContext.createMediaStreamDestination();
  const track = destination.stream.getAudioTracks()[0];
  if (!track) throw new Error("could not create silent reflex transport");
  track.enabled = false;
  reflexSilentStream = destination.stream;
  return destination.stream;
}

export function isReflexReady() {
  return reflexSession !== null && reflexTransport?.status === "connected";
}

export function interruptReflex() {
  try {
    reflexSession?.interrupt();
  } catch {
    /* ignore */
  }
}

export function sendReflexText(text: string): boolean {
  if (!reflexSession || reflexTransport?.status !== "connected") return false;
  try {
    reflexSession.sendMessage(text);
    return true;
  } catch {
    return false;
  }
}

// A page can receive a typed message during the 1–2 second WebRTC handshake.
// Previously that race dropped straight into the durable job queue, making the
// interface look frozen despite the fast lane being moments from ready. Hold
// exactly one turn locally and flush it the instant the peer connects.
export function queueReflexText(text: string): boolean {
  if (sendReflexText(text)) return true;
  if (queuedReflexText) return false;
  queuedReflexText = text;
  return true;
}

export function cancelQueuedReflexText(text?: string) {
  if (!text || queuedReflexText === text) queuedReflexText = null;
}

function flushQueuedReflexText() {
  const text = queuedReflexText;
  if (!text || !sendReflexText(text)) return false;
  queuedReflexText = null;
  return true;
}

export function stopReflex() {
  try {
    reflexSession?.close();
  } catch {
    /* ignore */
  }
  reflexSession = null;
  reflexTransport = null;
  try {
    reflexSilentStream?.getTracks().forEach((track) => track.stop());
  } catch {
    /* ignore */
  }
  reflexSilentStream = null;
  try {
    void reflexAudioContext?.close();
  } catch {
    /* ignore */
  }
  reflexAudioContext = null;
  queuedReflexText = null;
}

function resetReflexConnection() {
  try {
    reflexSession?.close();
  } catch {
    /* ignore */
  }
  reflexSession = null;
  reflexTransport = null;
  try {
    reflexSilentStream?.getTracks().forEach((track) => track.stop());
  } catch {
    /* ignore */
  }
  reflexSilentStream = null;
  try {
    void reflexAudioContext?.close();
  } catch {
    /* ignore */
  }
  reflexAudioContext = null;
}

export async function startReflex(h: ReflexHandlers, clientId = ""): Promise<boolean> {
  reflexHandlers = h;
  if (isReflexReady()) {
    h.onState("ready");
    return true;
  }
  if (reflexStarting) return reflexStarting;

  reflexStarting = (async () => {
    h.onState("connecting");
    try {
      // Do not discard a typed turn queued during this very handshake.
      resetReflexConnection();
      const [response, coreTools] = await Promise.all([
        fetch("/api/realtime-token", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ client: clientId, mode: "reflex" }),
        }),
        clientTools("core"),
      ]);
      const token = await response.json();
      if (!response.ok || !token.token) throw new Error(token.error ?? "no reflex token");

      const transport = new OpenAIRealtimeWebRTC({ mediaStream: silentAudioStream() });
      reflexTransport = transport;
      const activeTools = new Map<string, any>();
      for (const bridge of coreTools as any[]) activeTools.set(String(bridge.name), bridge);
      let makeAgent: () => RealtimeAgent;
      const domainTool = tool({
        name: "load_tool_domain",
        description:
          "Load a specialist tool belt only when needed: work for missions/projects/repairs/control/memory, creative for images/drawing/docs, travel for trip planning, or business for markets/rentals/shopping. After loading, call the requested specialist tool.",
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
          if (reflexSession) await reflexSession.updateAgent(makeAgent());
          return `${domain} tools loaded. Now call the specific tool Daniel asked for; do not merely describe it.`;
        },
      });
      makeAgent = () =>
        new RealtimeAgent({
          name: "JARVIS",
          instructions:
            String(token.instructions ?? "") +
            "\n\nYou begin with a compact core tool belt. When the requested tool is absent, load its domain and immediately use it. Never claim an action happened after only loading a belt.",
          tools: [...activeTools.values(), domainTool],
        });

      const nextSession = new RealtimeSession(makeAgent(), {
        transport,
        model: token.model || "gpt-realtime-2.1-mini",
        config: {
          outputModalities: ["text"],
          reasoning: { effort: "minimal" },
          audio: {
            input: { transcription: null, turnDetection: null, noiseReduction: null },
            output: null,
          },
        },
      });
      reflexSession = nextSession;
      const mirrored = new Set<string>();
      const observed = new Map<string, string>();
      nextSession.on("history_updated", (history: any[]) => {
        for (const item of history.slice(-32)) {
          if (item?.type !== "message") continue;
          const role = item.role === "user" ? "user" : "assistant";
          let text = (item.content ?? [])
            .map((content: any) => content?.transcript ?? content?.text ?? "")
            .join(" ")
            .trim();
          const observation = `${item.status ?? ""}|${text}`;
          if (observed.get(item.itemId) === observation) continue;
          observed.set(item.itemId, observation);
          if (!text || text.startsWith(NUDGE.slice(0, 20))) continue;
          if (role === "assistant" && isToolGarbage(text)) text = sanitizeAssistantText(text);
          if (!text) continue;
          const done = item.status === "completed";
          if (role === "assistant") reflexHandlers?.onCaption(text, done);
          if (done && !mirrored.has(item.itemId)) {
            mirrored.add(item.itemId);
            reflexHandlers?.onTurnDone(role, text);
            if (role === "assistant") setTimeout(() => compactSessionHistory(reflexSession), 0);
          }
        }
      });
      nextSession.on("error", (event: any) => {
        const detail = String(event?.error?.message ?? event?.message ?? event?.error ?? event);
        resetReflexConnection();
        reflexHandlers?.onState("error", detail);
      });
      await nextSession.connect({ apiKey: token.token });
      // Keep the synthetic negotiation track disabled for the entire session.
      nextSession.mute(true);
      reflexHandlers?.onState("ready");
      flushQueuedReflexText();
      return true;
    } catch (error: any) {
      resetReflexConnection();
      reflexHandlers?.onState("error", String(error?.message ?? error));
      return false;
    } finally {
      reflexStarting = null;
    }
  })();
  return reflexStarting;
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
    liveTransport = transport;

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
        "Load a specialist tool belt only when needed: work for missions/projects/repairs/control/memory, creative for images/drawing/docs, travel for trip planning, or business for markets/rentals/shopping. After loading, call the requested specialist tool.",
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
        // All speech output is free on-device TTS. Realtime supplies only the
        // fast text brain and microphone understanding — never paid model audio.
        outputModalities: ["text"],
        reasoning: { effort: "low" },
        audio: {
          input: {
            transcription: { model: "gpt-4o-transcribe", language: "en", prompt: STT_PROMPT },
            turnDetection: { type: "semantic_vad", eagerness: "high" },
            noiseReduction: { type: "near_field" },
          },
          output: null,
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
      for (const item of history.slice(-32)) {
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
          if (role === "assistant") setTimeout(() => compactSessionHistory(session), 0);
        }
      }
    });
    session.on("transport_event", (event: any) => {
      // Local TTS is outside the Realtime audio buffer. Stop it explicitly the
      // instant Daniel starts speaking so barge-in still feels natural.
      if (event?.type === "input_audio_buffer.speech_started") {
        void import("./tts").then((m) => m.stopSpeaking());
      }
    });
    session.on("error", (e: any) => {
      console.error("live error", e);
      const detail = String(e?.error?.message ?? e?.message ?? e?.error ?? e);
      stopLive();
      h.onState("error", detail);
    });

    await session.connect({ apiKey: tk.token });
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
  liveTransport = null;
  try {
    micStream?.getTracks().forEach((t) => t.stop());
  } catch {
    /* ignore */
  }
  micStream = null;
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
