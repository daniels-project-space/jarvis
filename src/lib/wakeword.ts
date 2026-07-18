"use client";
// Standby wake word — say "jarvis" (or "hey jarvis") and live mode starts,
// Siri-style. Uses the browser's continuous SpeechRecognition (no cloud keys,
// no models to download); auto-restarts itself until stopped.

let rec: any = null;
let wanted = false;
let suppressed = false; // hard gate: JARVIS is literally saying "jarvis" right now
let softGuard = false; // JARVIS is speaking: only a short, bare "hey jarvis" gets through
export const WAKE_COMMAND_GRACE_MS = 650;
const WAKE_RESTART_DELAY_MS = 120;

// Self-trigger gate with barge-in: while JARVIS speaks, long recognized speech
// is his own voice (ignored) — but Daniel snapping "hey jarvis" still
// interrupts, unless the utterance itself contains the word "jarvis".
export function setSuppressed(on: boolean, hard = false) {
  if (!on) {
    suppressed = false;
    softGuard = false;
  } else if (hard) {
    suppressed = true;
    softGuard = true;
  } else {
    softGuard = true;
  }
}

export function wakeSupported(): boolean {
  return typeof window !== "undefined" && !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);
}

export function commandAfterWake(transcript: string): string {
  return transcript
    .replace(/^.*?\b(?:hey\s+)?jarvis\b[\s,.:;!?-]*/i, "")
    .trim();
}

export function startWake(
  onWake: (transcript: string) => void,
  onState?: (listening: boolean) => void,
  onDetected?: (transcript: string) => void,
) {
  const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  if (!SR || wanted) return;
  wanted = true;
  const spin = () => {
    if (!wanted) return;
    const r = new SR();
    rec = r;
    r.lang = "en-GB";
    r.continuous = true;
    r.interimResults = true;
    let wakeTranscript = "";
    let wakeTimer: ReturnType<typeof setTimeout> | null = null;
    let delivered = false;
    let detected = false;
    const deliver = () => {
      if (delivered) return;
      delivered = true;
      if (wakeTimer) clearTimeout(wakeTimer);
      stopWake();
      onWake(wakeTranscript);
    };
    r.onresult = (e: any) => {
      if (suppressed) return; // JARVIS is saying "jarvis" himself — never self-wake
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const text = String(e.results[i][0].transcript || "").toLowerCase().trim();
        if (/\b(hey\s+)?jarvis\b/.test(text)) {
          // while he's speaking, only a short bare wake phrase counts as Daniel
          // interrupting — longer speech is JARVIS's own voice leaking in
          if (softGuard && text.split(/\s+/).length > 4) continue;
          wakeTranscript = text;
          if (!detected) {
            detected = true;
            // React on the first interim wake fragment. Command delivery keeps
            // a short grace window so "Jarvis, add milk" remains one turn.
            onDetected?.(wakeTranscript);
          }
          // Do not stop on the first interim "hey Jarvis" fragment. Waiting
          // for the final transcript preserves same-breath commands such as
          // "Hey Jarvis, add milk to my list" instead of opening and then
          // appearing to ignore everything after the wake word.
          if (e.results[i].isFinal) deliver();
          else {
            if (wakeTimer) clearTimeout(wakeTimer);
            wakeTimer = setTimeout(deliver, WAKE_COMMAND_GRACE_MS);
          }
          continue;
        }
        if (wakeTranscript && text) {
          wakeTranscript = `${wakeTranscript} ${text}`.trim();
          if (e.results[i].isFinal) deliver();
        }
      }
    };
    r.onend = () => {
      if (wakeTranscript && !delivered) {
        deliver();
        return;
      }
      if (wanted) {
        // SpeechRecognition ends its own sessions periodically. Keep the UI
        // logically active across the tiny respawn gap instead of flashing the
        // microphone off/on every few seconds.
        setTimeout(spin, WAKE_RESTART_DELAY_MS);
        return;
      }
      onState?.(false);
    };
    r.onerror = (e: any) => {
      // "not-allowed" = mic permission denied — stop trying
      if (e?.error === "not-allowed" || e?.error === "service-not-allowed") {
        wanted = false;
        onState?.(false);
      }
    };
    try {
      r.start();
      onState?.(true);
    } catch {
      /* already started */
    }
  };
  spin();
}

export function stopWake() {
  wanted = false;
  try {
    rec?.stop();
  } catch {
    /* ignore */
  }
  rec = null;
}

export function wakeActive() {
  return wanted;
}

// Soft chime so Daniel knows JARVIS woke up.
export function chime() {
  try {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = 880;
    o.connect(g);
    g.connect(ctx.destination);
    g.gain.setValueAtTime(0.001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + 0.03);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
    o.start();
    o.frequency.exponentialRampToValueAtTime(1320, ctx.currentTime + 0.18);
    o.stop(ctx.currentTime + 0.4);
  } catch {
    /* silent wake */
  }
}
