"use client";
// Standby wake word — say "jarvis" (or "hey jarvis") and live mode starts,
// Siri-style. Uses the browser's continuous SpeechRecognition (no cloud keys,
// no models to download); auto-restarts itself until stopped.

let rec: any = null;
let wanted = false;
let suppressed = false; // hard gate: JARVIS is literally saying "jarvis" right now
let softGuard = false; // JARVIS is speaking: only a short, bare "hey jarvis" gets through

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

export function startWake(onWake: () => void, onState?: (listening: boolean) => void) {
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
    r.onresult = (e: any) => {
      if (suppressed) return; // JARVIS is saying "jarvis" himself — never self-wake
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const text = String(e.results[i][0].transcript || "").toLowerCase().trim();
        if (/\b(hey\s+)?jarvis\b/.test(text)) {
          // while he's speaking, only a short bare wake phrase counts as Daniel
          // interrupting — longer speech is JARVIS's own voice leaking in
          if (softGuard && text.split(/\s+/).length > 4) continue;
          stopWake();
          onWake();
          return;
        }
      }
    };
    r.onend = () => {
      onState?.(false);
      if (wanted) setTimeout(spin, 400); // browser kills sessions periodically — respin
    };
    r.onerror = (e: any) => {
      // "not-allowed" = mic permission denied — stop trying
      if (e?.error === "not-allowed" || e?.error === "service-not-allowed") wanted = false;
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
