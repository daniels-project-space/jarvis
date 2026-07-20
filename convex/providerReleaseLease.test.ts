import { describe, expect, it, vi } from "vitest";
import {
  renewProviderReleaseLockTransaction,
  runningActivityIsStale,
} from "./jobs";

describe("provider release lease heartbeat", () => {
  it("atomically renews the release lock plus durable and compact job heartbeats", async () => {
    const now = 2_000_000;
    const job: any = {
      _id: "job-1",
      repo: "daniels-project-space/jarvis",
      task: "provider release",
      status: "running",
      attempt: 3,
      heartbeatAt: now - 299_000,
      createdAt: 1,
      providerRelease: {
        releaseId: `providers-v2:${"a".repeat(64)}`,
        baseSha: "b".repeat(40),
        headSha: "c".repeat(40),
      },
    };
    const lock: any = {
      _id: "lock-1",
      repo: job.repo,
      jobId: job._id,
      releaseId: job.providerRelease.releaseId,
      baseSha: job.providerRelease.baseSha,
      headSha: job.providerRelease.headSha,
      leaseToken: "d".repeat(48),
      leaseUntil: now + 1,
      status: "premerge_ready",
    };
    const runtime: any = {
      _id: "runtime-1",
      jobId: job._id,
      task: job.task,
      status: "running",
      priority: 50,
      stage: "provider_release",
      percent: 97,
      attempt: 3,
      maxAttempts: 12,
      heartbeatAt: job.heartbeatAt,
      createdAt: 1,
      updatedAt: job.heartbeatAt,
    };
    const db = {
      get: async () => job,
      query: (table: string) => ({
        withIndex: () => ({
          first: async () => table === "providerReleaseLocks" ? lock : runtime,
        }),
      }),
      patch: async (id: string, patch: Record<string, unknown>) => {
        Object.assign(id === lock._id ? lock : job, patch);
      },
      replace: async (_id: string, replacement: Record<string, unknown>) => {
        Object.assign(runtime, replacement);
      },
      insert: async () => { throw new Error("runtime row unexpectedly missing"); },
    };
    expect(runningActivityIsStale(runtime, now)).toBe(false);
    expect(runningActivityIsStale(runtime, now + 2_000)).toBe(true);

    const result = await renewProviderReleaseLockTransaction({ db }, {
      jobId: job._id,
      expectedAttempt: 3,
      releaseId: lock.releaseId,
      baseSha: lock.baseSha,
      headSha: lock.headSha,
      leaseToken: lock.leaseToken,
    }, now);

    expect(result).toEqual({ ok: true, leaseUntil: now + 10 * 60_000 });
    expect(lock).toMatchObject({ leaseUntil: now + 10 * 60_000, updatedAt: now });
    expect(job.heartbeatAt).toBe(now);
    expect(runtime.heartbeatAt).toBe(now);
    expect(runningActivityIsStale(runtime, now + 4 * 60_000)).toBe(false);
  });

  it("does not revive an expired or foreign release owner", async () => {
    const now = 3_000_000;
    const release = {
      releaseId: `providers-v2:${"a".repeat(64)}`,
      baseSha: "b".repeat(40),
      headSha: "c".repeat(40),
    };
    const job: any = {
      _id: "job-2",
      repo: "daniels-project-space/jarvis",
      task: "provider release",
      status: "running",
      attempt: 2,
      heartbeatAt: now - 299_000,
      createdAt: 1,
      providerRelease: release,
    };
    const lock: any = {
      _id: "lock-2",
      repo: job.repo,
      jobId: job._id,
      ...release,
      leaseToken: "d".repeat(48),
      leaseUntil: now,
      status: "premerge_ready",
    };
    const patch = vi.fn();
    const result = await renewProviderReleaseLockTransaction({
      db: {
        get: async () => job,
        query: () => ({ withIndex: () => ({ first: async () => lock }) }),
        patch,
      },
    }, {
      jobId: job._id,
      expectedAttempt: 2,
      ...release,
      leaseToken: lock.leaseToken,
    }, now);

    expect(result).toEqual({ ok: false, reason: "provider release lock is missing, expired, or owned elsewhere" });
    expect(patch).not.toHaveBeenCalled();
    expect(job.heartbeatAt).toBe(now - 299_000);
  });
});
