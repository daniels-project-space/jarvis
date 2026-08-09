import { mutation } from "./_generated/server";
import { v } from "convex/values";
import { actorAuthArgs, requireActor } from "./controlAuth";

const TURN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const MAX_DURATION_MS = 10 * 60_000;
const MAX_SOURCE_COUNT = 12;
const OUTCOME_RANK = { queued: 0, failed: 1, audible: 2 } as const;

const optionalDuration = v.optional(v.number());
const metricArgs = {
  turnId: v.string(),
  transcriptSource: v.union(v.literal("browser-final"), v.literal("server")),
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
