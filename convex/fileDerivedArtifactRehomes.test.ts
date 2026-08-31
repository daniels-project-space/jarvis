import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { api } from "./_generated/api";
import schema from "./schema";

declare global {
  interface ImportMeta {
    glob(pattern: string): Record<string, () => Promise<unknown>>;
  }
}

const modules = import.meta.glob("./**/*.ts");
const REHOME = "file-derived-artifact-rehome-test-token";
const WORKER = "file-derived-artifact-worker-test-token";
// The checked-in Convex API declarations are refreshed by `convex dev` in a
// configured deployment. Keep this isolated schema test independent of that
// local deployment requirement.
const rehomeApi = (api as any).fileDerivedArtifactRehomes;

beforeEach(() => {
  process.env.JARVIS_FILE_REHOME_TOKEN = REHOME;
  process.env.JARVIS_WORKER_TOKEN = WORKER;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-28T12:00:00Z"));
});

afterEach(() => {
  delete process.env.JARVIS_FILE_REHOME_TOKEN;
  delete process.env.JARVIS_WORKER_TOKEN;
  vi.useRealTimers();
});

async function seedReadyV1(t: ReturnType<typeof convexTest>, roles: "text" | "preview" | "both" = "both") {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const fileId = await ctx.db.insert("files", {
      originalName: "legacy.txt",
      relativePath: "legacy.txt",
      mimeType: "text/plain",
      sizeBytes: 24,
      expectedSha256: "a".repeat(64),
      sha256: "a".repeat(64),
      r2Key: "owners/daniel/files/pending/v1/original",
      status: "ready",
      ingestVersion: 1,
      ingestAttempt: 1,
      ingestOutputProtocol: 1,
      searchText: "legacy.txt",
      libraryVisible: true,
      createdAt: now,
      updatedAt: now,
    });
    const prefix = `owners/daniel/files/${fileId}/v1`;
    await ctx.db.patch(fileId, {
      r2Key: `${prefix}/original`,
      extractedTextR2Key: roles === "preview" ? undefined : `${prefix}/extracted.txt`,
      previewR2Key: roles === "text" ? undefined : `${prefix}/preview.webp`,
      updatedAt: now,
    });
    return fileId;
  });
}

async function inventoryToRehoming(t: ReturnType<typeof convexTest>) {
  for (let index = 0; index < 80; index += 1) {
    await t.mutation(rehomeApi.advanceFileDerivedArtifactRehomeCleanupPreflight, { rehomeToken: REHOME, limit: 32 });
    const result = await t.mutation(rehomeApi.advanceFileDerivedArtifactRehomeInventory, { rehomeToken: REHOME, limit: 32 });
    if (result.phase === "rehoming" || result.phase === "blocked") return result;
  }
  throw new Error("rehome inventory did not complete");
}

async function auditToReady(t: ReturnType<typeof convexTest>) {
  for (let index = 0; index < 80; index += 1) {
    const result = await t.mutation(rehomeApi.advanceFileDerivedArtifactRehomeAudit, { rehomeToken: REHOME, limit: 32 });
    if (result.isDone) return;
    if (result.phase === "blocked") throw new Error(`rehome audit blocked: ${String(result.failureCode ?? "unknown")}`);
  }
  throw new Error("rehome audit did not complete");
}

function admissionToken(row: any): string {
  const token = String(row?.claimToken ?? "");
  if (!/^[a-zA-Z0-9_-]{16,160}$/.test(token)) throw new Error("missing server-owned rehome admission token");
  return token;
}

function claimedGeneration(claim: any): number {
  const generation = Number(claim?.targetGeneration);
  if (!Number.isSafeInteger(generation) || generation < 1) throw new Error("missing claimed rehome target generation");
  return generation;
}

