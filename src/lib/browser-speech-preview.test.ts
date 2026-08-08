import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  BROWSER_SPEECH_FINAL_MIN_CONFIDENCE,
  chooseLiveTranscriptSource,
  isStableBrowserSpeechRevision,
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
      })).toEqual({ source: "server" });
    }
  });

  it("falls back to one server decision on cancellation, stale speech, or session mismatch", () => {
    const final = preview({ isFinal: true, confidence: 0.99 });
    expect(chooseLiveTranscriptSource({
      preview: final,
      sessionId: final.sessionId,
      currentVoiceAt: final.observedVoiceAt + 90,
      sessionActive: true,
    })).toEqual({ source: "server" });
    expect(chooseLiveTranscriptSource({
      preview: final,
      sessionId: "new-session",
      currentVoiceAt: final.observedVoiceAt,
      sessionActive: true,
    })).toEqual({ source: "server" });
    expect(chooseLiveTranscriptSource({
      preview: final,
      sessionId: final.sessionId,
      currentVoiceAt: final.observedVoiceAt,
      sessionActive: false,
    })).toEqual({ source: "server" });
    expect(chooseLiveTranscriptSource({
      preview: null,
      sessionId: final.sessionId,
      currentVoiceAt: final.observedVoiceAt,
      sessionActive: true,
    })).toEqual({ source: "server" });
  });

  it("keeps the live capture path to one post-endpoint server STT call", () => {
    const source = readFileSync(new URL("../components/JarvisUI.tsx", import.meta.url), "utf8");
    const liveTurn = source.slice(
      source.indexOf("async function freeVoiceTurn()"),
      source.indexOf("async function toggleMic()"),
    );
    expect(liveTurn.match(/viewerFetchWithTimeout\("\/api\/stt"/g)).toHaveLength(1);
    expect(liveTurn.match(/await requestTranscript\(/g)).toHaveLength(1);
    expect(liveTurn).not.toContain("requestData()");
  });
});
