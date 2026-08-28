import { describe, expect, it } from "vitest";
import {
  LIVE_BARGE_CALIBRATION_FRAMES,
  LIVE_BARGE_SAMPLE_MS,
  LIVE_BARGE_SPEECH_FRAMES,
  LIVE_COMPLETE_QUESTION_END_SILENCE_MS,
  LIVE_END_SILENCE_MS,
  LIVE_SPEAKER_TAIL_MS,
  LIVE_TRUSTED_BROWSER_FINAL_QUESTION_END_SILENCE_MS,
  LIVE_UNFINISHED_END_SILENCE_MS,
  advanceLiveVad,
  createLiveVadState,
  liveEndpointSilenceMs,
  shouldDeferLiveCapture,
  shouldCloseLiveUtterance,
  shouldStartLiveResearchPreview,
  spectrumBandLevel,
} from "./live-vad";

function frames(levels: number[], options: {
  ttsActive: boolean;
  quietUntil?: number;
  highFrequencyLevel?: number;
  aecEnabled?: boolean;
}) {
  const startedAt = 1_000;
  let state = createLiveVadState(startedAt);
  let bargeCount = 0;
  levels.forEach((level, index) => {
    const result = advanceLiveVad(state, {
      level,
      voiceLevel: level,
      highFrequencyLevel: options.highFrequencyLevel,
      now: startedAt + index * LIVE_BARGE_SAMPLE_MS,
      startedAt,
      ttsActive: options.ttsActive,
      quietUntil: options.quietUntil ?? 0,
      aecEnabled: options.aecEnabled,
    });
    state = result.state;
    if (result.bargeIn) bargeCount += 1;
  });
  return { state, barged: bargeCount > 0, bargeCount };
}

