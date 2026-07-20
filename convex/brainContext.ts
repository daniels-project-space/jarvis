import { query } from "./_generated/server";
import { v } from "convex/values";
import { requireViewer, viewerAuthArgs } from "./controlAuth";
import {
  BRAIN_CONTEXT_KEY,
  BRAIN_CONTEXT_VERSION,
  BRAIN_ACTIVE_INDEX_VERSION,
  MAX_MEMORY_MATCHES,
  emptyBrainContext,
  mergeMemoryDtos,
} from "./brainContextModel";

export const LOST_REFRESH_LEASE_MS = 60_000;

// Foreground contract: two singleton reads (projection + scheduler health) and
// at most four bounded DTO memory hits. Operational tables are never scanned
// here. A stale projection remains useful last-known-good context and reports a
// repair recommendation instead of falling back to the legacy fan-out.
export const snapshot = query({
  args: { userText: v.optional(v.string()), ...viewerAuthArgs },
  handler: async (ctx, a) => {
    await requireViewer(ctx, a);
    const now = Date.now();
    const [projection, refresh] = await Promise.all([
      ctx.db
        .query("brainContextProjection")
        .withIndex("by_key", (q: any) => q.eq("key", BRAIN_CONTEXT_KEY))
        .first(),
      ctx.db
        .query("brainContextRefresh")
        .withIndex("by_key", (q: any) => q.eq("key", BRAIN_CONTEXT_KEY))
        .first(),
    ]);
    const text = a.userText?.trim().slice(0, 240);
    const matches = text
      ? await ctx.db
          .query("brainMemory")
          .withSearchIndex("search_text", (q: any) => q.search("searchText", text))
          .take(MAX_MEMORY_MATCHES)
      : [];

    const versionValid = projection?.version === BRAIN_CONTEXT_VERSION;
    const payload = versionValid ? projection.payload : emptyBrainContext(0);
    const pending = Boolean(refresh?.dirtySources?.length);
    const refreshLeaseLost = pending && (!refresh?.scheduledAt || now - refresh.scheduledAt >= LOST_REFRESH_LEASE_MS);
    const activeIndexComplete = refresh?.activeIndexVersion === BRAIN_ACTIVE_INDEX_VERSION
      && refresh?.activeIndexComplete === true;
    const activeLeaseLost = !activeIndexComplete
      && (!refresh?.activeBackfillScheduledAt || now - refresh.activeBackfillScheduledAt >= LOST_REFRESH_LEASE_MS);
    const state = !versionValid
      ? "missing"
      : refreshLeaseLost || activeLeaseLost
        ? "stale"
        : !activeIndexComplete
          ? "migrating"
          : pending
            ? "refreshing"
            : "fresh";

    return {
      ...payload,
      memory: mergeMemoryDtos(matches, payload.memory ?? [], 10),
      generatedAt: versionValid ? projection.generatedAt : 0,
      projection: {
        state,
        version: versionValid ? projection.version : 0,
        generatedAt: versionValid ? projection.generatedAt : 0,
        payloadBytes: versionValid ? projection.payloadBytes : 0,
        refreshRequestedAt: refresh?.requestedAt ?? 0,
        lastRefreshCompletedAt: refresh?.lastCompletedAt ?? 0,
        memoryIndexComplete: refresh?.memoryComplete ?? false,
        activeIndexComplete,
        refreshRecommended: state === "missing" || state === "stale",
      },
    };
  },
});
