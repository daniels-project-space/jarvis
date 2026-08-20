import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireActor, requireAdmin, requireViewer, viewerAuthArgs } from "./controlAuth";

// Browser errands — JARVIS acting as Daniel in a logged-in browser.
//
// The durable approval boundary is deliberately stronger than an English plan:
// Convex canonicalizes the executable steps at proposal time, snapshots them
// into the approved record, and returns only that snapshot to the browser.
// No later model tool call can replace, append, or reinterpret those steps.

const envelopeValidator = v.object({
  allowedHosts: v.array(v.string()),
  allowedActions: v.array(v.string()),
  maxSends: v.number(),
  maxSteps: v.number(),
  ttlMs: v.number(),
});

const browserStepValidator = v.union(
  v.object({ action: v.literal("navigate"), url: v.string(), label: v.optional(v.string()) }),
  v.object({ action: v.literal("read"), selector: v.optional(v.string()), limit: v.optional(v.number()), label: v.optional(v.string()) }),
  v.object({ action: v.literal("click"), selector: v.string(), label: v.optional(v.string()) }),
  v.object({ action: v.literal("type"), selector: v.string(), text: v.string(), label: v.optional(v.string()) }),
  v.object({ action: v.literal("select"), selector: v.string(), value: v.string(), label: v.optional(v.string()) }),
  v.object({ action: v.literal("screenshot"), fullPage: v.optional(v.boolean()), label: v.optional(v.string()) }),
  v.object({ action: v.literal("send"), selector: v.string(), label: v.optional(v.string()) }),
);

const ACTIONS = ["navigate", "read", "click", "type", "select", "screenshot", "send"] as const;
const ACTION_SET = new Set<string>(ACTIONS);
const MIN_TASK_TTL_MS = 60_000;
const MAX_TASK_TTL_MS = 6 * 60 * 60_000;
const LEASE_GRACE_MS = 2 * 60_000;
const MAX_REAP_BATCH = 20;
const MAX_ALLOWED_HOSTS = 12;
const MAX_ALLOWED_ACTIONS = ACTIONS.length;
const MAX_STEPS = 200;
const MAX_SENDS = 10;
const MAX_OBJECTIVE_CHARS = 500;
const MAX_CREDENTIAL_ID_CHARS = 160;
const MAX_LABEL_CHARS = 240;
const MAX_SELECTOR_CHARS = 500;
const MAX_TYPE_TEXT_CHARS = 1_000;
const MAX_SELECT_VALUE_CHARS = 500;
const MAX_NAVIGATE_URL_CHARS = 2_048;
const MAX_READ_LIMIT = 2_000;
const BROWSER_ERRAND_RECEIPT_KEY = /^[A-Za-z0-9_.:-]{1,512}$/;
const UNKNOWN_OUTCOME_RESULT = "The execution lease expired before a final receipt arrived. Its outcome is unknown, so JARVIS did not retry it automatically.";
const MAX_UNKNOWN_OUTCOME_NOTICES = 3;
const MAX_UNKNOWN_OUTCOME_SCAN = 48;
const HOST_RE = /^(?:\*\.)?(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

type BrowserAction = (typeof ACTIONS)[number];
type BrowserEnvelope = {
  allowedHosts: string[];
  allowedActions: BrowserAction[];
  maxSends: number;
  maxSteps: number;
  ttlMs: number;
};
type BrowserStep =
  | { action: "navigate"; url: string; label?: string }
  | { action: "read"; selector?: string; limit?: number; label?: string }
  | { action: "click"; selector: string; label?: string }
  | { action: "type"; selector: string; text: string; label?: string }
  | { action: "select"; selector: string; value: string; label?: string }
  | { action: "screenshot"; fullPage?: boolean; label?: string }
  | { action: "send"; selector: string; label?: string };

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundedText(value: unknown, label: string, maxChars: number, preserveWhitespace = false): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = preserveWhitespace
    ? value.replace(/\r\n?/g, "\n")
    : value.trim();
  if (!normalized.trim() || normalized.length > maxChars || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
}

function optionalLabel(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return boundedText(value, "step label", MAX_LABEL_CHARS);
}

function boundedInteger(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isSafeInteger(value)) {
    throw new Error(`${label} must be a whole number`);
  }
  if (value < min || value > max) throw new Error(`${label} must be between ${min} and ${max}`);
  return value;
}

