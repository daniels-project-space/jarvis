import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { api } from "./_generated/api";
import schema from "./schema";
import { canonicalWorkspaceCheckpoint } from "../src/lib/workspace-checkpoint";

declare global {
  interface ImportMeta { glob(pattern: string): Record<string, () => Promise<unknown>>; }
}

const modules = import.meta.glob("./**/*.ts");
const WORKER = "checkpoint-replay-worker";
const BASE = "a".repeat(40);
const SOURCE = "b".repeat(64);
const LOCK = "c".repeat(64);
const ARCHIVE = "d".repeat(64);
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

beforeEach(() => { process.env.JARVIS_WORKER_TOKEN = WORKER; });
afterEach(() => { delete process.env.JARVIS_WORKER_TOKEN; });

describe("durable cloud checkpoint control evidence", () => {
  it("records one canonical bounded manifest idempotently and replays it only through exact bindings", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    const jobId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("jobs", {
        task: "continue exact cloud work", status: "running", attempt: 1, maxAttempts: 4,
        workerRunId: "run-1", priority: 50, stage: "executing", percent: 60,
        createdAt: now, heartbeatAt: now,
      });
      await ctx.db.insert("workAttempts", {
        jobId: id, attempt: 1, status: "running", workerRunId: "run-1",
        workspaceBaseSha: BASE, livenessAt: now, progressAt: now, lastEventAt: now, createdAt: now,
      });
      await ctx.db.insert("jobRuntime", {
        jobId: id, task: "continue exact cloud work", status: "running", active: true,
        attempt: 1, maxAttempts: 4, priority: 50, stage: "executing", percent: 60,
        workerRunId: "run-1", heartbeatAt: now, progressAt: now, createdAt: now, updatedAt: now,
      });
      return id;
    });
    const identity = {
      providerName: "cloudflare" as const,
      providerWorkspaceId: "workspace-1", providerSessionId: "session-1",
      baseSha: BASE, runtime: "node-22", lockfileDigest: LOCK, template: "node-template",
      sourceArchiveDigest: SOURCE, sourceArchiveBytes: 2_048,
    };
    expect(await t.mutation(api.jobs.bindCloudWorkspace, {
      jobId, expectedAttempt: 1, workerRunId: "run-1", ...identity, workerToken: WORKER,
    })).toBe(true);
    const manifest = canonicalWorkspaceCheckpoint({
      version: 2, jobId: String(jobId), attempt: 1, provider: "cloudflare",
      providerWorkspaceId: identity.providerWorkspaceId, providerSessionId: identity.providerSessionId,
      baseSha: BASE, sourceArchiveSha256: SOURCE, sourceArchiveBytes: 2_048,
      archiveSha256: ARCHIVE, archiveBytes: 4_096, runtime: "node-22", lockfileDigest: LOCK,
      template: "node-template", attemptKey: `${String(jobId)}:1`, causationId: "run-1:1", createdAt: now,
    });
    const record = {
      jobId, expectedAttempt: 1,
      providerWorkspaceId: identity.providerWorkspaceId, providerSessionId: identity.providerSessionId,
      checkpointRef: `sandbox-checkpoints/sha256/${ARCHIVE}`, checkpointDigest: ARCHIVE,
      checkpointBytes: 4_096, checkpointManifestDigest: sha256(manifest), checkpointManifest: manifest,
      workerToken: WORKER,
    };
    expect(await t.mutation(api.jobs.recordCloudCheckpoint, record)).toBe(true);
    expect(await t.mutation(api.jobs.recordCloudCheckpoint, record)).toBe(true);
    expect(await t.mutation(api.jobs.recordCloudCheckpoint, { ...record, checkpointBytes: 4_095 })).toBe(false);

    await t.run(async (ctx) => {
      const job = await ctx.db.get(jobId);
      const first = await ctx.db.query("workAttempts").withIndex("by_job_attempt", (q) => q.eq("jobId", jobId).eq("attempt", 1)).first();
      const runtime = await ctx.db.query("jobRuntime").withIndex("by_job", (q) => q.eq("jobId", jobId)).first();
      await ctx.db.patch(job!._id, { attempt: 2, workerRunId: "run-2" });
      await ctx.db.patch(first!._id, { status: "checkpointed" });
      await ctx.db.patch(runtime!._id, { attempt: 2, workerRunId: "run-2" });
      await ctx.db.insert("workAttempts", {
        jobId, attempt: 2, status: "running", workerRunId: "run-2", workspaceBaseSha: BASE,
        livenessAt: now, progressAt: now, lastEventAt: now, createdAt: now,
      });
    });
    const replayArgs = {
      jobId, expectedAttempt: 2, workerRunId: "run-2", providerName: "cloudflare" as const,
      baseSha: BASE, runtime: "node-22", lockfileDigest: LOCK, template: "node-template",
      sourceArchiveDigest: SOURCE, sourceArchiveBytes: 2_048, workerToken: WORKER,
    };
    const replay = await t.query(api.jobs.cloudCheckpointForReplay, replayArgs);
    expect(replay).toMatchObject({ disposition: "replay", sourceAttempt: 1, checkpointDigest: ARCHIVE });
    expect(Object.values(replay as Record<string, unknown>).some((value) => value instanceof Uint8Array)).toBe(false);
    expect(await t.query(api.jobs.cloudCheckpointForReplay, { ...replayArgs, lockfileDigest: "e".repeat(64) }))
      .toMatchObject({ disposition: "hydrate", reason: "lockfile_changed" });

    await t.run(async (ctx) => {
      const first = await ctx.db.query("workAttempts").withIndex("by_job_attempt", (q) => q.eq("jobId", jobId).eq("attempt", 1)).first();
      await ctx.db.patch(first!._id, { checkpointManifest: `${manifest} ` });
    });
    expect(await t.query(api.jobs.cloudCheckpointForReplay, replayArgs))
      .toMatchObject({ disposition: "reject", reason: "checkpoint_manifest_tampered" });
  });
});
