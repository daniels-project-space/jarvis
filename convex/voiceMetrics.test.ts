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
const DISPATCH = "voice-metrics-test-dispatcher";
const OWNER_HASH = "a".repeat(64);

beforeEach(() => {
  process.env.JARVIS_WORKER_TOKEN = WORKER;
  process.env.JARVIS_DISPATCH_TOKEN = DISPATCH;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-09T12:00:00Z"));
});

afterEach(() => {
  delete process.env.JARVIS_WORKER_TOKEN;
  delete process.env.JARVIS_DISPATCH_TOKEN;
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

  it("returns bounded owner-only aggregate latency without turn data", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.insert("adminSessions", {
        tokenHash: OWNER_HASH,
        enrolledAt: now,
        createdAt: now,
        expiresAt: now + 60_000,
      });
    });
    await t.mutation(api.voiceMetrics.record, {
      ...metric,
      turnId: "voice-a",
      outcome: "audible",
      queuedToFirstAudioMs: 300,
      captureToFirstAudioMs: 1_000,
      workerToken: WORKER,
    });
    vi.advanceTimersByTime(1);
    await t.mutation(api.voiceMetrics.record, {
      ...metric,
      turnId: "voice-b",
      transcriptSource: "browser-final",
      endpointStrategy: "trusted-browser-final",
      outcome: "audible",
      queuedToFirstAudioMs: 500,
      captureToFirstAudioMs: 1_500,
      workerToken: WORKER,
    });
    vi.advanceTimersByTime(1);
    await t.mutation(api.voiceMetrics.record, {
      ...metric,
      turnId: "voice-c",
      outcome: "failed",
      captureToFirstAudioMs: 2_200,
      workerToken: WORKER,
    });

    await expect(t.query(api.voiceMetrics.summary, {})).rejects.toThrow(/Authentication required/);
    const summary = await t.query(api.voiceMetrics.summary, { authTokenHash: OWNER_HASH });
    expect(summary).toMatchObject({
      sampleCount: 3,
      sampleLimit: 500,
      outcomes: { audible: 2, failed: 1, queued: 0 },
      transcriptSources: { browserFinal: 1, server: 2 },
      endpointStrategies: { standard: 2, trustedBrowserFinal: 1 },
      latencies: {
        queuedToFirstAudio: { samples: 2, p50Ms: 300, p95Ms: 500 },
        captureToFirstAudio: { samples: 3, p50Ms: 1_500, p95Ms: 2_200 },
      },
    });
    expect(summary).not.toHaveProperty("turnId");
    expect(JSON.stringify(summary)).not.toContain("voice-a");

    await expect(t.query(api.voiceMetrics.summary, { dispatchToken: DISPATCH })).resolves.toEqual(summary);
  });
});
