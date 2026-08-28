import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireFileDerivedArtifactRehome } from "./controlAuth";
import {
  canonicalDerivedArtifactKeys,
  fileDerivedArtifactRehomeControl,
  FILE_DERIVED_ARTIFACT_REHOME_CONTROL_KEY,
  FILE_DERIVED_ARTIFACT_REHOME_LEASE_MS,
  INGEST_OUTPUT_PROTOCOL_V1,
  INGEST_OUTPUT_PROTOCOL_V2,
  rehomeOutputAttemptId,
} from "./fileDerivedArtifactRehomeProtocol";

const TERMINAL_STATUSES = ["ready", "stored_only", "error", "quarantined", "deleted"] as const;
const IN_FLIGHT_STATUSES = ["reserved", "uploading", "uploaded", "processing", "deleting"] as const;
const REHOME_OUTPUT_PRODUCER_WINDOW_MS = 10 * 60_000;
const REHOME_CLEANUP_INTERVAL_MS = 2 * 60 * 60_000;
const MAX_REHOME_TARGET_GENERATION = 9_999;

function boundedClaimToken(value: string): string {
  const token = value.trim();
  if (!/^[a-zA-Z0-9_-]{16,160}$/.test(token)) {
    throw new ConvexError({ code: "FILE_DERIVED_REHOME_CLAIM", message: "Rehome claim identity is invalid" });
  }
  return token;
}

function boundedDigest(value: string | undefined, role: string): string {
  const digest = String(value ?? "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new ConvexError({ code: "FILE_DERIVED_REHOME_PROOF", message: `${role} digest is invalid` });
  }
  return digest;
}

function boundedByteLength(value: number | undefined, role: string): number {
  const bytes = Math.floor(Number(value));
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > 4 * 1024 * 1024) {
    throw new ConvexError({ code: "FILE_DERIVED_REHOME_PROOF", message: `${role} byte length is invalid` });
  }
  return bytes;
}

function boundedTargetGeneration(value: number, role = "target generation"): number {
  const generation = Math.floor(Number(value));
  if (!Number.isSafeInteger(generation) || generation < 0 || generation > MAX_REHOME_TARGET_GENERATION) {
    throw new ConvexError({ code: "FILE_DERIVED_REHOME_GENERATION", message: `${role} is invalid` });
  }
  return generation;
}

/**
 * A claim token is a server-owned admission identity, not caller-selected
 * worker state. Once a target has been prewritten, its producer must never be
 * able to claim a later target again: the next generation gets a different
 * token and every stale task is rejected before it can associate old bytes
 * with a newer key.
 */
function nextRehomeClaimToken(rehome: any): string {
  const nextGeneration = boundedTargetGeneration(rehome.targetGeneration) + 1;
  if (nextGeneration > MAX_REHOME_TARGET_GENERATION) {
    throw new ConvexError({ code: "FILE_DERIVED_REHOME_GENERATION", message: "No fresh rehome target generation remains" });
  }
  return boundedClaimToken(`rehome-claim-${String(rehome._id)}-g${nextGeneration}`);
}

function generationMatches(rehome: any, value: number): boolean {
  return Number.isSafeInteger(value)
    && value >= 0
    && value === Number(rehome.targetGeneration);
}

function terminalStatus(status: string): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

function sourceKeysForFile(file: any) {
  let expected: { extractedTextR2Key: string; previewR2Key: string };
  try {
    expected = canonicalDerivedArtifactKeys(file._id, file.ingestVersion, INGEST_OUTPUT_PROTOCOL_V1);
  } catch {
    // Historical data is untrusted until it has been represented by the
    // migration manifest. Do not let a malformed identity abort the frozen
    // inventory transaction forever; persist a repairable release no-go.
    return { valid: false as const, reason: "source_identity_invalid" };
  }
  const extractedTextR2Key = file.extractedTextR2Key === undefined ? undefined : String(file.extractedTextR2Key);
  const previewR2Key = file.previewR2Key === undefined ? undefined : String(file.previewR2Key);
  if (extractedTextR2Key !== undefined && extractedTextR2Key !== expected.extractedTextR2Key) {
    return { valid: false as const, reason: "source_extracted_key_invalid" };
  }
  if (previewR2Key !== undefined && previewR2Key !== expected.previewR2Key) {
    return { valid: false as const, reason: "source_preview_key_invalid" };
  }
  return {
    valid: true as const,
    extractedTextR2Key,
    previewR2Key,
  };
}

function hasSourceArtifact(rehome: any): boolean {
  return Boolean(rehome.sourceExtractedTextR2Key || rehome.sourcePreviewR2Key);
}

function targetKeysForRehome(rehome: any) {
  const attempt = String(rehome.targetOutputAttemptId ?? "");
  const expected = canonicalDerivedArtifactKeys(rehome.fileId, rehome.sourceIngestVersion, INGEST_OUTPUT_PROTOCOL_V2, attempt);
  if (
    rehome.targetExtractedTextR2Key !== expected.extractedTextR2Key
    || rehome.targetPreviewR2Key !== expected.previewR2Key
  ) {
    throw new ConvexError({ code: "FILE_DERIVED_REHOME_KEY", message: "Rehome target keys are invalid" });
  }
  return expected;
}

function sourceTupleMatches(file: any, rehome: any): boolean {
  return Boolean(
    file
    && file.derivedArtifactRehomeId === rehome._id
    && file.ingestVersion === rehome.sourceIngestVersion
    && file.updatedAt === rehome.sourceFileUpdatedAt
    && file.status === rehome.sourceStatus
    && terminalStatus(file.status)
    && Number(file.ingestOutputProtocol ?? INGEST_OUTPUT_PROTOCOL_V1) === INGEST_OUTPUT_PROTOCOL_V1
    && (file.extractedTextR2Key ?? undefined) === (rehome.sourceExtractedTextR2Key ?? undefined)
    && (file.previewR2Key ?? undefined) === (rehome.sourcePreviewR2Key ?? undefined),
  );
}

async function controlOrThrow(ctx: { db: any }) {
  const control = await fileDerivedArtifactRehomeControl(ctx);
  if (!control) throw new ConvexError({ code: "FILE_DERIVED_REHOME_NOT_STARTED", message: "File-derived artifact rehome has not started" });
  return control;
}

async function outputAttemptForRehome(ctx: { db: any }, rehome: any) {
  const id = rehome.targetOutputAttemptOutboxId;
  return id ? await ctx.db.get(id) : null;
}

async function retireTargetOutputAttempt(ctx: { db: any }, rehome: any, now: number) {
  const outbox = await outputAttemptForRehome(ctx, rehome);
  if (!outbox) return null;
  if (
    outbox.fileId !== rehome.fileId
    || outbox.ingestVersion !== rehome.sourceIngestVersion
    || outbox.outputProtocol !== INGEST_OUTPUT_PROTOCOL_V2
    || outbox.outputAttemptId !== rehome.targetOutputAttemptId
  ) {
    throw new ConvexError({ code: "FILE_DERIVED_REHOME_RECEIPT", message: "Rehome output receipt is invalid" });
  }
  if (outbox.state === "active" || outbox.state === "cleanup") {
    await ctx.db.patch(outbox._id, {
      state: "cleanup",
      // The old rehome generation can no longer win the CAS. A prewrite may
      // already have reached R2, so normal V2 cleanup retains it as a sweep.
      writerHandoff: true,
      cleanupClaimToken: undefined,
      cleanupClaimExpiresAt: undefined,
      nextCleanupAt: now,
      updatedAt: now,
    });
  }
  return outbox;
}

async function blockRehome(ctx: { db: any }, control: any, rehome: any, failureCode: string, now: number) {
  await retireTargetOutputAttempt(ctx, rehome, now);
  await ctx.db.patch(rehome._id, {
    state: "blocked",
    claimToken: undefined,
    claimExpiresAt: undefined,
    failureCode: failureCode.slice(0, 120),
    updatedAt: now,
  });
  await ctx.db.patch(control._id, {
    phase: "blocked",
    blockedCount: control.blockedCount + (rehome.state === "blocked" ? 0 : 1),
    updatedAt: now,
  });
}

