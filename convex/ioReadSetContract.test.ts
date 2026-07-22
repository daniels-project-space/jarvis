import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { api } from "./_generated/api";
import schema from "./schema";
import {
  JOB_LIST_COMPATIBILITY_MAX,
  boundedJobListLimit,
  detail,
  list,
  monitor,
} from "./jobs";
import { HISTORY_PAGE_MAX, listMessages, paginatedMessages } from "./chatQueue";
import { PROACTIVE_ATTENTION_MAX, PROACTIVE_AUTHORITY_MIGRATION_PAGE } from "./proactive";

declare global {
  interface ImportMeta {
    glob(pattern: string): Record<string, () => Promise<unknown>>;
  }
}

const modules = import.meta.glob("./**/*.ts");
const WORKER = "io-contract-worker";
const VIEWER = { issuer: "https://jarvis-orcin-six.vercel.app", subject: "daniel-owner" };

function handlerOf(value: unknown) {
  return (value as { _handler: (ctx: any, args: any) => Promise<any> })._handler;
}

function runtimeRow(overrides: Record<string, unknown> = {}) {
  return {
    jobId: "job-1", status: "running", attempt: 2, stage: "testing", percent: 71,
    progress: "safe progress sk-abcdefghijklmnopqrstuvwxyz123456", sourceBranch: "main",
    sourceHeadSha: "a".repeat(40), integrationBranch: "jarvis/integration", workerBranch: "jarvis/worker",
    branch: "jarvis/result", mergeCommitSha: null, label: "Bounded query work", agentId: "sentry",
    repo: "daniels-project-space/jarvis", progressAt: 2, model: "terra", reasoningEffort: "high",
    workerRuntime: "trigger", workerRunId: "run-1", deliveryGeneration: 3, maxAttempts: 4,
    integrationState: "not_applicable", deliveryStatus: "branch", startedAt: 1, stallReason: null,
    task: "must never escape", log: "must never escape", checkpoint: "must never escape",
    ...overrides,
  };
}

function jobReadHarness(rows: any[]) {
  const reads: Array<{ table: string; index?: string; limit?: number; first?: boolean }> = [];
  const ctx = {
    auth: { getUserIdentity: async () => VIEWER },
    db: {
      query(table: string) {
        const read = { table } as (typeof reads)[number];
        reads.push(read);
        const builder = {
          withIndex(index: string, apply?: (q: any) => unknown) {
            read.index = index;
            apply?.({ eq: () => ({}) });
            return builder;
          },
          order() { return builder; },
          async take(limit: number) { read.limit = limit; return rows.slice(0, limit); },
          async first() { read.first = true; return rows[0] ?? null; },
        };
        return builder;
      },
    },
  };
  return { ctx, reads };
}

