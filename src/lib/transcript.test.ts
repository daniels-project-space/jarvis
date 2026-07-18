import { describe, expect, it } from "vitest";
import { cleanSpeechTranscript } from "./transcript";

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
});
