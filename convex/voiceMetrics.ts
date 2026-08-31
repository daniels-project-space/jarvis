import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import {
  actorAuthArgs,
  ownerDispatcherAuthArgs,
  requireActor,
  requireOwnerOrDispatcher,
} from "./controlAuth";

const TURN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const MAX_DURATION_MS = 10 * 60_000;
const MAX_SOURCE_COUNT = 12;
const SUMMARY_SAMPLE_LIMIT = 500;
const OUTCOME_RANK = { queued: 0, failed: 1, audible: 2 } as const;

const optionalDuration = v.optional(v.number());
const metricArgs = {
  turnId: v.string(),
  transcriptSource: v.union(v.literal("browser-final"), v.literal("server")),
  endpointStrategy: v.optional(v.union(v.literal("standard"), v.literal("trusted-browser-final"))),
  researchState: v.union(v.literal("none"), v.literal("ready"), v.literal("discarded"), v.literal("promoted")),
  researchSourceCount: v.number(),
  outcome: v.union(v.literal("queued"), v.literal("audible"), v.literal("failed")),
  captureToSpeechClosedMs: optionalDuration,
  speechClosedToTranscriptMs: optionalDuration,
  transcriptToQueuedMs: optionalDuration,
  queuedToFirstAudioMs: optionalDuration,
  captureToFirstAudioMs: optionalDuration,
};

function validDuration(value: number | undefined): boolean {
  return value === undefined || (Number.isFinite(value) && Number.isInteger(value) && value >= 0 && value <= MAX_DURATION_MS);
}

function latencySummary(values: Array<number | undefined>) {
  const sorted = values.filter((value): value is number => typeof value === "number").sort((a, b) => a - b);
  const percentile = (fraction: number) => sorted.length === 0
    ? null
    : sorted[Math.ceil(sorted.length * fraction) - 1];
  return { samples: sorted.length, p50Ms: percentile(0.5), p95Ms: percentile(0.95) };
}

/** Upserts privacy-safe performance counters for one owner voice turn. */
export const record = mutation({
  args: { ...metricArgs, ...actorAuthArgs },
  handler: async (ctx, args) => {
    await requireActor(ctx, args);
    if (!TURN_ID.test(args.turnId) || args.turnId.length > 120) throw new Error("Invalid voice metric turn id");
    if (!Number.isInteger(args.researchSourceCount) || args.researchSourceCount < 0 || args.researchSourceCount > MAX_SOURCE_COUNT) {
      throw new Error("Invalid voice metric source count");
    }
    const durations = [
      args.captureToSpeechClosedMs,
      args.speechClosedToTranscriptMs,
      args.transcriptToQueuedMs,
      args.queuedToFirstAudioMs,
      args.captureToFirstAudioMs,
    ];
    if (!durations.every(validDuration)) throw new Error("Invalid voice metric duration");

    const incoming = {
      turnId: args.turnId,
      transcriptSource: args.transcriptSource,
      endpointStrategy: args.endpointStrategy ?? "standard",
      researchState: args.researchState,
      researchSourceCount: args.researchSourceCount,
      outcome: args.outcome,
      captureToSpeechClosedMs: args.captureToSpeechClosedMs,
      speechClosedToTranscriptMs: args.speechClosedToTranscriptMs,
      transcriptToQueuedMs: args.transcriptToQueuedMs,
      queuedToFirstAudioMs: args.queuedToFirstAudioMs,
      captureToFirstAudioMs: args.captureToFirstAudioMs,
      updatedAt: Date.now(),
    };
    const existing = await ctx.db
      .query("voiceTurnMetrics")
      .withIndex("by_turn", (q) => q.eq("turnId", args.turnId))
      .first();
    if (existing) {
      // Client diagnostics are fire-and-forget, so later lifecycle requests can
      // arrive first. Never let a delayed queued/failed request downgrade an
      // audible result or erase audio timings already captured.
      const outcome = OUTCOME_RANK[args.outcome] >= OUTCOME_RANK[existing.outcome]
        ? args.outcome
        : existing.outcome;
      await ctx.db.patch(existing._id, {
        ...incoming,
        outcome,
        captureToSpeechClosedMs: args.captureToSpeechClosedMs ?? existing.captureToSpeechClosedMs,
        speechClosedToTranscriptMs: args.speechClosedToTranscriptMs ?? existing.speechClosedToTranscriptMs,
        transcriptToQueuedMs: args.transcriptToQueuedMs ?? existing.transcriptToQueuedMs,
        queuedToFirstAudioMs: args.queuedToFirstAudioMs ?? existing.queuedToFirstAudioMs,
        captureToFirstAudioMs: args.captureToFirstAudioMs ?? existing.captureToFirstAudioMs,
      });
      return existing._id;
    }
    return await ctx.db.insert("voiceTurnMetrics", incoming);
  },
});

/**
 * Owner-only, aggregate voice latency snapshot. It deliberately returns no
 * turn IDs, timestamps, transcript text, source URLs, or device data.
 */
export const summary = query({
  args: ownerDispatcherAuthArgs,
  handler: async (ctx, args) => {
    await requireOwnerOrDispatcher(ctx, args);
    const rows = await ctx.db
      .query("voiceTurnMetrics")
      .withIndex("by_updatedAt")
      .order("desc")
      .take(SUMMARY_SAMPLE_LIMIT);
    return {
      sampleCount: rows.length,
      sampleLimit: SUMMARY_SAMPLE_LIMIT,
      outcomes: {
        audible: rows.filter((row) => row.outcome === "audible").length,
        failed: rows.filter((row) => row.outcome === "failed").length,
        queued: rows.filter((row) => row.outcome === "queued").length,
      },
      transcriptSources: {
        browserFinal: rows.filter((row) => row.transcriptSource === "browser-final").length,
        server: rows.filter((row) => row.transcriptSource === "server").length,
      },
      endpointStrategies: {
        standard: rows.filter((row) => row.endpointStrategy === "standard").length,
        trustedBrowserFinal: rows.filter((row) => row.endpointStrategy === "trusted-browser-final").length,
      },
      latencies: {
        captureToSpeechClosed: latencySummary(rows.map((row) => row.captureToSpeechClosedMs)),
        speechClosedToTranscript: latencySummary(rows.map((row) => row.speechClosedToTranscriptMs)),
        transcriptToQueued: latencySummary(rows.map((row) => row.transcriptToQueuedMs)),
        queuedToFirstAudio: latencySummary(rows.map((row) => row.queuedToFirstAudioMs)),
        captureToFirstAudio: latencySummary(rows.map((row) => row.captureToFirstAudioMs)),
      },
    };
  },
});
