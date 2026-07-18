import { describe, expect, it } from "vitest";
import { cleanSpeechTranscript, hasConfidentSpeechSegments, isMeaningfulSpeechTranscript, isRecentVoiceDuplicate } from "./transcript";

describe("cleanSpeechTranscript", () => {
  it("collapses the exact repeated live utterance seen in production", () => {
    expect(cleanSpeechTranscript("Hey, how are you? Hey, how are you?"))
      .toBe("Hey, how are you?");
    expect(cleanSpeechTranscript("Can you investigate this shell issue, please? Can you investigate this shell issue, please?"))
      .toBe("Can you investigate this shell issue, please?");
  });

  it("handles three repeated STT segments", () => {
    expect(cleanSpeechTranscript("Hi JARVIS. Hi JARVIS. Hi JARVIS."))
      .toBe("Hi JARVIS.");
  });

  it("preserves intentional emphasis and non-identical clauses", () => {
    expect(cleanSpeechTranscript("That is very, very good."))
      .toBe("That is very, very good.");
    expect(cleanSpeechTranscript("How are you? I am feeling better."))
      .toBe("How are you? I am feeling better.");
  });

  it("rejects punctuation-only Whisper noise", () => {
    expect(isMeaningfulSpeechTranscript(".")).toBe(false);
    expect(isMeaningfulSpeechTranscript(" … — ")).toBe(false);
    expect(isMeaningfulSpeechTranscript("Music")).toBe(true);
  });

  it("rejects non-speech and low-confidence transcription segments", () => {
    expect(hasConfidentSpeechSegments([{ start: 0, end: 1.2, avg_logprob: -0.2, no_speech_prob: 0.04 }])).toBe(true);
    expect(hasConfidentSpeechSegments([{ start: 0, end: 1.2, avg_logprob: -0.2, no_speech_prob: 0.82 }])).toBe(false);
    expect(hasConfidentSpeechSegments([{ start: 0, end: 1.2, avg_logprob: -1.1, no_speech_prob: 0.1 }])).toBe(false);
    expect(hasConfidentSpeechSegments([])).toBe(false);
  });

  it("holds exact repeated voice text long enough to break a stale STT loop", () => {
    const previous = { text: "Music.", at: 10_000 };
    expect(isRecentVoiceDuplicate("music", previous, 35_000)).toBe(true);
    expect(isRecentVoiceDuplicate("music", previous, 310_001)).toBe(false);
    const longer = { text: "repeat the longer request now", at: 10_000 };
    expect(isRecentVoiceDuplicate("repeat the longer request now", longer, 25_000)).toBe(true);
    expect(isRecentVoiceDuplicate("repeat the longer request now", longer, 100_001)).toBe(false);
  });
});
