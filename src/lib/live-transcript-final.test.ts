import { describe, expect, it } from "vitest";

import { selectFinalLiveTranscript } from "./live-transcript-final";

describe("selectFinalLiveTranscript", () => {
  it("keeps the accurate recorded final authoritative over a plausible streaming hallucination", () => {
    expect(selectFinalLiveTranscript({
      recordedText: "Jarvis, say banana.",
      streamedText: "Darwith say by man a",
    })).toEqual({ text: "Jarvis, say banana.", source: "recorded" });
  });

  it("falls back without turning punctuation or empty candidates into commands", () => {
    expect(selectFinalLiveTranscript({
      recordedText: "",
      browserFinalText: "open the project",
      streamedText: "open a project",
    })).toEqual({ text: "open the project", source: "browser-final" });
    expect(selectFinalLiveTranscript({ recordedText: ".", streamedText: "" }))
      .toEqual({ text: "", source: "none" });
  });
});
