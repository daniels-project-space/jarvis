import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { api } from "./_generated/api";
import schema from "./schema";

declare global {
  interface ImportMeta {
    glob(pattern: string): Record<string, () => Promise<unknown>>;
  }
}

const modules = import.meta.glob("./**/*.ts");
const WORKER = "voice-metrics-test-worker";

beforeEach(() => {
  process.env.JARVIS_WORKER_TOKEN = WORKER;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-09T12:00:00Z"));
});

afterEach(() => {
  delete process.env.JARVIS_WORKER_TOKEN;
  vi.useRealTimers();
});

const metric = {
  turnId: "voice-1",
  transcriptSource: "server" as const,
  endpointStrategy: "standard" as const,
  researchState: "promoted" as const,
  researchSourceCount: 3,
  outcome: "queued" as const,
  captureToSpeechClosedMs: 800,
  speechClosedToTranscriptMs: 200,
  transcriptToQueuedMs: 150,
};

describe("voice performance metrics", () => {
  it("upserts one bounded no-transcript record per voice turn", async () => {
    const t = convexTest(schema, modules);
    const id = await t.mutation(api.voiceMetrics.record, { ...metric, workerToken: WORKER });
    await t.mutation(api.voiceMetrics.record, {
      ...metric,
      outcome: "audible",
      queuedToFirstAudioMs: 500,
      captureToFirstAudioMs: 1_650,
      workerToken: WORKER,
    });
    // Fire-and-forget requests can be delivered out of order. A delayed queue
    // event must not downgrade the terminal result or erase audio timings.
    await t.mutation(api.voiceMetrics.record, { ...metric, workerToken: WORKER });
    const rows = await t.run((ctx) => ctx.db.query("voiceTurnMetrics").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      _id: id,
      outcome: "audible",
      captureToFirstAudioMs: 1_650,
    });
    expect(rows[0]).not.toHaveProperty("text");
    expect(rows[0]).not.toHaveProperty("transcript");
  });

  it("rejects unbounded client durations", async () => {
    const t = convexTest(schema, modules);
    await expect(t.mutation(api.voiceMetrics.record, {
      ...metric,
      captureToSpeechClosedMs: 600_001,
      workerToken: WORKER,
    })).rejects.toThrow(/Invalid voice metric duration/);
  });
});
