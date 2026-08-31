import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  BROWSER_SPEECH_FINAL_MIN_CONFIDENCE,
  chooseLiveTranscriptSource,
  isStableBrowserFinalRevision,
  isStableBrowserSpeechRevision,
  recoverLiveTranscriptFromBrowser,
  waitForBrowserSpeechFinal,
  type BrowserSpeechPreview,
} from "./browser-speech-preview";

function preview(overrides: Partial<BrowserSpeechPreview> = {}): BrowserSpeechPreview {
  return {
    sessionId: "voice-session-1",
    text: "Research how Sesame builds voice agents",
    isFinal: false,
    confidence: 0,
    observedVoiceAt: 4_000,
    ...overrides,
  };
}

describe("browser speech preview", () => {
  it("requires an exact longer same-session revision before preview research", () => {
    const previous = preview();
    expect(isStableBrowserSpeechRevision(previous, preview({
      text: "Research how Sesame builds voice agents for natural conversation",
      observedVoiceAt: 4_600,
    }))).toBe(true);
    expect(isStableBrowserSpeechRevision(previous, preview({
      text: "Research how Perplexity builds voice agents for natural conversation",
      observedVoiceAt: 4_600,
    }))).toBe(false);
    expect(isStableBrowserSpeechRevision(previous, preview({
      sessionId: "voice-session-2",
      text: "Research how Sesame builds voice agents for natural conversation",
    }))).toBe(false);
    expect(isStableBrowserSpeechRevision(previous, preview({
      text: "Research how Sesame builds voice agents for natural conversation",
      observedVoiceAt: 3_900,
    }))).toBe(false);
  });

  it("uses a browser final only with strong confidence and an exact VAD fence", () => {
    const final = preview({
      isFinal: true,
      confidence: BROWSER_SPEECH_FINAL_MIN_CONFIDENCE,
    });
    expect(chooseLiveTranscriptSource({
      preview: final,
      sessionId: final.sessionId,
      currentVoiceAt: final.observedVoiceAt,
      sessionActive: true,
      allowBrowserFinalTranscript: true,
    })).toEqual({ source: "browser-final", text: final.text });

    for (const rejected of [
      preview({ isFinal: false, confidence: 0.99 }),
      preview({ isFinal: true, confidence: BROWSER_SPEECH_FINAL_MIN_CONFIDENCE - 0.01 }),
      preview({ isFinal: true, confidence: Number.NaN }),
    ]) {
      expect(chooseLiveTranscriptSource({
        preview: rejected,
        sessionId: rejected.sessionId,
        currentVoiceAt: rejected.observedVoiceAt,
        sessionActive: true,
        allowBrowserFinalTranscript: true,
      })).toEqual({ source: "server" });
    }
  });

  it("accepts an unknown-confidence final only after an exact stable revision and explicit safe admission", () => {
    const previous = preview({ text: "How does Sesame make voice replies faster", observedVoiceAt: 4_000 });
    const final = preview({
      text: previous.text,
      isFinal: true,
      confidence: 0,
      observedVoiceAt: previous.observedVoiceAt,
    });
    expect(isStableBrowserFinalRevision(previous, final)).toBe(true);
    expect(chooseLiveTranscriptSource({
      previous,
      preview: final,
      sessionId: final.sessionId,
      currentVoiceAt: final.observedVoiceAt,
      sessionActive: true,
      allowBrowserFinalTranscript: true,
      allowStableFinalWithoutConfidence: true,
    })).toEqual({ source: "browser-final", text: final.text });

    expect(chooseLiveTranscriptSource({
      previous,
      preview: final,
      sessionId: final.sessionId,
      currentVoiceAt: final.observedVoiceAt,
      sessionActive: true,
    })).toEqual({ source: "server" });
  });

  it("rejects unstable, low-confidence, stale, and cross-session final revisions", () => {
    const previous = preview({ text: "How does Sesame make voice replies", observedVoiceAt: 4_000 });
    const base = preview({
      text: "How does another system make voice replies",
      isFinal: true,
      confidence: 0,
      observedVoiceAt: 4_000,
    });
    expect(isStableBrowserFinalRevision(previous, base)).toBe(false);
    for (const candidate of [
      base,
      { ...base, text: previous.text, confidence: 0.4 },
      { ...base, text: previous.text, sessionId: "voice-session-2" },
    ]) {
      expect(chooseLiveTranscriptSource({
        previous,
        preview: candidate,
        sessionId: "voice-session-1",
        currentVoiceAt: 4_000,
        sessionActive: true,
        allowBrowserFinalTranscript: true,
        allowStableFinalWithoutConfidence: true,
      })).toEqual({ source: "server" });
    }
    expect(chooseLiveTranscriptSource({
      previous,
      preview: { ...base, text: previous.text },
      sessionId: "voice-session-1",
      currentVoiceAt: 4_090,
      sessionActive: true,
      allowBrowserFinalTranscript: true,
      allowStableFinalWithoutConfidence: true,
    })).toEqual({ source: "server" });
  });

  it("falls back to one server decision on cancellation, stale speech, or session mismatch", () => {
    const final = preview({ isFinal: true, confidence: 0.99 });
    expect(chooseLiveTranscriptSource({
      preview: final,
      sessionId: final.sessionId,
      currentVoiceAt: final.observedVoiceAt + 90,
      sessionActive: true,
      allowBrowserFinalTranscript: true,
    })).toEqual({ source: "server" });
    expect(chooseLiveTranscriptSource({
      preview: final,
      sessionId: "new-session",
      currentVoiceAt: final.observedVoiceAt,
      sessionActive: true,
      allowBrowserFinalTranscript: true,
    })).toEqual({ source: "server" });
    expect(chooseLiveTranscriptSource({
      preview: final,
      sessionId: final.sessionId,
      currentVoiceAt: final.observedVoiceAt,
      sessionActive: false,
      allowBrowserFinalTranscript: true,
    })).toEqual({ source: "server" });
    expect(chooseLiveTranscriptSource({
      preview: null,
      sessionId: final.sessionId,
      currentVoiceAt: final.observedVoiceAt,
      sessionActive: true,
      allowBrowserFinalTranscript: true,
    })).toEqual({ source: "server" });
  });

  it("waits briefly for the final event that Chromium emits after recorder stop", async () => {
    vi.useFakeTimers();
    let current = preview({ text: "How does this voice path work", isFinal: false });
    let notify: () => void = () => undefined;
    const settled = waitForBrowserSpeechFinal({
      enabled: true,
      current: () => current,
      subscribe: (listener) => {
        notify = listener;
        return () => { notify = () => undefined; };
      },
    });

    current = { ...current, isFinal: true, confidence: 0.93 };
    notify();
    await expect(settled).resolves.toBe(true);
    vi.useRealTimers();
  });

  it("adds no wait without a recognizer and remains bounded when no final arrives", async () => {
    await expect(waitForBrowserSpeechFinal({
      enabled: false,
      current: () => null,
      subscribe: () => () => undefined,
    })).resolves.toBe(false);

    vi.useFakeTimers();
    const timedOut = waitForBrowserSpeechFinal({
      enabled: true,
      current: () => preview({ isFinal: false }),
      subscribe: () => () => undefined,
      timeoutMs: 25,
    });
    await vi.advanceTimersByTimeAsync(25);
    await expect(timedOut).resolves.toBe(false);
    vi.useRealTimers();
  });

  it("rescues a fenced recorded utterance only from a usable final or stable revision", () => {
    const previous = preview({ text: "show me the weather", observedVoiceAt: 3_900 });
    const stable = preview({ text: "show me the weather in Seville", observedVoiceAt: 4_000 });
    expect(recoverLiveTranscriptFromBrowser({
      previous,
      preview: stable,
      sessionId: stable.sessionId,
      currentVoiceAt: stable.observedVoiceAt,
      sessionActive: true,
      allowBrowserRecovery: true,
    })).toBe(stable.text);

    const final = preview({ isFinal: true, confidence: 0.7 });
    expect(recoverLiveTranscriptFromBrowser({
      previous: null,
      preview: final,
      sessionId: final.sessionId,
      currentVoiceAt: final.observedVoiceAt,
      sessionActive: true,
      allowBrowserRecovery: true,
    })).toBe(final.text);

    expect(recoverLiveTranscriptFromBrowser({
      previous: null,
      preview: final,
      sessionId: final.sessionId,
      currentVoiceAt: final.observedVoiceAt,
      sessionActive: true,
    })).toBe("");

    expect(recoverLiveTranscriptFromBrowser({
      previous,
      preview: stable,
      sessionId: "another-session",
      currentVoiceAt: stable.observedVoiceAt,
      sessionActive: true,
      allowBrowserRecovery: true,
    })).toBe("");
    expect(recoverLiveTranscriptFromBrowser({
      previous: null,
      preview: preview({ isFinal: true, confidence: 0.4 }),
      sessionId: "voice-session-1",
      currentVoiceAt: 4_000,
      sessionActive: true,
      allowBrowserRecovery: true,
    })).toBe("");
  });

  it("keeps one STT call site with a bounded two-attempt recovery for the same recording", () => {
    const source = readFileSync(new URL("../components/JarvisUI.tsx", import.meta.url), "utf8");
    const liveTurn = source.slice(
      source.indexOf("async function freeVoiceTurn()"),
      source.indexOf("async function toggleMic()"),
    );
    expect(liveTurn.match(/viewerFetchWithTimeout\("\/api\/stt"/g)).toHaveLength(1);
    expect(liveTurn.match(/await requestTranscript\(/g)).toHaveLength(1);
    expect(liveTurn).toContain("attempt < 2");
    expect(liveTurn).toContain('"x-jarvis-stt-attempt": String(attempt + 1)');
    expect(liveTurn).toContain("recoverLiveTranscriptFromBrowser");
    expect(liveTurn).toContain("waitForBrowserSpeechFinal");
    expect(liveTurn).toContain("isReadOnlyBrowserFinalTranscript");
    expect(liveTurn).not.toContain("requestData()");
  });
});