async function createLegacySourceSweeper(ctx: { db: any }, rehome: any, now: number) {
  const rows = await ctx.db
    .query("fileIngestOutputAttempts")
    .withIndex("by_file_version", (q: any) => q.eq("fileId", rehome.fileId).eq("ingestVersion", rehome.sourceIngestVersion))
    .take(16);
  const existing = rows.find((row: any) => row.outputProtocol === INGEST_OUTPUT_PROTOCOL_V1);
  if (existing) {
    if (
      existing.state !== "legacy_sweeping"
      || existing.cleanupExtractedText !== true
      || existing.cleanupPreview !== true
    ) {
      await ctx.db.patch(existing._id, {
        state: "legacy_sweeping",
        // Before CAS, a bridge may deliberately be preview-only to preserve
        // a live V1 text pointer. After CAS the file has detached that source
        // pair, so this becomes the permanent late-V1-PUT reaper and must
        // cover both deterministic roles.
        cleanupExtractedText: true,
        cleanupPreview: true,
        cleanupClaimToken: undefined,
        cleanupClaimExpiresAt: undefined,
        nextCleanupAt: now,
        updatedAt: now,
      });
    }
    return existing._id;
  }
  const keys = canonicalDerivedArtifactKeys(rehome.fileId, rehome.sourceIngestVersion, INGEST_OUTPUT_PROTOCOL_V1);
  const attempt = rehomeOutputAttemptId(rehome._id, Math.max(1, rehome.targetGeneration));
  return await ctx.db.insert("fileIngestOutputAttempts", {
    fileId: rehome.fileId,
    ingestVersion: rehome.sourceIngestVersion,
    outputProtocol: INGEST_OUTPUT_PROTOCOL_V1,
    outputAttemptId: `legacy-${attempt}`.slice(0, 180),
    claimToken: `rehome-source-sweeper-${String(rehome._id)}`.slice(0, 160),
    extractedTextR2Key: keys.extractedTextR2Key,
    previewR2Key: keys.previewR2Key,
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
}

async function allocateTargetGeneration(ctx: { db: any }, rehome: any, claimToken: string, now: number) {
  const expectedClaimToken = nextRehomeClaimToken(rehome);
  if (claimToken !== expectedClaimToken) {
    throw new ConvexError({ code: "FILE_DERIVED_REHOME_CLAIM", message: "Rehome admission identity is stale" });
  }
  const targetGeneration = boundedTargetGeneration(rehome.targetGeneration) + 1;
  const targetOutputAttemptId = rehomeOutputAttemptId(rehome._id, targetGeneration);
  const target = canonicalDerivedArtifactKeys(
    rehome.fileId,
    rehome.sourceIngestVersion,
    INGEST_OUTPUT_PROTOCOL_V2,
    targetOutputAttemptId,
  );
  const outboxId = await ctx.db.insert("fileIngestOutputAttempts", {
    fileId: rehome.fileId,
    ingestVersion: rehome.sourceIngestVersion,
    outputProtocol: INGEST_OUTPUT_PROTOCOL_V2,
    outputAttemptId: targetOutputAttemptId,
    claimToken,
    extractedTextR2Key: target.extractedTextR2Key,
    previewR2Key: target.previewR2Key,
    producerMayWriteUntil: now + REHOME_OUTPUT_PRODUCER_WINDOW_MS,
    state: "active",
    writerHandoff: false,
    writeStarted: false,
    nextCleanupAt: now + REHOME_OUTPUT_PRODUCER_WINDOW_MS,
    sweepCount: 0,
    createdAt: now,
    updatedAt: now,
  });
  await ctx.db.patch(rehome._id, {
    state: "copying",
    targetGeneration,
    targetOutputAttemptId,
    targetOutputAttemptOutboxId: outboxId,
    targetExtractedTextR2Key: target.extractedTextR2Key,
    targetPreviewR2Key: target.previewR2Key,
    claimToken,
    claimExpiresAt: now + FILE_DERIVED_ARTIFACT_REHOME_LEASE_MS,
    extractedTextWriteStarted: false,
    previewWriteStarted: false,
    sourceExtractedTextSha256: undefined,
    sourcePreviewSha256: undefined,
    targetExtractedTextSha256: undefined,
    targetPreviewSha256: undefined,
    sourceExtractedTextBytes: undefined,
    sourcePreviewBytes: undefined,
    targetExtractedTextBytes: undefined,
    targetPreviewBytes: undefined,
    failureCode: undefined,
    updatedAt: now,
  });
  return await ctx.db.get(rehome._id);
}

function claimedRehomePayload(rehome: any) {
  const target = targetKeysForRehome(rehome);
  return {
    claimed: true as const,
    rehomeId: String(rehome._id),
    fileId: String(rehome.fileId),
    sourceIngestVersion: rehome.sourceIngestVersion,
    sourceExtractedTextR2Key: rehome.sourceExtractedTextR2Key,
    sourcePreviewR2Key: rehome.sourcePreviewR2Key,
    targetOutputAttemptId: rehome.targetOutputAttemptId,
    targetOutputAttemptOutboxId: String(rehome.targetOutputAttemptOutboxId),
    targetExtractedTextR2Key: target.extractedTextR2Key,
    targetPreviewR2Key: target.previewR2Key,
    targetGeneration: rehome.targetGeneration,
    claimExpiresAt: rehome.claimExpiresAt,
  };
}

function rehomeTargetResetPatch(errorCode: string | undefined, now: number) {
  return {
    state: "planned" as const,
    claimToken: undefined,
    claimExpiresAt: undefined,
    targetOutputAttemptId: undefined,
    targetOutputAttemptOutboxId: undefined,
    targetExtractedTextR2Key: undefined,
    targetPreviewR2Key: undefined,
    extractedTextWriteStarted: undefined,
    previewWriteStarted: undefined,
    sourceExtractedTextSha256: undefined,
    sourcePreviewSha256: undefined,
    targetExtractedTextSha256: undefined,
    targetPreviewSha256: undefined,
    sourceExtractedTextBytes: undefined,
    sourcePreviewBytes: undefined,
    targetExtractedTextBytes: undefined,
    targetPreviewBytes: undefined,
    failureCode: errorCode?.trim().slice(0, 120),
    updatedAt: now,
  };
}

async function retireAndRequeueRehomeTarget(ctx: { db: any }, rehome: any, now: number, errorCode?: string) {
  await retireTargetOutputAttempt(ctx, rehome, now);
  await ctx.db.patch(rehome._id, rehomeTargetResetPatch(errorCode, now));
}

/**
 * A V1 cleanup lease is not a physical R2 DELETE fence. A task that claimed
 * one of these shared keys before migration start can finish its provider
 * delete after a newer worker has observed its expiry or completion. Only
 * block when that exact historical pair still intersects a live terminal V1
 * pointer; deleted/no-pointer history is harmless to the rehome source.
 */
async function unsafeV1CleanupHistoryForRow(ctx: { db: any }, row: any) {
  if (
    row.outputProtocol !== INGEST_OUTPUT_PROTOCOL_V1
    || !["deleting", "legacy_sweeping"].includes(row.state)
    || row.cleanupHistoryAcknowledgedRehomeId
  ) return null;
  const file = await ctx.db.get(row.fileId);
  if (
    !file
    || file.status === "deleted"
    || !terminalStatus(file.status)
    || file.ingestVersion !== row.ingestVersion
    || Number(file.ingestOutputProtocol ?? INGEST_OUTPUT_PROTOCOL_V1) !== INGEST_OUTPUT_PROTOCOL_V1
  ) return null;
  const source = sourceKeysForFile(file);
  if (!source.valid) {
    return {
      reason: "v1_cleanup_history_source_identity_invalid" as const,
      fileId: file._id,
      outputAttemptId: row._id,
    };
  }
  // Historical rows without role flags are conservatively a full pair. A
  // bridge made by the new legacy cleanup path can be exact (for example,
  // preview-only), so it must not block migration of an independent live
  // text pointer or later let a generic sweeper delete it.
  const mayDeleteExtractedText = row.cleanupExtractedText !== false;
  const mayDeletePreview = row.cleanupPreview !== false;
  if (
    (mayDeleteExtractedText && source.extractedTextR2Key === row.extractedTextR2Key)
    || (mayDeletePreview && source.previewR2Key === row.previewR2Key)
  ) {
    return { reason: "v1_cleanup_history_may_delete_source" as const, fileId: file._id, outputAttemptId: row._id };
  }
  return null;
}

/** Freeze normal file mutation only after server-side preflight confirms no
 * in-flight writer or deletion can be mistaken for inventory state. */
export const startFileDerivedArtifactRehome = mutation({
  args: { rehomeToken: v.optional(v.string()) },
  handler: async (ctx, args) => {
    requireFileDerivedArtifactRehome(args.rehomeToken);
    const existing = await fileDerivedArtifactRehomeControl(ctx);
    if (existing) return { started: false as const, phase: existing.phase };
    const [rollout, unsafe, legacyDerivedCleanup] = await Promise.all([
      ctx.db.query("workerProtocolRollouts")
        .withIndex("by_key", (q: any) => q.eq("key", "file-ingest-output-protocol-v2"))
        .first(),
      Promise.all(IN_FLIGHT_STATUSES.map(async (status) => await ctx.db
        .query("files")
        .withIndex("by_status_updated", (q: any) => q.eq("status", status))
        .first())),
      // This legacy one-shot row has no claim state. Its existence is the
      // durable fence: a worker may already hold its shared V1 delete keys.
      ctx.db.query("fileIngestCleanupOutbox").withIndex("by_createdAt").first(),
    ]);
    if (rollout) return { started: false as const, reason: "v2_already_active" as const };
    if (legacyDerivedCleanup) return { started: false as const, reason: "legacy_derived_cleanup_pending" as const };
    const unsafeIndex = unsafe.findIndex(Boolean);
    if (unsafeIndex >= 0) {
      return { started: false as const, reason: `in_flight_${IN_FLIGHT_STATUSES[unsafeIndex]}` };
    }
    const now = Date.now();
    await ctx.db.insert("fileDerivedArtifactRehomeControls", {
      key: FILE_DERIVED_ARTIFACT_REHOME_CONTROL_KEY,
      phase: "frozen",
      inventoryStatus: "ready",
      scannedCount: 0,
      cleanupPreflightStatus: "pending",
      cleanupPreflightScannedCount: 0,
      auditStatus: "pending",
      auditScannedCount: 0,
      snapshotCount: 0,
      cutoverCount: 0,
      blockedCount: 0,
      createdAt: now,
      updatedAt: now,
    });
    return { started: true as const, phase: "frozen" as const };
  },
});

async function blockCleanupPreflightOnFile(
  ctx: { db: any },
  control: any,
  file: any,
  failureCode: string,
  outputAttemptId: any,
  now: number,
) {
  const prior = await ctx.db
    .query("fileDerivedArtifactRehomes")
    .withIndex("by_file", (q: any) => q.eq("fileId", file._id))
    .first();
  const source = sourceKeysForFile(file);
  let snapshotAdded = 0;
  let blockedAdded = 0;
  let cutoverRemoved = 0;
  if (!prior) {
    const rehomeId = await ctx.db.insert("fileDerivedArtifactRehomes", {
      controlKey: FILE_DERIVED_ARTIFACT_REHOME_CONTROL_KEY,
      fileId: file._id,
      sourceIngestVersion: file.ingestVersion,
      // The lock patch below is the snapshot linearization point.
      sourceFileUpdatedAt: now,
      sourceStatus: file.status,
      sourceExtractedTextR2Key: source.valid ? source.extractedTextR2Key : undefined,
      sourcePreviewR2Key: source.valid ? source.previewR2Key : undefined,
      targetGeneration: 0,
      state: "blocked",
      failureCode,
      createdAt: now,
      updatedAt: now,
    });
    // Keep this assignment explicit so a recovery mutation can locate the
    // exact manifest without trusting an operator-supplied R2 key.
    await ctx.db.patch(file._id, { derivedArtifactRehomeId: rehomeId, updatedAt: now });
    snapshotAdded = 1;
    blockedAdded = 1;
  } else if (prior.state !== "blocked") {
    if (prior.state === "cutover") cutoverRemoved = 1;
    await ctx.db.patch(prior._id, {
      state: "blocked",
      claimToken: undefined,
      claimExpiresAt: undefined,
      failureCode,
      updatedAt: now,
    });
    blockedAdded = 1;
  }
  await ctx.db.patch(control._id, {
    phase: "blocked",
    cleanupPreflightStatus: "blocked",
    cleanupPreflightFailureFileId: file._id,
    cleanupPreflightFailureOutputAttemptId: outputAttemptId,
    cleanupPreflightFailureCode: failureCode,
    snapshotCount: control.snapshotCount + snapshotAdded,
    cutoverCount: Math.max(0, control.cutoverCount - cutoverRemoved),
    blockedCount: control.blockedCount + blockedAdded,
    updatedAt: now,
  });
}

/**
 * Scan every durable V1 cleanup history row before inventory starts. The
 * control already freezes new normal mutations, so a marker seen here is the
 * complete logical record for every cleanup claim made after this protocol.
 * Old unrecorded workers remain an explicit provider-residual release no-go.
 */
export const advanceFileDerivedArtifactRehomeCleanupPreflight = mutation({
  args: { limit: v.optional(v.number()), rehomeToken: v.optional(v.string()) },
  handler: async (ctx, args) => {
    requireFileDerivedArtifactRehome(args.rehomeToken);
    const control = await controlOrThrow(ctx);
    const status = control.cleanupPreflightStatus ?? "pending";
    if (control.phase === "blocked" || control.phase === "active" || control.phase === "ready") {
      return { phase: control.phase, status, scanned: 0, isDone: status === "complete" };
    }
    if (status === "complete") return { phase: control.phase, status: "complete" as const, scanned: 0, isDone: true };
    const limit = Math.min(32, Math.max(1, Math.floor(args.limit ?? 12)));
    const page = await ctx.db
      .query("fileIngestOutputAttempts")
      .withIndex("by_createdAt")
      .order("asc")
      .paginate({ cursor: control.cleanupPreflightCursor ?? null, numItems: limit, maximumRowsRead: limit });
    const now = Date.now();
    for (const row of page.page) {
      const unsafe = await unsafeV1CleanupHistoryForRow(ctx, row);
      if (!unsafe) continue;
      const file = await ctx.db.get(unsafe.fileId);
      if (!file) throw new ConvexError({ code: "FILE_DERIVED_REHOME", message: "Cleanup-history file disappeared during preflight" });
      await blockCleanupPreflightOnFile(ctx, control, file, unsafe.reason, unsafe.outputAttemptId, now);
      return {
        phase: "blocked" as const,
        status: "blocked" as const,
        scanned: 0,
        isDone: false,
        failureCode: unsafe.reason,
        fileId: String(unsafe.fileId),
        outputAttemptId: String(unsafe.outputAttemptId),
      };
    }
    const nextStatus = page.isDone ? "complete" : "scanning";
    await ctx.db.patch(control._id, {
      cleanupPreflightStatus: nextStatus,
      cleanupPreflightCursor: page.isDone ? undefined : page.continueCursor,
      cleanupPreflightScannedCount: Number(control.cleanupPreflightScannedCount ?? 0) + page.page.length,
      updatedAt: now,
    });
    return { phase: control.phase, status: nextStatus, scanned: page.page.length, isDone: page.isDone };
  },
});

/** Inventory every file row through a bounded, durable cursor. Every
 * pointer-bearing terminal V1 row is locked and represented by exactly one
 * manifest before any worker receives an R2 target identity; an unknown or
 * newly in-flight status fails closed instead of bypassing the activation
 * proof. */
export const advanceFileDerivedArtifactRehomeInventory = mutation({
  args: { limit: v.optional(v.number()), rehomeToken: v.optional(v.string()) },
  handler: async (ctx, args) => {
    requireFileDerivedArtifactRehome(args.rehomeToken);
    const control = await controlOrThrow(ctx);
    if (control.phase === "blocked" || control.phase === "active") return { phase: control.phase, scanned: 0 };
    if (control.phase === "ready") return { phase: control.phase, scanned: 0 };
    if ((control.cleanupPreflightStatus ?? "pending") !== "complete") {
      return { phase: control.phase, scanned: 0, reason: "cleanup_preflight_pending" as const };
    }
    // A recovery must never turn the phase back to `rehoming` while its
    // historical V1 DELETE preflight is still blocked or incomplete. The
    // controller may be retried out of order, so make the admission fence
    // explicit here rather than relying on the normal start sequence.
    if (control.phase === "rehoming") return { phase: control.phase, scanned: 0 };
    if (control.inventoryStatus === "complete") {
      await ctx.db.patch(control._id, { phase: "rehoming", updatedAt: Date.now() });
      return { phase: "rehoming" as const, scanned: 0 };
    }
    const limit = Math.min(32, Math.max(1, Math.floor(args.limit ?? 12)));
    const page = await ctx.db
      .query("files")
      .withIndex("by_updatedAt")
      .order("asc")
      .paginate({ cursor: control.inventoryCursor ?? null, numItems: limit, maximumRowsRead: limit });
    const now = Date.now();
    let snapshotAdded = 0;
    let cutoverAdded = 0;
    let blockedAdded = 0;
    for (const file of page.page) {
      const prior = await ctx.db
        .query("fileDerivedArtifactRehomes")
        .withIndex("by_file", (q: any) => q.eq("fileId", file._id))
        .first();
      if (prior) continue;
      if (!terminalStatus(file.status)) {
        // `start` rejects the known active states. If an old worker or an
        // unknown historical status appears after the freeze, do not let it
        // silently escape the durable activation inventory.
        await ctx.db.insert("fileDerivedArtifactRehomes", {
          controlKey: FILE_DERIVED_ARTIFACT_REHOME_CONTROL_KEY,
          fileId: file._id,
          sourceIngestVersion: file.ingestVersion,
          sourceFileUpdatedAt: file.updatedAt,
          sourceStatus: file.status,
          targetGeneration: 0,
          state: "blocked",
          failureCode: (IN_FLIGHT_STATUSES as readonly string[]).includes(file.status)
            ? `source_status_in_flight_${file.status}`
            : "source_status_unknown",
          createdAt: now,
          updatedAt: now,
        });
        snapshotAdded += 1;
        blockedAdded += 1;
        continue;
      }
      if (Number(file.ingestOutputProtocol ?? INGEST_OUTPUT_PROTOCOL_V1) !== INGEST_OUTPUT_PROTOCOL_V1) continue;
      const source = sourceKeysForFile(file);
      snapshotAdded += 1;
      if (!source.valid) {
        await ctx.db.insert("fileDerivedArtifactRehomes", {
          controlKey: FILE_DERIVED_ARTIFACT_REHOME_CONTROL_KEY,
          fileId: file._id,
          sourceIngestVersion: file.ingestVersion,
          sourceFileUpdatedAt: file.updatedAt,
          sourceStatus: file.status,
          targetGeneration: 0,
          state: "blocked",
          failureCode: source.reason,
          createdAt: now,
          updatedAt: now,
        });
        blockedAdded += 1;
        continue;
      }
      if (file.status === "deleted") {
        // A deleted file must never be copied back into a live V2 pointer.
        // Detach its historical V1 pointers atomically and retain the exact
        // shared pair as a permanent reaper for a late V1 PUT. This lets the
        // server prove *all* terminal rows are no longer V1-referenced
        // without deleting any source inline.
        const rehomeId = await ctx.db.insert("fileDerivedArtifactRehomes", {
          controlKey: FILE_DERIVED_ARTIFACT_REHOME_CONTROL_KEY,
          fileId: file._id,
          sourceIngestVersion: file.ingestVersion,
          sourceFileUpdatedAt: file.updatedAt,
          sourceStatus: file.status,
          sourceExtractedTextR2Key: source.extractedTextR2Key,
          sourcePreviewR2Key: source.previewR2Key,
          targetGeneration: 0,
          state: "cutover",
          createdAt: now,
          updatedAt: now,
        });
        const deletedRehome = await ctx.db.get(rehomeId);
        if (!deletedRehome) throw new ConvexError({ code: "FILE_DERIVED_REHOME", message: "Deleted-file rehome manifest was not persisted" });
        if (hasSourceArtifact(deletedRehome)) await createLegacySourceSweeper(ctx, deletedRehome, now);
        await ctx.db.patch(file._id, {
          extractedTextR2Key: undefined,
          previewR2Key: undefined,
          ingestOutputProtocol: INGEST_OUTPUT_PROTOCOL_V2,
          ingestOutputAttemptId: undefined,
          derivedArtifactRehomeId: undefined,
          updatedAt: now,
        });
        cutoverAdded += 1;
        continue;
      }
      if (!source.extractedTextR2Key && !source.previewR2Key) {
        await ctx.db.insert("fileDerivedArtifactRehomes", {
          controlKey: FILE_DERIVED_ARTIFACT_REHOME_CONTROL_KEY,
          fileId: file._id,
          sourceIngestVersion: file.ingestVersion,
          sourceFileUpdatedAt: now,
          sourceStatus: file.status,
          targetGeneration: 0,
          state: "cutover",
          createdAt: now,
          updatedAt: now,
        });
        await ctx.db.patch(file._id, {
          ingestOutputProtocol: INGEST_OUTPUT_PROTOCOL_V2,
          ingestOutputAttemptId: undefined,
          updatedAt: now,
        });
        cutoverAdded += 1;
        continue;
      }
      const rehomeId = await ctx.db.insert("fileDerivedArtifactRehomes", {
        controlKey: FILE_DERIVED_ARTIFACT_REHOME_CONTROL_KEY,
        fileId: file._id,
        sourceIngestVersion: file.ingestVersion,
        // This is overwritten with the lock write's exact timestamp below.
        sourceFileUpdatedAt: now,
        sourceStatus: file.status,
        sourceExtractedTextR2Key: source.extractedTextR2Key,
        sourcePreviewR2Key: source.previewR2Key,
        targetGeneration: 0,
        state: "planned",
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.patch(file._id, { derivedArtifactRehomeId: rehomeId, updatedAt: now });
    }
    const nextStatus = page.isDone ? "complete" : "ready";
    const nextCursor = page.isDone ? undefined : page.continueCursor;
    const phase = page.isDone ? (blockedAdded > 0 || control.blockedCount > 0 ? "blocked" : "rehoming") : "inventorying";
    await ctx.db.patch(control._id, {
      phase,
      inventoryStatus: nextStatus,
      inventoryCursor: nextCursor,
      scannedCount: control.scannedCount + page.page.length,
      snapshotCount: control.snapshotCount + snapshotAdded,
      cutoverCount: control.cutoverCount + cutoverAdded,
      blockedCount: control.blockedCount + blockedAdded,
      updatedAt: now,
    });
    return {
      phase,
      status: page.isDone ? "complete" : "scanning",
      scanned: page.page.length,
      isDone: page.isDone,
      blocked: blockedAdded,
    };
  },
});

export const pendingFileDerivedArtifactRehomes = query({
  args: { limit: v.optional(v.number()), rehomeToken: v.optional(v.string()) },
  handler: async (ctx, args) => {
    requireFileDerivedArtifactRehome(args.rehomeToken);
    const control = await fileDerivedArtifactRehomeControl(ctx);
    if (!control || control.phase !== "rehoming") return [];
    if ((control.cleanupPreflightStatus ?? "pending") !== "complete") return [];
    const limit = Math.min(16, Math.max(1, Math.floor(args.limit ?? 8)));
    const now = Date.now();
    const [planned, copying, verified] = await Promise.all([
      ctx.db.query("fileDerivedArtifactRehomes")
        .withIndex("by_control_state", (q: any) => q.eq("controlKey", FILE_DERIVED_ARTIFACT_REHOME_CONTROL_KEY).eq("state", "planned"))
        .take(limit),
      ctx.db.query("fileDerivedArtifactRehomes")
        .withIndex("by_control_state", (q: any) => q.eq("controlKey", FILE_DERIVED_ARTIFACT_REHOME_CONTROL_KEY).eq("state", "copying"))
        .take(limit),
      ctx.db.query("fileDerivedArtifactRehomes")
        .withIndex("by_control_state", (q: any) => q.eq("controlKey", FILE_DERIVED_ARTIFACT_REHOME_CONTROL_KEY).eq("state", "verified"))
        .take(limit),
    ]);
    return [...planned, ...verified, ...copying.filter((row: any) => Number(row.claimExpiresAt ?? 0) <= now)]
      .slice(0, limit)
      .map((row: any) => ({
        rehomeId: String(row._id),
        fileId: String(row.fileId),
        targetGeneration: row.targetGeneration,
        claimToken: nextRehomeClaimToken(row),
      }));
  },
});

export const claimFileDerivedArtifactRehome = mutation({
  args: {
    rehomeId: v.id("fileDerivedArtifactRehomes"),
    claimToken: v.string(),
    rehomeToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireFileDerivedArtifactRehome(args.rehomeToken);
    const claimToken = boundedClaimToken(args.claimToken);
    const control = await controlOrThrow(ctx);
    if (control.phase !== "rehoming") return { claimed: false as const, phase: control.phase };
    if ((control.cleanupPreflightStatus ?? "pending") !== "complete") {
      return { claimed: false as const, reason: "cleanup_preflight_pending" as const };
    }
    const rehome = await ctx.db.get(args.rehomeId);
    if (!rehome || rehome.controlKey !== FILE_DERIVED_ARTIFACT_REHOME_CONTROL_KEY) return null;
    if (rehome.state === "cutover") return { claimed: false as const, committed: true as const };
    if (rehome.state === "blocked") return { claimed: false as const, blocked: true as const, failureCode: rehome.failureCode };
    const file = await ctx.db.get(rehome.fileId);
    if (!file || !sourceTupleMatches(file, rehome)) {
      const now = Date.now();
      await blockRehome(ctx, control, rehome, "source_tuple_changed", now);
      return { claimed: false as const, blocked: true as const, failureCode: "source_tuple_changed" };
    }
    const now = Date.now();
    if (rehome.state === "copying") {
      if (rehome.claimToken === claimToken && Number(rehome.claimExpiresAt ?? 0) > now) {
        const outbox = await outputAttemptForRehome(ctx, rehome);
        if (outbox?.state === "active") {
          // Never reissue a copying target, even before the first recorded
          // prewrite. Two duplicate Trigger executions can read a changing
          // late-V1 source on either side of `begin...Write`; the first proof
          // could otherwise be recorded after the second PUT overwrote the
          // same path. Retire/requeue gives every execution a disjoint target
          // and makes the server-owned generation token invalid immediately.
          await retireAndRequeueRehomeTarget(ctx, rehome, now, "prewrite_claim_replaced");
          return { claimed: false as const, requeued: true as const };
        }
        await blockRehome(ctx, control, rehome, "target_receipt_unavailable", now);
        return { claimed: false as const, blocked: true as const, failureCode: "target_receipt_unavailable" };
      }
      if (Number(rehome.claimExpiresAt ?? 0) > now) {
        return { claimed: false as const, retryAfterMs: Number(rehome.claimExpiresAt) - now };
      }
      if (rehome.claimToken === claimToken) {
        // An expired retry still carries the prior producer identity. Leave
        // it planned so only the controller's next generation token can mint
        // the replacement target.
        await retireAndRequeueRehomeTarget(ctx, rehome, now, "expired_claim_replaced");
        return { claimed: false as const, requeued: true as const };
      }
      if (claimToken !== nextRehomeClaimToken(rehome)) {
        return { claimed: false as const, superseded: true as const };
      }
      // Never reuse a stale target generation. The previous producer may have
      // an accepted R2 PUT in flight; its exact receipt is moved into normal
      // sweeping cleanup before a fresh, disjoint target is allocated.
      await retireTargetOutputAttempt(ctx, rehome, now);
      const fresh = await allocateTargetGeneration(ctx, rehome, claimToken, now);
      return claimedRehomePayload(fresh);
    }
    if (rehome.state === "verified") {
      return { claimed: false as const, verified: true as const, targetGeneration: rehome.targetGeneration };
    }
    if (claimToken !== nextRehomeClaimToken(rehome)) {
      return { claimed: false as const, superseded: true as const };
    }
    const fresh = await allocateTargetGeneration(ctx, rehome, claimToken, now);
    return claimedRehomePayload(fresh);
  },
});

export const beginFileDerivedArtifactRehomeWrite = mutation({
  args: {
    rehomeId: v.id("fileDerivedArtifactRehomes"),
    claimToken: v.string(),
    targetGeneration: v.number(),
    purpose: v.union(v.literal("extracted.txt"), v.literal("preview.webp")),
    rehomeToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireFileDerivedArtifactRehome(args.rehomeToken);
    const rehome = await ctx.db.get(args.rehomeId);
    if (
      !rehome
      || rehome.state !== "copying"
      || rehome.claimToken !== boundedClaimToken(args.claimToken)
      || !generationMatches(rehome, args.targetGeneration)
    ) return false;
    if (Number(rehome.claimExpiresAt ?? 0) <= Date.now()) return false;
    if (args.purpose === "extracted.txt" && !rehome.sourceExtractedTextR2Key) return false;
    if (args.purpose === "preview.webp" && !rehome.sourcePreviewR2Key) return false;
    const outbox = await outputAttemptForRehome(ctx, rehome);
    if (!outbox || outbox.state !== "active" || outbox.claimToken !== rehome.claimToken || outbox.writeStarted === undefined) return false;
    targetKeysForRehome(rehome);
    const now = Date.now();
    await ctx.db.patch(outbox._id, { writeStarted: true, updatedAt: now });
    await ctx.db.patch(rehome._id, {
      ...(args.purpose === "extracted.txt" ? { extractedTextWriteStarted: true } : { previewWriteStarted: true }),
      updatedAt: now,
    });
    return true;
  },
});

export const recordFileDerivedArtifactRehomeReadback = mutation({
  args: {
    rehomeId: v.id("fileDerivedArtifactRehomes"),
    claimToken: v.string(),
    targetGeneration: v.number(),
    sourceExtractedTextSha256: v.optional(v.string()),
    sourcePreviewSha256: v.optional(v.string()),
    targetExtractedTextSha256: v.optional(v.string()),
    targetPreviewSha256: v.optional(v.string()),
    sourceExtractedTextBytes: v.optional(v.number()),
    sourcePreviewBytes: v.optional(v.number()),
    targetExtractedTextBytes: v.optional(v.number()),
    targetPreviewBytes: v.optional(v.number()),
    rehomeToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireFileDerivedArtifactRehome(args.rehomeToken);
    const rehome = await ctx.db.get(args.rehomeId);
    if (
      !rehome
      || rehome.state !== "copying"
      || rehome.claimToken !== boundedClaimToken(args.claimToken)
      || !generationMatches(rehome, args.targetGeneration)
    ) return { verified: false as const, reason: "stale_claim" as const };
    const outbox = await outputAttemptForRehome(ctx, rehome);
    if (!outbox || outbox.state !== "active" || outbox.claimToken !== rehome.claimToken) {
      return { verified: false as const, reason: "target_receipt_unavailable" as const };
    }
    const extracted = Boolean(rehome.sourceExtractedTextR2Key);
    const preview = Boolean(rehome.sourcePreviewR2Key);
    const proof = {
      sourceExtractedTextSha256: extracted ? boundedDigest(args.sourceExtractedTextSha256, "source extracted") : undefined,
      sourcePreviewSha256: preview ? boundedDigest(args.sourcePreviewSha256, "source preview") : undefined,
      targetExtractedTextSha256: extracted ? boundedDigest(args.targetExtractedTextSha256, "target extracted") : undefined,
      targetPreviewSha256: preview ? boundedDigest(args.targetPreviewSha256, "target preview") : undefined,
      sourceExtractedTextBytes: extracted ? boundedByteLength(args.sourceExtractedTextBytes, "source extracted") : undefined,
      sourcePreviewBytes: preview ? boundedByteLength(args.sourcePreviewBytes, "source preview") : undefined,
      targetExtractedTextBytes: extracted ? boundedByteLength(args.targetExtractedTextBytes, "target extracted") : undefined,
      targetPreviewBytes: preview ? boundedByteLength(args.targetPreviewBytes, "target preview") : undefined,
    };
    if (
      (extracted && (!rehome.extractedTextWriteStarted || proof.sourceExtractedTextSha256 !== proof.targetExtractedTextSha256 || proof.sourceExtractedTextBytes !== proof.targetExtractedTextBytes))
      || (preview && (!rehome.previewWriteStarted || proof.sourcePreviewSha256 !== proof.targetPreviewSha256 || proof.sourcePreviewBytes !== proof.targetPreviewBytes))
    ) {
      return { verified: false as const, reason: "target_readback_mismatch" as const };
    }
    const now = Date.now();
    await ctx.db.patch(rehome._id, {
      ...proof,
      state: "verified",
      claimExpiresAt: now + FILE_DERIVED_ARTIFACT_REHOME_LEASE_MS,
      updatedAt: now,
    });
    return { verified: true as const };
  },
});

export const commitFileDerivedArtifactRehome = mutation({
  args: {
    rehomeId: v.id("fileDerivedArtifactRehomes"),
    targetGeneration: v.number(),
    rehomeToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireFileDerivedArtifactRehome(args.rehomeToken);
    const control = await controlOrThrow(ctx);
    const rehome = await ctx.db.get(args.rehomeId);
    if (!rehome) return { committed: false as const, reason: "missing" as const };
    if (!generationMatches(rehome, args.targetGeneration)) return { committed: false as const, reason: "stale_generation" as const };
    if (rehome.state === "cutover") return { committed: true as const, recovered: true as const };
    if (control.phase !== "rehoming" || rehome.state !== "verified") return { committed: false as const, reason: "not_verified" as const };
    const file = await ctx.db.get(rehome.fileId);
    const now = Date.now();
    if (!file || !sourceTupleMatches(file, rehome)) {
      await blockRehome(ctx, control, rehome, "source_tuple_changed", now);
      return { committed: false as const, reason: "source_tuple_changed" as const };
    }
    const outbox = await outputAttemptForRehome(ctx, rehome);
    if (!outbox || outbox.state !== "active" || outbox.claimToken !== rehome.claimToken) {
      await blockRehome(ctx, control, rehome, "target_receipt_unavailable", now);
      return { committed: false as const, reason: "target_receipt_unavailable" as const };
    }
    const target = targetKeysForRehome(rehome);
    if (
      (rehome.sourceExtractedTextR2Key && (!rehome.extractedTextWriteStarted || !rehome.sourceExtractedTextSha256 || rehome.sourceExtractedTextSha256 !== rehome.targetExtractedTextSha256 || rehome.sourceExtractedTextBytes !== rehome.targetExtractedTextBytes))
      || (rehome.sourcePreviewR2Key && (!rehome.previewWriteStarted || !rehome.sourcePreviewSha256 || rehome.sourcePreviewSha256 !== rehome.targetPreviewSha256 || rehome.sourcePreviewBytes !== rehome.targetPreviewBytes))
    ) {
      await blockRehome(ctx, control, rehome, "verification_incomplete", now);
      return { committed: false as const, reason: "verification_incomplete" as const };
    }
    await ctx.db.patch(file._id, {
      extractedTextR2Key: rehome.sourceExtractedTextR2Key ? target.extractedTextR2Key : undefined,
      previewR2Key: rehome.sourcePreviewR2Key ? target.previewR2Key : undefined,
      ingestOutputProtocol: INGEST_OUTPUT_PROTOCOL_V2,
      ingestOutputAttemptId: rehome.targetOutputAttemptId,
      derivedArtifactRehomeId: undefined,
      updatedAt: now,
    });
    // This is the linearization point: the V2 pointers and removal of their
    // uncommitted-output receipt occur in the same Convex mutation.
    await ctx.db.delete(outbox._id);
    await createLegacySourceSweeper(ctx, rehome, now);
    await ctx.db.patch(rehome._id, {
      state: "cutover",
      claimToken: undefined,
      claimExpiresAt: undefined,
      updatedAt: now,
    });
    await ctx.db.patch(control._id, { cutoverCount: control.cutoverCount + 1, updatedAt: now });
    return { committed: true as const };
  },
});

export const fileDerivedArtifactRehomeReceipt = query({
  args: { rehomeId: v.id("fileDerivedArtifactRehomes"), rehomeToken: v.optional(v.string()) },
  handler: async (ctx, args) => {
    requireFileDerivedArtifactRehome(args.rehomeToken);
    const rehome = await ctx.db.get(args.rehomeId);
    if (!rehome) return null;
    const file = await ctx.db.get(rehome.fileId);
    const target = rehome.targetOutputAttemptId ? targetKeysForRehome(rehome) : null;
    const committed = Boolean(
      rehome.state === "cutover"
      && file
      && Number(file.ingestOutputProtocol) === INGEST_OUTPUT_PROTOCOL_V2
      && file.ingestOutputAttemptId === rehome.targetOutputAttemptId
      && (file.extractedTextR2Key ?? undefined) === (rehome.sourceExtractedTextR2Key ? target?.extractedTextR2Key : undefined)
      && (file.previewR2Key ?? undefined) === (rehome.sourcePreviewR2Key ? target?.previewR2Key : undefined),
    );
    return {
      state: rehome.state,
      committed,
      blocked: rehome.state === "blocked",
      failureCode: rehome.failureCode,
      targetOutputAttemptId: rehome.targetOutputAttemptId,
      targetGeneration: rehome.targetGeneration,
    };
  },
});

export const retireFileDerivedArtifactRehome = mutation({
  args: {
    rehomeId: v.id("fileDerivedArtifactRehomes"),
    claimToken: v.string(),
    targetGeneration: v.number(),
    errorCode: v.optional(v.string()),
    rehomeToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireFileDerivedArtifactRehome(args.rehomeToken);
    const rehome = await ctx.db.get(args.rehomeId);
    if (!rehome) return { committed: false as const, missing: true as const };
    const receipt = await ctx.db.get(rehome.fileId);
    if (!generationMatches(rehome, args.targetGeneration)) return { committed: false as const, stale: true as const };
    if (rehome.state === "cutover") return { committed: true as const };
    if (rehome.claimToken !== boundedClaimToken(args.claimToken)) return { committed: false as const, stale: true as const };
    const now = Date.now();
    await retireAndRequeueRehomeTarget(ctx, rehome, now, args.errorCode);
    return { committed: false as const, requeued: Boolean(receipt) };
  },
});

/** A missing legacy role or a non-identical full target readback is not a
 * retryable transport hiccup. Preserve the source, retire only the unique
 * target receipt, and make the global activation proof fail closed. */
export const blockFileDerivedArtifactRehome = mutation({
  args: {
    rehomeId: v.id("fileDerivedArtifactRehomes"),
    claimToken: v.string(),
    targetGeneration: v.number(),
    failureCode: v.string(),
    rehomeToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireFileDerivedArtifactRehome(args.rehomeToken);
    const control = await controlOrThrow(ctx);
    const rehome = await ctx.db.get(args.rehomeId);
    if (!rehome) return false;
    if (!generationMatches(rehome, args.targetGeneration)) return false;
    if (rehome.state === "cutover") return false;
    if (rehome.claimToken !== boundedClaimToken(args.claimToken)) return false;
    await blockRehome(ctx, control, rehome, args.failureCode.trim() || "rehome_repair_required", Date.now());
    return true;
  },
});

/**
 * A provider-confirmed remediation for one durable legacy V1 cleanup claim.
 *
 * The migration cannot infer that an already-accepted R2 DELETE has stopped
 * from a worker lease or a queue drain. This capability-only transition is
 * deliberately narrow: an operator must first establish the provider fence
 * and repair/verify the canonical V1 source if necessary. We then mark only
 * the exact blocking cleanup history as acknowledged, restart the paginated
 * preflight from the beginning, and keep the file locked until the ordinary
 * full-readback/CAS/audit proof completes.
 */
export const acknowledgeFileDerivedArtifactRehomeCleanupHistory = mutation({
  args: {
    rehomeId: v.id("fileDerivedArtifactRehomes"),
    outputAttemptId: v.id("fileIngestOutputAttempts"),
    rehomeToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireFileDerivedArtifactRehome(args.rehomeToken);
    const control = await controlOrThrow(ctx);
    if (control.phase !== "blocked" || control.cleanupPreflightStatus !== "blocked") {
      return { resumed: false as const, reason: "cleanup_preflight_not_blocked" as const };
    }
    if (control.cleanupPreflightFailureOutputAttemptId !== args.outputAttemptId) {
      return { resumed: false as const, reason: "cleanup_history_not_current" as const };
    }
    const rehome = await ctx.db.get(args.rehomeId);
    const outputAttempt = await ctx.db.get(args.outputAttemptId);
    if (!rehome || rehome.controlKey !== FILE_DERIVED_ARTIFACT_REHOME_CONTROL_KEY || rehome.state !== "blocked") {
      return { resumed: false as const, reason: "rehome_not_blocked" as const };
    }
    if (!outputAttempt || outputAttempt.fileId !== rehome.fileId || outputAttempt.cleanupHistoryAcknowledgedRehomeId) {
      return { resumed: false as const, reason: "cleanup_history_not_current" as const };
    }
    const unsafe = await unsafeV1CleanupHistoryForRow(ctx, outputAttempt);
    if (!unsafe || unsafe.fileId !== rehome.fileId || unsafe.outputAttemptId !== outputAttempt._id) {
      return { resumed: false as const, reason: "cleanup_history_not_current" as const };
    }
    const file = await ctx.db.get(rehome.fileId);
    if (!file || !sourceTupleMatches(file, rehome)) {
      return { resumed: false as const, reason: "source_tuple_changed" as const };
    }
    const now = Date.now();
    await ctx.db.patch(outputAttempt._id, {
      cleanupHistoryAcknowledgedRehomeId: rehome._id,
      cleanupHistoryAcknowledgedAt: now,
      updatedAt: now,
    });
    await ctx.db.patch(rehome._id, {
      ...rehomeTargetResetPatch(undefined, now),
      state: "planned",
    });
    await ctx.db.patch(control._id, {
      phase: "frozen",
      // Restart the complete preflight so an acknowledgement cannot skip a
      // second historical cleaner that was added before the global freeze.
      cleanupPreflightStatus: "scanning",
      cleanupPreflightCursor: undefined,
      cleanupPreflightScannedCount: 0,
      cleanupPreflightFailureFileId: undefined,
      cleanupPreflightFailureOutputAttemptId: undefined,
      cleanupPreflightFailureCode: undefined,
      inventoryStatus: "ready",
      inventoryCursor: undefined,
      scannedCount: 0,
      blockedCount: Math.max(0, control.blockedCount - 1),
      updatedAt: now,
    });
    return { resumed: true as const, phase: "frozen" as const };
  },
});

/**
 * A blocked row is intentionally a release no-go, never an automatic retry.
 * After an operator restores/reconciles the canonical V1 source, this
 * capability-only mutation re-snapshots server-owned pointers and lets the
 * worker prove the bytes again. No caller supplies an R2 path and no prior
 * target generation is reused.
 */
export const reopenFileDerivedArtifactRehome = mutation({
  args: { rehomeId: v.id("fileDerivedArtifactRehomes"), rehomeToken: v.optional(v.string()) },
  handler: async (ctx, args) => {
    requireFileDerivedArtifactRehome(args.rehomeToken);
    const control = await controlOrThrow(ctx);
    const rehome = await ctx.db.get(args.rehomeId);
    if (!rehome || rehome.state !== "blocked") return { reopened: false as const, reason: "not_blocked" as const };
    if (rehome.failureCode?.startsWith("v1_cleanup_history_")) {
      // A logical cleanup lease is not a physical DELETE fence. This class of
      // block can resume only through the explicit provider-fence
      // acknowledgement above, which re-scans every legacy cleanup record.
      return { reopened: false as const, reason: "cleanup_history_requires_acknowledgement" as const };
    }
    const file = await ctx.db.get(rehome.fileId);
    if (!file || !terminalStatus(file.status)) {
      return { reopened: false as const, reason: "source_status_not_terminal" as const };
    }
    if (Number(file.ingestOutputProtocol ?? INGEST_OUTPUT_PROTOCOL_V1) !== INGEST_OUTPUT_PROTOCOL_V1) {
      return { reopened: false as const, reason: "source_protocol_changed" as const };
    }
    const source = sourceKeysForFile(file);
    if (!source.valid) return { reopened: false as const, reason: source.reason };
    const now = Date.now();
    const blockedCount = Math.max(0, control.blockedCount - 1);
    if (file.status === "deleted" || (!source.extractedTextR2Key && !source.previewR2Key)) {
      if (file.status === "deleted" && (source.extractedTextR2Key || source.previewR2Key)) {
        const detached = {
          ...rehome,
          sourceIngestVersion: file.ingestVersion,
          sourceExtractedTextR2Key: source.extractedTextR2Key,
          sourcePreviewR2Key: source.previewR2Key,
        };
        await createLegacySourceSweeper(ctx, detached, now);
      }
      await ctx.db.patch(file._id, {
        extractedTextR2Key: undefined,
        previewR2Key: undefined,
        ingestOutputProtocol: INGEST_OUTPUT_PROTOCOL_V2,
        ingestOutputAttemptId: undefined,
        derivedArtifactRehomeId: undefined,
        updatedAt: now,
      });
      await ctx.db.patch(rehome._id, {
        sourceIngestVersion: file.ingestVersion,
        sourceFileUpdatedAt: file.updatedAt,
        sourceStatus: file.status,
        sourceExtractedTextR2Key: source.extractedTextR2Key,
        sourcePreviewR2Key: source.previewR2Key,
        state: "cutover",
        claimToken: undefined,
        claimExpiresAt: undefined,
        failureCode: undefined,
        updatedAt: now,
      });
      await ctx.db.patch(control._id, {
        phase: "rehoming",
        blockedCount,
        cutoverCount: control.cutoverCount + 1,
        ...(control.auditStatus === "blocked"
          ? {
            auditStatus: "pending" as const,
            auditCursor: undefined,
            auditScannedCount: 0,
            auditFailureFileId: undefined,
            auditFailureCode: undefined,
          }
          : {}),
        updatedAt: now,
      });
      return { reopened: true as const, cutover: true as const };
    }
    const needsLock = file.derivedArtifactRehomeId !== rehome._id;
    if (needsLock) await ctx.db.patch(file._id, { derivedArtifactRehomeId: rehome._id, updatedAt: now });
    const sourceFileUpdatedAt = needsLock ? now : file.updatedAt;
    await ctx.db.patch(rehome._id, {
      sourceIngestVersion: file.ingestVersion,
      sourceFileUpdatedAt,
      sourceStatus: file.status,
      sourceExtractedTextR2Key: source.extractedTextR2Key,
      sourcePreviewR2Key: source.previewR2Key,
      state: "planned",
      claimToken: undefined,
      claimExpiresAt: undefined,
      targetOutputAttemptId: undefined,
      targetOutputAttemptOutboxId: undefined,
      targetExtractedTextR2Key: undefined,
      targetPreviewR2Key: undefined,
      extractedTextWriteStarted: undefined,
      previewWriteStarted: undefined,
      sourceExtractedTextSha256: undefined,
      sourcePreviewSha256: undefined,
      targetExtractedTextSha256: undefined,
      targetPreviewSha256: undefined,
      sourceExtractedTextBytes: undefined,
      sourcePreviewBytes: undefined,
      targetExtractedTextBytes: undefined,
      targetPreviewBytes: undefined,
      failureCode: undefined,
      updatedAt: now,
    });
    await ctx.db.patch(control._id, {
      phase: "rehoming",
      blockedCount,
      ...(control.auditStatus === "blocked"
        ? {
          auditStatus: "pending" as const,
          auditCursor: undefined,
          auditScannedCount: 0,
          auditFailureFileId: undefined,
          auditFailureCode: undefined,
        }
        : {}),
      updatedAt: now,
    });
    return { reopened: true as const, cutover: false as const };
  },
});

function auditIssueForFile(file: any): string | null {
  if (!terminalStatus(file.status)) return "audit_status_not_terminal";
  const protocol = Number(file.ingestOutputProtocol ?? INGEST_OUTPUT_PROTOCOL_V1);
  let v1: { extractedTextR2Key: string; previewR2Key: string };
  try {
    v1 = canonicalDerivedArtifactKeys(file._id, file.ingestVersion, INGEST_OUTPUT_PROTOCOL_V1);
  } catch {
    return "audit_source_identity_invalid";
  }
  // The protocol field is not itself a pointer fence. A corrupt V2-labelled
  // row may still reference the shared V1 path, which a legacy sweeper can
  // delete after activation. Reject that exact shape before considering its
  // advertised protocol.
  if (file.extractedTextR2Key === v1.extractedTextR2Key || file.previewR2Key === v1.previewR2Key) {
    return "terminal_v1_pointer_remaining";
  }
  if (protocol === INGEST_OUTPUT_PROTOCOL_V1) {
    const source = sourceKeysForFile(file);
    if (!source.valid) return source.reason;
    return "terminal_v1_protocol_remaining";
  }
  if (protocol !== INGEST_OUTPUT_PROTOCOL_V2) return "audit_output_protocol_invalid";
  const hasPointer = Boolean(file.extractedTextR2Key || file.previewR2Key);
  if (!hasPointer) return null;
  try {
    const v2 = canonicalDerivedArtifactKeys(
      file._id,
      file.ingestVersion,
      INGEST_OUTPUT_PROTOCOL_V2,
      String(file.ingestOutputAttemptId ?? ""),
    );
    if (
      (file.extractedTextR2Key && file.extractedTextR2Key !== v2.extractedTextR2Key)
      || (file.previewR2Key && file.previewR2Key !== v2.previewR2Key)
    ) return "audit_v2_pointer_invalid";
  } catch {
    return "audit_v2_pointer_identity_invalid";
  }
  return null;
}

async function blockAuditOnFile(ctx: { db: any }, control: any, file: any, failureCode: string, now: number) {
  const prior = await ctx.db
    .query("fileDerivedArtifactRehomes")
    .withIndex("by_file", (q: any) => q.eq("fileId", file._id))
    .first();
  let snapshotAdded = 0;
  let blockedAdded = 0;
  let cutoverRemoved = 0;
  if (!prior) {
    const source = sourceKeysForFile(file);
    await ctx.db.insert("fileDerivedArtifactRehomes", {
      controlKey: FILE_DERIVED_ARTIFACT_REHOME_CONTROL_KEY,
      fileId: file._id,
      sourceIngestVersion: file.ingestVersion,
      sourceFileUpdatedAt: file.updatedAt,
      sourceStatus: file.status,
      sourceExtractedTextR2Key: source.valid ? source.extractedTextR2Key : undefined,
      sourcePreviewR2Key: source.valid ? source.previewR2Key : undefined,
      targetGeneration: 0,
      state: "blocked",
      failureCode,
      createdAt: now,
      updatedAt: now,
    });
    snapshotAdded = 1;
    blockedAdded = 1;
  } else if (prior.state !== "blocked") {
    if (prior.state === "cutover") cutoverRemoved = 1;
    await ctx.db.patch(prior._id, {
      state: "blocked",
      claimToken: undefined,
      claimExpiresAt: undefined,
      failureCode,
      updatedAt: now,
    });
    blockedAdded = 1;
  }
  await ctx.db.patch(control._id, {
    phase: "blocked",
    auditStatus: "blocked",
    auditFailureFileId: file._id,
    auditFailureCode: failureCode,
    snapshotCount: control.snapshotCount + snapshotAdded,
    cutoverCount: Math.max(0, control.cutoverCount - cutoverRemoved),
    blockedCount: control.blockedCount + blockedAdded,
    updatedAt: now,
  });
}

/**
 * Recheck every row through a second durable cursor after the inventory has
 * sealed and each manifest reports cutover. This is the server-side proof
 * used by activation, not an operator count or a fixed library-size cap.
 */
export const advanceFileDerivedArtifactRehomeAudit = mutation({
  args: { limit: v.optional(v.number()), rehomeToken: v.optional(v.string()) },
  handler: async (ctx, args) => {
    requireFileDerivedArtifactRehome(args.rehomeToken);
    const control = await controlOrThrow(ctx);
    const auditStatus = control.auditStatus ?? "pending";
    if (control.phase === "blocked" || control.phase === "active" || control.phase === "ready") {
      return { phase: control.phase, status: auditStatus, scanned: 0, isDone: auditStatus === "complete" };
    }
    if (control.phase !== "rehoming" || control.inventoryStatus !== "complete") {
      return { phase: control.phase, status: auditStatus, scanned: 0, isDone: false };
    }
    if ((control.cleanupPreflightStatus ?? "pending") !== "complete") {
      return { phase: control.phase, status: auditStatus, scanned: 0, isDone: false, reason: "cleanup_preflight_pending" as const };
    }
    for (const state of ["planned", "copying", "verified", "blocked"]) {
      if (await firstNonCutoverRehome(ctx, state)) {
        return { phase: control.phase, status: auditStatus, scanned: 0, isDone: false, pendingState: state };
      }
    }
    if (control.snapshotCount !== control.cutoverCount || control.blockedCount > 0) {
      return { phase: control.phase, status: auditStatus, scanned: 0, isDone: false, reason: "inventory_count_mismatch" };
    }
    if (auditStatus === "complete") return { phase: control.phase, status: "complete" as const, scanned: 0, isDone: true };
    const limit = Math.min(32, Math.max(1, Math.floor(args.limit ?? 12)));
    const page = await ctx.db
      .query("files")
      .withIndex("by_updatedAt")
      .order("asc")
      .paginate({ cursor: control.auditCursor ?? null, numItems: limit, maximumRowsRead: limit });
    const now = Date.now();
    for (const file of page.page) {
      const issue = auditIssueForFile(file);
      if (issue) {
        await blockAuditOnFile(ctx, control, file, issue, now);
        return { phase: "blocked" as const, status: "blocked" as const, scanned: 0, isDone: false, failureCode: issue, fileId: String(file._id) };
      }
    }
    const status = page.isDone ? "complete" : "scanning";
    await ctx.db.patch(control._id, {
      auditStatus: status,
      auditCursor: page.isDone ? undefined : page.continueCursor,
      auditScannedCount: Number(control.auditScannedCount ?? 0) + page.page.length,
      updatedAt: now,
    });
    return { phase: control.phase, status, scanned: page.page.length, isDone: page.isDone };
  },
});

async function firstNonCutoverRehome(ctx: { db: any }, state: string) {
  return await ctx.db
    .query("fileDerivedArtifactRehomes")
    .withIndex("by_control_state", (q: any) => q.eq("controlKey", FILE_DERIVED_ARTIFACT_REHOME_CONTROL_KEY).eq("state", state))
    .first();
}

/** Server-side readiness proof for the irreversible V2 activation. No caller
 * can replace this with a boolean: inventory must be sealed, every manifest
 * cut over, and the durable full-library audit must find zero V1 pointers. */
export const finalizeFileDerivedArtifactRehome = mutation({
  args: { rehomeToken: v.optional(v.string()) },
  handler: async (ctx, args) => {
    requireFileDerivedArtifactRehome(args.rehomeToken);
    const control = await controlOrThrow(ctx);
    if (control.phase === "active") return { ready: true as const, active: true as const };
    if (control.phase === "blocked") return { ready: false as const, blocked: true as const };
    if (control.phase !== "rehoming" || control.inventoryStatus !== "complete") return { ready: false as const, phase: control.phase };
    if ((control.cleanupPreflightStatus ?? "pending") !== "complete") {
      return { ready: false as const, reason: "cleanup_preflight_pending" as const };
    }
    for (const state of ["planned", "copying", "verified", "blocked"]) {
      const pending = await firstNonCutoverRehome(ctx, state);
      if (pending) {
        if (state === "blocked") await ctx.db.patch(control._id, { phase: "blocked", updatedAt: Date.now() });
        return { ready: false as const, pendingState: state };
      }
    }
    if (control.snapshotCount !== control.cutoverCount || control.blockedCount > 0) {
      return { ready: false as const, reason: "inventory_count_mismatch" as const };
    }
    if ((control.auditStatus ?? "pending") !== "complete") {
      return { ready: false as const, reason: "audit_pending" as const, auditStatus: control.auditStatus ?? "pending" };
    }
    await ctx.db.patch(control._id, { phase: "ready", updatedAt: Date.now() });
    return { ready: true as const };
  },
});

/** Used only by V2 activation. It repeats the durable proof rather than
 * trusting a prior controller response or an operator-supplied drain flag. */
export async function assertFileDerivedArtifactRehomeReady(ctx: { db: any }) {
  const control = await fileDerivedArtifactRehomeControl(ctx);
  if (!control || control.phase !== "ready") {
    throw new ConvexError({ code: "FILE_DERIVED_REHOME_NOT_READY", message: "File-derived artifact rehome is not ready for activation" });
  }
  if (
    control.inventoryStatus !== "complete"
    || (control.cleanupPreflightStatus ?? "pending") !== "complete"
    || control.snapshotCount !== control.cutoverCount
    || control.blockedCount > 0
    || (control.auditStatus ?? "pending") !== "complete"
  ) {
    throw new ConvexError({ code: "FILE_DERIVED_REHOME_NOT_READY", message: "File-derived artifact rehome proof is incomplete" });
  }
  for (const state of ["planned", "copying", "verified", "blocked"]) {
    if (await firstNonCutoverRehome(ctx, state)) {
      throw new ConvexError({ code: "FILE_DERIVED_REHOME_NOT_READY", message: "File-derived artifact rehome still has pending work" });
    }
  }
  return control;
}
