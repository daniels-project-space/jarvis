import { mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { v } from "convex/values";
import { requireActor, requireDispatcher, requireViewer, requireWorker, viewerAuthArgs } from "./controlAuth";
import { normalizeIncidentSignature } from "../src/lib/incident-signature";

// Self-healing incident ledger. report() dedups by signature (48h window):
// an existing open/dispatched incident just bumps count; a recently-resolved
// one reopens WITH its attempt history so repeated failures escalate to
// Daniel instead of looping repair agents forever.

const WINDOW_MS = 48 * 60 * 60 * 1000;
const TRANSIENT_NETWORK_REPORT_THRESHOLD = 3;
const LEGACY_FAILED_FETCH_ATTENTION_FINGERPRINT = "jarvis:failed-fetch-unhandled-rejection";
const LEGACY_FAILED_FETCH_SIGNATURE = normalizeIncidentSignature("client:rejection:TypeError: Failed to fetch");

const attentionFingerprint = (id: unknown) => `incident:${String(id)}`;

function isTransientBrowserNetworkIncident(incident: { source?: string; signature?: string; message?: string }) {
  if (incident.source !== "client") return false;
  const text = `${incident.signature ?? ""} ${incident.message ?? ""}`;
  return /(?:typeerror:\s*)?(?:failed to fetch|load failed)|networkerror/i.test(text);
}

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
  const transientNetwork = isTransientBrowserNetworkIncident(incident);
  // A resolved observation that never had a user-facing item should stay
  // invisible. In particular, one suspended-tab/browser-radio fetch failure
  // is useful telemetry but is not work for Daniel.
  if (resolved && !existing) return;
  const item = {
    fingerprint,
    project: incident.app,
    title: transientNetwork
      ? needsDaniel ? "Connection needs your attention · Jarvis" : "Restoring Jarvis's connection"
      : needsDaniel
        ? `Repair needs Daniel · ${incident.app ?? "Jarvis"}`.slice(0, 140)
        : `Self-repair · ${incident.app ?? "Jarvis"}`.slice(0, 140),
    detail: transientNetwork
      ? `The browser connection was interrupted ${incident.count} times. Jarvis kept your work and is checking the affected route.`
      : incident.message.slice(0, 2_000),
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
}

async function retireLegacyFailedFetchAttention(ctx: MutationCtx, now: number) {
  const attention = await ctx.db
    .query("attentionItems")
    .withIndex("by_fingerprint", (q) => q.eq("fingerprint", LEGACY_FAILED_FETCH_ATTENTION_FINGERPRINT))
    .first();
  if (!attention || attention.status === "resolved") return false;

  const matching = await ctx.db
    .query("incidents")
    .withIndex("by_signature", (q) => q.eq("signature", LEGACY_FAILED_FETCH_SIGNATURE))
    .order("desc")
    .take(10);
  const hasLiveRecurrence = matching.some((incident: Doc<"incidents">) =>
    now - Number(incident.lastSeenAt ?? incident.createdAt) < WINDOW_MS
    && incident.count >= TRANSIENT_NETWORK_REPORT_THRESHOLD
    && ["open", "dispatched", "needs-daniel"].includes(incident.status),
  );
  if (hasLiveRecurrence) return false;
  await ctx.db.patch(attention._id, { status: "resolved", updatedAt: now });
  return true;
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
      .filter((i: any) => now - Number(i.lastSeenAt ?? i.createdAt) < WINDOW_MS)
      .sort((x: any, y: any) => Number(y.lastSeenAt ?? y.createdAt) - Number(x.lastSeenAt ?? x.createdAt))[0];
    if (recent) {
      const nextCount = recent.count + 1;
      const transientBelowThreshold = isTransientBrowserNetworkIncident({
        source: a.source,
        signature: sig,
        message: a.message,
      }) && nextCount < TRANSIENT_NETWORK_REPORT_THRESHOLD;
      const nextStatus = transientBelowThreshold
        ? "resolved"
        : recent.status === "resolved" ? "open" : recent.status;
      const patch: Record<string, unknown> = {
        count: nextCount,
        lastSeenAt: now,
        updatedAt: now,
        message: a.message.slice(0, 1500),
        status: nextStatus,
      };
      // Give legacy exhausted incidents a pre-recurrence baseline. Without
      // this migration-on-write, their first post-release recurrence could be
      // silently treated as an old unobserved repair.
      if (recent.observedCountAtLastAttempt === undefined && recent.attempts > 0) {
        patch.observedCountAtLastAttempt = recent.count;
      }
      await ctx.db.patch(recent._id, patch);
      await syncIncidentAttention(ctx, {
        ...recent,
        message: a.message.slice(0, 1500),
        count: nextCount,
        status: nextStatus,
      });
      return recent._id;
    }
    const initialStatus = isTransientBrowserNetworkIncident({
      source: a.source,
      signature: sig,
      message: a.message,
    }) ? "resolved" : "open";
    const id = await ctx.db.insert("incidents", {
      source: a.source,
      app: a.app,
      signature: sig,
      message: a.message.slice(0, 1500),
      count: 1,
      status: initialStatus,
      attempts: 0,
      lastSeenAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await syncIncidentAttention(ctx, {
      _id: id,
      source: a.source,
      app: a.app,
      message: a.message.slice(0, 1500),
      count: 1,
      status: initialStatus,
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
    const now = Date.now();
    await retireLegacyFailedFetchAttention(ctx, now);
    // Migrate one-off browser network incidents that an older healer already
    // dispatched or escalated before the recurrence threshold existed. A
    // stale status must not keep a phantom "repair running" notification alive
    // when the product never observed the failure again.
    for (const status of ["dispatched", "needs-daniel"] as const) {
      const legacyTransient = await ctx.db
        .query("incidents")
        .withIndex("by_status", (q: any) => q.eq("status", status))
        .order("asc")
        .take(24);
      for (const incident of legacyTransient) {
        if (
          !isTransientBrowserNetworkIncident(incident)
          || incident.count >= TRANSIENT_NETWORK_REPORT_THRESHOLD
        ) continue;
        await ctx.db.patch(incident._id, {
          status: "resolved",
          attempts: 0,
          observedCountAtLastAttempt: incident.count,
          updatedAt: now,
        });
        await syncIncidentAttention(ctx, { ...incident, status: "resolved" });
      }
    }
    const open = await ctx.db
      .query("incidents")
      .withIndex("by_status", (q: any) => q.eq("status", "open"))
      .order("asc")
      .take(50);
    const claims: any[] = [];
    const escalations: any[] = [];
    const max = a.maxAttempts ?? 2;
    for (const inc of open.sort((x: any, y: any) => x.updatedAt - y.updatedAt)) {
      // Browser radios, page suspension and deploy transitions can reject one
      // local fetch even while the route is healthy. Keep the observation in
      // the ledger, but do not spend repair workers or notify Daniel unless it
      // actually recurs in the 48-hour incident window.
      if (isTransientBrowserNetworkIncident(inc) && inc.count < TRANSIENT_NETWORK_REPORT_THRESHOLD) {
        await ctx.db.patch(inc._id, { status: "resolved", updatedAt: Date.now() });
        await syncIncidentAttention(ctx, { ...inc, status: "resolved" });
        continue;
      }
      if (inc.attempts >= max) {
        const observedAtAttempt = Number(inc.observedCountAtLastAttempt ?? inc.count);
        if (inc.count <= observedAtAttempt) {
          // The repair worker may have failed its own verification, but the
          // product has not emitted the failure again since that attempt. Keep
          // the evidence and silently monitor; a real recurrence reopens the
          // same row with an incremented count and will then escalate.
          await ctx.db.patch(inc._id, { status: "resolved", updatedAt: Date.now() });
          await syncIncidentAttention(ctx, { ...inc, status: "resolved" });
          continue;
        }
        await ctx.db.patch(inc._id, { status: "needs-daniel", updatedAt: Date.now() });
        await syncIncidentAttention(ctx, { ...inc, status: "needs-daniel" });
        escalations.push({ id: inc._id, signature: inc.signature, message: inc.message, attempts: inc.attempts });
        continue;
      }
      if (claims.length >= (a.limit ?? 2)) continue;
      await ctx.db.patch(inc._id, {
        status: "dispatched",
        attempts: inc.attempts + 1,
        observedCountAtLastAttempt: inc.count,
        updatedAt: Date.now(),
      });
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

// A live health check may retire a noisy stale incident only if no new report
// raced with that proof. Resetting its exhausted attempt budget is deliberate:
// a later recurrence should get a fresh bounded repair cycle, not an immediate
// page caused by yesterday's unrelated worker failures.
export const resolveIfUnchanged = mutation({
  args: {
    id: v.id("incidents"),
    expectedCount: v.number(),
    authTokenHash: v.optional(v.string()),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    const incident = await ctx.db.get(a.id);
    if (!incident || incident.count !== a.expectedCount) return false;
    await ctx.db.patch(a.id, {
      status: "resolved",
      attempts: 0,
      observedCountAtLastAttempt: incident.count,
      updatedAt: Date.now(),
    });
    await syncIncidentAttention(ctx, { ...incident, status: "resolved" });
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
    const limit = Number.isSafeInteger(a.limit) && Number(a.limit) > 0 ? Math.min(24, Number(a.limit)) : 10;
    return await ctx.db.query("incidents").withIndex("by_updatedAt").order("desc").take(limit);
  },
});
