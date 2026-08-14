import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { api } from "./_generated/api";
import schema from "./schema";

/* eslint-disable @typescript-eslint/no-explicit-any -- convex-test fixtures intentionally construct partial persisted records */

declare global {
  interface ImportMeta {
    glob(pattern: string): Record<string, () => Promise<unknown>>;
  }
}

const modules = import.meta.glob("./**/*.ts");
const WORKER = "cloud-cleanup-worker";
const NOW = Date.UTC(2026, 7, 14, 12, 0, 0);
const ORPHAN_AGE_MS = 5 * 60_000;

beforeEach(() => {
  process.env.JARVIS_WORKER_TOKEN = WORKER;
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  delete process.env.JARVIS_WORKER_TOKEN;
  vi.useRealTimers();
});

async function insertOrphan(
  t: ReturnType<typeof convexTest>,
  key: string,
  overrides: Record<string, unknown> = {},
) {
  return await t.run(async (ctx) => {
    const jobId = await ctx.db.insert("jobs", {
      task: `cleanup ${key}`,
      status: "error",
      createdAt: NOW - ORPHAN_AGE_MS - 60_000,
    });
    await ctx.db.insert("workAttempts", {
      jobId,
      attempt: 1,
      status: "error",
      providerName: "sandbox0",
      providerWorkspaceId: `workspace-${key}`,
      providerSessionId: `session-${key}`,
      cloudWorkspaceCleanupEligible: true,
      livenessAt: NOW - ORPHAN_AGE_MS - 60_000,
      progressAt: NOW - ORPHAN_AGE_MS - 60_000,
      lastEventAt: NOW - ORPHAN_AGE_MS - 60_000,
      createdAt: NOW - ORPHAN_AGE_MS - 60_000,
      ...overrides,
    } as any);
    return jobId;
  });
}