describe("deterministic Convex IO/read-set contract", () => {
  it("reads one compact indexed projection for exact monitoring and detail", async () => {
    const monitored = jobReadHarness([runtimeRow()]);
    const result = await handlerOf(monitor)(monitored.ctx, { jobId: "job-1" });
    expect(monitored.reads).toEqual([{ table: "jobRuntime", index: "by_job", first: true }]);
    expect(result).toMatchObject({ jobId: "job-1", status: "running", attempt: 2, stage: "testing", percent: 71 });
    expect(result.progress).not.toContain("sk-");
    expect(Object.keys(result).sort()).toEqual([
      "attempt", "branch", "integrationBranch", "jobId", "mergeCommitSha", "percent", "progress",
      "sourceBranch", "sourceHeadSha", "stage", "status", "workerBranch",
    ]);

    const drilled = jobReadHarness([runtimeRow()]);
    const drillResult = await handlerOf(detail)(drilled.ctx, { jobId: "job-1" });
    expect(drilled.reads).toEqual([{ table: "jobRuntime", index: "by_job", first: true }]);
    expect(drillResult).toMatchObject({ workerRunId: "run-1", generation: 3, maxAttempts: 4 });
    expect(drillResult).not.toHaveProperty("task");
    expect(drillResult).not.toHaveProperty("log");
    expect(drillResult).not.toHaveProperty("checkpoint");
  });

  it.each([
    ["hostile", 100, 12],
    ["missing", undefined, 8],
    ["negative", -9, 8],
    ["NaN", Number.NaN, 8],
    ["fractional", 7.5, 8],
    ["briefing", 8, 8],
  ])("bounds jobs:list %s input", async (_label, limit, expected) => {
    expect(boundedJobListLimit(limit)).toBe(expected);
    const harness = jobReadHarness(Array.from({ length: 30 }, (_, index) => runtimeRow({ jobId: `job-${index}` })));
    const result = await handlerOf(list)(harness.ctx, limit === undefined ? {} : { limit });
    expect(harness.reads).toEqual([{ table: "jobRuntime", index: "by_createdAt", limit: expected }]);
    expect(result).toHaveLength(expected);
    expect(result.every((row: any) => Object.keys(row).sort().join(",") === "_id,status")).toBe(true);
    expect(result.length).toBeLessThanOrEqual(JOB_LIST_COMPATIBILITY_MAX);
  });

  it("caps a streamed live read and every history cursor request", async () => {
    const reads: any[] = [];
    const rows = Array.from({ length: 40 }, (_, index) => ({ _id: `m-${index}`, createdAt: index }));
    const ctx = {
      auth: { getUserIdentity: async () => VIEWER },
      db: { query(table: string) {
        const read: any = { table }; reads.push(read);
        const builder = {
          withIndex(index: string) { read.index = index; return builder; }, order(order: string) { read.order = order; return builder; },
          async take(limit: number) { read.limit = limit; return rows.slice(0, limit); },
          async paginate(options: any) { read.options = options; return { page: rows.slice(0, options.maximumRowsRead), isDone: false, continueCursor: "next" }; },
        };
        return builder;
      } },
    };
    expect(await handlerOf(listMessages)(ctx, { threadId: "main" })).toHaveLength(20);
    const page = await handlerOf(paginatedMessages)(ctx, { threadId: "main", paginationOpts: { cursor: null, numItems: 100 } });
    expect(page.page).toHaveLength(HISTORY_PAGE_MAX);
    expect(reads).toEqual([
      { table: "chatMessages", index: "by_thread", order: "desc", limit: 20 },
      { table: "chatMessages", index: "by_thread", order: "desc", options: { cursor: null, numItems: 20, maximumRowsRead: 20, maximumBytesRead: 262144 } },
    ]);
  });
});

