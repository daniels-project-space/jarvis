import { describe, expect, it } from "vitest";
import {
  compactChatFeedback,
  foregroundUiProgress,
  shouldOfferForegroundRecovery,
} from "./chat-ui-feedback";

describe("compact Jarvis feedback", () => {
  it("shows recognized speech immediately instead of leaving the old assistant reply frozen", () => {
    expect(compactChatFeedback({
      phase: "thinking",
      caption: { who: "you", text: "show me a niche map of Sevilla" },
      latestUser: "an older request",
      latestAssistant: "an older answer",
    })).toBe("You: show me a niche map of Sevilla");

    expect(compactChatFeedback({
      phase: "listening",
      caption: { who: "you", text: "Processing…" },
      latestAssistant: "an older answer",
    })).toBe("Processing…");
  });

  it("hands feedback from optimistic input to streaming output and audio recovery", () => {
    expect(compactChatFeedback({
      phase: "responding",
      caption: { who: "you", text: "new request" },
      latestAssistant: "I found three quiet places.",
      assistantStreaming: true,
    })).toBe("I found three quiet places.");
    expect(compactChatFeedback({
      phase: "voice paused",
      caption: null,
      latestAssistant: "The finished answer.",
    })).toMatch(/tap the speaker/i);
  });

  it("moves visual progress forward without pretending thinking is complete", () => {
    const early = foregroundUiProgress({ phase: "thinking", elapsedMs: 500 });
    const later = foregroundUiProgress({ phase: "thinking", elapsedMs: 12_000 });
    const streaming = foregroundUiProgress({ phase: "responding", elapsedMs: 12_000, streamedChars: 600 });
    expect(early).toBeGreaterThanOrEqual(0.3);
    expect(later).toBeGreaterThan(early);
    expect(later).toBeLessThan(0.5);
    expect(streaming).toBeGreaterThan(later);
    expect(streaming).toBeLessThan(0.9);
  });

  it("offers manual recovery only after a real active turn has had a fair start", () => {
    expect(shouldOfferForegroundRecovery({ elapsedMs: 20_000, hasActiveTurn: false, recovery: "waiting" })).toBe(false);
    expect(shouldOfferForegroundRecovery({ elapsedMs: 7_999, hasActiveTurn: true, recovery: "waiting" })).toBe(false);
    expect(shouldOfferForegroundRecovery({ elapsedMs: 8_000, hasActiveTurn: true, recovery: "waiting" })).toBe(true);
    expect(shouldOfferForegroundRecovery({ elapsedMs: 0, hasActiveTurn: true, recovery: "failed" })).toBe(true);
  });
});