describe("live full-duplex voice gate", () => {
  it("does not begin a recorder while TTS, its tail, or keyboard input is active", () => {
    expect(shouldDeferLiveCapture({ ttsActive: true, now: 5_000, quietUntil: 0, keyboardQuietUntil: 0 })).toBe(true);
    expect(shouldDeferLiveCapture({ ttsActive: false, now: 5_000, quietUntil: 5_000 + LIVE_SPEAKER_TAIL_MS, keyboardQuietUntil: 0 })).toBe(true);
    expect(shouldDeferLiveCapture({ ttsActive: false, now: 5_000, quietUntil: 0, keyboardQuietUntil: 5_500 })).toBe(true);
    expect(shouldDeferLiveCapture({ ttsActive: false, now: 6_500, quietUntil: 6_400, keyboardQuietUntil: 6_000 })).toBe(false);
  });

  it("never treats ordinary speaker leakage as user speech", () => {
    const result = frames(Array(20).fill(35), {
      ttsActive: true,
      aecEnabled: true,
      highFrequencyLevel: 8,
    });
    expect(result.state.spoke).toBe(false);
    expect(result.barged).toBe(false);
    expect(result.state.speakerLeakFloor).toBeCloseTo(35);
  });

  it("calibrates a changing speaker baseline and rejects short loud passages", () => {
    const result = frames([
      22, 24, 28, 30, 32, 34,
      55, 55, 55, 55,
      33, 32,
      56, 56, 56, 56,
      31,
    ], { ttsActive: true, aecEnabled: true, highFrequencyLevel: 8 });
    expect(result.state.spoke).toBe(false);
    expect(result.barged).toBe(false);
  });

  it("emits one conservative barge candidate after calibration and sustained speech", () => {
    const result = frames([
      ...Array(LIVE_BARGE_CALIBRATION_FRAMES).fill(24),
      ...Array(LIVE_BARGE_SPEECH_FRAMES + 4).fill(62),
    ], { ttsActive: true, aecEnabled: true, highFrequencyLevel: 8 });
    expect(result.state.spoke).toBe(false);
    expect(result.barged).toBe(true);
    expect(result.bargeCount).toBe(1);
    expect(result.state.bargeFrames).toBe(LIVE_BARGE_SPEECH_FRAMES + 4);
  });

  it("does not emit a barge candidate without confirmed browser AEC", () => {
    const speechOverOutput = [
      ...Array(LIVE_BARGE_CALIBRATION_FRAMES).fill(24),
      ...Array(12).fill(70),
    ];
    expect(frames(speechOverOutput, { ttsActive: true, highFrequencyLevel: 8 }).barged).toBe(false);
    expect(frames(speechOverOutput, { ttsActive: true, aecEnabled: false, highFrequencyLevel: 8 }).barged).toBe(false);
  });

  it("rejects broadband noise over TTS even when it is sustained and loud", () => {
    const result = frames([
      ...Array(LIVE_BARGE_CALIBRATION_FRAMES).fill(24),
      ...Array(12).fill(70),
    ], { ttsActive: true, aecEnabled: true, highFrequencyLevel: 68 });
    expect(result.barged).toBe(false);
    expect(result.state.spoke).toBe(false);
  });

  it("rejects the speaker tail after TTS ends", () => {
    const result = frames(Array(12).fill(40), { ttsActive: false, quietUntil: 5_000 });
    expect(result.state.spoke).toBe(false);
  });

  it("accepts normal speech after the speaker tail is quiet", () => {
    const result = frames([28, 28, 28, 28], { ttsActive: false, highFrequencyLevel: 8 });
    expect(result.state.spoke).toBe(true);
    expect(result.state.acceptedFrames).toBe(4);
    expect(result.state.voiceStartedAt).toBe(1_000);
    expect(result.state.peakVoiceMargin).toBeGreaterThan(0);
  });

  it("rejects sustained broadband keyboard noise", () => {
    const result = frames(Array(20).fill(30), { ttsActive: false, highFrequencyLevel: 29 });
    expect(result.state.spoke).toBe(false);
  });

  it("does not close on a mid-sentence pause", () => {
    let state = { ...createLiveVadState(1_000), spoke: true, lastVoice: 2_000 };
    expect(shouldCloseLiveUtterance(state, 3_100)).toBe(false);
    state = advanceLiveVad(state, {
      level: 26,
      voiceLevel: 26,
      highFrequencyLevel: 7,
      now: 3_200,
      startedAt: 1_000,
      ttsActive: false,
      quietUntil: 0,
    }).state;
    expect(state.lastVoice).toBe(3_200);
    expect(shouldCloseLiveUtterance(state, state.lastVoice + LIVE_END_SILENCE_MS + 1)).toBe(true);
  });

  it("shortens endpointing only for a clear complete question", () => {
    const state = { ...createLiveVadState(1_000), spoke: true, lastVoice: 2_000 };
    const question = "How does Sesame train its voice agent?";
    expect(liveEndpointSilenceMs(question)).toBe(LIVE_COMPLETE_QUESTION_END_SILENCE_MS);
    expect(shouldCloseLiveUtterance(state, 2_000 + LIVE_COMPLETE_QUESTION_END_SILENCE_MS, question)).toBe(false);
    expect(shouldCloseLiveUtterance(state, 2_000 + LIVE_COMPLETE_QUESTION_END_SILENCE_MS + 1, question)).toBe(true);

    const statement = "I want to understand how its voice agent works";
    expect(liveEndpointSilenceMs(statement)).toBe(LIVE_END_SILENCE_MS);
    expect(shouldCloseLiveUtterance(state, 2_000 + LIVE_COMPLETE_QUESTION_END_SILENCE_MS + 1, statement)).toBe(false);
  });

  it("uses the faster boundary only for an exact trusted browser-final question", () => {
    const state = { ...createLiveVadState(1_000), spoke: true, lastVoice: 2_000 };
    const question = "How does Sesame train its voice agent?";
    expect(shouldCloseLiveUtterance(
      state,
      state.lastVoice + LIVE_TRUSTED_BROWSER_FINAL_QUESTION_END_SILENCE_MS,
      question,
      true,
    )).toBe(false);
    expect(shouldCloseLiveUtterance(
      state,
      state.lastVoice + LIVE_TRUSTED_BROWSER_FINAL_QUESTION_END_SILENCE_MS + 1,
      question,
      true,
    )).toBe(true);
    expect(shouldCloseLiveUtterance(
      state,
      state.lastVoice + LIVE_TRUSTED_BROWSER_FINAL_QUESTION_END_SILENCE_MS + 1,
      question,
    )).toBe(false);
    expect(shouldCloseLiveUtterance(
      state,
      state.lastVoice + LIVE_TRUSTED_BROWSER_FINAL_QUESTION_END_SILENCE_MS + 1,
      "I need you to help me with this",
      true,
    )).toBe(false);
    expect(shouldCloseLiveUtterance(
      state,
      state.lastVoice + LIVE_TRUSTED_BROWSER_FINAL_QUESTION_END_SILENCE_MS + 1,
      "How can I explain this to you —",
      true,
    )).toBe(false);
  });

  it("extends endpointing for an unfinished connective and a self-correction", () => {
    const state = { ...createLiveVadState(1_000), spoke: true, lastVoice: 2_000 };
    for (const partial of [
      "How does Sesame train its agent and",
      "Compare the voice architecture with",
      "Research the voice model, I mean",
      "Explain their approach —",
    ]) {
      expect(liveEndpointSilenceMs(partial)).toBe(LIVE_UNFINISHED_END_SILENCE_MS);
      expect(shouldCloseLiveUtterance(state, 2_000 + LIVE_END_SILENCE_MS + 200, partial)).toBe(false);
      expect(shouldCloseLiveUtterance(state, 2_000 + LIVE_UNFINISHED_END_SILENCE_MS + 1, partial)).toBe(true);
    }
  });

  it("keeps a natural unpunctuated pause on the proven default boundary", () => {
    const partial = "I have been thinking about their voice architecture";
    expect(liveEndpointSilenceMs(partial)).toBe(LIVE_END_SILENCE_MS);
    const state = { ...createLiveVadState(1_000), spoke: true, lastVoice: 2_000 };
    expect(shouldCloseLiveUtterance(state, 3_100, partial)).toBe(false);
  });

  it("measures vocal and keyboard bands independently", () => {
    const spectrum = new Uint8Array(256);
    // At 48 kHz / 256 bins, these populate roughly 100 Hz–3.8 kHz and 4.5–10 kHz.
    spectrum.fill(40, 1, 41);
    spectrum.fill(10, 48, 107);
    expect(spectrumBandLevel(spectrum, 48_000, 90, 3_800)).toBeGreaterThan(35);
    expect(spectrumBandLevel(spectrum, 48_000, 4_500, 10_000)).toBeLessThan(15);
  });
});

