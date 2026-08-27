import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { actorAuthArgs, requireActor, requireViewer, viewerAuthArgs } from "./controlAuth";

const DUE_BATCH_SIZE = 50;
const DUE_PENDING_RESERVE = 25;
const DELIVERY_LEASE_MS = 5 * 60_000;

// Timed reminders: "remind me at 7pm to call mum" → push + spoken weave when
// due. The agent-runner cron (*/2) sweeps `due` and delivers.
export const add = mutation({
  args: {
    text: v.string(),
    at: v.number(),
    sourceKey: v.optional(v.string()),
    originThreadId: v.optional(v.string()),
    // A caller may opt a source-key update into an atomic server-clock cutoff.
    // Normal reminders deliberately retain their existing behavior.
    sourceKeyUpdateCutoffAt: v.optional(v.number()),
    ...actorAuthArgs,
  },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    const sourceKey = a.sourceKey?.trim();
    if (sourceKey && !/^[a-f0-9]{64}$/.test(sourceKey)) throw new Error("Reminder source key is invalid");
    if (a.sourceKeyUpdateCutoffAt !== undefined
      && (!sourceKey || !Number.isFinite(a.sourceKeyUpdateCutoffAt))) {
      throw new Error("Reminder source-key update cutoff is invalid");
    }
    // This is intentionally inside the transactional mutation rather than a
    // caller-side clock check: a delayed worker must not update or create the
    // source-keyed reminder after its owner-facing protection window starts.
    if (sourceKey && a.sourceKeyUpdateCutoffAt !== undefined && Date.now() >= a.sourceKeyUpdateCutoffAt) {
      // Keep the normal mutation's return type stable for every ordinary
      // reminder caller. The Trigger refresher recognizes this fixed code and
      // records the travel preflight as too late without touching Hub.
      throw new Error("source_update_cutoff_passed");
    }
    // Automated travel and booking flows can retry after an interrupted web or
    // calendar handoff. Re-use the same pending reminder rather than creating
    // a second push/spoken alert, and refresh its timing if Gmail changed it.
    if (sourceKey) {
      const existing = await ctx.db
        .query("reminders")
        .withIndex("by_sourceKey", (q: any) => q.eq("sourceKey", sourceKey))
        .unique();
      if (existing) {
        // A rescheduled future trip may have already delivered its earlier
        // preflight. Re-arm that one durable reminder, but never revive a
        // reminder the owner explicitly cancelled.
        if (existing.status === "pending" || (existing.status === "done" && a.at > Date.now())) {
          await ctx.db.patch(existing._id, {
            text: a.text.slice(0, 300),
            at: a.at,
            originThreadId: a.originThreadId,
            ...(existing.status === "done" ? {
              status: "pending",
              // This is also the delivery fence.  Do not reset it when a
              // source-keyed reminder is re-armed: a very late worker from
              // the earlier schedule must never match the new delivery.
              deliverStartedAt: undefined,
            } : {}),
          });
        }
        return existing._id;
      }
    }
    return await ctx.db.insert("reminders", {
      text: a.text.slice(0, 300),
      at: a.at,
      status: "pending",
      sourceKey,
      originThreadId: a.originThreadId,
      deliveryAttempts: 0,
      createdAt: Date.now(),
    });
  },
});

export const due = mutation({
  args: { ...actorAuthArgs },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    const now = Date.now();
    const pending = await ctx.db
      .query("reminders")
      .withIndex("by_status", (q: any) => q.eq("status", "pending").lte("at", now))
      .take(DUE_BATCH_SIZE);
    const stale = await ctx.db
      .query("reminders")
      .withIndex("by_status_deliverStartedAt", (q: any) => q
        .eq("status", "delivering")
        .lt("deliverStartedAt", now - DELIVERY_LEASE_MS))
      .take(DUE_BATCH_SIZE);
    // Always reserve half the bounded batch for newly-due reminders. Reclaimed
    // delivery leases fill unused capacity, then remaining pending work does;
    // this keeps recovery moving without letting a stale backlog delay fresh
    // owner-facing reminders forever.
    const reservedPending = pending.slice(0, DUE_PENDING_RESERVE);
    const reclaimed = stale.slice(0, DUE_BATCH_SIZE - reservedPending.length);
    const pendingFill = pending.slice(
      reservedPending.length,
      reservedPending.length + DUE_BATCH_SIZE - reservedPending.length - reclaimed.length,
    );
    const fire = [...reservedPending, ...reclaimed, ...pendingFill];
    // Claim atomically. A Trigger container dying after this point is recovered
    // after the lease, rather than leaving the reminder stuck forever.
    for (const row of fire)
      await ctx.db.patch(row._id, {
        status: "delivering",
        deliverStartedAt: now,
        deliveryAttempts: (row.deliveryAttempts ?? 0) + 1,
      });
    return fire.map((row: any) => ({
      _id: row._id,
      text: row.text,
      at: row.at,
      originThreadId: row.originThreadId,
      // `deliveryAttempts` is a monotonic lease generation, not merely
      // observability.  The worker must present this exact value when it
      // persists the visible reminder.
      deliveryAttempt: (row.deliveryAttempts ?? 0) + 1,
    }));
  },
});

export const deliver = mutation({
  args: {
    id: v.id("reminders"),
    deliveryAttempt: v.number(),
    threadId: v.string(),
    ...actorAuthArgs,
  },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    const reminder = await ctx.db.get(a.id);
    // The five-minute reaper can hand the same reminder to a newer Trigger
    // run.  Persisting the chat row and terminal reminder state in this one
    // transaction lets exactly one lease win, including response-lost retry
    // paths, instead of allowing both workers to weave the alert.
    if (
      !reminder
      || reminder.status !== "delivering"
      || reminder.deliveryAttempts !== a.deliveryAttempt
    ) return false;
    const now = Date.now();
    const minutesLate = Math.round((now - reminder.at) / 60_000);
    const late = minutesLate > 4
      ? ` (set for ${new Date(reminder.at).toLocaleTimeString("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "Europe/London",
      })})`
      : "";
    await ctx.db.insert("chatMessages", {
      threadId: a.threadId,
      role: "assistant",
      text: `⏰ Reminder, sir — ${reminder.text}${late}`,
      status: "done",
      delivery: "notification",
      createdAt: now,
    });
    await ctx.db.patch(reminder._id, {
      status: "done",
      deliverStartedAt: undefined,
    });
    return true;
  },
});

export const complete = mutation({
  args: { id: v.id("reminders"), ...actorAuthArgs },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    await ctx.db.patch(a.id, { status: "done" });
  },
});

export const cancel = mutation({
  args: { match: v.string(), ...actorAuthArgs },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    const rows = await ctx.db
      .query("reminders")
      .withIndex("by_status", (q: any) => q.eq("status", "pending"))
      .order("asc")
      .take(100);
    const m = a.match.toLowerCase();
    const hit = rows.find((r: any) => r.text.toLowerCase().includes(m));
    if (!hit) return false;
    await ctx.db.patch(hit._id, { status: "cancelled" });
    return hit.text;
  },
});

export const upcoming = query({
  args: { ...viewerAuthArgs },
  handler: async (ctx, a) => {
    await requireViewer(ctx, a);
    const rows = await ctx.db
      .query("reminders")
      .withIndex("by_status", (q: any) => q.eq("status", "pending"))
      .order("asc")
      .take(20);
    return rows;
  },
});