describe("file-derived artifact rehome", () => {
  it("freezes, inventories, verifies, atomically repoints, and server-gates V2 readiness", async () => {
    const t = convexTest(schema, modules);
    const fileId = await seedReadyV1(t);
    await expect(t.mutation(rehomeApi.startFileDerivedArtifactRehome, { rehomeToken: REHOME }))
      .resolves.toEqual({ started: true, phase: "frozen" });
    await inventoryToRehoming(t);

    const pending = await t.query(rehomeApi.pendingFileDerivedArtifactRehomes, { rehomeToken: REHOME });
    expect(pending).toHaveLength(1);
    const claimToken = admissionToken(pending[0]);
    const claim = await t.mutation(rehomeApi.claimFileDerivedArtifactRehome, {
      rehomeId: pending[0].rehomeId as any,
      claimToken,
      rehomeToken: REHOME,
    });
    expect(claim).toMatchObject({ claimed: true, fileId: String(fileId) });
    const targetGeneration = claimedGeneration(claim);
    await expect(t.mutation(rehomeApi.beginFileDerivedArtifactRehomeWrite, {
      rehomeId: pending[0].rehomeId as any,
      claimToken,
      targetGeneration,
      purpose: "extracted.txt",
      rehomeToken: REHOME,
    })).resolves.toBe(true);
    await expect(t.mutation(rehomeApi.beginFileDerivedArtifactRehomeWrite, {
      rehomeId: pending[0].rehomeId as any,
      claimToken,
      targetGeneration,
      purpose: "preview.webp",
      rehomeToken: REHOME,
    })).resolves.toBe(true);
    const digest = "b".repeat(64);
    await expect(t.mutation(rehomeApi.recordFileDerivedArtifactRehomeReadback, {
      rehomeId: pending[0].rehomeId as any,
      claimToken,
      targetGeneration,
      sourceExtractedTextSha256: digest,
      targetExtractedTextSha256: digest,
      sourceExtractedTextBytes: 12,
      targetExtractedTextBytes: 12,
      sourcePreviewSha256: digest,
      targetPreviewSha256: digest,
      sourcePreviewBytes: 8,
      targetPreviewBytes: 8,
      rehomeToken: REHOME,
    })).resolves.toEqual({ verified: true });
    await expect(t.mutation(rehomeApi.commitFileDerivedArtifactRehome, {
      rehomeId: pending[0].rehomeId as any,
      targetGeneration,
      rehomeToken: REHOME,
    })).resolves.toEqual({ committed: true });
    const file = await t.run(async (ctx) => await ctx.db.get(fileId));
    expect(file).toMatchObject({
      ingestOutputProtocol: 2,
      ingestOutputAttemptId: claim.targetOutputAttemptId,
      extractedTextR2Key: claim.targetExtractedTextR2Key,
      previewR2Key: claim.targetPreviewR2Key,
    });
    expect(file?.derivedArtifactRehomeId).toBeUndefined();
    const receipt = await t.query(rehomeApi.fileDerivedArtifactRehomeReceipt, {
      rehomeId: pending[0].rehomeId as any,
      rehomeToken: REHOME,
    });
    expect(receipt).toMatchObject({ committed: true, state: "cutover" });
    await auditToReady(t);
    await expect(t.mutation(rehomeApi.finalizeFileDerivedArtifactRehome, { rehomeToken: REHOME }))
      .resolves.toEqual({ ready: true });
    await expect(t.mutation(api.files.activateIngestOutputProtocolV2, { rehomeToken: REHOME }))
      .resolves.toMatchObject({ activated: true, protocolVersion: 2 });
  });

  it("does not let a generic worker or a caller boolean activate V2 before the server-owned rehome proof", async () => {
    const t = convexTest(schema, modules);
    await seedReadyV1(t, "text");
    await expect(t.mutation(api.files.activateIngestOutputProtocolV2, {
      legacyTriggerDrained: true,
    } as any)).rejects.toThrow(/Unexpected field `legacyTriggerDrained`/);
    await expect(t.mutation(api.files.activateIngestOutputProtocolV2, {
      rehomeToken: "some-generic-worker-token",
    })).rejects.toThrow(/Unauthorized file-derived-artifact rehome capability/);
    await t.mutation(rehomeApi.startFileDerivedArtifactRehome, { rehomeToken: REHOME });
    await inventoryToRehoming(t);
    await expect(t.mutation(api.files.activateIngestOutputProtocolV2, { rehomeToken: REHOME }))
      .rejects.toThrow(/rehome is not ready/i);
  });

  it("detaches deleted V1 pointers into a permanent sweeper before server activation", async () => {
    const t = convexTest(schema, modules);
    const fileId = await seedReadyV1(t);
    await t.run(async (ctx) => await ctx.db.patch(fileId, {
      status: "deleted",
      libraryVisible: false,
      updatedAt: Date.now(),
    }));
    await t.mutation(rehomeApi.startFileDerivedArtifactRehome, { rehomeToken: REHOME });
    await inventoryToRehoming(t);
    const [file, attempts] = await t.run(async (ctx) => [
      await ctx.db.get(fileId),
      await ctx.db.query("fileIngestOutputAttempts")
        .withIndex("by_file_version", (q) => q.eq("fileId", fileId).eq("ingestVersion", 1))
        .collect(),
    ]);
    expect(file).toMatchObject({ status: "deleted", ingestOutputProtocol: 2 });
    expect(file?.extractedTextR2Key).toBeUndefined();
    expect(file?.previewR2Key).toBeUndefined();
    expect(attempts).toEqual(expect.arrayContaining([
      expect.objectContaining({ outputProtocol: 1, state: "legacy_sweeping" }),
    ]));
    await auditToReady(t);
    await expect(t.mutation(rehomeApi.finalizeFileDerivedArtifactRehome, { rehomeToken: REHOME }))
      .resolves.toEqual({ ready: true });
    await expect(t.mutation(api.files.activateIngestOutputProtocolV2, { rehomeToken: REHOME }))
      .resolves.toMatchObject({ activated: true, protocolVersion: 2 });
  });

  it("fails closed on an unknown historical file status instead of skipping its V1 pointer", async () => {
    const t = convexTest(schema, modules);
    const fileId = await seedReadyV1(t);
    await t.run(async (ctx) => await ctx.db.patch(fileId, { status: "historical_terminal", updatedAt: Date.now() }));
    await t.mutation(rehomeApi.startFileDerivedArtifactRehome, { rehomeToken: REHOME });
    await inventoryToRehoming(t);
    const [manifest] = await t.run(async (ctx) => await ctx.db
      .query("fileDerivedArtifactRehomes")
      .withIndex("by_file", (q) => q.eq("fileId", fileId))
      .collect());
    expect(manifest).toMatchObject({ state: "blocked", failureCode: "source_status_unknown" });
    await expect(t.mutation(api.files.activateIngestOutputProtocolV2, { rehomeToken: REHOME }))
      .rejects.toThrow(/rehome is not ready/i);
  });

  it("fails the server audit when a V2-labelled terminal row still points at a canonical V1 key", async () => {
    const t = convexTest(schema, modules);
    const fileId = await seedReadyV1(t, "text");
    await t.run(async (ctx) => await ctx.db.patch(fileId, {
      ingestOutputProtocol: 2,
      ingestOutputAttemptId: "rehome-audit-corrupt-attempt-123e4567-e89b-12d3-a456-426614174000",
      updatedAt: Date.now(),
    }));
    await t.mutation(rehomeApi.startFileDerivedArtifactRehome, { rehomeToken: REHOME });
    await inventoryToRehoming(t);
    await expect(t.mutation(rehomeApi.advanceFileDerivedArtifactRehomeAudit, { rehomeToken: REHOME }))
      .resolves.toMatchObject({
        phase: "blocked",
        status: "blocked",
        failureCode: "terminal_v1_pointer_remaining",
        fileId: String(fileId),
      });
    await expect(t.mutation(api.files.activateIngestOutputProtocolV2, { rehomeToken: REHOME }))
      .rejects.toThrow(/rehome is not ready/i);
  });

  it("pages more than 500 historical deleted rows through the activation audit", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const now = Date.now();
      for (let index = 0; index < 501; index += 1) {
        await ctx.db.insert("files", {
          originalName: `deleted-${index}.txt`,
          relativePath: `deleted-${index}.txt`,
          mimeType: "text/plain",
          sizeBytes: 1,
          expectedSha256: "a".repeat(64),
          sha256: "a".repeat(64),
          r2Key: `owners/daniel/files/deleted-${index}/v1/original`,
          status: "deleted",
          ingestVersion: 1,
          ingestAttempt: 1,
          ingestOutputProtocol: 2,
          searchText: `deleted-${index}.txt`,
          libraryVisible: false,
          createdAt: now,
          updatedAt: now,
        });
      }
    });
    await t.mutation(rehomeApi.startFileDerivedArtifactRehome, { rehomeToken: REHOME });
    await inventoryToRehoming(t);
    await auditToReady(t);
    await expect(t.mutation(rehomeApi.finalizeFileDerivedArtifactRehome, { rehomeToken: REHOME }))
      .resolves.toEqual({ ready: true });
  });

  it("moves a cutover manifest back to blocked with balanced counts and can reopen it for a fresh audit", async () => {
    const t = convexTest(schema, modules);
    const fileId = await seedReadyV1(t, "text");
    await t.mutation(rehomeApi.startFileDerivedArtifactRehome, { rehomeToken: REHOME });
    await inventoryToRehoming(t);
    const { rehomeId } = await t.run(async (ctx) => {
      const [control] = await ctx.db.query("fileDerivedArtifactRehomeControls").collect();
      const [rehome] = await ctx.db.query("fileDerivedArtifactRehomes").collect();
      const now = Date.now();
      await ctx.db.patch(rehome!._id, { state: "cutover", updatedAt: now });
      await ctx.db.patch(fileId, {
        ingestOutputProtocol: 2,
        ingestOutputAttemptId: "rehome-audit-balance-corrupt-123e4567-e89b-12d3-a456-426614174000",
        updatedAt: now,
      });
      await ctx.db.patch(control!._id, {
        phase: "rehoming",
        cleanupPreflightStatus: "complete",
        inventoryStatus: "complete",
        snapshotCount: 1,
        cutoverCount: 1,
        blockedCount: 0,
        auditStatus: "pending",
        auditCursor: undefined,
        auditScannedCount: 0,
        updatedAt: now,
      });
      return { rehomeId: rehome!._id };
    });
    await expect(t.mutation(rehomeApi.advanceFileDerivedArtifactRehomeAudit, { rehomeToken: REHOME }))
      .resolves.toMatchObject({ phase: "blocked", failureCode: "terminal_v1_pointer_remaining" });
    const blocked = await t.run(async (ctx) => {
      const control = (await ctx.db.query("fileDerivedArtifactRehomeControls").collect())[0];
      const rehome = await ctx.db.get(rehomeId);
      return { control, rehome };
    });
    expect(blocked.control).toMatchObject({ cutoverCount: 0, blockedCount: 1, auditStatus: "blocked" });
    expect(blocked.rehome).toMatchObject({ state: "blocked", failureCode: "terminal_v1_pointer_remaining" });
    await t.run(async (ctx) => await ctx.db.patch(fileId, {
      ingestOutputProtocol: 1,
      ingestOutputAttemptId: undefined,
      updatedAt: Date.now(),
    }));
    await expect(t.mutation(rehomeApi.reopenFileDerivedArtifactRehome, { rehomeId, rehomeToken: REHOME }))
      .resolves.toEqual({ reopened: true, cutover: false });
    const reopened = await t.run(async (ctx) => (await ctx.db.query("fileDerivedArtifactRehomeControls").collect())[0]);
    expect(reopened).toMatchObject({ phase: "rehoming", cutoverCount: 0, blockedCount: 0, auditStatus: "pending" });
  });

  it("refuses to freeze after a V1 cleanup has already claimed shared delete keys", async () => {
    const t = convexTest(schema, modules);
    const fileId = await seedReadyV1(t);
    await t.run(async (ctx) => await ctx.db.patch(fileId, { status: "error", updatedAt: Date.now() }));
    await t.run(async (ctx) => {
      const now = Date.now();
      return await ctx.db.insert("fileIngestOutputAttempts", {
        fileId,
        ingestVersion: 1,
        outputProtocol: 1,
        outputAttemptId: "legacy-preclaim-delete-123e4567-e89b-12d3-a456-426614174000",
        claimToken: "legacy-preclaim-delete-token",
        extractedTextR2Key: `owners/daniel/files/${fileId}/v1/extracted.txt`,
        previewR2Key: `owners/daniel/files/${fileId}/v1/preview.webp`,
        producerMayWriteUntil: now,
        // Represents a pre-compat cleanup worker that already received the
        // shared delete keys before this migration control existed.
        state: "deleting",
        writerHandoff: false,
        writeStarted: true,
        cleanupExtractedText: true,
        cleanupPreview: true,
        cleanupClaimToken: "preclaim-delete-claim-123e4567-e89b-12d3-a456-426614174000",
        cleanupClaimExpiresAt: now + 60_000,
        nextCleanupAt: now,
        sweepCount: 0,
        createdAt: now,
        updatedAt: now,
      });
    });
    await expect(t.mutation(rehomeApi.startFileDerivedArtifactRehome, { rehomeToken: REHOME }))
      .resolves.toEqual({ started: true, phase: "frozen" });
    await expect(t.mutation(rehomeApi.advanceFileDerivedArtifactRehomeCleanupPreflight, { rehomeToken: REHOME }))
      .resolves.toMatchObject({ phase: "blocked", status: "blocked", failureCode: "v1_cleanup_history_may_delete_source", fileId: String(fileId) });
    const controls = await t.run(async (ctx) => await ctx.db.query("fileDerivedArtifactRehomeControls").collect());
    expect(controls).toEqual([expect.objectContaining({ phase: "blocked", cleanupPreflightStatus: "blocked" })]);
  });

  it("preserves a current error-state V1 pointer, while a known historical cleaner still blocks rehome", async () => {
    const t = convexTest(schema, modules);
    const fileId = await seedReadyV1(t);
    await t.run(async (ctx) => await ctx.db.patch(fileId, { status: "error", updatedAt: Date.now() }));
    const cleanup = await t.mutation(api.files.enqueueIngestDerivedCleanup, {
      fileId,
      ingestVersion: 1,
      claimToken: "legacy-cleanup-history-123e4567-e89b-12d3-a456-426614174000",
      extractedTextR2Key: `owners/daniel/files/${fileId}/v1/extracted.txt`,
      previewR2Key: `owners/daniel/files/${fileId}/v1/preview.webp`,
      workerToken: WORKER,
    });
    if (!cleanup.outboxId) throw new Error("missing legacy cleanup outbox");
    const cleanupClaimToken = "legacy-cleanup-worker-123e4567-e89b-12d3-a456-426614174000";
    await expect(t.mutation(api.files.claimIngestDerivedCleanup, {
      outboxId: cleanup.outboxId,
      cleanupClaimToken,
      workerToken: WORKER,
    })).resolves.toEqual({ ready: false, committed: true });
    const marker = await t.run(async (ctx) => {
      const now = Date.now();
      return await ctx.db.insert("fileIngestOutputAttempts", {
        fileId,
        ingestVersion: 1,
        outputProtocol: 1,
        outputAttemptId: "legacy-finished-cleanup-history-123e4567-e89b-12d3-a456-426614174000",
        claimToken: "legacy-finished-cleanup-history-token",
        extractedTextR2Key: `owners/daniel/files/${fileId}/v1/extracted.txt`,
        previewR2Key: `owners/daniel/files/${fileId}/v1/preview.webp`,
        producerMayWriteUntil: now,
        state: "legacy_sweeping",
        writerHandoff: false,
        writeStarted: true,
        cleanupExtractedText: true,
        cleanupPreview: true,
        nextCleanupAt: now,
        sweepCount: 1,
        createdAt: now,
        updatedAt: now,
      });
    });
    const file = await t.run(async (ctx) => await ctx.db.get(fileId));
    expect(file?.extractedTextR2Key).toBe(`owners/daniel/files/${fileId}/v1/extracted.txt`);
    await t.mutation(rehomeApi.startFileDerivedArtifactRehome, { rehomeToken: REHOME });
    await expect(t.mutation(rehomeApi.advanceFileDerivedArtifactRehomeCleanupPreflight, { rehomeToken: REHOME }))
      .resolves.toMatchObject({ phase: "blocked", status: "blocked", failureCode: "v1_cleanup_history_may_delete_source", fileId: String(fileId), outputAttemptId: String(marker) });
  });

  it("refuses a new rehome control after V2 is already active", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("workerProtocolRollouts", {
        key: "file-ingest-output-protocol-v2",
        protocolVersion: 2,
        activatedAt: now,
        updatedAt: now,
      });
    });
    await expect(t.mutation(rehomeApi.startFileDerivedArtifactRehome, { rehomeToken: REHOME }))
      .resolves.toEqual({ started: false, reason: "v2_already_active" });
  });

  it("returns a verified manifest to the controller so a replacement worker can finish its CAS", async () => {
    const t = convexTest(schema, modules);
    await seedReadyV1(t, "text");
    await t.mutation(rehomeApi.startFileDerivedArtifactRehome, { rehomeToken: REHOME });
    await inventoryToRehoming(t);
    const [pending] = await t.query(rehomeApi.pendingFileDerivedArtifactRehomes, { rehomeToken: REHOME });
    const rehomeId = pending.rehomeId as any;
    const claimToken = admissionToken(pending);
    const claim = await t.mutation(rehomeApi.claimFileDerivedArtifactRehome, { rehomeId, claimToken, rehomeToken: REHOME });
    const targetGeneration = claimedGeneration(claim);
    await t.mutation(rehomeApi.beginFileDerivedArtifactRehomeWrite, {
      rehomeId,
      claimToken,
      targetGeneration,
      purpose: "extracted.txt",
      rehomeToken: REHOME,
    });
    const digest = "e".repeat(64);
    await t.mutation(rehomeApi.recordFileDerivedArtifactRehomeReadback, {
      rehomeId,
      claimToken,
      targetGeneration,
      sourceExtractedTextSha256: digest,
      targetExtractedTextSha256: digest,
      sourceExtractedTextBytes: 2,
      targetExtractedTextBytes: 2,
      rehomeToken: REHOME,
    });
    await expect(t.query(rehomeApi.pendingFileDerivedArtifactRehomes, { rehomeToken: REHOME }))
      .resolves.toEqual(expect.arrayContaining([expect.objectContaining({ rehomeId: String(rehomeId) })]));
  });

  it("only reopens a blocked manifest through the dedicated capability and re-snapshots it for proof", async () => {
    const t = convexTest(schema, modules);
    await seedReadyV1(t, "text");
    await t.mutation(rehomeApi.startFileDerivedArtifactRehome, { rehomeToken: REHOME });
    await inventoryToRehoming(t);
    const [pending] = await t.query(rehomeApi.pendingFileDerivedArtifactRehomes, { rehomeToken: REHOME });
    const rehomeId = pending.rehomeId as any;
    const claimToken = admissionToken(pending);
    const claim = await t.mutation(rehomeApi.claimFileDerivedArtifactRehome, { rehomeId, claimToken, rehomeToken: REHOME });
    const targetGeneration = claimedGeneration(claim);
    await t.mutation(rehomeApi.blockFileDerivedArtifactRehome, {
      rehomeId,
      claimToken,
      targetGeneration,
      failureCode: "source_missing",
      rehomeToken: REHOME,
    });
    await expect(t.mutation(rehomeApi.reopenFileDerivedArtifactRehome, {
      rehomeId,
      rehomeToken: "generic-worker-token",
    })).rejects.toThrow(/Unauthorized file-derived-artifact rehome capability/);
    await expect(t.mutation(rehomeApi.reopenFileDerivedArtifactRehome, { rehomeId, rehomeToken: REHOME }))
      .resolves.toEqual({ reopened: true, cutover: false });
    await expect(t.query(rehomeApi.pendingFileDerivedArtifactRehomes, { rehomeToken: REHOME }))
      .resolves.toEqual(expect.arrayContaining([expect.objectContaining({ rehomeId: String(rehomeId) })]));
  });

  it("keeps the old shared pair as a permanent source sweeper, while a migration lock rejects normal deletion", async () => {
    const t = convexTest(schema, modules);
    const fileId = await seedReadyV1(t);
    await t.mutation(rehomeApi.startFileDerivedArtifactRehome, { rehomeToken: REHOME });
    await inventoryToRehoming(t);
    await expect(t.mutation(api.files.beginDelete, { fileId, workerToken: WORKER } as any))
      .rejects.toThrow(/Private-file changes are temporarily frozen/);
    const pending = await t.query(rehomeApi.pendingFileDerivedArtifactRehomes, { rehomeToken: REHOME });
    const claimToken = admissionToken(pending[0]);
    const rehomeId = pending[0].rehomeId as any;
    const claim = await t.mutation(rehomeApi.claimFileDerivedArtifactRehome, { rehomeId, claimToken, rehomeToken: REHOME });
    const targetGeneration = claimedGeneration(claim);
    for (const purpose of ["extracted.txt", "preview.webp"] as const) {
      await t.mutation(rehomeApi.beginFileDerivedArtifactRehomeWrite, { rehomeId, claimToken, targetGeneration, purpose, rehomeToken: REHOME });
    }
    const digest = "c".repeat(64);
    await t.mutation(rehomeApi.recordFileDerivedArtifactRehomeReadback, {
      rehomeId,
      claimToken,
      targetGeneration,
      sourceExtractedTextSha256: digest,
      targetExtractedTextSha256: digest,
      sourceExtractedTextBytes: 1,
      targetExtractedTextBytes: 1,
      sourcePreviewSha256: digest,
      targetPreviewSha256: digest,
      sourcePreviewBytes: 1,
      targetPreviewBytes: 1,
      rehomeToken: REHOME,
    });
    await t.mutation(rehomeApi.commitFileDerivedArtifactRehome, { rehomeId, targetGeneration, rehomeToken: REHOME });
    const [file, attempts] = await t.run(async (ctx) => [
      await ctx.db.get(fileId),
      await ctx.db.query("fileIngestOutputAttempts")
        .withIndex("by_file_version", (q) => q.eq("fileId", fileId).eq("ingestVersion", 1))
        .collect(),
    ]);
    expect(file?.extractedTextR2Key).toBe(claim.targetExtractedTextR2Key);
    expect(file?.previewR2Key).toBe(claim.targetPreviewR2Key);
    expect(file?.extractedTextR2Key).not.toContain("/v1/extracted.txt");
    expect(attempts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        outputProtocol: 1,
        state: "legacy_sweeping",
        extractedTextR2Key: `owners/daniel/files/${fileId}/v1/extracted.txt`,
        previewR2Key: `owners/daniel/files/${fileId}/v1/preview.webp`,
      }),
    ]));
    const sweeper = attempts.find((attempt) => attempt.outputProtocol === 1);
    expect(sweeper).toBeTruthy();
    // Simulate a cleanup pass which might be followed by a late accepted V1
    // PUT. `finish` must preserve the exact source pair as a nonterminal
    // reaper instead of consuming its receipt after the first delete.
    const cleanup = await t.mutation(api.files.claimIngestOutputCleanup, {
      outputAttemptId: sweeper!._id,
      cleanupClaimToken: "legacy-source-sweep-cleanup-123e4567-e89b-12d3-a456-426614174000",
      workerToken: WORKER,
    });
    expect(cleanup).toMatchObject({
      ready: true,
      r2Keys: expect.arrayContaining([
        `owners/daniel/files/${fileId}/v1/extracted.txt`,
        `owners/daniel/files/${fileId}/v1/preview.webp`,
      ]),
    });
    await expect(t.mutation(api.files.finishIngestOutputCleanup, {
      outputAttemptId: sweeper!._id,
      cleanupClaimToken: "legacy-source-sweep-cleanup-123e4567-e89b-12d3-a456-426614174000",
      workerToken: WORKER,
    })).resolves.toBe(true);
    const retainedSweeper = await t.run(async (ctx) => await ctx.db.get(sweeper!._id));
    expect(retainedSweeper).toMatchObject({ outputProtocol: 1, state: "legacy_sweeping", sweepCount: 1 });
  });

  it("promotes a pre-CAS preview-only bridge to a full source sweeper after a text-only V1 rehome", async () => {
    const t = convexTest(schema, modules);
    const fileId = await seedReadyV1(t, "text");
    const markerId = await t.run(async (ctx) => {
      const now = Date.now();
      return await ctx.db.insert("fileIngestOutputAttempts", {
        fileId,
        ingestVersion: 1,
        outputProtocol: 1,
        outputAttemptId: "legacy-preview-bridge-before-cas-123e4567-e89b-12d3-a456-426614174000",
        claimToken: "legacy-preview-bridge-before-cas",
        extractedTextR2Key: `owners/daniel/files/${fileId}/v1/extracted.txt`,
        previewR2Key: `owners/daniel/files/${fileId}/v1/preview.webp`,
        producerMayWriteUntil: now,
        state: "legacy_sweeping",
        writerHandoff: false,
        writeStarted: true,
        cleanupExtractedText: false,
        cleanupPreview: true,
        nextCleanupAt: now,
        sweepCount: 0,
        createdAt: now,
        updatedAt: now,
      });
    });
    await t.mutation(rehomeApi.startFileDerivedArtifactRehome, { rehomeToken: REHOME });
    await inventoryToRehoming(t);
    const [pending] = await t.query(rehomeApi.pendingFileDerivedArtifactRehomes, { rehomeToken: REHOME });
    const claimToken = admissionToken(pending);
    const claim = await t.mutation(rehomeApi.claimFileDerivedArtifactRehome, {
      rehomeId: pending.rehomeId as any,
      claimToken,
      rehomeToken: REHOME,
    });
    const targetGeneration = claimedGeneration(claim);
    await t.mutation(rehomeApi.beginFileDerivedArtifactRehomeWrite, {
      rehomeId: pending.rehomeId as any,
      claimToken,
      targetGeneration,
      purpose: "extracted.txt",
      rehomeToken: REHOME,
    });
    const digest = "d".repeat(64);
    await t.mutation(rehomeApi.recordFileDerivedArtifactRehomeReadback, {
      rehomeId: pending.rehomeId as any,
      claimToken,
      targetGeneration,
      sourceExtractedTextSha256: digest,
      targetExtractedTextSha256: digest,
      sourceExtractedTextBytes: 12,
      targetExtractedTextBytes: 12,
      rehomeToken: REHOME,
    });
    await expect(t.mutation(rehomeApi.commitFileDerivedArtifactRehome, {
      rehomeId: pending.rehomeId as any,
      targetGeneration,
      rehomeToken: REHOME,
    })).resolves.toEqual({ committed: true });
    const marker = await t.run(async (ctx) => await ctx.db.get(markerId));
    expect(marker).toMatchObject({
      state: "legacy_sweeping",
      cleanupExtractedText: true,
      cleanupPreview: true,
    });
    const cleanup = await t.mutation(api.files.claimIngestOutputCleanup, {
      outputAttemptId: markerId,
      cleanupClaimToken: "legacy-full-sweeper-after-cas-123e4567-e89b-12d3-a456-426614174000",
      workerToken: WORKER,
    });
    expect(cleanup).toEqual(expect.objectContaining({
      ready: true,
      r2Keys: expect.arrayContaining([
        `owners/daniel/files/${fileId}/v1/extracted.txt`,
        `owners/daniel/files/${fileId}/v1/preview.webp`,
      ]),
    }));
  });

  it("refuses to freeze when a due V1 sweeping history still intersects its source", async () => {
    const t = convexTest(schema, modules);
    const fileId = await seedReadyV1(t);
    const sourceKeys = {
      extractedTextR2Key: `owners/daniel/files/${fileId}/v1/extracted.txt`,
      previewR2Key: `owners/daniel/files/${fileId}/v1/preview.webp`,
    };
    const outputAttemptId = await t.run(async (ctx) => {
      const now = Date.now();
      return await ctx.db.insert("fileIngestOutputAttempts", {
        fileId,
        ingestVersion: 1,
        outputProtocol: 1,
        outputAttemptId: "legacy-preinventory-cleanup-123e4567-e89b-12d3-a456-426614174000",
        claimToken: "legacy-preinventory-cleanup-token",
        ...sourceKeys,
        producerMayWriteUntil: now,
        state: "legacy_sweeping",
        writerHandoff: false,
        writeStarted: true,
        nextCleanupAt: now,
        sweepCount: 0,
        createdAt: now,
        updatedAt: now,
      });
    });
    await t.mutation(rehomeApi.startFileDerivedArtifactRehome, { rehomeToken: REHOME });
    await expect(t.mutation(rehomeApi.advanceFileDerivedArtifactRehomeCleanupPreflight, { rehomeToken: REHOME }))
      .resolves.toMatchObject({ phase: "blocked", status: "blocked", failureCode: "v1_cleanup_history_may_delete_source", fileId: String(fileId) });
    const retained = await t.run(async (ctx) => await ctx.db.get(outputAttemptId));
    expect(retained).toMatchObject({ state: "legacy_sweeping", ...sourceKeys });
  });

  it("does not let a preview-only V1 cleanup bridge block migration of an independent live text pointer", async () => {
    const t = convexTest(schema, modules);
    const fileId = await seedReadyV1(t, "text");
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("fileIngestOutputAttempts", {
        fileId,
        ingestVersion: 1,
        outputProtocol: 1,
        outputAttemptId: "legacy-preview-only-cleanup-123e4567-e89b-12d3-a456-426614174000",
        claimToken: "legacy-preview-only-cleanup-token",
        extractedTextR2Key: `owners/daniel/files/${fileId}/v1/extracted.txt`,
        previewR2Key: `owners/daniel/files/${fileId}/v1/preview.webp`,
        producerMayWriteUntil: now,
        state: "legacy_sweeping",
        writerHandoff: false,
        writeStarted: true,
        cleanupExtractedText: false,
        cleanupPreview: true,
        nextCleanupAt: now,
        sweepCount: 0,
        createdAt: now,
        updatedAt: now,
      });
    });
    await t.mutation(rehomeApi.startFileDerivedArtifactRehome, { rehomeToken: REHOME });
    await expect(t.mutation(rehomeApi.advanceFileDerivedArtifactRehomeCleanupPreflight, { rehomeToken: REHOME }))
      .resolves.toMatchObject({ phase: "frozen", status: "complete", isDone: true });
    await inventoryToRehoming(t);
    const pending = await t.query(rehomeApi.pendingFileDerivedArtifactRehomes, { rehomeToken: REHOME });
    expect(pending).toHaveLength(1);
  });

  it("requires an explicit provider-fence acknowledgement before resuming a cleanup-history block", async () => {
    const t = convexTest(schema, modules);
    const fileId = await seedReadyV1(t);
    const outputAttemptId = await t.run(async (ctx) => {
      const now = Date.now();
      return await ctx.db.insert("fileIngestOutputAttempts", {
        fileId,
        ingestVersion: 1,
        outputProtocol: 1,
        outputAttemptId: "legacy-acknowledgement-cleanup-123e4567-e89b-12d3-a456-426614174000",
        claimToken: "legacy-acknowledgement-cleanup-token",
        extractedTextR2Key: `owners/daniel/files/${fileId}/v1/extracted.txt`,
        previewR2Key: `owners/daniel/files/${fileId}/v1/preview.webp`,
        producerMayWriteUntil: now,
        state: "legacy_sweeping",
        writerHandoff: false,
        writeStarted: true,
        cleanupExtractedText: true,
        cleanupPreview: true,
        nextCleanupAt: now,
        sweepCount: 0,
        createdAt: now,
        updatedAt: now,
      });
    });
    await t.mutation(rehomeApi.startFileDerivedArtifactRehome, { rehomeToken: REHOME });
    await expect(t.mutation(rehomeApi.advanceFileDerivedArtifactRehomeCleanupPreflight, { rehomeToken: REHOME }))
      .resolves.toMatchObject({ phase: "blocked", status: "blocked", outputAttemptId: String(outputAttemptId) });
    const [blocked] = await t.run(async (ctx) => await ctx.db.query("fileDerivedArtifactRehomes").collect());
    await expect(t.mutation(rehomeApi.reopenFileDerivedArtifactRehome, {
      rehomeId: blocked!._id,
      rehomeToken: REHOME,
    })).resolves.toEqual({ reopened: false, reason: "cleanup_history_requires_acknowledgement" });
    await expect(t.mutation(rehomeApi.acknowledgeFileDerivedArtifactRehomeCleanupHistory, {
      rehomeId: blocked!._id,
      outputAttemptId,
      rehomeToken: REHOME,
    })).resolves.toEqual({ resumed: true, phase: "frozen" });
    const marker = await t.run(async (ctx) => await ctx.db.get(outputAttemptId));
    expect(marker).toMatchObject({ cleanupHistoryAcknowledgedRehomeId: blocked!._id });
    await expect(t.mutation(rehomeApi.advanceFileDerivedArtifactRehomeCleanupPreflight, { rehomeToken: REHOME }))
      .resolves.toMatchObject({ phase: "frozen", status: "complete", isDone: true });
    await inventoryToRehoming(t);
    const pending = await t.query(rehomeApi.pendingFileDerivedArtifactRehomes, { rehomeToken: REHOME });
    expect(pending).toHaveLength(1);
  });

  it("blocks the migration on an atomic-CAS source conflict and leaves V1 pointers untouched", async () => {
    const t = convexTest(schema, modules);
    const fileId = await seedReadyV1(t, "text");
    await t.mutation(rehomeApi.startFileDerivedArtifactRehome, { rehomeToken: REHOME });
    await inventoryToRehoming(t);
    const [pending] = await t.query(rehomeApi.pendingFileDerivedArtifactRehomes, { rehomeToken: REHOME });
    const rehomeId = pending.rehomeId as any;
    const claimToken = admissionToken(pending);
    const claim = await t.mutation(rehomeApi.claimFileDerivedArtifactRehome, { rehomeId, claimToken, rehomeToken: REHOME });
    const targetGeneration = claimedGeneration(claim);
    await t.mutation(rehomeApi.beginFileDerivedArtifactRehomeWrite, {
      rehomeId,
      claimToken,
      targetGeneration,
      purpose: "extracted.txt",
      rehomeToken: REHOME,
    });
    const digest = "d".repeat(64);
    await t.mutation(rehomeApi.recordFileDerivedArtifactRehomeReadback, {
      rehomeId,
      claimToken,
      targetGeneration,
      sourceExtractedTextSha256: digest,
      targetExtractedTextSha256: digest,
      sourceExtractedTextBytes: 3,
      targetExtractedTextBytes: 3,
      rehomeToken: REHOME,
    });
    await t.run(async (ctx) => await ctx.db.patch(fileId, { updatedAt: Date.now() + 1 }));
    await expect(t.mutation(rehomeApi.commitFileDerivedArtifactRehome, { rehomeId, targetGeneration, rehomeToken: REHOME }))
      .resolves.toEqual({ committed: false, reason: "source_tuple_changed" });
    const [file, receipt] = await Promise.all([
      t.run(async (ctx) => await ctx.db.get(fileId)),
      t.query(rehomeApi.fileDerivedArtifactRehomeReceipt, { rehomeId, rehomeToken: REHOME }),
    ]);
    expect(file?.extractedTextR2Key).toBe(`owners/daniel/files/${fileId}/v1/extracted.txt`);
    expect(receipt).toMatchObject({ state: "blocked", committed: false, failureCode: "source_tuple_changed" });
  });

  it("never reuses a prewrite-started target when the same Trigger task retries under a live lease", async () => {
    const t = convexTest(schema, modules);
    await seedReadyV1(t, "text");
    await t.mutation(rehomeApi.startFileDerivedArtifactRehome, { rehomeToken: REHOME });
    await inventoryToRehoming(t);
    const [pending] = await t.query(rehomeApi.pendingFileDerivedArtifactRehomes, { rehomeToken: REHOME });
    const rehomeId = pending.rehomeId as any;
    const firstToken = admissionToken(pending);
    const first = await t.mutation(rehomeApi.claimFileDerivedArtifactRehome, {
      rehomeId,
      claimToken: firstToken,
      rehomeToken: REHOME,
    });
    await t.mutation(rehomeApi.beginFileDerivedArtifactRehomeWrite, {
      rehomeId,
      claimToken: firstToken,
      targetGeneration: claimedGeneration(first),
      purpose: "extracted.txt",
      rehomeToken: REHOME,
    });
    // Trigger may retry the same payload before its 10 minute logical lease
    // expires. It must retire/requeue instead of reusing the prewritten key.
    await expect(t.mutation(rehomeApi.claimFileDerivedArtifactRehome, {
      rehomeId,
      claimToken: firstToken,
      rehomeToken: REHOME,
    })).resolves.toEqual({ claimed: false, requeued: true });
    const [secondPending] = await t.query(rehomeApi.pendingFileDerivedArtifactRehomes, { rehomeToken: REHOME });
    const secondToken = admissionToken(secondPending);
    expect(secondToken).not.toBe(firstToken);
    const second = await t.mutation(rehomeApi.claimFileDerivedArtifactRehome, {
      rehomeId,
      claimToken: secondToken,
      rehomeToken: REHOME,
    });
    expect(second).toMatchObject({ claimed: true });
    expect(claimedGeneration(second)).toBe(claimedGeneration(first) + 1);
    expect(second.targetOutputAttemptId).not.toBe(first.targetOutputAttemptId);
    expect(second.targetExtractedTextR2Key).not.toBe(first.targetExtractedTextR2Key);
    await expect(t.mutation(rehomeApi.beginFileDerivedArtifactRehomeWrite, {
      rehomeId,
      claimToken: firstToken,
      targetGeneration: claimedGeneration(first),
      purpose: "extracted.txt",
      rehomeToken: REHOME,
    })).resolves.toBe(false);
    const oldAttempt = await t.run(async (ctx) => await ctx.db.get(first.targetOutputAttemptOutboxId as any));
    expect(oldAttempt).toMatchObject({ state: "cleanup", writerHandoff: true, writeStarted: true });
  });

  it("does not reissue an unprewritten target to a duplicate live Trigger execution", async () => {
    const t = convexTest(schema, modules);
    await seedReadyV1(t, "text");
    await t.mutation(rehomeApi.startFileDerivedArtifactRehome, { rehomeToken: REHOME });
    await inventoryToRehoming(t);
    const [pending] = await t.query(rehomeApi.pendingFileDerivedArtifactRehomes, { rehomeToken: REHOME });
    const rehomeId = pending.rehomeId as any;
    const firstToken = admissionToken(pending);
    const first = await t.mutation(rehomeApi.claimFileDerivedArtifactRehome, { rehomeId, claimToken: firstToken, rehomeToken: REHOME });
    await expect(t.mutation(rehomeApi.claimFileDerivedArtifactRehome, {
      rehomeId,
      claimToken: firstToken,
      rehomeToken: REHOME,
    })).resolves.toEqual({ claimed: false, requeued: true });
    const [next] = await t.query(rehomeApi.pendingFileDerivedArtifactRehomes, { rehomeToken: REHOME });
    const nextToken = admissionToken(next);
    const second = await t.mutation(rehomeApi.claimFileDerivedArtifactRehome, { rehomeId, claimToken: nextToken, rehomeToken: REHOME });
    expect(second).toMatchObject({ claimed: true });
    expect(second.targetOutputAttemptId).not.toBe(first.targetOutputAttemptId);
    await expect(t.mutation(rehomeApi.beginFileDerivedArtifactRehomeWrite, {
      rehomeId,
      claimToken: firstToken,
      targetGeneration: claimedGeneration(first),
      purpose: "extracted.txt",
      rehomeToken: REHOME,
    })).resolves.toBe(false);
  });
});
