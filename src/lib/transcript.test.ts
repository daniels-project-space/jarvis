import { describe, expect, it } from "vitest";
import { cleanSpeechTranscript, isMeaningfulSpeechTranscript, isRecentVoiceDuplicate } from "./transcript";

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

  it("holds short repeated voice fragments long enough to break an echo loop", () => {
    const previous = { text: "Music.", at: 10_000 };
    expect(isRecentVoiceDuplicate("music", previous, 35_000)).toBe(true);
    expect(isRecentVoiceDuplicate("music", previous, 41_000)).toBe(false);
    expect(isRecentVoiceDuplicate("repeat the longer request now", { text: "repeat the longer request now", at: 10_000 }, 15_000)).toBe(false);
  });
});