function normalizedHost(value: unknown): string {
  const host = boundedText(value, "allowed host", 253).toLowerCase().replace(/\.$/, "");
  if (!HOST_RE.test(host)) throw new Error("allowed host is invalid");
  return host;
}

function hostAllowed(host: string, allowedHosts: readonly string[]): boolean {
  return allowedHosts.some((allowed) => {
    if (allowed.startsWith("*.")) {
      const suffix = allowed.slice(1);
      return host.endsWith(suffix) && host.length > suffix.length;
    }
    return host === allowed;
  });
}

function normalizeEnvelope(value: unknown): BrowserEnvelope {
  if (!record(value)) throw new Error("browser errand envelope is invalid");
  if (!Array.isArray(value.allowedHosts) || !Array.isArray(value.allowedActions)) {
    throw new Error("browser errand envelope is invalid");
  }
  const allowedHosts = [...new Set(value.allowedHosts.map(normalizedHost))];
  if (!allowedHosts.length || allowedHosts.length > MAX_ALLOWED_HOSTS) {
    throw new Error("a plan must name between one and twelve allowed hosts");
  }
  const allowedActions = [...new Set(value.allowedActions.map((action) => boundedText(action, "allowed action", 24)))];
  if (!allowedActions.length || allowedActions.length > MAX_ALLOWED_ACTIONS || allowedActions.some((action) => !ACTION_SET.has(action))) {
    throw new Error("browser errand actions are invalid");
  }
  const maxSends = boundedInteger(value.maxSends, "max sends", 0, MAX_SENDS);
  if (maxSends > 0 && !allowedActions.includes("send")) {
    throw new Error("a send budget requires 'send' in allowedActions");
  }
  return {
    allowedHosts,
    allowedActions: allowedActions as BrowserAction[],
    maxSends,
    maxSteps: boundedInteger(value.maxSteps, "max steps", 1, MAX_STEPS),
    ttlMs: boundedInteger(value.ttlMs, "approval lifetime", MIN_TASK_TTL_MS, MAX_TASK_TTL_MS),
  };
}

function normalizeNavigateUrl(value: unknown, envelope: BrowserEnvelope): string {
  const raw = boundedText(value, "navigate URL", MAX_NAVIGATE_URL_CHARS);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("navigate URL is invalid");
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.port) {
    throw new Error("navigate URL is invalid");
  }
  const host = url.hostname.toLowerCase();
  if (!hostAllowed(host, envelope.allowedHosts)) {
    throw new Error("navigate URL is outside the allowed host list");
  }
  url.hash = "";
  return url.toString();
}

