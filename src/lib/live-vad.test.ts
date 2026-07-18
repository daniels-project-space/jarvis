import { describe, expect, it } from "vitest";
import {
  LIVE_END_SILENCE_MS,
  advanceLiveVad,
  createLiveVadState,
  shouldCloseLiveUtterance,
  spectrumBandLevel,
} from "./live-vad";

function frames(levels: number[], options: { ttsActive: boolean; quietUntil?: number; highFrequencyLevel?: number }) {
  const startedAt = 1_000;
  let state = createLiveVadState(startedAt);
  let barged = false;
  levels.forEach((level, index) => {
    const result = advanceLiveVad(state, {
      level,
      voiceLevel: level,
      highFrequencyLevel: options.highFrequencyLevel,
      now: startedAt + index * 90,
      startedAt,
      ttsActive: options.ttsActive,
      quietUntil: options.quietUntil ?? 0,
    });
    state = result.state;
    barged ||= result.bargeIn;
  });
  return { state, barged };
}

describe("live full-duplex voice gate", () => {
  it("never treats ordinary speaker leakage as user speech", () => {
    const result = frames(Array(20).fill(35), { ttsActive: true });
    expect(result.state.spoke).toBe(false);
    expect(result.barged).toBe(false);
  });

  it("never accepts loud speaker output as a barge-in", () => {
    const result = frames(Array(5).fill(70), { ttsActive: true });
    expect(result.state.spoke).toBe(false);
    expect(result.barged).toBe(false);
  });

  it("rejects the speaker tail after TTS ends", () => {
    const result = frames(Array(12).fill(40), { ttsActive: false, quietUntil: 5_000 });
    expect(result.state.spoke).toBe(false);
  });

  it("accepts normal speech after the speaker tail is quiet", () => {
    const result = frames([28, 28, 28, 28], { ttsActive: false, highFrequencyLevel: 8 });
    expect(result.state.spoke).toBe(true);
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

  it("measures vocal and keyboard bands independently", () => {
    const spectrum = new Uint8Array(256);
    // At 48 kHz / 256 bins, these populate roughly 100 Hz–3.8 kHz and 4.5–10 kHz.
    spectrum.fill(40, 1, 41);
    spectrum.fill(10, 48, 107);
    expect(spectrumBandLevel(spectrum, 48_000, 90, 3_800)).toBeGreaterThan(35);
    expect(spectrumBandLevel(spectrum, 48_000, 4_500, 10_000)).toBeLessThan(15);
  });
});
