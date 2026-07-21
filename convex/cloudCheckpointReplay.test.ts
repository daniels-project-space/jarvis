import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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
      const first = await ctx.db.query("workAttempts")
        .withIndex("by_job_attempt", (q) => q.eq("jobId", jobId).eq("attempt", 1)).first();
      expect(first).toMatchObject({
        checkpointAvailable: true,
        checkpointRef: record.checkpointRef,
        checkpointDigest: record.checkpointDigest,
        checkpointManifestDigest: record.checkpointManifestDigest,
        checkpointManifest: record.checkpointManifest,
      });
    });

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

  it("uses the checkpoint-availability index to choose only the newest valid prior receipt", async () => {
    const source = readFileSync(new URL("./jobs.ts", import.meta.url), "utf8");
    const replayQuery = source.slice(source.indexOf("export const cloudCheckpointForReplay"), source.indexOf("export const recordCloudReplayDecision"));
    expect(replayQuery).toContain('withIndex("by_job_checkpoint_available_attempt"');
    expect(replayQuery).toContain('.eq("checkpointAvailable", true)');
    expect(replayQuery).toContain('.lt("attempt", a.expectedAttempt)');
    expect(replayQuery).toContain('.order("desc")');
    expect(replayQuery).toContain('.first()');
    expect(replayQuery).not.toContain(".collect()");
    expect(replayQuery).not.toContain(".filter(");
    expect(replayQuery).not.toContain(".sort(");

    const t = convexTest(schema, modules);
    const now = Date.now();
    const jobId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("jobs", {
        task: "replay newest indexed checkpoint", status: "running", attempt: 110, maxAttempts: 160,
        workerRunId: "run-110", priority: 50, stage: "executing", percent: 60,
        createdAt: now, heartbeatAt: now,
      });
      await ctx.db.insert("jobRuntime", {
        jobId: id, task: "replay newest indexed checkpoint", status: "running", active: true,
        attempt: 110, maxAttempts: 160, priority: 50, stage: "executing", percent: 60,
        workerRunId: "run-110", heartbeatAt: now, progressAt: now, createdAt: now, updatedAt: now,
      });
      for (let attempt = 1; attempt < 110; attempt += 1) {
        await ctx.db.insert("workAttempts", {
          jobId: id, attempt, status: "checkpointed", workerRunId: `run-${attempt}`,
          workspaceBaseSha: BASE, livenessAt: now, progressAt: now, lastEventAt: now, createdAt: now,
        });
      }
      await ctx.db.insert("workAttempts", {
        jobId: id, attempt: 110, status: "running", workerRunId: "run-110", workspaceBaseSha: BASE,
        livenessAt: now, progressAt: now, lastEventAt: now, createdAt: now,
      });
      return id;
    });

    const installReceipt = async (attempt: number, available = true) => {
      const providerWorkspaceId = `workspace-${attempt}`;
      const providerSessionId = `session-${attempt}`;
      const manifest = canonicalWorkspaceCheckpoint({
        version: 2, jobId: String(jobId), attempt, provider: "cloudflare",
        providerWorkspaceId, providerSessionId, baseSha: BASE,
        sourceArchiveSha256: SOURCE, sourceArchiveBytes: 2_048,
        archiveSha256: ARCHIVE, archiveBytes: 4_096, runtime: "node-22", lockfileDigest: LOCK,
        template: "node-template", attemptKey: `${String(jobId)}:${attempt}`,
        causationId: `run-${attempt}:${attempt}`, createdAt: now,
      });
      await t.run(async (ctx) => {
        const row = await ctx.db.query("workAttempts")
          .withIndex("by_job_attempt", (q) => q.eq("jobId", jobId).eq("attempt", attempt)).first();
        await ctx.db.patch(row!._id, {
          providerName: "cloudflare", providerWorkspaceId, providerSessionId,
          workspaceRuntime: "node-22", workspaceLockfileDigest: LOCK, workspaceTemplate: "node-template",
          sourceArchiveDigest: SOURCE, sourceArchiveBytes: 2_048,
          checkpointRef: `sandbox-checkpoints/sha256/${ARCHIVE}`, checkpointDigest: ARCHIVE,
          checkpointBytes: 4_096, checkpointManifestDigest: sha256(manifest), checkpointManifest: manifest,
          ...(available ? { checkpointAvailable: true } : {}),
        });
      });
    };

    // 108 non-checkpoint attempts must not be read to find the two receipts.
    await installReceipt(17);
    await installReceipt(84);
    // A complete legacy receipt without the authority marker intentionally
    // remains unavailable for replay, and current/future receipts are fenced.
    await installReceipt(109, false);
    await t.run(async (ctx) => {
      for (const attempt of [110, 111, 140]) {
        if (attempt !== 110) await ctx.db.insert("workAttempts", {
          jobId, attempt, status: "checkpointed", workerRunId: `run-${attempt}`, workspaceBaseSha: BASE,
          livenessAt: now, progressAt: now, lastEventAt: now, createdAt: now,
        });
      }
    });
    await installReceipt(111);
    await installReceipt(140);

    const args = {
      jobId, expectedAttempt: 110, workerRunId: "run-110", providerName: "cloudflare" as const,
      baseSha: BASE, runtime: "node-22", lockfileDigest: LOCK, template: "node-template",
      sourceArchiveDigest: SOURCE, sourceArchiveBytes: 2_048, workerToken: WORKER,
    };
    expect(await t.query(api.jobs.cloudCheckpointForReplay, args))
      .toMatchObject({ disposition: "replay", sourceAttempt: 84, checkpointDigest: ARCHIVE });
    expect(await t.query(api.jobs.cloudCheckpointForReplay, { ...args, workerRunId: "stale-run" }))
      .toMatchObject({ disposition: "reject", reason: "stale_attempt" });
  });

  it("hydrates when no indexed receipt exists and fails closed on incomplete or tampered newest receipts", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    const jobId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("jobs", {
        task: "fail closed checkpoint receipt", status: "running", attempt: 6, maxAttempts: 8,
        workerRunId: "run-6", priority: 50, stage: "executing", percent: 60, createdAt: now, heartbeatAt: now,
      });
      await ctx.db.insert("jobRuntime", {
        jobId: id, task: "fail closed checkpoint receipt", status: "running", active: true,
        attempt: 6, maxAttempts: 8, priority: 50, stage: "executing", percent: 60,
        workerRunId: "run-6", heartbeatAt: now, progressAt: now, createdAt: now, updatedAt: now,
      });
      for (let attempt = 1; attempt <= 6; attempt += 1) await ctx.db.insert("workAttempts", {
        jobId: id, attempt, status: attempt === 6 ? "running" : "checkpointed", workerRunId: `run-${attempt}`,
        workspaceBaseSha: BASE, livenessAt: now, progressAt: now, lastEventAt: now, createdAt: now,
      });
      return id;
    });
    const args = {
      jobId, expectedAttempt: 6, workerRunId: "run-6", providerName: "cloudflare" as const,
      baseSha: BASE, runtime: "node-22", lockfileDigest: LOCK, template: "node-template",
      sourceArchiveDigest: SOURCE, sourceArchiveBytes: 2_048, workerToken: WORKER,
    };
    expect(await t.query(api.jobs.cloudCheckpointForReplay, args))
      .toMatchObject({ disposition: "hydrate", reason: "no_prior_checkpoint" });

    await t.run(async (ctx) => {
      const incomplete = await ctx.db.query("workAttempts")
        .withIndex("by_job_attempt", (q) => q.eq("jobId", jobId).eq("attempt", 5)).first();
      await ctx.db.patch(incomplete!._id, {
        checkpointAvailable: true, checkpointRef: `sandbox-checkpoints/sha256/${ARCHIVE}`,
      });
    });
    expect(await t.query(api.jobs.cloudCheckpointForReplay, args))
      .toMatchObject({ disposition: "reject", reason: "checkpoint_receipt_incomplete" });

    const manifest = canonicalWorkspaceCheckpoint({
      version: 2, jobId: String(jobId), attempt: 5, provider: "cloudflare",
      providerWorkspaceId: "workspace-5", providerSessionId: "session-5", baseSha: BASE,
      sourceArchiveSha256: SOURCE, sourceArchiveBytes: 2_048,
      archiveSha256: ARCHIVE, archiveBytes: 4_096, runtime: "node-22", lockfileDigest: LOCK,
      template: "node-template", attemptKey: `${String(jobId)}:5`, causationId: "run-5:5", createdAt: now,
    });
    await t.run(async (ctx) => {
      const tampered = await ctx.db.query("workAttempts")
        .withIndex("by_job_attempt", (q) => q.eq("jobId", jobId).eq("attempt", 5)).first();
      await ctx.db.patch(tampered!._id, {
        providerName: "cloudflare", providerWorkspaceId: "workspace-5", providerSessionId: "session-5",
        workspaceRuntime: "node-22", workspaceLockfileDigest: LOCK, workspaceTemplate: "node-template",
        sourceArchiveDigest: SOURCE, sourceArchiveBytes: 2_048, checkpointDigest: ARCHIVE,
        checkpointBytes: 4_096, checkpointManifestDigest: sha256(manifest), checkpointManifest: `${manifest} `,
      });
    });
    expect(await t.query(api.jobs.cloudCheckpointForReplay, args))
      .toMatchObject({ disposition: "reject", reason: "checkpoint_manifest_tampered" });
  });
});
