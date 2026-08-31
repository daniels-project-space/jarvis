import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireViewer, requireWorker, viewerAuthArgs } from "./controlAuth";
import {
  codexSessionUnavailableCode,
  isCodexSessionUnavailableCode,
  type CodexSessionUnavailableCode,
} from "../src/lib/codex-session-status";

const REPAIR_HOLD_LIMIT = 8;
const LEGACY_HOLD_LIMIT = 32;
const REPAIR_KEY = "managed-codex-session";

type RuntimeRow = Record<string, unknown>;

function holdCode(
  row: RuntimeRow,
  currentRepairGeneration: number,
  operationalSuccessAt = 0,
): CodexSessionUnavailableCode | null {
  if (row.status !== "needs_input" || row.active === false) return null;
  const holdAt = typeof row.controllerSessionHoldAt === "number"
    ? row.controllerSessionHoldAt
    : typeof row.updatedAt === "number" ? row.updatedAt : 0;
  // One later trusted Codex completion proves that this older global session
  // hold is stale. The job remains needs_input for its own audit/recovery; only
  // the misleading global reconnect warning and autonomous-work hold clear.
  if (holdAt > 0 && holdAt < operationalSuccessAt) return null;
  const holdGeneration = typeof row.controllerSessionRepairGeneration === "number"
    ? row.controllerSessionRepairGeneration
    : 0;
  if (holdGeneration < currentRepairGeneration) return null;
  // New worker holds carry a machine-readable code. Keep the text fallback
  // while already-held production jobs age out; it recognizes the same finite
  // signal and never treats a task or checkpoint as a session status source.
  if (row.controllerSessionRepairRequired === true) {
    return isCodexSessionUnavailableCode(row.controllerSessionHoldCode)
      ? row.controllerSessionHoldCode
      : null;
  }
  return codexSessionUnavailableCode(row.progress);
}

export function controllerSessionStatusFromRows(
  rows: readonly RuntimeRow[],
  currentRepairGeneration = 0,
  operationalSuccessAt = 0,
) {
  for (const row of rows) {
    const code = holdCode(row, currentRepairGeneration, operationalSuccessAt);
    if (code) return { state: "repair_required" as const, code };
  }
  // This is intentionally not a credential probe: "clear" means that no
  // unresolved durable work has reported a terminal controller-session hold.
  return { state: "clear" as const };
}

export async function currentControllerSessionRepairGeneration(ctx: { db: any }) {
  const repair = await ctx.db
    .query("controllerSessionRepairs")
    .withIndex("by_key", (q: any) => q.eq("key", REPAIR_KEY))
    .unique();
  return typeof repair?.generation === "number" ? repair.generation : 0;
}

/**
 * Called only after the trusted enrollment task has durably reseeded the
 * encrypted controller session. It records no credential material. Exact
 * retries are idempotent; older or contradictory versions fail closed.
 */
export const confirmRepair = mutation({
  args: {
    workerToken: v.string(),
    sessionVersion: v.number(),
    tokenExpiresAt: v.number(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireWorker(args.workerToken);
    const now = Date.now();
    if (
      !Number.isSafeInteger(args.sessionVersion)
      || args.sessionVersion < 1
      || !Number.isSafeInteger(args.tokenExpiresAt)
      || args.tokenExpiresAt <= now + 60_000
    ) throw new Error("Invalid controller-session repair receipt");
    const existing = await ctx.db
      .query("controllerSessionRepairs")
      .withIndex("by_key", (q: any) => q.eq("key", REPAIR_KEY))
      .unique();
    if (existing) {
      if (args.sessionVersion < existing.sessionVersion) return false;
      if (args.sessionVersion === existing.sessionVersion) {
        if (args.tokenExpiresAt !== existing.tokenExpiresAt) return false;
        return {
          generation: existing.generation,
          sessionVersion: existing.sessionVersion,
          tokenExpiresAt: existing.tokenExpiresAt,
          repairedAt: existing.repairedAt,
        };
      }
      const next = {
        generation: existing.generation + 1,
        sessionVersion: args.sessionVersion,
        tokenExpiresAt: args.tokenExpiresAt,
        repairedAt: now,
      };
      await ctx.db.patch(existing._id, next);
      return next;
    }
    const first = {
      key: REPAIR_KEY,
      generation: 1,
      sessionVersion: args.sessionVersion,
      tokenExpiresAt: args.tokenExpiresAt,
      repairedAt: now,
    };
    await ctx.db.insert("controllerSessionRepairs", first);
    return {
      generation: first.generation,
      sessionVersion: first.sessionVersion,
      tokenExpiresAt: first.tokenExpiresAt,
      repairedAt: first.repairedAt,
    };
  },
});

/**
 * Records only the fact that a trusted controller-managed Codex turn finished
 * successfully. This is a stale-hold fence, not a credential or health probe.
 */
export const confirmOperationalSuccess = mutation({
  args: {
    workerToken: v.string(),
    source: v.union(v.literal("foreground"), v.literal("background")),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    requireWorker(args.workerToken);
    const existing = await ctx.db
      .query("controllerSessionRepairs")
      .withIndex("by_key", (q) => q.eq("key", REPAIR_KEY))
      .unique();
    // A managed session has no safe operational-success lineage until its
    // first trusted enrollment receipt exists.
    if (!existing) return false;
    const now = Date.now();
    await ctx.db.patch(existing._id, {
      operationalSuccessAt: now,
      operationalSuccessSource: args.source,
    });
    return true;
  },
});

/**
 * Owner-visible, bounded session safety state. It reads only durable job
 * projections that a worker has already written after refusing to use an
 * unsafe session; it never acquires, refreshes, or exposes a subscription.
 */
export const status = query({
  args: { ...viewerAuthArgs },
  returns: v.any(),
  handler: async (ctx, args) => {
    await requireViewer(ctx, args);
    const [typedRows, legacyRows, repair] = await Promise.all([
      ctx.db.query("jobRuntime")
        .withIndex("by_controller_session_repair", (q) => q
          .eq("controllerSessionRepairRequired", true)
          .eq("status", "needs_input"))
        .order("desc")
        .take(REPAIR_HOLD_LIMIT),
      ctx.db.query("jobRuntime")
        .withIndex("by_visibility_status_priority", (q) => q
          .eq("visibility", "conversation")
          .eq("status", "needs_input"))
        .order("desc")
        .take(LEGACY_HOLD_LIMIT),
      ctx.db.query("controllerSessionRepairs")
        .withIndex("by_key", (q) => q.eq("key", REPAIR_KEY))
        .unique(),
    ]);
    return controllerSessionStatusFromRows(
      [...typedRows, ...legacyRows],
      typeof repair?.generation === "number" ? repair.generation : 0,
      typeof repair?.operationalSuccessAt === "number" ? repair.operationalSuccessAt : 0,
    );
  },
});