function normalizeSteps(value: unknown, envelope: BrowserEnvelope): BrowserStep[] {
  if (!Array.isArray(value) || !value.length || value.length > envelope.maxSteps) {
    throw new Error("browser errand must include a bounded executable step list");
  }
  const steps: BrowserStep[] = [];
  let sends = 0;
  for (const raw of value) {
    if (!record(raw) || typeof raw.action !== "string" || !ACTION_SET.has(raw.action)) {
      throw new Error("browser errand step is invalid");
    }
    const action = raw.action as BrowserAction;
    if (!envelope.allowedActions.includes(action)) {
      throw new Error(`step '${action}' is outside the allowed action list`);
    }
    const label = optionalLabel(raw.label);
    switch (action) {
      case "navigate":
        steps.push({ action, url: normalizeNavigateUrl(raw.url, envelope), ...(label ? { label } : {}) });
        break;
      case "read": {
        const selector = raw.selector === undefined ? undefined : boundedText(raw.selector, "read selector", MAX_SELECTOR_CHARS);
        const limit = raw.limit === undefined ? undefined : boundedInteger(raw.limit, "read limit", 1, MAX_READ_LIMIT);
        steps.push({ action, ...(selector ? { selector } : {}), ...(limit ? { limit } : {}), ...(label ? { label } : {}) });
        break;
      }
      case "click":
      case "send": {
        const selector = boundedText(raw.selector, `${action} selector`, MAX_SELECTOR_CHARS);
        steps.push({ action, selector, ...(label ? { label } : {}) });
        if (action === "send" && ++sends > envelope.maxSends) throw new Error("executable steps exceed the approved send budget");
        break;
      }
      case "type":
        steps.push({
          action,
          selector: boundedText(raw.selector, "type selector", MAX_SELECTOR_CHARS),
          text: boundedText(raw.text, "type text", MAX_TYPE_TEXT_CHARS, true),
          ...(label ? { label } : {}),
        });
        break;
      case "select":
        steps.push({
          action,
          selector: boundedText(raw.selector, "select selector", MAX_SELECTOR_CHARS),
          value: boundedText(raw.value, "select value", MAX_SELECT_VALUE_CHARS),
          ...(label ? { label } : {}),
        });
        break;
      case "screenshot":
        if (raw.fullPage !== undefined && typeof raw.fullPage !== "boolean") throw new Error("screenshot fullPage is invalid");
        steps.push({ action, ...(raw.fullPage === undefined ? {} : { fullPage: raw.fullPage }), ...(label ? { label } : {}) });
        break;
    }
  }
  return steps;
}

function stepSummary(step: BrowserStep): string {
  const label = step.label ? ` — ${step.label}` : "";
  switch (step.action) {
    case "navigate": return `Navigate to ${step.url}${label}`;
    case "read": return `Read ${step.selector ? `(${step.selector})` : "the page"}${step.limit ? `, up to ${step.limit} characters` : ""}${label}`;
    case "click": return `Click ${step.selector}${label}`;
    case "type": return `Type ${JSON.stringify(step.text)} into ${step.selector}${label}`;
    case "select": return `Select ${JSON.stringify(step.value)} in ${step.selector}${label}`;
    case "screenshot": return `Take ${step.fullPage ? "a full-page " : "a "}screenshot${label}`;
    case "send": return `Send/submit with ${step.selector}${label}`;
  }
}

function terminalLeaseFailure(now: number) {
  return {
    status: "failed",
    result: UNKNOWN_OUTCOME_RESULT,
    finishedAt: now,
    leaseToken: undefined,
    leaseUntil: undefined,
    browserDeadlineAt: undefined,
  };
}

