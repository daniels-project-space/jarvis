import { describe, expect, it } from "vitest";
import {
  buildVoiceTurnMetric,
  shouldRecordVoiceTurnMetric,
  type VoiceTurnMetric,
} from "./voice-turn-metrics";

describe("voice-turn metrics", () => {
  it("emits only bounded timing deltas and categorical state", () => {
    expect(buildVoiceTurnMetric({
      turnId: "voice-1",
      startedAt: 10,
      speechClosedAt: 1_010,
      transcriptReadyAt: 1_260,
      queuedAt: 1_500,
      firstAudioAt: 2_100,
      transcriptSource: "browser-final",
      endpointStrategy: "trusted-browser-final",
      researchState: "promoted",
      researchSourceCount: 20,
    }, "audible")).toEqual({
      turnId: "voice-1",
      transcriptSource: "browser-final",
      endpointStrategy: "trusted-browser-final",
      researchState: "promoted",
      researchSourceCount: 12,
      outcome: "audible",
      captureToSpeechClosedMs: 1_000,
      speechClosedToTranscriptMs: 250,
      transcriptToQueuedMs: 240,
      queuedToFirstAudioMs: 600,
      captureToFirstAudioMs: 2_090,
    });
  });

  it("rejects an unsafe identifier and drops impossible timings", () => {
    expect(buildVoiceTurnMetric({
      turnId: "bad id",
      startedAt: 1,
    }, "failed")).toBeNull();

    expect(buildVoiceTurnMetric({
      turnId: "voice-2",
      startedAt: 1_000,
      speechClosedAt: 200,
      transcriptReadyAt: 900_000,
    }, "failed")).toMatchObject({
      turnId: "voice-2",
      captureToSpeechClosedMs: undefined,
      speechClosedToTranscriptMs: undefined,
    });
  });

  it("samples healthy turns deterministically while retaining slow turns and failures", () => {
    const base: VoiceTurnMetric = {
      turnId: "voice-0",
      transcriptSource: "server",
      endpointStrategy: "standard",
      researchState: "none",
      researchSourceCount: 0,
      outcome: "queued",
      captureToSpeechClosedMs: 500,
    };
    const ids = Array.from({ length: 200 }, (_, index) => `voice-${index}`);
    const sampledId = ids.find((turnId) => shouldRecordVoiceTurnMetric({ ...base, turnId }));
    const unsampledId = ids.find((turnId) => !shouldRecordVoiceTurnMetric({ ...base, turnId }));
    expect(sampledId).toBeDefined();
    expect(unsampledId).toBeDefined();

    expect(shouldRecordVoiceTurnMetric({ ...base, turnId: sampledId! })).toBe(true);
    expect(shouldRecordVoiceTurnMetric({ ...base, turnId: sampledId! })).toBe(true);
    expect(shouldRecordVoiceTurnMetric({ ...base, turnId: unsampledId! })).toBe(false);
    expect(shouldRecordVoiceTurnMetric({
      ...base,
      turnId: unsampledId!,
      outcome: "audible",
      captureToFirstAudioMs: 7_999,
    })).toBe(false);
    expect(shouldRecordVoiceTurnMetric({
      ...base,
      turnId: unsampledId!,
      outcome: "audible",
      captureToFirstAudioMs: 8_000,
    })).toBe(true);
    expect(shouldRecordVoiceTurnMetric({ ...base, turnId: unsampledId!, outcome: "failed" })).toBe(true);
  });
});
