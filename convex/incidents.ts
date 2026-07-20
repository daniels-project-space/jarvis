import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireActor, requireDispatcher, requireViewer, requireWorker, viewerAuthArgs } from "./controlAuth";
import { normalizeIncidentSignature } from "../src/lib/incident-signature";
import { requestContextRefresh } from "./contextProjection";

// Self-healing incident ledger. report() dedups by signature (48h window):
// an existing open/dispatched incident just bumps count; a recently-resolved
// one reopens WITH its attempt history so repeated failures escalate to
// Daniel instead of looping repair agents forever.

const WINDOW_MS = 48 * 60 * 60 * 1000;

const attentionFingerprint = (id: unknown) => `incident:${String(id)}`;

async function syncIncidentAttention(
  ctx: any,
  incident: { _id: unknown; app?: string; source: string; message: string; count: number; status: string },
  options?: { jobId?: string },
) {
  const fingerprint = attentionFingerprint(incident._id);
  const existing = await ctx.db
    .query("attentionItems")
    .withIndex("by_fingerprint", (q: any) => q.eq("fingerprint", fingerprint))
    .first();
  const needsDaniel = incident.status === "needs-daniel";
  const resolved = incident.status === "resolved";
  const item = {
    fingerprint,
    project: incident.app,
    title: needsDaniel
      ? `Repair needs Daniel · ${incident.app ?? "Jarvis"}`.slice(0, 140)
      : `Self-repair · ${incident.app ?? "Jarvis"}`.slice(0, 140),
    detail: incident.message.slice(0, 2_000),
    evidence: [`source ${incident.source}`, `seen ${incident.count}x`, `incident ${String(incident._id)}`],
    severity: needsDaniel ? "critical" : "warning",
    impact: incident.source === "stack-poller" ? 80 : 65,
    urgency: needsDaniel ? 90 : incident.source === "stack-poller" ? 80 : 60,
    confidence: 1,
    actionClass: needsDaniel ? "ask" : "safe-auto-fix",
    status: resolved ? "resolved" : incident.status === "dispatched" ? "working" : "open",
    jobId: options?.jobId,
    updatedAt: Date.now(),
  };
  if (existing) await ctx.db.patch(existing._id, item);
  else await ctx.db.insert("attentionItems", { ...item, createdAt: Date.now() });
  await requestContextRefresh(ctx, ["attention"]);
}

export const report = mutation({
  args: {
    source: v.string(),
    signature: v.string(),
    message: v.string(),
    app: v.optional(v.string()),
    authTokenHash: v.optional(v.string()),
    dispatchToken: v.optional(v.string()),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    await requireDispatcher(ctx, a);
    const sig = normalizeIncidentSignature(a.signature);
    const existing = await ctx.db
      .query("incidents")
      .withIndex("by_signature", (q: any) => q.eq("signature", sig))
      .order("desc")
      .take(10);
    const now = Date.now();
    const recent = existing
      .filter((i: any) => now - i.updatedAt < WINDOW_MS)
      .sort((x: any, y: any) => y.updatedAt - x.updatedAt)[0];
    if (recent) {
      const nextStatus = recent.status === "resolved" ? "open" : recent.status;
      const patch: Record<string, unknown> = {
        count: recent.count + 1,
        updatedAt: now,
        message: a.message.slice(0, 1500),
      };
      // recurrence after a "fix" = the fix didn't hold — reopen with history
      if (recent.status === "resolved") patch.status = nextStatus;
      await ctx.db.patch(recent._id, patch);
      await syncIncidentAttention(ctx, {
        ...recent,
        message: a.message.slice(0, 1500),
        count: recent.count + 1,
        status: nextStatus,
      });
      return recent._id;
    }
    const id = await ctx.db.insert("incidents", {
      source: a.source,
      app: a.app,
      signature: sig,
      message: a.message.slice(0, 1500),
      count: 1,
      status: "open",
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    });
    await syncIncidentAttention(ctx, {
      _id: id,
      source: a.source,
      app: a.app,
      message: a.message.slice(0, 1500),
      count: 1,
      status: "open",
    });
    return id;
  },
});

// Healer claim: open incidents become dispatched (attempts+1); ones that
// already burned their attempts escalate to needs-daniel instead.
export const claimForRepair = mutation({
  args: { limit: v.optional(v.number()), maxAttempts: v.optional(v.number()), workerToken: v.optional(v.string()) },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const open = await ctx.db
      .query("incidents")
      .withIndex("by_status", (q: any) => q.eq("status", "open"))
      .collect();
    const claims: any[] = [];
    const escalations: any[] = [];
    const max = a.maxAttempts ?? 2;
    for (const inc of open.sort((x: any, y: any) => x.updatedAt - y.updatedAt)) {
      if (inc.attempts >= max) {
        await ctx.db.patch(inc._id, { status: "needs-daniel", updatedAt: Date.now() });
        await syncIncidentAttention(ctx, { ...inc, status: "needs-daniel" });
        escalations.push({ id: inc._id, signature: inc.signature, message: inc.message, attempts: inc.attempts });
        continue;
      }
      if (claims.length >= (a.limit ?? 2)) continue;
      await ctx.db.patch(inc._id, { status: "dispatched", attempts: inc.attempts + 1, updatedAt: Date.now() });
      await syncIncidentAttention(ctx, { ...inc, status: "dispatched", count: inc.count });
      claims.push({
        id: inc._id,
        source: inc.source,
        app: inc.app ?? null,
        signature: inc.signature,
        message: inc.message,
        count: inc.count,
        attempts: inc.attempts + 1,
      });
    }
    return { claims, escalations };
  },
});

export const setStatus = mutation({
  args: {
    id: v.id("incidents"),
    status: v.string(),
    authTokenHash: v.optional(v.string()),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    const incident = await ctx.db.get(a.id);
    if (!incident) return false;
    await ctx.db.patch(a.id, { status: a.status, updatedAt: Date.now() });
    await syncIncidentAttention(ctx, { ...incident, status: a.status });
    return true;
  },
});

export const linkJob = mutation({
  args: { id: v.id("incidents"), jobId: v.string(), workerToken: v.optional(v.string()) },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const incident = await ctx.db.get(a.id);
    if (!incident) return false;
    await syncIncidentAttention(ctx, { ...incident, status: "dispatched" }, { jobId: a.jobId });
    return true;
  },
});

export const list = query({
  args: { limit: v.optional(v.number()), ...viewerAuthArgs },
  handler: async (ctx, a) => {
    await requireViewer(ctx, a);
    const rows = await ctx.db.query("incidents").collect();
    return rows.sort((x: any, y: any) => y.updatedAt - x.updatedAt).slice(0, a.limit ?? 10);
  },
});
