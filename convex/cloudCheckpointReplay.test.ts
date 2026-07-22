import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { api } from "./_generated/api";
import schema from "./schema";
import { ensureWorkAttempt, patchJobWithRuntime } from "./controlPlane";
import { testMissionAdmission } from "./testSourceAdmission";
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

async function runningFixture(
  t: ReturnType<typeof convexTest>,
  options: { task: string; attempt: number; maxAttempts: number; workerRunId: string },
) {
  const admitted = await testMissionAdmission(t, {
    key: options.task,
    workerToken: WORKER,
  });
  const jobId = await t.mutation(api.jobs.enqueue, {
    task: options.task,
    missionId: String(admitted.missionId),
    projectAdmission: admitted.projectAdmission,
    maxAttempts: options.maxAttempts,
    workerToken: WORKER,
  });
  const authorityDigest = await t.run(async (ctx) => {
    const job = await ctx.db.get(jobId);
    if (!job) throw new Error("checkpoint fixture job missing");
    let currentAuthorityDigest = "";
    for (let attempt = 1; attempt <= options.attempt; attempt += 1) {
      const row = await ensureWorkAttempt(
        ctx,
        job,
        attempt,
        attempt === options.attempt ? "running" : "checkpointed",
        Date.now(),
      );
      await ctx.db.patch(row._id, {
        status: attempt === options.attempt ? "running" : "checkpointed",
        workerRunId: attempt === options.attempt ? options.workerRunId : `run-${attempt}`,
        workspaceBaseSha: BASE,
      });
      if (attempt === options.attempt) currentAuthorityDigest = String(row.authorityDigest);
    }
    await patchJobWithRuntime(ctx, job, {
      status: "running",
      attempt: options.attempt,
      workerRunId: options.workerRunId,
      stage: "executing",
      percent: 60,
      heartbeatAt: Date.now(),
    });
    return currentAuthorityDigest;
  });
  return { jobId, authorityDigest };
}

beforeEach(() => { process.env.JARVIS_WORKER_TOKEN = WORKER; });
afterEach(() => { delete process.env.JARVIS_WORKER_TOKEN; });

describe("durable cloud checkpoint control evidence", () => {
  it("records one canonical bounded manifest idempotently and replays it only through exact bindings", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    const initial = await runningFixture(t, {
      task: "continue exact cloud work", attempt: 1, maxAttempts: 4, workerRunId: "run-1",
    });
    const { jobId } = initial;
    const identity = {
      providerName: "cloudflare" as const,
      providerWorkspaceId: "workspace-1", providerSessionId: "session-1",
      baseSha: BASE, runtime: "node-22", lockfileDigest: LOCK, template: "node-template",
      sourceArchiveDigest: SOURCE, sourceArchiveBytes: 2_048,
    };
    expect(await t.mutation(api.jobs.bindCloudWorkspace, {
      jobId, expectedAttempt: 1, authorityDigest: initial.authorityDigest,
      workerRunId: "run-1", ...identity, workerToken: WORKER,
    })).toBe(true);
    const manifest = canonicalWorkspaceCheckpoint({
      version: 2, jobId: String(jobId), attempt: 1, provider: "cloudflare",
      providerWorkspaceId: identity.providerWorkspaceId, providerSessionId: identity.providerSessionId,
      baseSha: BASE, sourceArchiveSha256: SOURCE, sourceArchiveBytes: 2_048,
      archiveSha256: ARCHIVE, archiveBytes: 4_096, runtime: "node-22", lockfileDigest: LOCK,
      template: "node-template", attemptKey: `${String(jobId)}:1`, causationId: "run-1:1", createdAt: now,
    });
    const record = {
      jobId, expectedAttempt: 1, authorityDigest: initial.authorityDigest,
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

    const secondAuthorityDigest = await t.run(async (ctx) => {
      const job = await ctx.db.get(jobId);
      const first = await ctx.db.query("workAttempts").withIndex("by_job_attempt", (q) => q.eq("jobId", jobId).eq("attempt", 1)).first();
      await ctx.db.patch(first!._id, { status: "checkpointed" });
      const second = await ensureWorkAttempt(ctx, job!, 2, "running", now);
      await ctx.db.patch(second._id, { status: "running", workerRunId: "run-2", workspaceBaseSha: BASE });
      await patchJobWithRuntime(ctx, job!, { attempt: 2, workerRunId: "run-2" });
      return String(second.authorityDigest);
    });
    const replayArgs = {
      jobId, expectedAttempt: 2, authorityDigest: secondAuthorityDigest,
      workerRunId: "run-2", providerName: "cloudflare" as const,
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
    const current = await runningFixture(t, {
      task: "replay newest indexed checkpoint", attempt: 110, maxAttempts: 160, workerRunId: "run-110",
    });
    const { jobId } = current;

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
      const job = await ctx.db.get(jobId);
      for (const attempt of [110, 111, 140]) {
        if (attempt !== 110) {
          const row = await ensureWorkAttempt(ctx, job!, attempt, "checkpointed", now);
          await ctx.db.patch(row._id, {
            status: "checkpointed", workerRunId: `run-${attempt}`, workspaceBaseSha: BASE,
          });
        }
      }
    });
    await installReceipt(111);
    await installReceipt(140);

    const args = {
      jobId, expectedAttempt: 110, authorityDigest: current.authorityDigest,
      workerRunId: "run-110", providerName: "cloudflare" as const,
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
    const current = await runningFixture(t, {
      task: "fail closed checkpoint receipt", attempt: 6, maxAttempts: 8, workerRunId: "run-6",
    });
    const { jobId } = current;
    const args = {
      jobId, expectedAttempt: 6, authorityDigest: current.authorityDigest,
      workerRunId: "run-6", providerName: "cloudflare" as const,
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
