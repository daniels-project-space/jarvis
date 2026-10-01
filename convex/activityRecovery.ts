import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import { internalAction, internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { requireWorker } from "./controlAuth";

export const RECOVERY_INTERVAL_MS = 60_000;
const tickRef = makeFunctionReference<"mutation">("activityRecovery:tick");
const wakeRef = makeFunctionReference<"action">("activityRecovery:wake");
const KEY = "activity-recovery";
const armedInTransaction = new WeakMap<MutationCtx, number>();

// One timer shared by all admissions. Inserting work and arming recovery are
// one transaction, so a lost Vercel/Trigger wake cannot strand that work.
export async function armActivityRecovery(ctx: MutationCtx, at = Date.now() + RECOVERY_INTERVAL_MS): Promise<void> {
  // A fleet reservation/control batch can transition many jobs in one
  // transaction. Read the shared timer once rather than multiplying index
  // ranges and risking Convex's 128-range execution limit.
  const armedAt = armedInTransaction.get(ctx);
  if (armedAt !== undefined && armedAt <= at) return;
  const row = await ctx.db.query("activityRecoveryTimers").withIndex("by_key", q => q.eq("key", KEY)).unique();
  if (row?.scheduledId && row.at <= at) {
    const scheduled = await ctx.db.system.get(row.scheduledId);
    if (scheduled?.state.kind === "pending" || scheduled?.state.kind === "inProgress") {
      armedInTransaction.set(ctx, row.at);
      return;
    }
  }
  if (row?.scheduledId) await ctx.scheduler.cancel(row.scheduledId);
  const scheduledId = await ctx.scheduler.runAt(at, tickRef, { at });
  if (row) await ctx.db.patch(row._id, { at, scheduledId });
  else await ctx.db.insert("activityRecoveryTimers", { key: KEY, at, scheduledId });
  armedInTransaction.set(ctx, at);
}

// Keep the generated mutation builder's generic signature and argument/result
// inference. Use this only for admissions and owner control transitions, never
// stream deltas, worker heartbeats or viewer reads.
export const activityMutation: typeof mutation = (definition: any) => mutation({
  ...definition,
  handler: async (ctx: MutationCtx, args: any) => {
    const result = await definition.handler(ctx, args);
    await armActivityRecovery(ctx);
    return result;
  },
});

export type RecoveryDemand = { chat: boolean; fleet: boolean; nextAt: number | null };

async function recoveryDemand(ctx: QueryCtx | MutationCtx, includeChat = true): Promise<RecoveryDemand> {
  const now = Date.now();
  let nextAt: number | null = null;
  const due = (at: number | undefined) => {
    if (!Number.isFinite(at)) return false;
    nextAt = Math.min(nextAt ?? Infinity, Math.max(now + RECOVERY_INTERVAL_MS, at!));
    return at! <= now;
  };
  const first = async (table: "chatMessages" | "jobs" | "missions" | "incidents" | "browserErrands", status: string) =>
    await ctx.db.query(table).withIndex("by_status", q => q.eq("status", status)).first();
  const [pending, streaming, running, dispatching, steering, mission, synthesis, incident, browser] = await Promise.all([
    includeChat ? first("chatMessages", "pending") : null,
    includeChat ? first("chatMessages", "streaming") : null,
    ctx.db.query("jobRuntime").withIndex("by_status_priority", q => q.eq("status", "running")).first(),
    ctx.db.query("jobRuntime").withIndex("by_status_priority", q => q.eq("status", "dispatching")).first(),
    ctx.db.query("jobRuntime").withIndex("by_status_priority", q => q.eq("status", "steering")).first(),
    ctx.db.query("missionRuntime").withIndex("by_status", q => q.eq("status", "running")).take(20),
    ctx.db.query("missionRuntime").withIndex("by_status", q => q.eq("status", "synthesizing")).first(),
    first("incidents", "open"),
    ctx.db.query("browserErrands").withIndex("by_status_lease", q => q.eq("status", "running")).first(),
  ]);
  // Dispatch-ready heads exclude dependent work and approval/system holds.
  const queued = await ctx.db.query("jobRuntime").withIndex("by_dispatch_ready", q => q
    .eq("status", "pending").eq("schedulingBound", true).eq("dispatchReady", true)).first();
  const paused = await ctx.db.query("jobRuntime").withIndex("by_status_next_run", q => q
    .eq("status", "paused").gte("nextRunAt", 0)).first();
  const pausedClaim = await ctx.db.query("jobRuntime").withIndex("by_pause_checkpoint_heartbeat", q => q
    .eq("status", "paused").eq("pauseCheckpointPending", true)).first();
  const configurationHold = await ctx.db.query("jobs").withIndex("by_status_provider_observed", q => q
    .eq("status", "paused").eq("providerRunState", "blocked"))
    .filter(q => q.eq(q.field("cloudWorkspaceBlockCode"), "missing_configuration")).first();
  const integration = await Promise.all(["claimed", "prepared", "provider_waiting"].map(status => ctx.db
    .query("integrationAttempts").withIndex("by_status_created", q => q.eq("status", status)).first()));
  const [reminder, delivering, watch] = await Promise.all([
    ctx.db.query("reminders").withIndex("by_status", q => q.eq("status", "pending")).first(),
    ctx.db.query("reminders").withIndex("by_status_deliverStartedAt", q => q.eq("status", "delivering")).first(),
    ctx.db.query("watchRules").withIndex("by_status_nextCheckAt", q => q.eq("status", "active")).first(),
  ]);
  const preflights = await Promise.all([
    "scheduled", "pending_refresh", "pending_google", "needs_flight_confirmation", "needs_city_confirmation",
  ].map(state => ctx.db.query("appleMapsOfflinePreflights").withIndex("by_refreshState_nextRefreshAt", q => q
    .eq("refreshState", state as any).gt("nextRefreshAt", Number.MIN_SAFE_INTEGER)).first()));
  const supervisors = await Promise.all(["ready", "waiting", "leased"].map(state => ctx.db
    .query("missionSupervisorState").withIndex("by_state_due", q => q.eq("state", state as any)).first()));
  const cleanups = await Promise.all(["checkpointed", "paused", "cancelled", "done", "error", "needs_input"].map(status => ctx.db
    .query("workAttempts").withIndex("by_cloud_workspace_cleanup_status", q => q
      .eq("cloudWorkspaceCleanupEligible", true).eq("status", status).eq("providerTerminatedAt", undefined)).first()));
  let fleet = Boolean(running || dispatching || steering || synthesis || incident);
  // A mission can remain "running" while every job is paused or waiting for
  // Daniel. That label alone is not runnable work. Preserve automatic phase
  // advancement and synthesis when terminal children actually make it ready.
  for (const row of mission) {
    if (row.mode === "goal" || row.externalRunId) continue; // goal coordinator owns phase/external reconciliation
    const active = await ctx.db.query("jobRuntime").withIndex("by_mission_active_priority", q => q
      .eq("missionId", String(row.missionId)).eq("active", true)).first();
    if (active) continue;
    const children = await ctx.db.query("jobRuntime").withIndex("by_mission", q => q.eq("missionId", String(row.missionId))).take(101);
    if (children.length > 0 && children.length <= 100 && children.every(child => ["done", "error", "cancelled"].includes(child.status))) fleet = true;
  }
  if (queued) fleet = due(queued.nextRunAt ?? now) || fleet;
  if (paused) fleet = due(paused.nextRunAt) || fleet;
  if (pausedClaim) fleet = due((pausedClaim.heartbeatAt ?? 0) + 5 * 60_000) || fleet;
  if (configurationHold) fleet = due((configurationHold.providerObservedAt ?? 0) + 60 * 60_000) || fleet;
  if (integration.some(Boolean)) fleet = true;
  if (browser) fleet = due(browser.leaseUntil ?? now) || fleet;
  if (reminder) fleet = due(reminder.at) || fleet;
  if (delivering) fleet = due((delivering.deliverStartedAt ?? 0) + 5 * 60_000) || fleet;
  if (watch) fleet = due(Math.min(Math.max(watch.nextCheckAt, watch.leaseUntil ?? 0), watch.expiresAt ?? Infinity)) || fleet;
  for (const row of preflights) if (row) fleet = due(row.nextRefreshAt) || fleet;
  for (const row of supervisors) if (row) fleet = due(row.state === "leased" ? row.leaseUntil : row.nextTickAt) || fleet;
  for (const row of cleanups) if (row) fleet = due(Math.max(row.cleanupNextRetryAt ?? 0, row.progressAt + 5 * 60_000)) || fleet;
  const chat = Boolean(pending || streaming);
  if (chat || fleet) nextAt = now + RECOVERY_INTERVAL_MS;
  return { chat, fleet, nextAt };
}

export const demand = query({
  args: { workerToken: v.optional(v.string()) },
  handler: async (ctx, args): Promise<RecoveryDemand> => {
    requireWorker(args.workerToken);
    return await recoveryDemand(ctx);
  },
});

// The self-hosted fleet stays subscribed while idle. Foreground token deltas
// must not invalidate its signal or repeatedly recompute the fleet indexes.
export const fleetDemand = query({
  args: { workerToken: v.optional(v.string()) },
  handler: async (ctx, args): Promise<RecoveryDemand> => {
    requireWorker(args.workerToken);
    return await recoveryDemand(ctx, false);
  },
});

export const tick = internalMutation({
  args: { at: v.optional(v.number()) },
  handler: async (ctx, args): Promise<RecoveryDemand | null> => {
    const row = await ctx.db.query("activityRecoveryTimers").withIndex("by_key", q => q.eq("key", KEY)).unique();
    if (args.at !== undefined && row?.at !== args.at) return null;
    // The hourly safety sweep must not duplicate an already-armed timer.
    if (args.at === undefined && row?.scheduledId) {
      const scheduled = await ctx.db.system.get(row.scheduledId);
      if (scheduled?.state.kind === "pending" || scheduled?.state.kind === "inProgress") return null;
    }
    if (row) await ctx.db.patch(row._id, { scheduledId: undefined });
    const demand = await recoveryDemand(ctx);
    if (demand.chat || demand.fleet) await ctx.scheduler.runAfter(0, wakeRef, { ...demand, at: Date.now() });
    if (demand.nextAt !== null) await armActivityRecovery(ctx, demand.nextAt);
    return demand;
  },
});

export const wake = internalAction({
  args: { chat: v.boolean(), fleet: v.boolean(), nextAt: v.union(v.number(), v.null()), at: v.number() },
  handler: async (_ctx, args) => {
    const token = process.env.JARVIS_WORKER_TOKEN;
    if (!token) throw new Error("Recovery worker capability is missing");
    const response = await fetch("https://jarvis-orcin-six.vercel.app/api/activity-recovery", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ chat: args.chat, fleet: args.fleet, at: args.at }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`Recovery wake failed (${response.status})`);
    // The next durable minute timer retries even if this action or the network
    // dies. No success receipt can cancel an uncompleted work item's recovery.
  },
});