describe("durable cloud workspace cleanup scheduling", () => {
  it("keeps ordinary terminal attempts out of the indexed cleanup lane while recovering legacy workspaces", async () => {
    const t = convexTest(schema, modules);
    const legacyJobId = await insertOrphan(t, "legacy", { cloudWorkspaceCleanupEligible: undefined });

    await t.run(async (ctx) => {
      const partialLegacyJobId = await ctx.db.insert("jobs", {
        task: "partial legacy workspace",
        status: "error",
        createdAt: NOW - ORPHAN_AGE_MS - 1,
      });
      await ctx.db.insert("workAttempts", {
        jobId: partialLegacyJobId,
        attempt: 1,
        status: "error",
        providerName: "sandbox0",
        livenessAt: NOW - ORPHAN_AGE_MS - 1,
        progressAt: NOW - ORPHAN_AGE_MS - 1,
        lastEventAt: NOW - ORPHAN_AGE_MS - 1,
        createdAt: NOW - ORPHAN_AGE_MS - 1,
      } as any);
      for (let index = 0; index < 80; index += 1) {
        const jobId = await ctx.db.insert("jobs", {
          task: `ordinary terminal ${index}`,
          status: "error",
          createdAt: NOW - ORPHAN_AGE_MS - index,
        });
        await ctx.db.insert("workAttempts", {
          jobId,
          attempt: 1,
          status: "error",
          livenessAt: NOW - ORPHAN_AGE_MS - index,
          progressAt: NOW - ORPHAN_AGE_MS - index,
          lastEventAt: NOW - ORPHAN_AGE_MS - index,
          createdAt: NOW - ORPHAN_AGE_MS - index,
        } as any);
      }
    });

    await expect(t.query(api.jobs.cloudWorkspaceOrphans, {
      olderThan: NOW - ORPHAN_AGE_MS,
      workerToken: WORKER,
    })).resolves.toEqual([
      expect.objectContaining({ jobId: legacyJobId, providerWorkspaceId: "workspace-legacy" }),
    ]);
  });

  it("skips blocked rows until their retry is due without starving a newer eligible orphan", async () => {
    const t = convexTest(schema, modules);
    const retryAfter = NOW + 60 * 60_000;

    for (let index = 0; index < 55; index += 1) {
      await insertOrphan(t, `blocked-${index}`, {
        progressAt: NOW - ORPHAN_AGE_MS - 100 - index,
        cleanupAttempts: 1,
        cleanupNextRetryAt: retryAfter,
      });
    }
    const dueJobId = await insertOrphan(t, "due", {
      progressAt: NOW - ORPHAN_AGE_MS - 1,
    });

    const scheduled = await t.query(api.jobs.cloudWorkspaceOrphans, {
      olderThan: NOW - ORPHAN_AGE_MS,
      workerToken: WORKER,
    });

    expect(scheduled).toEqual([
      expect.objectContaining({
        jobId: dueJobId,
        providerWorkspaceId: "workspace-due",
        providerSessionId: "session-due",
      }),
    ]);
  });

  it("keeps blocked cleanup attention visible, backs off repeat failures, and clears retry state after termination", async () => {
    const t = convexTest(schema, modules);
    const jobId = await insertOrphan(t, "retry");
    const cleanup = {
      jobId,
      expectedAttempt: 1,
      providerWorkspaceId: "workspace-retry",
      providerSessionId: "session-retry",
      code: "provider_unavailable",
      reason: "provider still unavailable",
      workerToken: WORKER,
    };

    expect(await t.mutation(api.jobs.noteCloudWorkspaceCleanupBlocked, cleanup)).toBe(true);
    const first = await t.run(async (ctx) => ({
      attempt: await ctx.db.query("workAttempts")
        .withIndex("by_job_attempt", (q) => q.eq("jobId", jobId).eq("attempt", 1))
        .first(),
      attention: await ctx.db.query("attentionItems")
        .withIndex("by_jobId", (q) => q.eq("jobId", String(jobId)))
        .first(),
    }));
    const firstRetryAt = Number((first.attempt as any)?.cleanupNextRetryAt);
    expect(first.attempt).toMatchObject({ cleanupAttempts: 1, cleanupBlockedCode: "provider_unavailable" });
    expect(firstRetryAt).toBe(NOW + 60_000);
    expect(first.attention).toMatchObject({ authority: "provider-cleanup", status: "open" });

    await expect(t.query(api.jobs.cloudWorkspaceOrphans, {
      olderThan: NOW - ORPHAN_AGE_MS,
      workerToken: WORKER,
    })).resolves.toEqual([]);

    vi.setSystemTime(NOW + 1);
    expect(await t.mutation(api.jobs.noteCloudWorkspaceCleanupBlocked, cleanup)).toBe(true);
    const second = await t.run(async (ctx) => await ctx.db.query("workAttempts")
      .withIndex("by_job_attempt", (q) => q.eq("jobId", jobId).eq("attempt", 1))
      .first());
    expect(second).toMatchObject({ cleanupAttempts: 2 });
    expect(Number((second as any)?.cleanupNextRetryAt)).toBe(NOW + 1 + 2 * 60_000);

    expect(await t.mutation(api.jobs.markCloudWorkspaceTerminated, {
      jobId,
      expectedAttempt: 1,
      providerWorkspaceId: "workspace-retry",
      providerSessionId: "session-retry",
      workerToken: WORKER,
    })).toBe(true);
    const terminated = await t.run(async (ctx) => ({
      attempt: await ctx.db.query("workAttempts")
        .withIndex("by_job_attempt", (q) => q.eq("jobId", jobId).eq("attempt", 1))
        .first(),
      attention: await ctx.db.query("attentionItems")
        .withIndex("by_jobId", (q) => q.eq("jobId", String(jobId)))
        .first(),
    }));
    expect(terminated.attempt?.providerTerminatedAt).toBe(NOW + 1);
    expect((terminated.attempt as any)?.cloudWorkspaceCleanupEligible).toBeUndefined();
    expect((terminated.attempt as any)?.cleanupAttempts).toBeUndefined();
    expect((terminated.attempt as any)?.cleanupNextRetryAt).toBeUndefined();
    expect(terminated.attention).toMatchObject({ status: "resolved" });
  });
});
