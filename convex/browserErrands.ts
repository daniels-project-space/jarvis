import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireActor, requireViewer, viewerAuthArgs } from "./controlAuth";

// Browser errands — JARVIS acting as Daniel in a logged-in browser.
//
// The approval gate lives HERE, in Convex, not in the tool layer: `run` refuses
// to hand a plan to jarvis-browser unless this table says Daniel approved that
// exact envelope. A model that decides to skip the proposal step simply cannot
// obtain a runnable errand.

const envelopeValidator = v.object({
  allowedHosts: v.array(v.string()),
  allowedActions: v.array(v.string()),
  maxSends: v.number(),
  maxSteps: v.number(),
  ttlMs: v.number(),
});

export const propose = mutation({
  args: {
    objective: v.string(),
    credentialId: v.optional(v.string()),
    envelope: envelopeValidator,
    plan: v.array(v.string()),
    chatId: v.optional(v.string()),
    authTokenHash: v.optional(v.string()),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    if (a.envelope.allowedHosts.length === 0) throw new Error("a plan must name at least one host");
    if (a.envelope.maxSends > 0 && !a.envelope.allowedActions.includes("send")) {
      throw new Error("a send budget requires 'send' in allowedActions");
    }
    return await ctx.db.insert("browserErrands", {
      objective: a.objective.slice(0, 500),
      credentialId: a.credentialId,
      envelope: a.envelope,
      plan: a.plan.slice(0, 30).map((s) => s.slice(0, 300)),
      status: "proposed",
      chatId: a.chatId,
      requestedAt: Date.now(),
    });
  },
});

export const pending = query({
  args: { ...viewerAuthArgs },
  handler: async (ctx, a) => {
    await requireViewer(ctx, a);
    const proposed = await ctx.db.query("browserErrands")
      .withIndex("by_status", (q: any) => q.eq("status", "proposed")).order("desc").take(20);
    const escalated = await ctx.db.query("browserErrands")
      .withIndex("by_status", (q: any) => q.eq("status", "needs_step_approval")).order("desc").take(20);
    return [...proposed, ...escalated];
  },
});

export const decide = mutation({
  args: {
    errandId: v.id("browserErrands"),
    decision: v.union(v.literal("approved"), v.literal("declined")),
    authTokenHash: v.optional(v.string()),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    const errand = await ctx.db.get(a.errandId);
    if (!errand) return false;
    if (errand.status !== "proposed" && errand.status !== "needs_step_approval") return false;
    await ctx.db.patch(a.errandId, { status: a.decision, resolvedAt: Date.now() });
    return true;
  },
});

/**
 * Claim an approved errand for execution. Single-use by design: it flips to
 * "running" in the same transaction, so a replayed tool call cannot re-run an
 * approval Daniel granted once.
 */
export const claim = mutation({
  args: {
    errandId: v.id("browserErrands"),
    authTokenHash: v.optional(v.string()),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    const errand = await ctx.db.get(a.errandId);
    if (!errand) return { ok: false as const, reason: "no such errand" };
    if (errand.status !== "approved") {
      return { ok: false as const, reason: `errand is '${errand.status}', not 'approved'` };
    }
    await ctx.db.patch(a.errandId, { status: "running", startedAt: Date.now() });
    return {
      ok: true as const,
      objective: errand.objective,
      credentialId: errand.credentialId ?? null,
      envelope: errand.envelope,
      plan: errand.plan,
    };
  },
});

export const finish = mutation({
  args: {
    errandId: v.id("browserErrands"),
    status: v.union(
      v.literal("done"), v.literal("failed"), v.literal("blocked"), v.literal("needs_step_approval"),
    ),
    result: v.optional(v.string()),
    escalation: v.optional(v.string()),
    sends: v.optional(v.number()),
    authTokenHash: v.optional(v.string()),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    const errand = await ctx.db.get(a.errandId);
    if (!errand) return false;
    await ctx.db.patch(a.errandId, {
      status: a.status,
      result: a.result?.slice(0, 4000),
      escalation: a.escalation?.slice(0, 1000),
      sends: a.sends,
      finishedAt: Date.now(),
      // An escalation re-opens the approval gate, so clear the earlier decision.
      ...(a.status === "needs_step_approval" ? { resolvedAt: undefined } : {}),
    });
    return true;
  },
});

export const get = query({
  args: { errandId: v.id("browserErrands"), ...viewerAuthArgs },
  handler: async (ctx, a) => {
    await requireViewer(ctx, a);
    return await ctx.db.get(a.errandId);
  },
});

export const recent = query({
  args: { ...viewerAuthArgs },
  handler: async (ctx, a) => {
    await requireViewer(ctx, a);
    return await ctx.db.query("browserErrands").order("desc").take(25);
  },
});
