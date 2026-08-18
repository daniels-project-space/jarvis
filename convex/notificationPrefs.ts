import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { actorAuthArgs, requireActor, requireViewer, requireWorker, viewerAuthArgs } from "./controlAuth";

// Which categories may interrupt Daniel, and when.
//
// Fail-open is the governing choice here: an install that has never been
// configured still delivers. Only an explicit `false` silences a category, so
// a missed price hit is always something he turned off, never something the
// system defaulted him into.

export type NotificationCategory = "price_hunt" | "errand" | "work" | "reminder" | "incident";

const KEY = "default";

const DEFAULTS = {
  pushEnabled: true,
  categories: {
    price_hunt: true,
    errand: true,
    work: true,
    reminder: true,
    incident: true,
  },
  quietHoursStart: undefined as number | undefined,
  quietHoursEnd: undefined as number | undefined,
};

function inQuietHours(start?: number, end?: number, now = new Date()): boolean {
  if (start === undefined || end === undefined || start === end) return false;
  const hour = now.getHours();
  // Windows that wrap midnight (23 -> 7) are the normal case, so handle them
  // as first-class rather than as an edge.
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

export const get = query({
  args: { ...viewerAuthArgs },
  handler: async (ctx, a) => {
    await requireViewer(ctx, a);
    const row = await ctx.db.query("notificationPrefs").withIndex("by_key", (q: any) => q.eq("key", KEY)).first();
    return row ?? { key: KEY, ...DEFAULTS, updatedAt: 0 };
  },
});

/**
 * Worker-facing gate. Returns whether a push for `category` should go out now.
 * The bell is never gated by this — suppressed notifications still appear
 * in-app, so quiet hours defer rather than discard.
 */
export const shouldPush = query({
  args: { category: v.string(), workerToken: v.optional(v.string()), authTokenHash: v.optional(v.string()) },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const row = await ctx.db.query("notificationPrefs").withIndex("by_key", (q: any) => q.eq("key", KEY)).first();
    if (!row) return { allowed: true, reason: "no preferences set" };
    if (!row.pushEnabled) return { allowed: false, reason: "push disabled" };
    const categories = row.categories as Record<string, boolean>;
    if (categories[a.category] === false) return { allowed: false, reason: `${a.category} muted` };
    if (inQuietHours(row.quietHoursStart, row.quietHoursEnd)) {
      return { allowed: false, reason: "quiet hours" };
    }
    return { allowed: true, reason: "ok" };
  },
});

export const update = mutation({
  args: {
    pushEnabled: v.optional(v.boolean()),
    categories: v.optional(v.object({
      price_hunt: v.optional(v.boolean()),
      errand: v.optional(v.boolean()),
      work: v.optional(v.boolean()),
      reminder: v.optional(v.boolean()),
      incident: v.optional(v.boolean()),
    })),
    quietHoursStart: v.optional(v.number()),
    quietHoursEnd: v.optional(v.number()),
    ...actorAuthArgs,
  },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    for (const hour of [a.quietHoursStart, a.quietHoursEnd]) {
      if (hour !== undefined && (!Number.isInteger(hour) || hour < 0 || hour > 23)) {
        throw new Error("quiet hours must be integers 0..23");
      }
    }
    const existing = await ctx.db.query("notificationPrefs").withIndex("by_key", (q: any) => q.eq("key", KEY)).first();
    const base = existing ?? { key: KEY, ...DEFAULTS, updatedAt: 0 };
    const merged = {
      key: KEY,
      pushEnabled: a.pushEnabled ?? base.pushEnabled,
      categories: { ...base.categories, ...(a.categories ?? {}) },
      quietHoursStart: a.quietHoursStart ?? base.quietHoursStart,
      quietHoursEnd: a.quietHoursEnd ?? base.quietHoursEnd,
      updatedAt: Date.now(),
    };
    if (existing) {
      await ctx.db.patch(existing._id, merged);
      return existing._id;
    }
    return await ctx.db.insert("notificationPrefs", merged);
  },
});
