import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { actorAuthArgs, requireActor, requireViewer, requireWorker, viewerAuthArgs } from "./controlAuth";
import { evaluateWatchTransition } from "./watchPolicy";
import { requestContextRefresh } from "./contextProjection";

const clampCadence = (value: number | undefined, fallback: number, minimum = 15 * 60_000) =>
  Math.max(minimum, Math.min(7 * 86_400_000, Math.round(value ?? fallback)));
const priceOf = (kind: string, observation: any): number | undefined => {
  if (kind === "product" && observation?.deliveryKnown === false) return undefined;
  const raw = kind === "product" ? observation?.landedPence ?? observation?.pricePence : observation?.price;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
};

export const createProduct = mutation({
  args: {
    query: v.string(),
    targetPence: v.optional(v.number()),
    condition: v.optional(v.string()),
    cadenceMs: v.optional(v.number()),
    initialObservation: v.optional(v.any()),
    originThreadId: v.optional(v.string()),
    ...actorAuthArgs,
  },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    const queryText = a.query.trim().slice(0, 180);
    if (!queryText) throw new Error("Product query required");
    const subjectKey = `product:${queryText.toLowerCase().replace(/\s+/g, " ")}`.slice(0, 240);
    const existing = await ctx.db
      .query("watchRules")
      .withIndex("by_subject_status", (q: any) => q.eq("subjectKey", subjectKey).eq("status", "active"))
      .first();
    const targetPence = a.targetPence && a.targetPence > 0 ? Math.round(a.targetPence) : undefined;
    const initialValue = priceOf("product", a.initialObservation);
    const now = Date.now();
    const definition = {
      type: "product",
      query: queryText,
      condition: ["new", "used", "any"].includes(a.condition ?? "") ? a.condition : "any",
      targetPence,
      minDropBps: 300,
      minDropPence: 200,
      includeDelivery: true,
      productKey: a.initialObservation?.productKey,
      providerProductId: a.initialObservation?.providerProductId,
      canonicalUrl: a.initialObservation?.url,
    };
    if (existing) {
      await ctx.db.patch(existing._id, {
        definition,
        cadenceMs: clampCadence(a.cadenceMs, existing.cadenceMs),
        version: existing.version + 1,
        nextCheckAt: now,
        updatedAt: now,
      });
      return existing._id;
    }
    return await ctx.db.insert("watchRules", {
      kind: "product",
      subjectKey,
      label: queryText,
      status: "active",
      definition,
      cadenceMs: clampCadence(a.cadenceMs, 3 * 3600_000),
      nextCheckAt: now + clampCadence(a.cadenceMs, 3 * 3600_000),
      version: 1,
      triggerSeq: 0,
      lastObservation: a.initialObservation,
      conditionMet: targetPence !== undefined && initialValue !== undefined ? initialValue <= targetPence : false,
      lastNotifiedValue: initialValue,
      failureCount: 0,
      originThreadId: a.originThreadId,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const createAsset = mutation({
  args: {
    symbol: v.string(),
    provider: v.string(),
    interval: v.string(),
    operator: v.union(v.literal("above"), v.literal("below")),
    threshold: v.number(),
    currency: v.string(),
    triggerMode: v.optional(v.string()),
    cadenceMs: v.optional(v.number()),
    initialObservation: v.optional(v.any()),
    originThreadId: v.optional(v.string()),
    ...actorAuthArgs,
  },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    if (!Number.isFinite(a.threshold) || a.threshold <= 0) throw new Error("Positive threshold required");
    const symbol = a.symbol.trim().toUpperCase().slice(0, 32);
    const provider = a.provider.trim().toLowerCase().slice(0, 40);
    const subjectKey = `asset:${provider}:${symbol}`;
    const definition = {
      type: "asset",
      symbol,
      provider,
      interval: a.interval,
      operator: a.operator,
      threshold: a.threshold,
      currency: a.currency,
      triggerMode: a.triggerMode === "bar_close" ? "bar_close" : "cross",
      rearmBps: 10,
    };
    const now = Date.now();
    const initialValue = priceOf("asset", a.initialObservation);
    return await ctx.db.insert("watchRules", {
      kind: "asset",
      subjectKey,
      label: `${symbol} ${a.operator} ${a.threshold}`,
      status: "active",
      definition,
      cadenceMs: clampCadence(a.cadenceMs, 60_000, 60_000),
      nextCheckAt: now + clampCadence(a.cadenceMs, 60_000, 60_000),
      version: 1,
      triggerSeq: 0,
      lastObservation: a.initialObservation,
      conditionMet: initialValue !== undefined ? (a.operator === "above" ? initialValue >= a.threshold : initialValue <= a.threshold) : false,
      lastNotifiedValue: initialValue,
      failureCount: 0,
      originThreadId: a.originThreadId,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const claimDue = mutation({
  args: { now: v.number(), limit: v.number(), leaseMs: v.number(), leaseToken: v.string(), workerToken: v.string() },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const rows = await ctx.db
      .query("watchRules")
      .withIndex("by_status_nextCheckAt", (q: any) => q.eq("status", "active").lte("nextCheckAt", a.now))
      .take(Math.min(50, Math.max(1, a.limit)));
    const claimed = rows.filter((row) => !row.leaseUntil || row.leaseUntil <= a.now);
    for (const row of claimed)
      await ctx.db.patch(row._id, { leaseToken: a.leaseToken, leaseUntil: a.now + Math.min(10 * 60_000, a.leaseMs) });
    return claimed;
  },
});

export const commitObservation = mutation({
  args: {
    id: v.id("watchRules"),
    leaseToken: v.string(),
    observation: v.optional(v.any()),
    error: v.optional(v.string()),
    now: v.number(),
    workerToken: v.string(),
  },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    const rule = await ctx.db.get(a.id);
    if (!rule || rule.status !== "active" || rule.leaseToken !== a.leaseToken || (rule.leaseUntil ?? 0) < a.now)
      return { ok: false as const, reason: "lease" as const };
    const observationValue = a.observation ? priceOf(rule.kind, a.observation) : undefined;
    const observationError = a.error ?? (
      a.observation && observationValue === undefined
        ? "Observation did not contain a valid verified price"
        : undefined
    );
    if (observationError || !a.observation) {
      const failures = rule.failureCount + 1;
      const backoff = Math.min(12 * 3600_000, rule.cadenceMs * 2 ** Math.min(5, failures));
      await ctx.db.patch(rule._id, {
        failureCount: failures,
        lastError: (observationError ?? "No observation").slice(0, 400),
        nextCheckAt: a.now + backoff,
        leaseToken: undefined,
        leaseUntil: undefined,
        updatedAt: a.now,
      });
      if (failures >= 3) {
        const fingerprint = `watch-provider:${rule.subjectKey}`.slice(0, 240);
        const existing = await ctx.db
          .query("attentionItems")
          .withIndex("by_fingerprint", (q: any) => q.eq("fingerprint", fingerprint))
          .first();
        const attention = {
          fingerprint,
          title: `Price source failing · ${rule.label}`.slice(0, 140),
          detail: `The watch has failed ${failures} consecutive checks: ${(observationError ?? "No observation").slice(0, 300)}`,
          evidence: [`watch ${String(rule._id)}`],
          severity: "warning",
          impact: 45,
          urgency: 35,
          confidence: 1,
          actionClass: "inform",
          status: "open",
          updatedAt: a.now,
        };
        if (existing) await ctx.db.patch(existing._id, attention);
        else await ctx.db.insert("attentionItems", { ...attention, createdAt: a.now });
        await requestContextRefresh(ctx, ["attention"]);
      }
      return { ok: true as const, triggered: false as const };
    }

    // The error branch above proves this is a finite positive verified value.
    const value = observationValue as number;
    const previousValue = priceOf(rule.kind, rule.lastObservation);
    const definition: any = rule.definition;
    const transition = evaluateWatchTransition({
      kind: rule.kind,
      definition,
      previousValue,
      value,
      conditionMet: rule.conditionMet ?? false,
      cooldownUntil: rule.cooldownUntil,
      lastNotifiedValue: rule.lastNotifiedValue,
      now: a.now,
    });
    const { trigger, conditionMet, reason } = transition;

    let eventId: any = undefined;
    let spoken = "";
    let title = "";
    if (trigger) {
      const triggerSeq = rule.triggerSeq + 1;
      const eventKey = `${String(rule._id)}:${rule.version}:${triggerSeq}`;
      title = rule.kind === "asset" ? `Chart signal · ${definition.symbol}` : `Price found · ${rule.label}`;
      const display = rule.kind === "product" ? `£${(value / 100).toFixed(2)}` : `${value.toLocaleString("en-GB")} ${definition.currency}`;
      spoken = rule.kind === "product"
        ? `Price hunt hit, sir — ${rule.label} is now ${display}.`
        : `${definition.symbol} has crossed ${definition.operator} ${definition.threshold}, sir — it is now ${display}.`;
      const detail = `${reason}. Source: ${a.observation.source?.provider ?? a.observation.provider ?? "unknown"}; observed ${new Date(a.observation.source?.observedAt ?? a.now).toISOString()}.`;
      const threadRow = await ctx.db.query("ui").withIndex("by_key", (q: any) => q.eq("key", "activeThread")).first();
      const chatMessageId = await ctx.db.insert("chatMessages", {
        threadId: threadRow?.value ?? rule.originThreadId ?? "main",
        role: "assistant",
        text: spoken,
        status: "done",
        createdAt: a.now,
      });
      eventId = await ctx.db.insert("watchEvents", {
        eventKey,
        watchId: rule._id,
        ruleVersion: rule.version,
        kind: rule.kind,
        reason,
        previousValue,
        observation: a.observation,
        title,
        spoken,
        detail,
        status: "open",
        glowUntil: a.now + 24 * 3600_000,
        chatMessageId,
        pushStatus: "pending",
        createdAt: a.now,
      });
      const fingerprint = `watch:${String(rule._id)}`;
      const existingAttention = await ctx.db
        .query("attentionItems")
        .withIndex("by_fingerprint", (q: any) => q.eq("fingerprint", fingerprint))
        .first();
      const attention = {
        fingerprint,
        title: title.slice(0, 140),
        detail: `${spoken} ${detail}`.slice(0, 2_000),
        evidence: [reason, `event ${eventKey}`],
        severity: "opportunity",
        impact: rule.kind === "asset" ? 70 : 80,
        urgency: 85,
        confidence: 0.95,
        actionClass: "inform",
        status: "open",
        updatedAt: a.now,
      };
      if (existingAttention) await ctx.db.patch(existingAttention._id, attention);
      else await ctx.db.insert("attentionItems", { ...attention, createdAt: a.now });
      await requestContextRefresh(ctx, ["attention"]);
      await ctx.db.patch(rule._id, {
        triggerSeq,
        lastTriggeredAt: a.now,
        cooldownUntil: a.now + (rule.kind === "asset" ? 15 * 60_000 : 12 * 3600_000),
        lastNotifiedValue: value,
      });
    }
    await ctx.db.patch(rule._id, {
      lastObservation: a.observation,
      conditionMet,
      failureCount: 0,
      lastError: undefined,
      nextCheckAt: a.now + rule.cadenceMs,
      leaseToken: undefined,
      leaseUntil: undefined,
      updatedAt: a.now,
    });
    return { ok: true as const, triggered: trigger, eventId: eventId ? String(eventId) : undefined, title, spoken };
  },
});

export const markPush = mutation({
  args: { id: v.id("watchEvents"), status: v.union(v.literal("sent"), v.literal("failed")), workerToken: v.string() },
  handler: async (ctx, a) => {
    requireWorker(a.workerToken);
    await ctx.db.patch(a.id, {
      pushStatus: a.status,
      pushAttemptedAt: Date.now(),
      pushSentAt: a.status === "sent" ? Date.now() : undefined,
    });
  },
});

export const list = query({
  args: { status: v.optional(v.string()), limit: v.optional(v.number()), ...viewerAuthArgs },
  handler: async (ctx, a) => {
    await requireViewer(ctx, a);
    const status = a.status ?? "active";
    return await ctx.db
      .query("watchRules")
      .withIndex("by_status_nextCheckAt", (q: any) => q.eq("status", status))
      .take(Math.min(80, a.limit ?? 40));
  },
});

export const openEvents = query({
  args: { limit: v.optional(v.number()), ...viewerAuthArgs },
  handler: async (ctx, a) => {
    await requireViewer(ctx, a);
    return await ctx.db
      .query("watchEvents")
      .withIndex("by_status_createdAt", (q: any) => q.eq("status", "open"))
      .order("desc")
      .take(Math.min(40, a.limit ?? 20));
  },
});

export const cancel = mutation({
  args: { match: v.string(), ...actorAuthArgs },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    const rows = await ctx.db
      .query("watchRules")
      .withIndex("by_status_nextCheckAt", (q: any) => q.eq("status", "active"))
      .take(100);
    const match = a.match.toLowerCase();
    const row = rows.find((candidate) => candidate.label.toLowerCase().includes(match) || String(candidate._id) === a.match);
    if (!row) return false;
    await ctx.db.patch(row._id, { status: "cancelled", leaseToken: undefined, leaseUntil: undefined, updatedAt: Date.now() });
    return row.label;
  },
});

export const markEvent = mutation({
  args: { id: v.id("watchEvents"), status: v.union(v.literal("seen"), v.literal("dismissed")), ...actorAuthArgs },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    await ctx.db.patch(a.id, { status: a.status, seenAt: Date.now() });
  },
});