describe("live research preview admission", () => {
  const stable = {
    authoritativePartialTranscript: "Research how Sesame builds agent intelligence for natural voice",
    previousAuthoritativePartialTranscript: "Research how Sesame builds agent intelligence",
    alreadyStarted: false,
  };

  it("admits one read-only preview after two stable authoritative revisions", () => {
    expect(shouldStartLiveResearchPreview(stable)).toBe(true);
    expect(shouldStartLiveResearchPreview({ ...stable, alreadyStarted: true })).toBe(false);
  });

  it("rejects unstable topics and self-corrections", () => {
    expect(shouldStartLiveResearchPreview({
      ...stable,
      authoritativePartialTranscript: "Research how Perplexity builds agent intelligence for natural voice",
    })).toBe(false);
    expect(shouldStartLiveResearchPreview({
      ...stable,
      authoritativePartialTranscript: "Research how Sesame builds agent intelligence, no wait",
    })).toBe(false);
    expect(shouldStartLiveResearchPreview({
      ...stable,
      previousAuthoritativePartialTranscript: "Research how Sesame builds agent intelligence for natural voice",
      authoritativePartialTranscript: "Research how Sesame builds agent intelligence for expressive video",
    })).toBe(false);
  });

  it("rejects mutating requests and insufficient partial evidence", () => {
    expect(shouldStartLiveResearchPreview({
      ...stable,
      authoritativePartialTranscript: "Research how Sesame works and then deploy the change",
    })).toBe(false);
    expect(shouldStartLiveResearchPreview({
      ...stable,
      authoritativePartialTranscript: "Research Sesame voice",
    })).toBe(false);
  });
});
