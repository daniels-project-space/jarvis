import { describe, expect, it } from "vitest";
import {
  DEFAULT_STABLE_SPEECH_DEBOUNCE_MS,
  stableSpeechDebounceMs,
  VOICE_FIRST_STABLE_SPEECH_DEBOUNCE_MS,
} from "./voice-response-latency";

describe("stableSpeechDebounceMs", () => {
  it("starts the first already-stable voice clause sooner", () => {
    expect(stableSpeechDebounceMs({ voiceTurn: true, scheduledChars: 0 }))
      .toBe(VOICE_FIRST_STABLE_SPEECH_DEBOUNCE_MS);
  });

  it("keeps typed chat and follow-on voice chunks coalesced for natural cadence", () => {
    expect(stableSpeechDebounceMs({ voiceTurn: false, scheduledChars: 0 }))
      .toBe(DEFAULT_STABLE_SPEECH_DEBOUNCE_MS);
    expect(stableSpeechDebounceMs({ voiceTurn: true, scheduledChars: 24 }))
      .toBe(DEFAULT_STABLE_SPEECH_DEBOUNCE_MS);
  });
});
