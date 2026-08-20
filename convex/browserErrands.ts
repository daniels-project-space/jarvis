import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireActor, requireAdmin, requireViewer, viewerAuthArgs } from "./controlAuth";

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

// `ttlMs` is passed to jarvis-browser as the task lifetime as well as being
// the owner's approval lifetime. Keep the Convex lease a little longer than
// that task lifetime so a still-valid browser task is never reaped underneath
// itself, while still giving a crashed request a terminal, non-retryable end.
const MIN_TASK_TTL_MS = 60_000;
const MAX_TASK_TTL_MS = 6 * 60 * 60_000;
const LEASE_GRACE_MS = 2 * 60_000;
const MAX_REAP_BATCH = 20;

function boundedTaskTtl(ttlMs: number): number {
  if (!Number.isFinite(ttlMs)) return MIN_TASK_TTL_MS;
  return Math.min(MAX_TASK_TTL_MS, Math.max(MIN_TASK_TTL_MS, Math.trunc(ttlMs)));
}

function terminalLeaseFailure(now: number) {
  return {
    status: "failed",
    result: "The execution lease expired before a final receipt arrived. Its outcome is unknown, so JARVIS did not retry it automatically.",
    finishedAt: now,
    leaseToken: undefined,
    leaseUntil: undefined,
  };
}

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
    // Approval is an owner decision, never a worker/model capability. The
    // only client route that exposes this mutation is same-origin and
    // owner-authenticated; keeping the same requirement here prevents a
    // future tool or worker from silently becoming an approval backdoor.
    await requireAdmin(ctx, a.authTokenHash);
    const errand = await ctx.db.get(a.errandId);
    if (!errand) return false;
    if (errand.status !== "proposed" && errand.status !== "needs_step_approval") return false;
    // A paused browser task has no sealed replacement step/envelope yet. Do
    // not turn an old broad approval into permission to rerun earlier steps.
    // The owner may close it, then ask for a fresh, exact proposal instead.
    if (errand.status === "needs_step_approval" && a.decision === "approved") return false;
    const now = Date.now();
    await ctx.db.patch(a.errandId, {
      status: a.decision,
      resolvedAt: now,
      ...(a.decision === "approved"
        ? { approvalExpiresAt: now + boundedTaskTtl(errand.envelope.ttlMs) }
        : { approvalExpiresAt: undefined }),
    });
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
    // Generated server-side by runApprovedErrand. It fences finalization so a
    // late request cannot overwrite a later recovery decision.
    leaseToken: v.string(),
    authTokenHash: v.optional(v.string()),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    const errand = await ctx.db.get(a.errandId);
    if (!errand) return { ok: false as const, reason: "no such errand" };
    const now = Date.now();
    if (errand.status === "running" && Number(errand.leaseUntil ?? 0) <= now) {
      // Never replay a stale errand: the prior browser request may have made
      // an irreversible change before its caller disappeared. Mark it
      // terminal and make Daniel request a fresh, explicit plan instead.
      await ctx.db.patch(a.errandId, terminalLeaseFailure(now));
      return { ok: false as const, reason: "the earlier execution lease expired; its outcome is unknown and it was not retried" };
    }
    if (errand.status !== "approved") {
      return { ok: false as const, reason: `errand is '${errand.status}', not 'approved'` };
    }
    if (!/^[A-Za-z0-9_-]{24,128}$/.test(a.leaseToken)) {
      return { ok: false as const, reason: "invalid execution lease" };
    }
    const approvalExpiresAt = Number(
      errand.approvalExpiresAt
      ?? Number(errand.resolvedAt ?? errand.requestedAt) + boundedTaskTtl(errand.envelope.ttlMs),
    );
    if (!Number.isFinite(approvalExpiresAt) || approvalExpiresAt <= now) {
      await ctx.db.patch(a.errandId, {
        status: "expired",
        result: "Approval expired before the errand began. Nothing was run.",
        finishedAt: now,
      });
      return { ok: false as const, reason: "approval expired before execution began" };
    }
    await ctx.db.patch(a.errandId, {
      status: "running",
      startedAt: now,
      leaseToken: a.leaseToken,
      leaseUntil: now + boundedTaskTtl(errand.envelope.ttlMs) + LEASE_GRACE_MS,
    });
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
    leaseToken: v.string(),
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
    if (errand.status !== "running" || errand.leaseToken !== a.leaseToken) return false;
    await ctx.db.patch(a.errandId, {
      status: a.status,
      result: a.result?.slice(0, 4000),
      escalation: a.escalation?.slice(0, 1000),
      sends: a.sends,
      finishedAt: Date.now(),
      leaseToken: undefined,
      leaseUntil: undefined,
      // An escalation re-opens the approval gate, so clear the earlier decision.
      ...(a.status === "needs_step_approval"
        ? { resolvedAt: undefined, approvalExpiresAt: undefined }
        : {}),
    });
    return true;
  },
});

/**
 * Owner-triggered, bounded cleanup for callers that died after claiming an
 * errand. This only ever fails a stale run; it never retries browser work.
 * `claim` performs the same single-row cleanup as a backstop, so a stale row
 * cannot block a later explicit run even if the owner has not opened the UI.
 */
export const expireStale = mutation({
  args: {
    limit: v.optional(v.number()),
    authTokenHash: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    await requireAdmin(ctx, a.authTokenHash);
    const now = Date.now();
    const limit = Math.min(MAX_REAP_BATCH, Math.max(1, Math.trunc(a.limit ?? MAX_REAP_BATCH)));
    const expired = await ctx.db.query("browserErrands")
      .withIndex("by_status_lease", (q: any) => q.eq("status", "running").lte("leaseUntil", now))
      .take(limit);

    // A small legacy sweep covers rows created before `leaseUntil` existed.
    // It is intentionally bounded and only terminalizes a row; it never
    // creates a new browser task or changes a completed result.
    const selected = [...expired];
    if (selected.length < limit) {
      const known = new Set(selected.map((row) => row._id));
      const legacy = await ctx.db.query("browserErrands")
        .withIndex("by_status", (q: any) => q.eq("status", "running"))
        .order("asc")
        .take(Math.min(100, limit * 5));
      for (const row of legacy) {
        if (selected.length >= limit) break;
        if (known.has(row._id) || Number(row.leaseUntil ?? 0) > now) continue;
        selected.push(row);
        known.add(row._id);
      }
    }

    let reaped = 0;
    for (const row of selected) {
      // A concurrent terminal receipt wins: checking the current row makes
      // cleanup idempotent and prevents this bounded reaper from overwriting
      // it on an old snapshot.
      const current = await ctx.db.get(row._id);
      if (!current || current.status !== "running" || Number(current.leaseUntil ?? 0) > now) continue;
      await ctx.db.patch(current._id, terminalLeaseFailure(now));
      reaped += 1;
    }
    return { expired: reaped };
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