describe("streaming and paginated history behavior", () => {
  beforeEach(() => { process.env.JARVIS_WORKER_TOKEN = WORKER; });
  afterEach(() => { delete process.env.JARVIS_WORKER_TOKEN; });

  it("keeps live text incremental, final text authoritative, and old rows thread-scoped and fetchable", async () => {
    const t = convexTest(schema, modules);
    const viewer = t.withIdentity(VIEWER);
    const ids = await t.run(async (ctx) => {
      for (let index = 0; index < 34; index += 1) {
        await ctx.db.insert("chatMessages", { threadId: "alpha", role: index % 2 ? "assistant" : "user", text: `alpha-${index}`, status: "done", delivery: "foreground", createdAt: index + 1 });
      }
      await ctx.db.insert("chatMessages", { threadId: "beta", role: "user", text: "beta-only", status: "done", delivery: "foreground", createdAt: 1 });
      const parent = await ctx.db.insert("chatMessages", { threadId: "alpha", role: "user", text: "active", status: "done", delivery: "foreground", createdAt: 100 });
      const assistant = await ctx.db.insert("chatMessages", { threadId: "alpha", role: "assistant", text: "", status: "streaming", delivery: "foreground", parentMessageId: parent, streamRevision: 0, createdAt: 101 });
      await ctx.db.insert("chatMessages", { threadId: "alpha", role: "assistant", text: "", status: "done", delivery: "foreground", parentMessageId: parent, attachment: { type: "image", value: "r2://safe", title: "card" }, createdAt: 102 });
      return { parent, assistant };
    });

    expect(await t.mutation(api.chatQueue.updateStream, { messageId: ids.assistant, text: "partial", revision: 1, workerToken: WORKER })).toBe(true);
    let live = await viewer.query(api.chatQueue.listMessages, { threadId: "alpha" });
    expect(live).toHaveLength(20);
    expect(live.find((row) => row._id === ids.assistant)?.text).toBe("partial");
    expect(live.some((row) => row.threadId === "beta")).toBe(false);

    expect(await t.mutation(api.chatQueue.finalize, { messageId: ids.assistant, threadId: "alpha", status: "done", finalText: "authoritative final", workerToken: WORKER })).toBe(true);
    expect(await t.mutation(api.chatQueue.updateStream, { messageId: ids.assistant, text: "late duplicate", revision: 2, workerToken: WORKER })).toBe(false);
    live = await viewer.query(api.chatQueue.listMessages, { threadId: "alpha" });
    expect(live.find((row) => row._id === ids.assistant)?.text).toBe("authoritative final");

    const fetched: any[] = [];
    let cursor: string | null = null;
    let isDone = false;
    while (!isDone) {
      const page: { page: any[]; continueCursor: string; isDone: boolean } = await viewer.query(api.chatQueue.paginatedMessages, { threadId: "alpha", paginationOpts: { cursor, numItems: 100 } });
      expect(page.page.length).toBeLessThanOrEqual(HISTORY_PAGE_MAX);
      fetched.push(...page.page);
      cursor = page.continueCursor;
      isDone = page.isDone;
    }
    expect(fetched).toHaveLength(37);
    expect(fetched.some((row) => row.text === "alpha-0")).toBe(true);
    expect(fetched.find((row) => row.attachment?.title === "card")?.parentMessageId).toBe(ids.parent);
    expect(fetched.some((row) => row.threadId === "beta")).toBe(false);
  });

  it("reconciles proactive ownership through bounded indexed pages despite unrelated rows", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      for (let index = 0; index < 60; index += 1) {
        await ctx.db.insert("attentionItems", {
          fingerprint: `unrelated:${index}`, title: `Unrelated ${index}`, detail: "safe", severity: "warning",
          impact: 1, urgency: 1, confidence: 1, actionClass: "inform", status: "open", createdAt: index + 1, updatedAt: index + 1,
        });
      }
      await ctx.db.insert("attentionItems", {
        fingerprint: "proactive:legacy:stale", title: "Legacy proactive", detail: "safe", severity: "warning",
        impact: 1, urgency: 1, confidence: 1, actionClass: "inform", status: "open", createdAt: 100, updatedAt: 100,
      });
    });

    const first = await t.mutation(api.proactive.reconcile, { now: 1_000, workerToken: WORKER });
    expect(first.authorityMigration).toEqual({ scanned: PROACTIVE_AUTHORITY_MIGRATION_PAGE, repaired: 0, complete: false });
    expect(first.signals).toBe(0);
    for (let index = 0; index < 6; index += 1) await t.mutation(api.proactive.reconcile, { now: 1_001 + index, workerToken: WORKER });
    const rows = await t.run(async (ctx) => await ctx.db.query("attentionItems")
      .withIndex("by_authority_status", (q) => q.eq("authority", "proactive").eq("status", "resolved"))
      .take(PROACTIVE_ATTENTION_MAX));
    expect(rows.map((row) => row.fingerprint)).toContain("proactive:legacy:stale");
    expect(await t.run(async (ctx) => (await ctx.db.query("attentionItems").withIndex("by_fingerprint", (q) => q.eq("fingerprint", "unrelated:0")).first())?.authority ?? null)).toBeNull();
  });

  it("records historical provider cleanup as blocked attention without pretending termination", async () => {
    const t = convexTest(schema, modules);
    const jobId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("jobs", { task: "historical cleanup", status: "error", createdAt: 1 });
      await ctx.db.insert("workAttempts", {
        jobId: id, attempt: 1, status: "error", providerName: "daytona",
        providerWorkspaceId: "legacy-workspace", providerSessionId: "legacy-session",
        livenessAt: 1, progressAt: 1, lastEventAt: 1, createdAt: 1,
      });
      return id;
    });
    expect(await t.mutation(api.jobs.noteCloudWorkspaceCleanupBlocked, {
      jobId, expectedAttempt: 1, providerWorkspaceId: "legacy-workspace", providerSessionId: "legacy-session",
      code: "cleanup_blocked", reason: "retired adapter; api_key=sk-abcdefghijklmnopqrstuvwxyz123456", workerToken: WORKER,
    })).toBe(true);
    const state = await t.run(async (ctx) => ({
      attempt: await ctx.db.query("workAttempts").withIndex("by_job_attempt", (q) => q.eq("jobId", jobId).eq("attempt", 1)).first(),
      attention: await ctx.db.query("attentionItems").withIndex("by_jobId", (q) => q.eq("jobId", String(jobId))).first(),
    }));
    expect(state.attempt).toMatchObject({ cleanupBlockedCode: "cleanup_blocked" });
    expect(state.attempt?.providerTerminatedAt).toBeUndefined();
    expect(state.attention).toMatchObject({ authority: "provider-cleanup", status: "open", actionClass: "ask" });
    expect(state.attention?.detail).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
  });
});