export const propose = mutation({
  args: {
    objective: v.string(),
    credentialId: v.optional(v.string()),
    envelope: envelopeValidator,
    steps: v.array(browserStepValidator),
    chatId: v.optional(v.string()),
    authTokenHash: v.optional(v.string()),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    const envelope = normalizeEnvelope(a.envelope);
    const executionSteps = normalizeSteps(a.steps, envelope);
    return await ctx.db.insert("browserErrands", {
      objective: boundedText(a.objective, "objective", MAX_OBJECTIVE_CHARS, true),
      ...(a.credentialId ? { credentialId: boundedText(a.credentialId, "credential ID", MAX_CREDENTIAL_ID_CHARS) } : {}),
      envelope,
      executionSteps,
      // The card displays server-derived summaries of the exact normalized
      // fields above; a model's separate English narrative has no authority.
      plan: executionSteps.map(stepSummary),
      status: "proposed",
      ...(a.chatId ? { chatId: boundedText(a.chatId, "chat ID", 160) } : {}),
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

// This deliberately returns only the owner-safe recovery handoff. It never
// sends a provider reason, selector, credential, or executable plan back to
// the browser, and its fixed bound avoids turning the chat surface into an
// errand-history feed.
export const unknownOutcomes = query({
  args: { ...viewerAuthArgs },
  handler: async (ctx, a) => {
    await requireViewer(ctx, a);
    const failed = await ctx.db.query("browserErrands")
      .withIndex("by_status_finished", (q: any) => q.eq("status", "failed"))
      .order("desc")
      .take(MAX_UNKNOWN_OUTCOME_SCAN);
    return failed
      .filter((errand) => errand.result === UNKNOWN_OUTCOME_RESULT)
      .slice(0, MAX_UNKNOWN_OUTCOME_NOTICES)
      .map((errand) => ({
        _id: errand._id,
        objective: errand.objective,
      }));
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
    if (errand.status === "needs_step_approval" && a.decision === "approved") return false;

    const now = Date.now();
    if (a.decision === "declined") {
      await ctx.db.patch(a.errandId, {
        status: "declined",
        resolvedAt: now,
        approvalExpiresAt: undefined,
        approvedSteps: undefined,
        approvedEnvelope: undefined,
      });
      return true;
    }

    // A legacy `plan` string array is intentionally insufficient. Only a
    // canonical executable snapshot can become an approved browser run.
    if (!errand.executionSteps?.length) return false;
    let envelope: BrowserEnvelope;
    let steps: BrowserStep[];
    try {
      envelope = normalizeEnvelope(errand.envelope);
      steps = normalizeSteps(errand.executionSteps, envelope);
    } catch {
      return false;
    }
    await ctx.db.patch(a.errandId, {
      status: "approved",
      resolvedAt: now,
      approvalExpiresAt: now + envelope.ttlMs,
      approvedEnvelope: envelope,
      approvedSteps: steps,
      browserDeadlineAt: undefined,
    });
    return true;
  },
});

/**
 * Claim an approved errand for execution. A claim needs the already-redeemed
 * foreground owner receipt recorded by chatQueue; this makes the receipt and
 * the owner-visible approval both necessary for every browser run.
 */
export const claim = mutation({
  args: {
    errandId: v.id("browserErrands"),
    leaseToken: v.string(),
    foregroundReceiptKey: v.string(),
    authTokenHash: v.optional(v.string()),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    if (!BROWSER_ERRAND_RECEIPT_KEY.test(a.foregroundReceiptKey)) {
      return { ok: false as const, reason: "a one-time foreground owner execution receipt is required" };
    }
    const ownerReceipt = await ctx.db
      .query("chatTurnOwnerToolUses")
      .withIndex("by_receipt", (q: any) => q.eq("receiptKey", a.foregroundReceiptKey))
      .first();
    if (
      !ownerReceipt
      || ownerReceipt.toolName !== "browser_errand_run"
      || ownerReceipt.browserErrandId !== String(a.errandId)
    ) {
      return { ok: false as const, reason: "a matching one-time foreground owner execution receipt is required" };
    }

    const errand = await ctx.db.get(a.errandId);
    if (!errand) return { ok: false as const, reason: "no such errand" };
    const now = Date.now();
    if (errand.status === "running" && Number(errand.leaseUntil ?? 0) <= now) {
      await ctx.db.patch(a.errandId, terminalLeaseFailure(now));
      return { ok: false as const, reason: "the earlier execution lease expired; its outcome is unknown and it was not retried" };
    }
    if (errand.status !== "approved") {
      return { ok: false as const, reason: `errand is '${errand.status}', not 'approved'` };
    }
    if (!/^[A-Za-z0-9_-]{24,128}$/.test(a.leaseToken)) {
      return { ok: false as const, reason: "invalid execution lease" };
    }
    if (!errand.approvedEnvelope || !errand.approvedSteps?.length) {
      await ctx.db.patch(a.errandId, {
        status: "needs_step_approval",
        result: "This legacy approval did not contain a sealed executable plan. Nothing was run; request a new exact proposal.",
        escalation: "A new exact browser proposal is required before execution.",
        finishedAt: now,
        approvalExpiresAt: undefined,
      });
      return { ok: false as const, reason: "approval has no sealed executable plan" };
    }
    let approvedEnvelope: BrowserEnvelope;
    let approvedSteps: BrowserStep[];
    try {
      approvedEnvelope = normalizeEnvelope(errand.approvedEnvelope);
      approvedSteps = normalizeSteps(errand.approvedSteps, approvedEnvelope);
    } catch {
      await ctx.db.patch(a.errandId, {
        status: "needs_step_approval",
        result: "The sealed browser plan could not be validated. Nothing was run; request a new exact proposal.",
        escalation: "A new exact browser proposal is required before execution.",
        finishedAt: now,
        approvalExpiresAt: undefined,
      });
      return { ok: false as const, reason: "sealed plan is invalid" };
    }
    const approvalExpiresAt = Number(
      errand.approvalExpiresAt
      ?? Number(errand.resolvedAt ?? errand.requestedAt) + approvedEnvelope.ttlMs,
    );
    if (!Number.isFinite(approvalExpiresAt) || approvalExpiresAt <= now) {
      await ctx.db.patch(a.errandId, {
        status: "expired",
        result: "Approval expired before the errand began. Nothing was run.",
        finishedAt: now,
      });
      return { ok: false as const, reason: "approval expired before execution began" };
    }
    // Browser lifetime is the remaining approval window, not the original
    // arbitrary proposal duration. The service gets this normalized TTL and
    // Vercel also refuses to issue/await steps after the absolute deadline.
    const browserDeadlineAt = Math.min(approvalExpiresAt, now + approvedEnvelope.ttlMs);
    const remainingTtlMs = Math.max(1, browserDeadlineAt - now);
    await ctx.db.patch(a.errandId, {
      status: "running",
      startedAt: now,
      leaseToken: a.leaseToken,
      browserDeadlineAt,
      leaseUntil: browserDeadlineAt + LEASE_GRACE_MS,
    });
    return {
      ok: true as const,
      objective: errand.objective,
      credentialId: errand.credentialId ?? null,
      envelope: { ...approvedEnvelope, ttlMs: remainingTtlMs },
      steps: approvedSteps,
      browserDeadlineAt,
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
    const now = Date.now();
    // A matching late response is not a valid receipt. The browser task had a
    // hard deadline; preserve an unknown outcome instead of accepting a
    // potentially post-deadline provider action as completed work.
    if (!Number.isFinite(errand.leaseUntil) || Number(errand.leaseUntil) <= now) {
      await ctx.db.patch(a.errandId, terminalLeaseFailure(now));
      return false;
    }
    await ctx.db.patch(a.errandId, {
      status: a.status,
      result: a.result?.slice(0, 4000),
      escalation: a.escalation?.slice(0, 1000),
      sends: a.sends,
      finishedAt: now,
      leaseToken: undefined,
      leaseUntil: undefined,
      browserDeadlineAt: undefined,
      // An escalation re-opens the approval gate, so clear the earlier decision.
      ...(a.status === "needs_step_approval"
        ? { resolvedAt: undefined, approvalExpiresAt: undefined, approvedSteps: undefined, approvedEnvelope: undefined }
        : {}),
    });
    return true;
  },
});

/**
 * Owner-triggered, bounded cleanup for callers that died after claiming an
 * errand. This only ever fails a stale run; it never retries browser work.
 */
export const expireStale = mutation({
  args: {
    limit: v.optional(v.number()),
    authTokenHash: v.optional(v.string()),
    // The minute fleet supervisor needs the same narrow terminal-only
    // authority as the owner UI. It cannot propose, approve, or run errands.
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    const now = Date.now();
    const limit = Math.min(MAX_REAP_BATCH, Math.max(1, Math.trunc(a.limit ?? MAX_REAP_BATCH)));
    const expired = await ctx.db.query("browserErrands")
      .withIndex("by_status_lease", (q: any) => q.eq("status", "running").lte("leaseUntil", now))
      .take(limit);

    // A small legacy sweep covers rows created before `leaseUntil` existed.
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
