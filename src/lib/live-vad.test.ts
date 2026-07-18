import { describe, expect, it } from "vitest";
import { advanceLiveVad, createLiveVadState } from "./live-vad";

function frames(levels: number[], options: { ttsActive: boolean; quietUntil?: number }) {
  const startedAt = 1_000;
  let state = createLiveVadState(startedAt);
  let barged = false;
  levels.forEach((level, index) => {
    const result = advanceLiveVad(state, {
      level,
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

  it("allows a sustained foreground voice to interrupt TTS", () => {
    const result = frames(Array(5).fill(70), { ttsActive: true });
    expect(result.state.spoke).toBe(true);
    expect(result.barged).toBe(true);
  });

  it("rejects the speaker tail after TTS ends", () => {
    const result = frames(Array(12).fill(40), { ttsActive: false, quietUntil: 5_000 });
    expect(result.state.spoke).toBe(false);
  });

  it("accepts normal speech after the speaker tail is quiet", () => {
    const result = frames([28, 28], { ttsActive: false });
    expect(result.state.spoke).toBe(true);
  });
});
