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

    const hasProjection = Boolean(projection?.payload);
    const versionValid = projection?.version === BRAIN_CONTEXT_VERSION;
    // A preceding-version row is still the last known good read model. During
    // rollout it is safer and more useful than pretending that all operational
    // state vanished; the projection state below makes its migration explicit.
    const payload = hasProjection ? projection!.payload : emptyBrainContext(0);
    const activeIndexComplete = refresh?.activeIndexVersion === BRAIN_ACTIVE_INDEX_VERSION
      && refresh?.activeIndexComplete === true;
    const dirtySources = Array.isArray(refresh?.dirtySources) ? refresh.dirtySources : [];
    const pending = dirtySources.length > 0;
    const refreshablePending = pending && (
      activeIndexComplete
      || dirtySources.some((source: string) => !["projects", "work", "attention"].includes(source))
    );
    // Dependent dirt is intentionally unscheduled while the active index is
    // migrating. Only a source that can currently be rebuilt needs a live
    // refresh lease; otherwise every foreground turn would mislabel healthy
    // migration as stale and repeatedly kick a scheduler that has no work yet.
    const refreshLeaseLost = refreshablePending
      && (!refresh?.scheduledAt || now - refresh.scheduledAt >= LOST_REFRESH_LEASE_MS);
    const activeLeaseLost = !activeIndexComplete
      && (!refresh?.activeBackfillScheduledAt || now - refresh.activeBackfillScheduledAt >= LOST_REFRESH_LEASE_MS);
    const state = !hasProjection
      ? "missing"
      : refreshLeaseLost || activeLeaseLost
        ? "stale"
        : !versionValid || !activeIndexComplete
          ? "migrating"
          : pending
            ? "refreshing"
            : "fresh";

    return {
      ...payload,
      memory: mergeMemoryDtos(matches, payload.memory ?? [], 10),
      generatedAt: hasProjection ? projection!.generatedAt : 0,
      projection: {
        state,
        version: hasProjection ? projection!.version : 0,
        generatedAt: hasProjection ? projection!.generatedAt : 0,
        payloadBytes: hasProjection ? projection!.payloadBytes : 0,
        refreshRequestedAt: refresh?.requestedAt ?? 0,
        lastRefreshCompletedAt: refresh?.lastCompletedAt ?? 0,
        memoryIndexComplete: refresh?.memoryComplete ?? false,
        activeIndexComplete,
        refreshRecommended: state === "missing" || state === "stale",
      },
    };
  },
});
