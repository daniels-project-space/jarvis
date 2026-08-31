import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { paginationOptsValidator } from "convex/server";
import { actorAuthArgs, requireActor, requireFileDerivedArtifactRehome, requireViewer, requireWorker, viewerAuthArgs } from "./controlAuth";
import {
  CHAT_FILE_LIMITS,
  FILE_READY_STATUSES,
  normalizeRelativeUploadPath,
  normalizeUploadMime,
  normalizeUploadName,
  normalizeUploadSha256,
  privateFileSourceKey,
} from "../src/lib/chat-files";
import { visibleTurnText } from "../src/lib/host-context";
import { messageFileManifests } from "./fileHelpers";
import {
  fileDerivedArtifactRehomeControl,
  FILE_DERIVED_ARTIFACT_REHOME_RETRY_AFTER_MS,
  rehomeBlocksNormalFileMutation,
} from "./fileDerivedArtifactRehomeProtocol";
import { assertFileDerivedArtifactRehomeReady } from "./fileDerivedArtifactRehomes";

const uploadDescriptor = v.object({
  clientId: v.string(),
  name: v.string(),
  relativePath: v.string(),
  mimeType: v.string(),
  sizeBytes: v.number(),
  sha256: v.string(),
});

const fileReviewState = v.union(
  v.literal("unreviewed"),
  v.literal("favorite"),
  v.literal("review_remove"),
);

const libraryReviewFilter = v.union(
  v.literal("favorite"),
  v.literal("review_remove"),
);

const extractedChunk = v.object({
  ordinal: v.number(),
  text: v.string(),
  page: v.optional(v.number()),
  sheet: v.optional(v.string()),
  cellRange: v.optional(v.string()),
});

const INGEST_CLAIM_STALE_MS = 90_000;
export const INGEST_OUTPUT_PROTOCOL_V2 = 2;
const INGEST_OUTPUT_PROTOCOL_V1 = 1;
// Trigger's configured duration is intentionally not an R2 fence. This is a
// compatibility drain only: V2 output paths are unique even if a legacy
// worker wakes after this window. Known V1 paths remain sweepable instead of
// being treated as absent merely because a clock elapsed.
export const LEGACY_V1_OUTPUT_DRAIN_MS = 6 * 60_000;
// This schedules recovery; it is deliberately not a proof that an accepted
// private-R2 PUT cannot still land after the worker lease expires.
export const INGEST_OUTPUT_PRODUCER_WINDOW_MS = 6 * 60_000;
const INGEST_OUTPUT_CLEANUP_LEASE_MS = 60_000;
const LEGACY_OUTPUT_SWEEP_INTERVAL_MS = 2 * 60 * 60_000;
const INGEST_OUTPUT_ATTEMPT_ID = /^[a-zA-Z0-9_-]{16,180}$/;
const INGEST_OUTPUT_PROTOCOL_ROLLOUT = "file-ingest-output-protocol-v2";
// This fence only covers the final source validation through app-server model
// admission. It is deliberately much shorter than a foreground turn and is
// normally released as soon as `turn/start` is accepted.
export const TURN_FILE_LEASE_MS = 120_000;
const TURN_FILE_LEASE_ID = /^[a-zA-Z0-9_-]{16,120}$/;
const TURN_FILE_SOURCE_KEY_MAX_CHARS = 1_024;

/**
 * During the V1-to-V2 artifact rehome, a normal mutation must not change a
 * file tuple behind the migration CAS or hand a legacy source key to a direct
 * cleanup task. The rehome module itself uses separate, narrowly-scoped
 * mutations and capability; this guard intentionally applies only here.
 */
async function assertNormalFileMutationAllowed(ctx: { db: any }) {
  const control = await fileDerivedArtifactRehomeControl(ctx);
  if (rehomeBlocksNormalFileMutation(control)) {
    throw new ConvexError({
      code: "FILE_DERIVED_REHOME_ACTIVE",
      message: "Private-file changes are temporarily frozen while derived artifacts are rehomed",
    });
  }
}

async function activeDerivedArtifactRehomeRetryAfter(ctx: { db: any }, file: any): Promise<number | null> {
  if (!file?.derivedArtifactRehomeId) return null;
  const rehome = await ctx.db.get(file.derivedArtifactRehomeId);
  if (!rehome || rehome.state === "cutover") return null;
  // Do not let generic file cleanup infer either a V1 source or an abandoned
  // V2 generation while this row is migration-owned. A dedicated receipt
  // cleanup owns targets, and the source is only swept after the pointer CAS.
  return FILE_DERIVED_ARTIFACT_REHOME_RETRY_AFTER_MS;
}

function ownerThread(value: string | undefined): string {
  const threadId = value?.trim() || "main";
  if (!threadId || threadId.length > 120 || threadId.startsWith("guest:")) {
    throw new ConvexError({ code: "INVALID_FILE_THREAD", message: "Private files require an owner chat" });
  }
  return threadId;
}

function boundedRequestId(value: string): string {
  const requestId = value.trim();
  if (!/^[a-zA-Z0-9:_-]{8,120}$/.test(requestId)) {
    throw new ConvexError({ code: "INVALID_UPLOAD_REQUEST", message: "Upload request identity is invalid" });
  }
  return requestId;
}

function boundedTurnLeaseId(value: string): string {
  const leaseId = value.trim();
  if (!TURN_FILE_LEASE_ID.test(leaseId)) {
    throw new ConvexError({ code: "INVALID_FILE_LEASE", message: "Private file lease identity is invalid" });
  }
  return leaseId;
}

function boundedTurnSourceKey(value: string): string {
  if (!value || value.length > TURN_FILE_SOURCE_KEY_MAX_CHARS) {
    throw new ConvexError({ code: "INVALID_FILE_LEASE", message: "Private file source identity is invalid" });
  }
  return value;
}

function validatedDescriptor(input: {
  clientId: string;
  name: string;
  relativePath: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
}) {
  const clientId = input.clientId.trim().slice(0, 120);
  const name = normalizeUploadName(input.name);
  const relativePath = name ? normalizeRelativeUploadPath(input.relativePath, name) : null;
  const sha256 = normalizeUploadSha256(input.sha256);
  if (!clientId || !name || !relativePath || !sha256) {
    throw new ConvexError({ code: "INVALID_UPLOAD_FILE", message: "Upload metadata is invalid" });
  }
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes <= 0 || input.sizeBytes > CHAT_FILE_LIMITS.maxFileBytes) {
    throw new ConvexError({ code: "INVALID_UPLOAD_SIZE", message: "File size is outside the upload limit" });
  }
  return {
    clientId,
    name,
    relativePath,
    mimeType: normalizeUploadMime(input.mimeType),
    sizeBytes: input.sizeBytes,
    sha256,
  };
}

function publicFile(row: any) {
  return {
    fileId: String(row._id),
    name: row.originalName,
    relativePath: row.relativePath,
    mimeType: row.detectedMimeType ?? row.mimeType,
    sizeBytes: row.sizeBytes,
    status: row.status,
    summary: row.summary,
    extractedChars: row.extractedChars,
    chunkCount: row.chunkCount,
    pageCount: row.pageCount,
    sheetNames: row.sheetNames,
    errorCode: row.errorCode,
    reviewState: row.reviewState ?? "unreviewed",
    tags: Array.isArray(row.tags) ? row.tags : [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const WORKSPACE_DOCUMENT_MAX_CHARS = 120_000;
const WORKSPACE_TEXT_MIME = /^(?:text\/|application\/(?:json|xml|yaml|x-yaml|javascript|typescript|x-httpd-php))/i;

function workspaceFileName(value: string): string {
  const name = value.trim().replace(/[\\/\u0000-\u001f\u007f]/g, "_").replace(/\s+/g, " ").slice(0, 180);
  if (!name || name === "." || name === "..") {
    throw new ConvexError({ code: "INVALID_FILE_NAME", message: "File name is invalid" });
  }
  return name;
}

function workspaceFolderPath(value: string): string {
  const parts = value.replace(/\\/g, "/").split("/").map((part) => part.trim()).filter(Boolean);
  if (parts.length > 12 || parts.some((part) => part === "." || part === ".." || /[\u0000-\u001f\u007f]/.test(part))) {
    throw new ConvexError({ code: "INVALID_FOLDER_PATH", message: "Folder path is invalid" });
  }
  const path = parts.join("/").slice(0, 480);
  if (parts.join("/") !== path) throw new ConvexError({ code: "INVALID_FOLDER_PATH", message: "Folder path is too long" });
  return path;
}

function workspaceTags(values: string[]): string[] {
  const tags = [...new Set(values.map((tag) => tag.trim().replace(/\s+/g, " ").slice(0, 32)).filter(Boolean))];
  if (tags.length > 12) throw new ConvexError({ code: "INVALID_FILE_TAGS", message: "A file can have at most 12 tags" });
  return tags;
}

function workspaceSearchText(file: any, name: string, relativePath: string, tags: string[]): string {
  return [name, relativePath, tags.join(" "), String(file.summary ?? "")].filter(Boolean).join(" ").slice(0, 8_000);
}

function legacyOutputMayBeUncommitted(file: any): boolean {
  if (
    Number(file.ingestOutputProtocol ?? INGEST_OUTPUT_PROTOCOL_V1) !== INGEST_OUTPUT_PROTOCOL_V1
    || Number(file.ingestAttempt ?? 0) < 1
  ) return false;
  if (["processing", "error", "quarantined"].includes(String(file.status))) return true;
  if (file.status === "stored_only") {
    return !file.extractedTextR2Key && !file.previewR2Key;
  }
  if (file.status === "deleting") {
    const prior = String(file.deletePreviousStatus ?? "");
    if (["processing", "error", "quarantined"].includes(prior)) return true;
    if (prior === "stored_only") return !file.extractedTextR2Key && !file.previewR2Key;
  }
  return false;
}

function cleanupKeysForFile(file: any): string[] {
  if (file?.derivedArtifactRehomeId) {
    // A migration-owned file has an old V1 source plus a not-yet-referenced
    // V2 target that this generic helper cannot reason about. Its dedicated
    // protocol owns both; exposing either here would hand an old cleanup task
    // a destructive key during a pointer migration.
    return [];
  }
  const prefix = `owners/daniel/files/${String(file._id)}/v${Number(file.ingestVersion)}`;
  const legacyIngestMayWrite = legacyOutputMayBeUncommitted(file);
  return [...new Set([
    String(file.r2Key),
    legacyIngestMayWrite
      ? undefined
      : file.extractedTextR2Key
      ? String(file.extractedTextR2Key)
      : Number(file.ingestOutputProtocol ?? INGEST_OUTPUT_PROTOCOL_V1) === INGEST_OUTPUT_PROTOCOL_V1
        ? `${prefix}/extracted.txt`
        : undefined,
    legacyIngestMayWrite
      ? undefined
      : file.previewR2Key
      ? String(file.previewR2Key)
      : Number(file.ingestOutputProtocol ?? INGEST_OUTPUT_PROTOCOL_V1) === INGEST_OUTPUT_PROTOCOL_V1
        ? `${prefix}/preview.webp`
        : undefined,
  ].filter((key): key is string => Boolean(key)))];
}

type IngestCommitFile = Pick<
  Doc<"files">,
  "ingestVersion" | "status" | "extractedTextR2Key" | "previewR2Key" | "ingestOutputAttemptId"
>;

type DerivedOutputKeys = { extractedTextR2Key: string; previewR2Key: string };

function outputAttemptId(ingestAttempt: number, claimToken: string): string {
  const token = claimToken.trim();
  if (!/^[a-zA-Z0-9_-]{16,120}$/.test(token) || !Number.isSafeInteger(ingestAttempt) || ingestAttempt < 1) {
    throw new ConvexError({ code: "INGEST_OUTPUT_ATTEMPT", message: "V2 ingest output identity is invalid" });
  }
  const attemptId = `${ingestAttempt}-${token}`;
  if (!INGEST_OUTPUT_ATTEMPT_ID.test(attemptId)) {
    throw new ConvexError({ code: "INGEST_OUTPUT_ATTEMPT", message: "V2 ingest output identity is invalid" });
  }
  return attemptId;
}

function derivedOutputKeys(fileId: unknown, ingestVersion: number, outputProtocol: number, attemptId: string): DerivedOutputKeys {
  const id = String(fileId).trim();
  if (!/^[a-zA-Z0-9_-]+$/.test(id) || !Number.isSafeInteger(ingestVersion) || ingestVersion < 1) {
    throw new ConvexError({ code: "INGEST_OUTPUT_KEY", message: "Derived output identity is invalid" });
  }
  if (outputProtocol === INGEST_OUTPUT_PROTOCOL_V1) {
    return {
      extractedTextR2Key: `owners/daniel/files/${id}/v${ingestVersion}/extracted.txt`,
      previewR2Key: `owners/daniel/files/${id}/v${ingestVersion}/preview.webp`,
    };
  }
  if (outputProtocol !== INGEST_OUTPUT_PROTOCOL_V2 || !INGEST_OUTPUT_ATTEMPT_ID.test(attemptId)) {
    throw new ConvexError({ code: "INGEST_OUTPUT_KEY", message: "Derived output identity is invalid" });
  }
  return {
    extractedTextR2Key: `owners/daniel/files/${id}/v${ingestVersion}/a${attemptId}/extracted.txt`,
    previewR2Key: `owners/daniel/files/${id}/v${ingestVersion}/a${attemptId}/preview.webp`,
  };
}

function legacyBridgeAttemptId(file: any): string {
  const token = String(file.ingestClaimToken ?? "unknown").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120) || "unknown";
  return `legacy-${Math.max(1, Number(file.ingestAttempt ?? 1))}-${token}`.slice(0, 180);
}

function legacyProducerMayWriteUntil(file: any, now: number): number {
  const known = Number(file.ingestOutputMayWriteUntil ?? 0);
  const lastProgressAt = Number(file.lastProgressAt ?? now);
  const fromProgress = Number.isFinite(lastProgressAt)
    ? lastProgressAt + LEGACY_V1_OUTPUT_DRAIN_MS
    : now + LEGACY_V1_OUTPUT_DRAIN_MS;
  return Math.max(known, fromProgress);
}

async function ingestOutputProtocolRollout(ctx: { db: any }) {
  return await ctx.db
    .query("workerProtocolRollouts")
    .withIndex("by_key", (q: any) => q.eq("key", INGEST_OUTPUT_PROTOCOL_ROLLOUT))
    .first();
}

async function pendingIngestWakeups(ctx: { db: any }, limit: number, now = Date.now()) {
  const boundedLimit = Math.min(64, Math.max(1, Math.floor(limit)));
  const [uploaded, failed, processing] = await Promise.all([
    ctx.db.query("files").withIndex("by_status_updated", (q: any) => q.eq("status", "uploaded")).order("asc").take(boundedLimit),
    ctx.db.query("files").withIndex("by_status_updated", (q: any) => q.eq("status", "error")).order("asc").take(boundedLimit),
    ctx.db.query("files").withIndex("by_status_updated", (q: any) => q.eq("status", "processing")).order("asc").take(boundedLimit),
  ]);
  const staleBefore = now - INGEST_CLAIM_STALE_MS;
  return [...uploaded, ...failed, ...processing]
    .filter((file) => file.ingestAttempt < 3 && (file.status !== "processing" || Number(file.lastProgressAt ?? 0) <= staleBefore))
    .slice(0, boundedLimit)
    .map((file) => ({ fileId: String(file._id), ingestVersion: file.ingestVersion }));
}

function outboxOutputKeys(outbox: any): DerivedOutputKeys {
  const expected = derivedOutputKeys(outbox.fileId, outbox.ingestVersion, outbox.outputProtocol, outbox.outputAttemptId);
  if (
    outbox.extractedTextR2Key !== expected.extractedTextR2Key
    || outbox.previewR2Key !== expected.previewR2Key
  ) {
    // The worker capability must never become an arbitrary R2 deletion API,
    // even if a malformed durable row somehow reaches the cleanup task.
    throw new ConvexError({ code: "INGEST_OUTPUT_KEY", message: "Derived output cleanup key is invalid" });
  }
  return expected;
}

/**
 * A V1 bridge records the exact roles ever handed to a legacy R2 DELETE
 * worker. Historical rows without the fields are conservatively a full pair;
 * only an explicit `false` proves that a role cannot be deleted by that
 * bridge. This prevents a preview-only stale cleanup from later reaping a
 * live text pointer that happens to share the same vN namespace.
 */
function outputAttemptCleanupKeys(outbox: any): string[] {
  const keys = outboxOutputKeys(outbox);
  if (outbox.outputProtocol !== INGEST_OUTPUT_PROTOCOL_V1) return Object.values(keys);
  const cleanupKeys: string[] = [];
  if (outbox.cleanupExtractedText !== false) cleanupKeys.push(keys.extractedTextR2Key);
  if (outbox.cleanupPreview !== false) cleanupKeys.push(keys.previewR2Key);
  return cleanupKeys;
}

function safeV1OutputAttemptCleanupKeys(file: any, outbox: any): string[] {
  const keys = outputAttemptCleanupKeys(outbox);
  if (
    outbox.outputProtocol !== INGEST_OUTPUT_PROTOCOL_V1
    || !file
    || file.ingestVersion !== outbox.ingestVersion
    || !["ready", "stored_only", "error", "quarantined"].includes(file.status)
  ) return keys;
  const referenced = new Set(
    [file.extractedTextR2Key, file.previewR2Key].filter((key): key is string => Boolean(key)),
  );
  return keys.filter((key) => !referenced.has(key));
}

function legacyDerivedCleanupKeys(record: {
  fileId: unknown;
  ingestVersion: number;
  extractedTextR2Key?: string;
  previewR2Key?: string;
}): string[] {
  const expected = derivedOutputKeys(record.fileId, record.ingestVersion, INGEST_OUTPUT_PROTOCOL_V1, "legacy");
  const keys: string[] = [];
  if (record.extractedTextR2Key !== undefined) {
    if (record.extractedTextR2Key !== expected.extractedTextR2Key) {
      throw new ConvexError({ code: "INGEST_OUTPUT_KEY", message: "Legacy extracted cleanup key is invalid" });
    }
    keys.push(expected.extractedTextR2Key);
  }
  if (record.previewR2Key !== undefined) {
    if (record.previewR2Key !== expected.previewR2Key) {
      throw new ConvexError({ code: "INGEST_OUTPUT_KEY", message: "Legacy preview cleanup key is invalid" });
    }
    keys.push(expected.previewR2Key);
  }
  if (new Set(keys).size !== keys.length) {
    throw new ConvexError({ code: "INGEST_OUTPUT_KEY", message: "Legacy cleanup key roles are duplicated" });
  }
  return keys;
}

async function outputAttemptsForVersion(ctx: { db: any }, fileId: any, ingestVersion: number): Promise<any[]> {
  return await ctx.db
    .query("fileIngestOutputAttempts")
    .withIndex("by_file_version", (q: any) => q.eq("fileId", fileId).eq("ingestVersion", ingestVersion))
    .take(8);
}

function legacyBridgeMarker(rows: any[]): any | null {
  return rows.find((row) => row.outputProtocol === INGEST_OUTPUT_PROTOCOL_V1) ?? null;
}

function v2OutputAttempt(rows: any[], attemptId: string): any | null {
  return rows.find((row) => row.outputProtocol === INGEST_OUTPUT_PROTOCOL_V2 && row.outputAttemptId === attemptId) ?? null;
}

async function startLegacyBridgeMarker(
  ctx: { db: any },
  file: any,
  claimToken: string,
  now: number,
  cleanupKeys?: readonly string[],
) {
  const rows = await outputAttemptsForVersion(ctx, file._id, file.ingestVersion);
  const existing = legacyBridgeMarker(rows);
  if (existing) return existing;
  const outputAttemptId = legacyBridgeAttemptId({ ...file, ingestClaimToken: claimToken });
  const keys = derivedOutputKeys(file._id, file.ingestVersion, INGEST_OUTPUT_PROTOCOL_V1, outputAttemptId);
  const cleanupSet = cleanupKeys ? new Set(cleanupKeys) : null;
  const producerMayWriteUntil = legacyProducerMayWriteUntil(file, now);
  const id = await ctx.db.insert("fileIngestOutputAttempts", {
    fileId: file._id,
    ingestVersion: file.ingestVersion,
    outputProtocol: INGEST_OUTPUT_PROTOCOL_V1,
    outputAttemptId,
    claimToken,
    extractedTextR2Key: keys.extractedTextR2Key,
    previewR2Key: keys.previewR2Key,
    producerMayWriteUntil,
    state: "active",
    writerHandoff: false,
    writeStarted: false,
    cleanupExtractedText: cleanupSet ? cleanupSet.has(keys.extractedTextR2Key) : true,
    cleanupPreview: cleanupSet ? cleanupSet.has(keys.previewR2Key) : true,
    nextCleanupAt: producerMayWriteUntil,
    sweepCount: 0,
    createdAt: now,
    updatedAt: now,
  });
  return await ctx.db.get(id);
}

async function moveLegacyBridgeToSweep(ctx: { db: any }, outbox: any, now: number) {
  if (outbox.outputProtocol !== INGEST_OUTPUT_PROTOCOL_V1 || outbox.state === "legacy_sweeping") return;
  await ctx.db.patch(outbox._id, {
    state: "legacy_sweeping",
    // An ordinary V1 ingest attempt can have issued either deterministic
    // role. Unlike a bridge created from a filtered stale cleanup pair, it
    // carries no role-subset proof and must remain conservative.
    cleanupExtractedText: true,
    cleanupPreview: true,
    cleanupClaimToken: undefined,
    cleanupClaimExpiresAt: undefined,
    nextCleanupAt: now,
    updatedAt: now,
  });
}

async function transferOutputAttemptToCleanup(ctx: { db: any }, file: any, now: number) {
  const outputAttemptId = String(file.ingestOutputAttemptId ?? "");
  const outputProtocol = Number(file.ingestOutputProtocol ?? INGEST_OUTPUT_PROTOCOL_V1);
  if (outputProtocol === INGEST_OUTPUT_PROTOCOL_V2 && !outputAttemptId) return;
  const attempts = await outputAttemptsForVersion(ctx, file._id, file.ingestVersion);
  const outbox = outputProtocol === INGEST_OUTPUT_PROTOCOL_V2
    ? v2OutputAttempt(attempts, outputAttemptId)
    // V1 has no per-write receipt. A pre-compat worker can reach this new
    // terminal mutation after an accepted R2 PUT response was lost, so mint
    // the shared-pair bridge even when no prior V2-era marker exists.
    : legacyBridgeMarker(attempts) ?? await startLegacyBridgeMarker(ctx, file, String(file.ingestClaimToken ?? "legacy"), now);
  if (!outbox || outbox.state !== "active") return;
  await ctx.db.patch(outbox._id, {
    state: "cleanup",
    // This path runs only after the exact worker made a terminal Convex
    // callback. Unlike an expired lease, that is a durable no-more-writes
    // handoff and lets cleanup consume the attempt after R2 deletion.
    writerHandoff: true,
    cleanupClaimToken: undefined,
    cleanupClaimExpiresAt: undefined,
    nextCleanupAt: now,
    updatedAt: now,
  });
}

function matchesIngestCommit(
  file: IngestCommitFile | null,
  expected: { ingestVersion: number; extractedTextR2Key?: string; previewR2Key?: string; outputAttemptId?: string },
): boolean {
  return Boolean(
    file
    && file.ingestVersion === expected.ingestVersion
    && (file.status === "ready" || file.status === "stored_only")
    && (file.extractedTextR2Key ?? undefined) === expected.extractedTextR2Key
    && (file.previewR2Key ?? undefined) === expected.previewR2Key
    && (expected.outputAttemptId === undefined || file.ingestOutputAttemptId === expected.outputAttemptId),
  );
}

/**
 * A deleting row may still have a live ingestion worker which can be between
 * writing deterministic derived objects and recording them in Convex. Keep
 * the durable deletion outbox open until that claim can no longer write.
 */
async function activeIngestCleanupRetryAfter(ctx: { db: any }, file: any, now: number): Promise<number | null> {
  const isIngesting = file.status === "processing"
    || (file.status === "deleting" && file.deletePreviousStatus === "processing");
  if (!isIngesting && legacyOutputMayBeUncommitted(file)) {
    // A terminal V1 error has no durable prewrite receipt. Its worker may
    // have obtained an R2 PUT success after the callback that cleared the
    // claim, so retain the exact shared pair as a permanent reaper before a
    // V2 retry or file deletion exposes any direct cleanup keys.
    let marker = legacyBridgeMarker(await outputAttemptsForVersion(ctx, file._id, file.ingestVersion));
    marker = marker ?? await startLegacyBridgeMarker(ctx, file, String(file.ingestClaimToken ?? "legacy"), now);
    if (marker) await moveLegacyBridgeToSweep(ctx, marker, now);
    return null;
  }
  if (!isIngesting) return null;
  if (
    Number(file.ingestOutputProtocol ?? INGEST_OUTPUT_PROTOCOL_V1) === INGEST_OUTPUT_PROTOCOL_V2
    && file.ingestOutputAttemptId
  ) {
    const attempts = await outputAttemptsForVersion(ctx, file._id, file.ingestVersion);
    const outputAttempt = v2OutputAttempt(attempts, file.ingestOutputAttemptId);
    if (outputAttempt) {
      if (outputAttempt.state === "active" && outputAttempt.producerMayWriteUntil > now) {
        return Math.max(1, outputAttempt.producerMayWriteUntil - now);
      }
      // The exact attempt outbox now owns cleanup. Once there is no live
      // producer window, file deletion may finish without guessing a V1 vN
      // path; the durable attempt row remains scheduled until it is safe to
      // consume (or keeps sweeping after an uncertain producer expiry).
      return null;
    }
  }
  if (Number(file.ingestOutputProtocol ?? INGEST_OUTPUT_PROTOCOL_V1) === INGEST_OUTPUT_PROTOCOL_V1) {
    // Legacy V1 workers can write the shared pair without a prewrite receipt.
    // Before deletion exposes any cleanup, mint a durable bridge marker for
    // that exact pair. It persists as a reaper after the file row is deleted;
    // the old 90s heartbeat lease alone is never used as a physical R2 fence.
    let marker = legacyBridgeMarker(await outputAttemptsForVersion(ctx, file._id, file.ingestVersion));
    marker = marker ?? await startLegacyBridgeMarker(ctx, file, String(file.ingestClaimToken ?? "legacy"), now);
    if (marker?.state === "active") {
      if (marker.producerMayWriteUntil > now) return Math.max(1, marker.producerMayWriteUntil - now);
      await moveLegacyBridgeToSweep(ctx, marker, now);
    }
    // Any cleanup/sweep marker now owns the shared vN pair. File deletion may
    // continue without returning guessed derived keys; the marker is queued
    // independently and is intentionally nonterminal for old V1 writers.
    return null;
  }
  if (!file.ingestClaimToken) return null;
  const lastProgressAt = Number(file.lastProgressAt ?? 0);
  if (!Number.isFinite(lastProgressAt)) return null;
  const retryAfterMs = lastProgressAt + INGEST_CLAIM_STALE_MS - now;
  return retryAfterMs > 0 ? retryAfterMs : null;
}

function earliestRetryAfter(...values: Array<number | null>): number | null {
  const candidates = values.filter((value): value is number => value !== null && value > 0);
  return candidates.length ? Math.min(...candidates) : null;
}

/** Expired leases are harmless to deletion, but remove a bounded set on the
 * file's normal lifecycle path so crashed workers cannot accumulate rows. */
async function activeTurnFileLeaseRetryAfter(ctx: { db: any }, fileId: any, now: number): Promise<number | null> {
  const expired = await ctx.db
    .query("chatTurnFileLeases")
    .withIndex("by_file_expiry", (q: any) => q.eq("fileId", fileId).lte("expiresAt", now))
    .take(CHAT_FILE_LIMITS.maxFilesPerMessage + 1);
  for (const lease of expired) await ctx.db.delete(lease._id);
  const active = await ctx.db
    .query("chatTurnFileLeases")
    .withIndex("by_file_expiry", (q: any) => q.eq("fileId", fileId).gt("expiresAt", now))
    .first();
  if (!active) return null;
  return Math.max(1, Number(active.expiresAt) - now);
}

async function retireUploadBatch(ctx: { db: any }, batch: any, status: "expired" | "cancelled") {
  const now = Date.now();
  const cleanup: Array<{ fileId: string; r2Keys: string[]; deferred: boolean }> = [];
  let retired = 0;
  for (const fileId of batch.fileIds.slice(0, CHAT_FILE_LIMITS.maxFilesPerBatch)) {
    const file = await ctx.db.get(fileId);
    if (!file || file.status === "deleted") continue;
    const claimActive = file.status === "uploading" && Number(file.uploadClaimExpiresAt ?? 0) > now;
    const ingestRetryAfterMs = await activeIngestCleanupRetryAfter(ctx, file, now);
    const rehomeRetryAfterMs = await activeDerivedArtifactRehomeRetryAfter(ctx, file);
    const turnLeaseRetryAfterMs = await activeTurnFileLeaseRetryAfter(ctx, file._id, now);
    await ctx.db.patch(fileId, claimActive ? {
      cancelRequestedAt: now,
      errorCode: `upload_${status}`,
      libraryVisible: false,
      updatedAt: now,
    } : ingestRetryAfterMs !== null || rehomeRetryAfterMs !== null || turnLeaseRetryAfterMs !== null ? {
      status: "deleting",
      deletePreviousStatus: file.status === "processing"
        ? "processing"
        : file.status === "deleting"
          ? file.deletePreviousStatus
          : file.status,
      uploadClaimToken: undefined,
      uploadClaimExpiresAt: undefined,
      cancelRequestedAt: now,
      errorCode: `upload_${status}`,
      libraryVisible: false,
      updatedAt: now,
    } : {
      status: "deleting",
      deletePreviousStatus: file.status,
      uploadClaimToken: undefined,
      uploadClaimExpiresAt: undefined,
      cancelRequestedAt: now,
      ingestClaimToken: undefined,
      errorCode: `upload_${status}`,
      libraryVisible: false,
      updatedAt: now,
    });
    cleanup.push({
      fileId: String(fileId),
      r2Keys: cleanupKeysForFile(file),
      deferred: claimActive || ingestRetryAfterMs !== null || rehomeRetryAfterMs !== null || turnLeaseRetryAfterMs !== null,
    });
    retired += 1;
  }
  await ctx.db.patch(batch._id, { status, updatedAt: now });
  return { batchId: String(batch._id), retired, cleanup };
}

export const reserveBatch = mutation({
  args: {
    requestId: v.string(),
    threadId: v.optional(v.string()),
    files: v.array(uploadDescriptor),
    ...actorAuthArgs,
  },
  handler: async (ctx, args) => {
    await requireActor(ctx, args);
    await assertNormalFileMutationAllowed(ctx);
    const requestId = boundedRequestId(args.requestId);
    const threadId = ownerThread(args.threadId);
    if (!args.files.length || args.files.length > CHAT_FILE_LIMITS.maxFilesPerBatch) {
      throw new ConvexError({ code: "UPLOAD_BATCH_LIMIT", message: "Upload batch has too many files" });
    }
    const files = args.files.map(validatedDescriptor);
    if (new Set(files.map((file) => file.clientId)).size !== files.length) {
      throw new ConvexError({ code: "INVALID_UPLOAD_FILE", message: "Upload client identities must be unique" });
    }
    const totalBytes = files.reduce((sum, file) => sum + file.sizeBytes, 0);
    if (!Number.isSafeInteger(totalBytes) || totalBytes > CHAT_FILE_LIMITS.maxBatchBytes) {
      throw new ConvexError({ code: "UPLOAD_BATCH_LIMIT", message: "Upload batch is too large" });
    }

    const prior = await ctx.db
      .query("uploadBatches")
      .withIndex("by_request", (q) => q.eq("requestId", requestId))
      .first();
    if (prior) {
      if (prior.threadId !== threadId || prior.fileCount !== files.length || prior.totalBytes !== totalBytes) {
        throw new ConvexError({ code: "UPLOAD_REQUEST_CONFLICT", message: "Upload request identity was reused with different metadata" });
      }
      const rows = await Promise.all(prior.fileIds.map((fileId) => ctx.db.get(fileId)));
      if (rows.some((row, index) => !row || row.originalName !== files[index].name || row.expectedSha256 !== files[index].sha256)) {
        throw new ConvexError({ code: "UPLOAD_REQUEST_CONFLICT", message: "Upload request identity was reused with different files" });
      }
      return {
        batchId: String(prior._id),
        expiresAt: prior.expiresAt,
        files: rows.map((row, index) => ({ clientId: files[index].clientId, ...publicFile(row) })),
      };
    }

    const recentBatches = await ctx.db
      .query("uploadBatches")
      .withIndex("by_createdAt", (q) => q.gte("createdAt", Date.now() - 60_000))
      .take(CHAT_FILE_LIMITS.maxNewBatchesPerMinute + 1);
    if (recentBatches.length >= CHAT_FILE_LIMITS.maxNewBatchesPerMinute) {
      throw new ConvexError({ code: "UPLOAD_RATE_LIMIT", message: "Too many new upload batches; wait a minute" });
    }
    const activeStatuses = ["reserved", "uploading", "uploaded", "processing", "ready", "stored_only", "quarantined", "error", "deleting"];
    const activeGroups = await Promise.all(activeStatuses.map((status) => ctx.db
      .query("files")
      .withIndex("by_status_updated", (q) => q.eq("status", status))
      .take(CHAT_FILE_LIMITS.maxLibraryFiles + 1)));
    const active = activeGroups.flat();
    const activeBytes = active.reduce((sum, row) => sum + Number(row.sizeBytes), 0);
    if (active.length + files.length > CHAT_FILE_LIMITS.maxLibraryFiles || activeBytes + totalBytes > CHAT_FILE_LIMITS.maxLibraryBytes) {
      throw new ConvexError({ code: "UPLOAD_QUOTA", message: "Private file library quota reached" });
    }

    const now = Date.now();
    const fileIds = [];
    for (const file of files) {
      const fileId = await ctx.db.insert("files", {
        originalName: file.name,
        relativePath: file.relativePath,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        expectedSha256: file.sha256,
        r2Key: "pending",
        status: "reserved",
        ingestVersion: 1,
        ingestAttempt: 0,
        searchText: `${file.name} ${file.relativePath}`.slice(0, 1_000),
        libraryVisible: true,
        reviewState: "unreviewed",
        createdAt: now,
        updatedAt: now,
      });
      const r2Key = `owners/daniel/files/${String(fileId)}/v1/original`;
      await ctx.db.patch(fileId, { r2Key });
      await ctx.db.insert("threadFiles", { threadId, fileId, pinned: false, createdAt: now, updatedAt: now });
      fileIds.push(fileId);
    }
    const expiresAt = now + CHAT_FILE_LIMITS.uploadReservationTtlMs;
    const batchId = await ctx.db.insert("uploadBatches", {
      requestId,
      threadId,
      status: "reserved",
      fileIds,
      fileCount: fileIds.length,
      totalBytes,
      expiresAt,
      createdAt: now,
      updatedAt: now,
    });
    const rows = await Promise.all(fileIds.map((fileId) => ctx.db.get(fileId)));
    return {
      batchId: String(batchId),
      expiresAt,
      files: rows.map((row, index) => ({ clientId: files[index].clientId, ...publicFile(row) })),
    };
  },
});

export const cleanupExpiredReservations = mutation({
  args: { limit: v.optional(v.number()), ...actorAuthArgs },
  handler: async (ctx, args) => {
    await requireActor(ctx, args);
    await assertNormalFileMutationAllowed(ctx);
    const limit = Math.min(2, Math.max(1, Math.floor(args.limit ?? 2)));
    const now = Date.now();
    const [reserved, uploading] = await Promise.all([
      ctx.db.query("uploadBatches").withIndex("by_expiry", (q) => q.eq("status", "reserved").lt("expiresAt", now)).take(limit),
      ctx.db.query("uploadBatches").withIndex("by_expiry", (q) => q.eq("status", "uploading").lt("expiresAt", now)).take(limit),
    ]);
    const batches = [...reserved, ...uploading].sort((left, right) => left.expiresAt - right.expiresAt).slice(0, limit);
    const cleaned = [];
    for (const batch of batches) cleaned.push(await retireUploadBatch(ctx, batch, "expired"));
    return cleaned;
  },
});

export const cancelBatch = mutation({
  args: { batchId: v.id("uploadBatches"), ...actorAuthArgs },
  handler: async (ctx, args) => {
    await requireActor(ctx, args);
    await assertNormalFileMutationAllowed(ctx);
    const batch = await ctx.db.get(args.batchId);
    if (!batch) return null;
    if (batch.status === "complete") {
      throw new ConvexError({ code: "UPLOAD_BATCH_COMPLETE", message: "A completed upload batch cannot be cancelled" });
    }
    return await retireUploadBatch(ctx, batch, "cancelled");
  },
});

export const claimUpload = mutation({
  args: {
    batchId: v.id("uploadBatches"),
    fileId: v.id("files"),
    claimToken: v.string(),
    contentType: v.string(),
    sha256: v.string(),
    ...actorAuthArgs,
  },
  handler: async (ctx, args) => {
    await requireActor(ctx, args);
    await assertNormalFileMutationAllowed(ctx);
    const claimToken = args.claimToken.trim();
    if (!/^[a-zA-Z0-9_-]{16,120}$/.test(claimToken)) throw new ConvexError({ code: "INVALID_UPLOAD_CLAIM", message: "Upload claim is invalid" });
    const [batch, file] = await Promise.all([ctx.db.get(args.batchId), ctx.db.get(args.fileId)]);
    if (!batch || !file || !batch.fileIds.some((id) => String(id) === String(file._id))) {
      throw new ConvexError({ code: "UPLOAD_NOT_RESERVED", message: "Upload reservation was not found" });
    }
    const expectedKey = `owners/daniel/files/${String(file._id)}/v${Number(file.ingestVersion)}/original`;
    if (file.r2Key !== expectedKey) throw new ConvexError({ code: "UPLOAD_KEY_MISMATCH", message: "Private object identity is invalid" });
    if (normalizeUploadMime(args.contentType) !== file.mimeType || normalizeUploadSha256(args.sha256) !== file.expectedSha256) {
      throw new ConvexError({ code: "UPLOAD_MISMATCH", message: "Upload metadata does not match its reservation" });
    }
    if (["uploaded", "processing", "ready", "stored_only"].includes(file.status)) {
      return { claimed: false as const, idempotent: true as const, status: file.status, ingestVersion: file.ingestVersion };
    }
    const now = Date.now();
    if (file.cancelRequestedAt || batch.expiresAt <= now || ["cancelled", "expired", "complete"].includes(batch.status)) {
      throw new ConvexError({ code: "UPLOAD_EXPIRED", message: "Upload reservation is no longer writable" });
    }
    if (file.status === "uploading" && Number(file.uploadClaimExpiresAt ?? 0) > now) {
      return { claimed: false as const, idempotent: false as const, status: "uploading", retryAfterMs: Number(file.uploadClaimExpiresAt) - now };
    }
    if (!["reserved", "uploading"].includes(file.status)) {
      throw new ConvexError({ code: "UPLOAD_STATE_CONFLICT", message: "File is not awaiting upload" });
    }
    const uploadClaimExpiresAt = now + CHAT_FILE_LIMITS.uploadClaimLeaseMs;
    await ctx.db.patch(file._id, {
      status: "uploading",
      uploadClaimToken: claimToken,
      uploadClaimExpiresAt,
      lastProgressAt: now,
      updatedAt: now,
    });
    await ctx.db.patch(batch._id, { status: "uploading", updatedAt: now });
    return {
      claimed: true as const,
      idempotent: false as const,
      status: "uploading",
      r2Key: file.r2Key,
      sizeBytes: file.sizeBytes,
      mimeType: file.mimeType,
      expectedSha256: file.expectedSha256,
      ingestVersion: file.ingestVersion,
      expiresAt: batch.expiresAt,
    };
  },
});

export const releaseUploadClaim = mutation({
  args: { fileId: v.id("files"), claimToken: v.string(), ...actorAuthArgs },
  handler: async (ctx, args) => {
    await requireActor(ctx, args);
    await assertNormalFileMutationAllowed(ctx);
    const file = await ctx.db.get(args.fileId);
    if (!file || file.status !== "uploading" || file.uploadClaimToken !== args.claimToken) return false;
    const cancelled = Boolean(file.cancelRequestedAt);
    await ctx.db.patch(file._id, {
      status: cancelled ? "deleting" : "reserved",
      deletePreviousStatus: cancelled ? "uploading" : file.deletePreviousStatus,
      uploadClaimToken: undefined,
      uploadClaimExpiresAt: undefined,
      lastProgressAt: Date.now(),
      updatedAt: Date.now(),
    });
    return { released: true, cancelled, ...(cancelled ? { r2Keys: cleanupKeysForFile(file) } : {}) };
  },
});

export const claimCancelledUploadCleanup = mutation({
  args: { fileId: v.id("files"), ...actorAuthArgs },
  handler: async (ctx, args) => {
    await requireActor(ctx, args);
    await assertNormalFileMutationAllowed(ctx);
    const file = await ctx.db.get(args.fileId);
    if (!file || file.status === "deleted") return null;
    const now = Date.now();
    if (file.status === "deleting") {
      const retryAfterMs = earliestRetryAfter(
        await activeIngestCleanupRetryAfter(ctx, file, now),
        await activeDerivedArtifactRehomeRetryAfter(ctx, file),
        await activeTurnFileLeaseRetryAfter(ctx, file._id, now),
      );
      return retryAfterMs === null
        ? { ready: true as const, r2Keys: cleanupKeysForFile(file) }
        : { ready: false as const, retryAfterMs };
    }
    if (file.status !== "uploading" || !file.cancelRequestedAt) return null;
    if (Number(file.uploadClaimExpiresAt ?? 0) > now) {
      return { ready: false as const, retryAfterMs: Number(file.uploadClaimExpiresAt) - now };
    }
    await ctx.db.patch(file._id, {
      status: "deleting",
      deletePreviousStatus: "uploading",
      uploadClaimToken: undefined,
      uploadClaimExpiresAt: undefined,
      updatedAt: now,
    });
    return { ready: true as const, r2Keys: cleanupKeysForFile(file) };
  },
});

export const markUploaded = mutation({
  args: {
    batchId: v.id("uploadBatches"),
    fileId: v.id("files"),
    sizeBytes: v.number(),
    contentType: v.string(),
    sha256: v.string(),
    etag: v.optional(v.string()),
    claimToken: v.string(),
    ...actorAuthArgs,
  },
  handler: async (ctx, args) => {
    await requireActor(ctx, args);
    await assertNormalFileMutationAllowed(ctx);
    const [batch, file] = await Promise.all([ctx.db.get(args.batchId), ctx.db.get(args.fileId)]);
    if (!batch || !file || !batch.fileIds.some((fileId) => String(fileId) === String(args.fileId))) {
      throw new ConvexError({ code: "UPLOAD_NOT_RESERVED", message: "Upload reservation was not found" });
    }
    const sha256 = normalizeUploadSha256(args.sha256);
    if (args.sizeBytes !== file.sizeBytes || sha256 !== file.expectedSha256 || normalizeUploadMime(args.contentType) !== file.mimeType) {
      await ctx.db.patch(file._id, { status: "quarantined", errorCode: "upload_metadata_mismatch", updatedAt: Date.now() });
      throw new ConvexError({ code: "UPLOAD_MISMATCH", message: "Uploaded object does not match its reservation" });
    }
    if (["uploaded", "processing", "ready", "stored_only"].includes(file.status)) {
      return { ok: true, fileId: String(file._id), ingestVersion: file.ingestVersion, idempotent: true };
    }
    if (file.status !== "uploading" || file.uploadClaimToken !== args.claimToken) {
      throw new ConvexError({ code: "UPLOAD_STATE_CONFLICT", message: "File is not awaiting upload" });
    }
    const now = Date.now();
    if (file.cancelRequestedAt || batch.expiresAt <= now || ["cancelled", "expired"].includes(batch.status)) {
      await ctx.db.patch(file._id, {
        status: "deleting",
        deletePreviousStatus: "uploading",
        uploadEtag: args.etag?.slice(0, 160),
        uploadClaimToken: undefined,
        uploadClaimExpiresAt: undefined,
        libraryVisible: false,
        updatedAt: now,
      });
      return { ok: false, cancelled: true, fileId: String(file._id), r2Keys: cleanupKeysForFile(file) };
    }
    if (Number(file.uploadClaimExpiresAt ?? 0) <= now) {
      throw new ConvexError({ code: "UPLOAD_STATE_CONFLICT", message: "Upload claim expired before completion" });
    }
    await ctx.db.patch(file._id, {
      status: "uploaded",
      uploadEtag: args.etag?.slice(0, 160),
      uploadClaimToken: undefined,
      uploadClaimExpiresAt: undefined,
      cancelRequestedAt: undefined,
      lastProgressAt: now,
      errorCode: undefined,
      updatedAt: now,
    });
    const siblings = await Promise.all(batch.fileIds.map((fileId) => ctx.db.get(fileId)));
    const completedStates = new Set(["uploaded", "processing", "ready", "stored_only", "error", "quarantined"]);
    const complete = siblings.every((row) => row && (String(row._id) === String(file._id) || completedStates.has(String(row.status))));
    await ctx.db.patch(batch._id, { status: complete ? "complete" : "uploading", updatedAt: now });
    return { ok: true, fileId: String(file._id), ingestVersion: file.ingestVersion, idempotent: false };
  },
});

// Internal object coordinates are returned only across an authenticated
// server-to-Convex call. The browser receives an application upload URL, never
// an R2 key or storage credential.
export const getUploadReservation = query({
  args: { batchId: v.id("uploadBatches"), fileId: v.id("files"), ...actorAuthArgs },
  handler: async (ctx, args) => {
    await requireActor(ctx, args);
    const [batch, file] = await Promise.all([ctx.db.get(args.batchId), ctx.db.get(args.fileId)]);
    if (!batch || !file || !batch.fileIds.some((fileId) => String(fileId) === String(args.fileId))) return null;
    if (batch.expiresAt <= Date.now()) return null;
    return {
      fileId: String(file._id),
      r2Key: file.r2Key,
      status: file.status,
      sizeBytes: file.sizeBytes,
      mimeType: file.mimeType,
      expectedSha256: file.expectedSha256,
      ingestVersion: file.ingestVersion,
      expiresAt: batch.expiresAt,
    };
  },
});

export const getForOwner = query({
  args: { fileId: v.id("files"), ...actorAuthArgs },
  handler: async (ctx, args) => {
    await requireActor(ctx, args);
    const row = await ctx.db.get(args.fileId);
    return row && row.status !== "deleted" ? row : null;
  },
});

export const get = query({
  args: { fileId: v.id("files"), ...viewerAuthArgs },
  handler: async (ctx, args) => {
    await requireViewer(ctx, args);
    const row = await ctx.db.get(args.fileId);
    return row && row.status !== "deleted" ? publicFile(row) : null;
  },
});

export const listForThread = query({
  args: { threadId: v.optional(v.string()), limit: v.optional(v.number()), ...viewerAuthArgs },
  handler: async (ctx, args) => {
    await requireViewer(ctx, args);
    const threadId = ownerThread(args.threadId);
    const limit = Math.min(100, Math.max(1, Math.floor(args.limit ?? 60)));
    const links = await ctx.db
      .query("threadFiles")
      .withIndex("by_thread_updated", (q) => q.eq("threadId", threadId))
      .order("desc")
      .take(limit);
    const rows = await Promise.all(links.map((link) => ctx.db.get(link.fileId)));
    return rows.flatMap((row, index) => row && row.libraryVisible !== false && row.status !== "deleted"
      ? [{ ...publicFile(row), pinned: links[index].pinned }]
      : []);
  },
});

export const listLibrary = query({
  args: { limit: v.optional(v.number()), ...viewerAuthArgs },
  handler: async (ctx, args) => {
    await requireViewer(ctx, args);
    const limit = Math.min(100, Math.max(1, Math.floor(args.limit ?? 60)));
    const rows = await ctx.db
      .query("files")
      .withIndex("by_library_updated", (q) => q.eq("libraryVisible", true))
      .order("desc")
      .take(limit);
    return rows.map(publicFile);
  },
});

// The orb palette searches the complete owner-visible private library through
// Convex's metadata index. It returns only the same display-safe fields as the
// ordinary library; R2 coordinates and extraction contents stay server-side.
export const quickSearchLibrary = query({
  args: { search: v.string(), limit: v.optional(v.number()), ...viewerAuthArgs },
  handler: async (ctx, args) => {
    await requireViewer(ctx, args);
    const search = args.search.trim().slice(0, 160);
    if (search.length < 2) return [];
    const limit = Math.min(12, Math.max(1, Math.floor(args.limit ?? 8)));
    const [metadataRows, documentMatches, chunkMatches] = await Promise.all([
      ctx.db.query("files").withSearchIndex("search_metadata", (q) => q.search("searchText", search).eq("libraryVisible", true)).take(limit),
      ctx.db.query("fileDocuments").withSearchIndex("search_content", (q) => q.search("content", search)).take(limit),
      ctx.db.query("fileChunks").withSearchIndex("search_text", (q) => q.search("text", search)).take(limit),
    ]);
    const contentRows = await Promise.all([...documentMatches, ...chunkMatches].map((match) => ctx.db.get(match.fileId)));
    const seen = new Set<string>();
    return [...metadataRows, ...contentRows].flatMap((row) => {
      if (!row || row.libraryVisible !== true || row.status === "deleted" || row.status === "deleting") return [];
      const id = String(row._id);
      if (seen.has(id)) return [];
      seen.add(id);
      return [publicFile(row)];
    }).slice(0, limit);
  },
});

export const paginatedLibrary = query({
  args: {
    paginationOpts: paginationOptsValidator,
    search: v.optional(v.string()),
    reviewState: v.optional(libraryReviewFilter),
    ...viewerAuthArgs,
  },
  handler: async (ctx, args) => {
    await requireViewer(ctx, args);
    const search = args.search?.trim().slice(0, 160) ?? "";
    const result = search
      ? await ctx.db
          .query("files")
          .withSearchIndex("search_metadata", (q) => {
            const filter = q.search("searchText", search).eq("libraryVisible", true);
            return args.reviewState ? filter.eq("reviewState", args.reviewState) : filter;
          })
          .paginate(args.paginationOpts)
      : args.reviewState
        ? await ctx.db
            .query("files")
            .withIndex("by_library_review_updated", (q) => q.eq("libraryVisible", true).eq("reviewState", args.reviewState))
            .order("desc")
            .paginate(args.paginationOpts)
        : await ctx.db
            .query("files")
            .withIndex("by_library_updated", (q) => q.eq("libraryVisible", true))
            .order("desc")
            .paginate(args.paginationOpts);
    return { ...result, page: result.page.map(publicFile) };
  },
});

export const paginatedForThread = query({
  args: {
    threadId: v.optional(v.string()),
    paginationOpts: paginationOptsValidator,
    search: v.optional(v.string()),
    ...viewerAuthArgs,
  },
  handler: async (ctx, args) => {
    await requireViewer(ctx, args);
    const threadId = ownerThread(args.threadId);
    const search = args.search?.trim().slice(0, 160) ?? "";
    if (search) {
      // Search indexes cannot join. Advance a standard global search cursor,
      // then retain only rows linked to this chat. Sparse pages are valid and
      // the cursor still guarantees older matches remain reachable.
      const result = await ctx.db
        .query("files")
        .withSearchIndex("search_metadata", (q) => q.search("searchText", search).eq("libraryVisible", true))
        .paginate(args.paginationOpts);
      const links = await Promise.all(result.page.map((row) => ctx.db
        .query("threadFiles")
        .withIndex("by_thread_file", (q) => q.eq("threadId", threadId).eq("fileId", row._id))
        .first()));
      return {
        ...result,
        page: result.page.flatMap((row, index) => links[index]
          ? [{ ...publicFile(row), pinned: Boolean(links[index]?.pinned) }]
          : []),
      };
    }
    const result = await ctx.db
      .query("threadFiles")
      .withIndex("by_thread_updated", (q) => q.eq("threadId", threadId))
      .order("desc")
      .paginate(args.paginationOpts);
    const rows = await Promise.all(result.page.map((link) => ctx.db.get(link.fileId)));
    return {
      ...result,
      page: rows.flatMap((row, index) => row && row.libraryVisible !== false && row.status !== "deleted"
        ? [{ ...publicFile(row), pinned: result.page[index].pinned }]
        : []),
    };
  },
});

// Review is deliberately metadata-only: it never schedules deletion, touches
// R2, or changes a thread/message link. "unreviewed" is the reversible clear.
export const setReviewState = mutation({
  args: { fileId: v.id("files"), reviewState: fileReviewState, ...actorAuthArgs },
  handler: async (ctx, args) => {
    await requireActor(ctx, args);
    await assertNormalFileMutationAllowed(ctx);
    const file = await ctx.db.get(args.fileId);
    if (!file || file.status === "deleted" || file.status === "deleting") return null;
    const now = Date.now();
    await ctx.db.patch(file._id, { reviewState: args.reviewState, updatedAt: now });
    return publicFile({ ...file, reviewState: args.reviewState, updatedAt: now });
  },
});

export const updateWorkspaceMetadata = mutation({
  args: {
    fileId: v.id("files"),
    name: v.optional(v.string()),
    folderPath: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    ...actorAuthArgs,
  },
  handler: async (ctx, args) => {
    await requireActor(ctx, args);
    const file = await ctx.db.get(args.fileId);
    if (!file || file.status === "deleted" || file.status === "deleting") return null;
    const name = args.name === undefined ? String(file.originalName) : workspaceFileName(args.name);
    const currentPath = String(file.relativePath ?? file.originalName).replace(/\\/g, "/");
    const currentFolder = currentPath.includes("/") ? currentPath.slice(0, currentPath.lastIndexOf("/")) : "";
    const folderPath = args.folderPath === undefined ? workspaceFolderPath(currentFolder) : workspaceFolderPath(args.folderPath);
    const tags = args.tags === undefined
      ? (Array.isArray(file.tags) ? workspaceTags(file.tags.map(String)) : [])
      : workspaceTags(args.tags);
    const relativePath = folderPath ? `${folderPath}/${name}` : name;
    const now = Date.now();
    const patch = {
      originalName: name,
      relativePath,
      tags,
      searchText: workspaceSearchText(file, name, relativePath, tags),
      updatedAt: now,
    };
    await ctx.db.patch(file._id, patch);
    return publicFile({ ...file, ...patch });
  },
});

export const getWorkspaceDocument = query({
  args: { fileId: v.id("files"), ...actorAuthArgs },
  handler: async (ctx, args) => {
    await requireActor(ctx, args);
    const file = await ctx.db.get(args.fileId);
    if (!file || file.status === "deleted" || file.status === "deleting") return null;
    const mimeType = String(file.detectedMimeType ?? file.mimeType);
    if (!WORKSPACE_TEXT_MIME.test(mimeType)) return { editable: false as const, file: publicFile(file) };
    const draft = await ctx.db.query("fileDocuments").withIndex("by_file", (q) => q.eq("fileId", file._id)).unique();
    if (draft) {
      return { editable: true as const, file: publicFile(file), content: draft.content, version: draft.version, edited: true as const };
    }
    const chunks = await ctx.db.query("fileChunks").withIndex("by_file_ordinal", (q) => q.eq("fileId", file._id)).take(256);
    const content = chunks.map((chunk) => String(chunk.text)).join("\n\n").slice(0, WORKSPACE_DOCUMENT_MAX_CHARS);
    return { editable: true as const, file: publicFile(file), content, version: 0, edited: false as const };
  },
});

export const saveWorkspaceDocument = mutation({
  args: {
    fileId: v.id("files"),
    content: v.string(),
    baseVersion: v.number(),
    ...actorAuthArgs,
  },
  handler: async (ctx, args) => {
    await requireActor(ctx, args);
    const file = await ctx.db.get(args.fileId);
    if (!file || file.status === "deleted" || file.status === "deleting") return null;
    const mimeType = String(file.detectedMimeType ?? file.mimeType);
    if (!WORKSPACE_TEXT_MIME.test(mimeType)) {
      throw new ConvexError({ code: "FILE_NOT_EDITABLE", message: "Only text documents can be edited" });
    }
    if (!Number.isSafeInteger(args.baseVersion) || args.baseVersion < 0 || args.content.length > WORKSPACE_DOCUMENT_MAX_CHARS) {
      throw new ConvexError({ code: "INVALID_FILE_DOCUMENT", message: "Document edit is invalid or too large" });
    }
    const current = await ctx.db.query("fileDocuments").withIndex("by_file", (q) => q.eq("fileId", file._id)).unique();
    const currentVersion = current?.version ?? 0;
    if (currentVersion !== args.baseVersion) {
      throw new ConvexError({ code: "FILE_EDIT_CONFLICT", message: "This document changed in another session" });
    }
    const now = Date.now();
    const version = currentVersion + 1;
    if (current) await ctx.db.patch(current._id, { content: args.content, version, updatedAt: now });
    else await ctx.db.insert("fileDocuments", { fileId: file._id, content: args.content, version, createdAt: now, updatedAt: now });
    const summary = args.content.trim().replace(/\s+/g, " ").slice(0, 280) || file.summary;
    await ctx.db.patch(file._id, {
      summary,
      searchText: workspaceSearchText({ ...file, summary }, String(file.originalName), String(file.relativePath), Array.isArray(file.tags) ? file.tags.map(String) : []),
      updatedAt: now,
    });
    return { ok: true as const, fileId: String(file._id), version, updatedAt: now };
  },
});

// Tool calls must be bound to the exact user message that attached the file.
// This is still metadata-only: no R2 operation or thread/message link changes.
export const setReviewStateForMessage = mutation({
  args: {
    messageId: v.id("chatMessages"),
    fileId: v.id("files"),
    reviewState: fileReviewState,
    ...actorAuthArgs,
  },
  handler: async (ctx, args) => {
    await requireActor(ctx, args);
    await assertNormalFileMutationAllowed(ctx);
    const message = await ctx.db.get(args.messageId);
    if (!message || message.role !== "user") {
      throw new ConvexError({ code: "INVALID_FILE_MESSAGE", message: "File review requires a user message" });
    }
    const attachment = await ctx.db
      .query("messageFiles")
      .withIndex("by_message_file", (q) => q.eq("messageId", message._id).eq("fileId", args.fileId))
      .first();
    if (!attachment) {
      throw new ConvexError({ code: "FILE_NOT_ATTACHED", message: "That file is not attached to this message" });
    }
    const file = await ctx.db.get(args.fileId);
    if (!file || file.status === "deleted" || file.status === "deleting") {
      throw new ConvexError({ code: "FILE_NOT_REVIEWABLE", message: "Attached file is unavailable for review" });
    }
    const now = Date.now();
    await ctx.db.patch(file._id, { reviewState: args.reviewState, updatedAt: now });
    return publicFile({ ...file, reviewState: args.reviewState, updatedAt: now });
  },
});

export const updateWorkspaceMetadataForMessage = mutation({
  args: {
    messageId: v.id("chatMessages"),
    fileId: v.id("files"),
    name: v.optional(v.string()),
    folderPath: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    ...actorAuthArgs,
  },
  handler: async (ctx, args) => {
    await requireActor(ctx, args);
    const message = await ctx.db.get(args.messageId);
    if (!message || message.role !== "user") {
      throw new ConvexError({ code: "INVALID_FILE_MESSAGE", message: "File organization requires a user message" });
    }
    const attachment = await ctx.db.query("messageFiles").withIndex("by_message_file", (q) => q.eq("messageId", message._id).eq("fileId", args.fileId)).first();
    if (!attachment) throw new ConvexError({ code: "FILE_NOT_ATTACHED", message: "That file is not attached to this message" });
    const file = await ctx.db.get(args.fileId);
    if (!file || file.status === "deleted" || file.status === "deleting") {
      throw new ConvexError({ code: "FILE_NOT_ORGANIZABLE", message: "Attached file is unavailable" });
    }
    const name = args.name === undefined ? String(file.originalName) : workspaceFileName(args.name);
    const currentPath = String(file.relativePath ?? file.originalName).replace(/\\/g, "/");
    const currentFolder = currentPath.includes("/") ? currentPath.slice(0, currentPath.lastIndexOf("/")) : "";
    const folderPath = args.folderPath === undefined ? workspaceFolderPath(currentFolder) : workspaceFolderPath(args.folderPath);
    const tags = args.tags === undefined ? (Array.isArray(file.tags) ? workspaceTags(file.tags.map(String)) : []) : workspaceTags(args.tags);
    const relativePath = folderPath ? `${folderPath}/${name}` : name;
    const now = Date.now();
    const patch = { originalName: name, relativePath, tags, searchText: workspaceSearchText(file, name, relativePath, tags), updatedAt: now };
    await ctx.db.patch(file._id, patch);
    return publicFile({ ...file, ...patch });
  },
});

export const linkToThread = mutation({
  args: { fileId: v.id("files"), threadId: v.optional(v.string()), ...actorAuthArgs },
  handler: async (ctx, args) => {
    await requireActor(ctx, args);
    const threadId = ownerThread(args.threadId);
    const file = await ctx.db.get(args.fileId);
    if (!file || file.status === "deleted" || file.status === "deleting") throw new Error("file not found");
    const prior = await ctx.db
      .query("threadFiles")
      .withIndex("by_thread_file", (q) => q.eq("threadId", threadId).eq("fileId", args.fileId))
      .first();
    const now = Date.now();
    if (prior) {
      await ctx.db.patch(prior._id, { updatedAt: now });
      return String(prior._id);
    }
    return String(await ctx.db.insert("threadFiles", { threadId, fileId: args.fileId, pinned: false, createdAt: now, updatedAt: now }));
  },
});

export const unlinkFromThread = mutation({
  args: { fileId: v.id("files"), threadId: v.optional(v.string()), ...actorAuthArgs },
  handler: async (ctx, args) => {
    await requireActor(ctx, args);
    const threadId = ownerThread(args.threadId);
    const link = await ctx.db
      .query("threadFiles")
      .withIndex("by_thread_file", (q) => q.eq("threadId", threadId).eq("fileId", args.fileId))
      .first();
    if (link) await ctx.db.delete(link._id);
    return { ok: true, removed: Boolean(link) };
  },
});

/**
 * Explicitly completes the release cutover after the old Trigger deployment
 * has been quiesced. The returned batch must be woken with a fresh V2
 * idempotency namespace: earlier V2 tasks safely skipped before activation.
 */
export const activateIngestOutputProtocolV2 = mutation({
  args: {
    triggerDeploymentVersion: v.optional(v.string()),
    rehomeToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // This is deliberately not the generic worker capability. Activation is
    // irreversible for the old shared V1 namespace and is authorized only by
    // the migration controller after it has produced a durable server proof.
    requireFileDerivedArtifactRehome(args.rehomeToken);
    const existing = await ingestOutputProtocolRollout(ctx);
    if (existing) {
      return {
        activated: false as const,
        activatedAt: existing.activatedAt,
        protocolVersion: existing.protocolVersion,
        requeue: await pendingIngestWakeups(ctx, 64),
      };
    }
    const control = await assertFileDerivedArtifactRehomeReady(ctx);
    const now = Date.now();
    const triggerDeploymentVersion = args.triggerDeploymentVersion?.trim().slice(0, 160);
    await ctx.db.insert("workerProtocolRollouts", {
      key: INGEST_OUTPUT_PROTOCOL_ROLLOUT,
      protocolVersion: 2,
      activatedAt: now,
      activatedByDeploymentVersion: triggerDeploymentVersion || undefined,
      updatedAt: now,
    });
    await ctx.db.patch(control._id, { phase: "active", updatedAt: now });
    return {
      activated: true as const,
      activatedAt: now,
      protocolVersion: 2 as const,
      requeue: await pendingIngestWakeups(ctx, 64, now),
    };
  },
});

export const claimIngest = mutation({
  args: {
    fileId: v.id("files"),
    ingestVersion: v.number(),
    claimToken: v.string(),
    // Omitted means V1 so the already-deployed Trigger remains compatible
    // while Convex is released first. V2 is opt-in and gets an output intent
    // before it is allowed to write a derived R2 object.
    outputProtocol: v.optional(v.union(v.literal(1), v.literal(2))),
    ...actorAuthArgs,
  },
  handler: async (ctx, args) => {
    await requireActor(ctx, args);
    await assertNormalFileMutationAllowed(ctx);
    const file = await ctx.db.get(args.fileId);
    if (!file || file.ingestVersion !== args.ingestVersion) return null;
    const outputProtocol = args.outputProtocol ?? INGEST_OUTPUT_PROTOCOL_V1;
    const rollout = await ingestOutputProtocolRollout(ctx);
    const now = Date.now();
    if (
      (outputProtocol === INGEST_OUTPUT_PROTOCOL_V1 && rollout)
      || (outputProtocol === INGEST_OUTPUT_PROTOCOL_V2 && !rollout)
    ) return null;
    if (file.status === "processing" && Number(file.lastProgressAt ?? 0) > now - INGEST_CLAIM_STALE_MS) return null;
    if (!["uploaded", "error", "processing"].includes(file.status) || file.ingestAttempt >= 3) return null;
    const claimToken = args.claimToken.trim().slice(0, 160);
    if (!claimToken) return null;
    if (outputProtocol === INGEST_OUTPUT_PROTOCOL_V1) {
      const legacyCleanup = await ctx.db
        .query("fileIngestCleanupOutbox")
        .withIndex("by_file_version", (q) => q.eq("fileId", file._id).eq("ingestVersion", args.ingestVersion))
        .first();
      if (legacyCleanup) return null;
    }
    const attempts = await outputAttemptsForVersion(ctx, file._id, args.ingestVersion);
    let legacyMarker = legacyBridgeMarker(attempts);
    const staleLegacyClaim = file.status === "processing" && Number(file.ingestOutputProtocol ?? INGEST_OUTPUT_PROTOCOL_V1) === INGEST_OUTPUT_PROTOCOL_V1;
    let claimedIngestVersion = args.ingestVersion;
    let ingestAttempt = file.ingestAttempt + 1;

    // A pre-compat V1 worker may have claimed before this schema existed, so
    // synthesize a durable marker the first time the new control plane sees
    // it. A V2 worker never shares its paths, but waits through this bridge
    // window before taking the file claim; the known V1 keys remain sweepable.
    if (staleLegacyClaim) {
      legacyMarker = legacyMarker ?? await startLegacyBridgeMarker(ctx, file, String(file.ingestClaimToken ?? claimToken), now);
      if (Number(legacyMarker?.producerMayWriteUntil ?? 0) > now) return null;
      if (legacyMarker) await moveLegacyBridgeToSweep(ctx, legacyMarker, now);
      if (outputProtocol === INGEST_OUTPUT_PROTOCOL_V1) return null;
      // Never let V2 reuse the shared V1 version, even though its paths are
      // already unique. The old worker is now permanently stale and can only
      // ever write the prior version's bridge-swept pair.
      claimedIngestVersion = args.ingestVersion + 1;
      ingestAttempt = 1;
    }

    if (outputProtocol === INGEST_OUTPUT_PROTOCOL_V2 && !staleLegacyClaim && legacyOutputMayBeUncommitted(file)) {
      // A pre-compat V1 terminal error may have cleared its claim before an
      // accepted shared-pair PUT became observable. Keep that known V1 pair
      // permanently sweepable before this V2 attempt reuses the file row.
      legacyMarker = legacyMarker ?? await startLegacyBridgeMarker(ctx, file, String(file.ingestClaimToken ?? claimToken), now);
      if (legacyMarker) await moveLegacyBridgeToSweep(ctx, legacyMarker, now);
    }

    // Never hand the legacy shared vN pair to a second V1 worker while a
    // bridge marker owns it. V2 can proceed because its generation is unique.
    if (outputProtocol === INGEST_OUTPUT_PROTOCOL_V1 && legacyMarker) return null;

    let outputAttempt = "";
    let outputKeys: DerivedOutputKeys | undefined;
    let outputAttemptOutboxId: string | undefined;
    let producerMayWriteUntil: number;
    if (outputProtocol === INGEST_OUTPUT_PROTOCOL_V2) {
      outputAttempt = outputAttemptId(ingestAttempt, claimToken);
      outputKeys = derivedOutputKeys(file._id, claimedIngestVersion, outputProtocol, outputAttempt);
      producerMayWriteUntil = now + INGEST_OUTPUT_PRODUCER_WINDOW_MS;
      outputAttemptOutboxId = String(await ctx.db.insert("fileIngestOutputAttempts", {
        fileId: file._id,
        ingestVersion: claimedIngestVersion,
        outputProtocol,
        outputAttemptId: outputAttempt,
        claimToken,
        extractedTextR2Key: outputKeys.extractedTextR2Key,
        previewR2Key: outputKeys.previewR2Key,
        producerMayWriteUntil,
        state: "active",
        writerHandoff: false,
        writeStarted: false,
        nextCleanupAt: producerMayWriteUntil,
        sweepCount: 0,
        createdAt: now,
        updatedAt: now,
      }));
    } else {
      // This is a bridge sweep marker, not a V2 publish intent. The old
      // Trigger ignores it and continues using its deterministic V1 keys.
      const marker = await startLegacyBridgeMarker(
        ctx,
        { ...file, ingestAttempt, ingestClaimToken: claimToken, lastProgressAt: now },
        claimToken,
        now,
      );
      outputAttempt = String(marker?.outputAttemptId ?? "");
      producerMayWriteUntil = Number(marker?.producerMayWriteUntil ?? now + LEGACY_V1_OUTPUT_DRAIN_MS);
    }
    await ctx.db.patch(file._id, {
      status: "processing",
      ingestVersion: claimedIngestVersion,
      ingestAttempt,
      ingestClaimToken: claimToken,
      ingestOutputProtocol: outputProtocol,
      ingestOutputAttemptId: outputAttempt || undefined,
      ingestOutputMayWriteUntil: producerMayWriteUntil,
      lastProgressAt: now,
      errorCode: undefined,
      updatedAt: now,
    });
    return {
      ...file,
      status: "processing",
      ingestVersion: claimedIngestVersion,
      ingestAttempt,
      ingestClaimToken: claimToken,
      ingestOutputProtocol: outputProtocol,
      ingestOutputAttemptId: outputAttempt || undefined,
      ...(outputKeys ? { derivedOutput: { ...outputKeys, outputAttemptOutboxId } } : {}),
    };
  },
});

export const heartbeatIngest = mutation({
  args: { fileId: v.id("files"), ingestVersion: v.number(), claimToken: v.string(), ...actorAuthArgs },
  handler: async (ctx, args) => {
    await requireActor(ctx, args);
    await assertNormalFileMutationAllowed(ctx);
    const file = await ctx.db.get(args.fileId);
    if (!file || file.status !== "processing" || file.ingestVersion !== args.ingestVersion || file.ingestClaimToken !== args.claimToken) return false;
    const now = Date.now();
    if (
      Number(file.ingestOutputProtocol ?? INGEST_OUTPUT_PROTOCOL_V1) === INGEST_OUTPUT_PROTOCOL_V1
      && await ingestOutputProtocolRollout(ctx)
      && legacyProducerMayWriteUntil(file, now) <= now
    ) {
      const marker = await startLegacyBridgeMarker(ctx, file, args.claimToken, now);
      if (marker) await moveLegacyBridgeToSweep(ctx, marker, now);
      await ctx.db.patch(file._id, {
        status: "error",
        errorCode: "legacy_ingest_output_drain_expired",
        ingestClaimToken: undefined,
        ingestOutputMayWriteUntil: undefined,
        lastProgressAt: now,
        updatedAt: now,
      });
      return false;
    }
    await ctx.db.patch(file._id, { lastProgressAt: now, updatedAt: now });
    return true;
  },
});

/**
 * Durable prewrite fence for an exact V2 output attempt. The Trigger must
 * obtain this acknowledgement before it issues an R2 PUT. If the PUT response
 * is lost after the provider accepts it, `writeStarted` keeps the attempt in
 * the nonterminal sweep set instead of treating a later worker callback as a
 * physical R2 fence.
 */
export const beginIngestOutputWrite = mutation({
  args: {
    fileId: v.id("files"),
    ingestVersion: v.number(),
    claimToken: v.string(),
    outputAttemptId: v.id("fileIngestOutputAttempts"),
    purpose: v.union(v.literal("extracted.txt"), v.literal("preview.webp")),
    ...actorAuthArgs,
  },
  handler: async (ctx, args) => {
    await requireActor(ctx, args);
    await assertNormalFileMutationAllowed(ctx);
    const [file, outbox] = await Promise.all([ctx.db.get(args.fileId), ctx.db.get(args.outputAttemptId)]);
    if (
      !file
      || !outbox
      || outbox.fileId !== args.fileId
      || outbox.ingestVersion !== args.ingestVersion
      || outbox.outputProtocol !== INGEST_OUTPUT_PROTOCOL_V2
      || outbox.claimToken !== args.claimToken
      || outbox.state !== "active"
      || file.status !== "processing"
      || file.ingestVersion !== args.ingestVersion
      || file.ingestClaimToken !== args.claimToken
      || file.ingestOutputProtocol !== INGEST_OUTPUT_PROTOCOL_V2
      || file.ingestOutputAttemptId !== outbox.outputAttemptId
    ) return false;
    // Reconstruct the exact path as a defense-in-depth validation of the
    // purpose token. No caller-supplied R2 key reaches this mutation.
    const keys = outboxOutputKeys(outbox);
    if (args.purpose === "extracted.txt" && !keys.extractedTextR2Key) return false;
    if (args.purpose === "preview.webp" && !keys.previewR2Key) return false;
    await ctx.db.patch(outbox._id, { writeStarted: true, updatedAt: Date.now() });
    return true;
  },
});

export const readyDuplicateByHash = query({
  args: { fileId: v.id("files"), sha256: v.string(), ...actorAuthArgs },
  handler: async (ctx, args) => {
    await requireActor(ctx, args);
    const sha256 = normalizeUploadSha256(args.sha256);
    if (!sha256) return null;
    const candidates = await ctx.db.query("files").withIndex("by_sha256", (q) => q.eq("sha256", sha256)).take(5);
    const match = candidates.find((file) => String(file._id) !== String(args.fileId) && FILE_READY_STATUSES.has(file.status));
    if (!match) return null;
    const chunks = await ctx.db.query("fileChunks").withIndex("by_file_ordinal", (q) => q.eq("fileId", match._id)).take(CHAT_FILE_LIMITS.maxChunks);
    return { file: match, chunks: chunks.map((chunk) => ({ ordinal: chunk.ordinal, text: chunk.text, page: chunk.page, sheet: chunk.sheet, cellRange: chunk.cellRange })) };
  },
});

export const completeIngest = mutation({
  args: {
    fileId: v.id("files"),
    ingestVersion: v.number(),
    claimToken: v.string(),
    sha256: v.string(),
    detectedMimeType: v.string(),
    status: v.union(v.literal("ready"), v.literal("stored_only")),
    summary: v.optional(v.string()),
    extractedTextR2Key: v.optional(v.string()),
    previewR2Key: v.optional(v.string()),
    outputAttemptId: v.optional(v.string()),
    extractedChars: v.number(),
    pageCount: v.optional(v.number()),
    sheetNames: v.optional(v.array(v.string())),
    chunks: v.array(extractedChunk),
    ...actorAuthArgs,
  },
  handler: async (ctx, args) => {
    await requireActor(ctx, args);
    await assertNormalFileMutationAllowed(ctx);
    const file = await ctx.db.get(args.fileId);
    // A deletion keeps the active claim only while the worker might still
    // write a derived object. Once that exact worker has reached its terminal
    // completion callback, clear the claim immediately so its already-durable
    // cleanup can proceed instead of waiting for the stale-claim window.
    if (
      file
      && file.status === "deleting"
      && file.deletePreviousStatus === "processing"
      && file.ingestVersion === args.ingestVersion
      && file.ingestClaimToken === args.claimToken
    ) {
      const now = Date.now();
      await transferOutputAttemptToCleanup(ctx, file, now);
      // Do not consume a legacy bridge here. An old V1 Trigger can still have
      // an accepted shared-pair PUT (or its inline delete) in flight; the
      // marker remains the exact nonterminal reaper after file deletion.
      await ctx.db.patch(file._id, {
        ingestClaimToken: undefined,
        ingestOutputMayWriteUntil: undefined,
        lastProgressAt: now,
        updatedAt: now,
      });
      return { ok: false, reason: "stale_claim" as const };
    }
    if (!file || file.status !== "processing" || file.ingestVersion !== args.ingestVersion || file.ingestClaimToken !== args.claimToken) {
      return { ok: false, reason: "stale_claim" as const };
    }
    const outputProtocol = Number(file.ingestOutputProtocol ?? INGEST_OUTPUT_PROTOCOL_V1);
    const nowForLegacyDrain = Date.now();
    if (
      outputProtocol === INGEST_OUTPUT_PROTOCOL_V1
      && await ingestOutputProtocolRollout(ctx)
      && legacyProducerMayWriteUntil(file, nowForLegacyDrain) <= nowForLegacyDrain
    ) {
      const marker = await startLegacyBridgeMarker(ctx, file, args.claimToken, nowForLegacyDrain);
      if (marker) await moveLegacyBridgeToSweep(ctx, marker, nowForLegacyDrain);
      await ctx.db.patch(file._id, {
        status: "error",
        errorCode: "legacy_ingest_output_drain_expired",
        ingestClaimToken: undefined,
        ingestOutputMayWriteUntil: undefined,
        lastProgressAt: nowForLegacyDrain,
        updatedAt: nowForLegacyDrain,
      });
      return { ok: false, reason: "legacy_output_drain_expired" as const };
    }
    let outputAttempt: any | null = null;
    if (outputProtocol === INGEST_OUTPUT_PROTOCOL_V2) {
      const outputAttemptIdValue = args.outputAttemptId?.trim() ?? "";
      if (!outputAttemptIdValue || file.ingestOutputAttemptId !== outputAttemptIdValue) {
        return { ok: false, reason: "output_attempt_mismatch" as const };
      }
      const attempts = await outputAttemptsForVersion(ctx, file._id, args.ingestVersion);
      outputAttempt = v2OutputAttempt(attempts, outputAttemptIdValue);
      if (
        !outputAttempt
        || outputAttempt.claimToken !== args.claimToken
        || outputAttempt.state !== "active"
      ) {
        return { ok: false, reason: "output_attempt_mismatch" as const };
      }
      const expected = outboxOutputKeys(outputAttempt);
      if (
        (args.extractedTextR2Key !== undefined && args.extractedTextR2Key !== expected.extractedTextR2Key)
        || (args.previewR2Key !== undefined && args.previewR2Key !== expected.previewR2Key)
      ) {
        return { ok: false, reason: "output_key_mismatch" as const };
      }
    } else {
      if (args.outputAttemptId !== undefined) {
        // A V1 worker cannot accidentally complete a V2 generation by
        // smuggling an attempt id into the old compatibility path.
        return { ok: false, reason: "output_attempt_mismatch" as const };
      }
      // The old Trigger only knows the exact shared V1 pair. Enforce that
      // narrow shape during the bridge so an old worker capability cannot
      // persist or later inline-delete an arbitrary V2/private R2 path.
      const expected = derivedOutputKeys(file._id, args.ingestVersion, INGEST_OUTPUT_PROTOCOL_V1, "legacy");
      if (
        (args.extractedTextR2Key !== undefined && args.extractedTextR2Key !== expected.extractedTextR2Key)
        || (args.previewR2Key !== undefined && args.previewR2Key !== expected.previewR2Key)
      ) {
        return { ok: false, reason: "output_key_mismatch" as const };
      }
    }
    const sha256 = normalizeUploadSha256(args.sha256);
    if (!sha256 || sha256 !== file.expectedSha256) {
      if (outputAttempt) {
        const now = Date.now();
        await ctx.db.patch(outputAttempt._id, {
          state: "cleanup",
          writerHandoff: true,
          cleanupClaimToken: undefined,
          cleanupClaimExpiresAt: undefined,
          nextCleanupAt: now,
          updatedAt: now,
        });
      }
      await ctx.db.patch(file._id, {
        status: "quarantined",
        errorCode: "content_digest_mismatch",
        ingestClaimToken: undefined,
        lastProgressAt: Date.now(),
        updatedAt: Date.now(),
      });
      return { ok: false, reason: "digest_mismatch" as const };
    }
    if (args.chunks.length > CHAT_FILE_LIMITS.maxChunks || args.extractedChars > CHAT_FILE_LIMITS.maxExtractedChars) {
      throw new ConvexError({ code: "INGEST_RESULT_LIMIT", message: "Extracted file result exceeded its durable limit" });
    }
    const oldChunks = await ctx.db.query("fileChunks").withIndex("by_file_ordinal", (q) => q.eq("fileId", file._id)).take(CHAT_FILE_LIMITS.maxChunks + 1);
    if (oldChunks.length > CHAT_FILE_LIMITS.maxChunks) throw new Error("file chunk cleanup bound exceeded");
    for (const chunk of oldChunks) await ctx.db.delete(chunk._id);
    const now = Date.now();
    for (let index = 0; index < args.chunks.length; index += 1) {
      const chunk = args.chunks[index];
      if (chunk.ordinal !== index || !chunk.text.trim() || chunk.text.length > 2_200) throw new Error("invalid extracted chunk");
      await ctx.db.insert("fileChunks", {
        fileId: file._id,
        fileKey: String(file._id),
        ordinal: index,
        text: chunk.text,
        page: chunk.page,
        sheet: chunk.sheet?.slice(0, 120),
        cellRange: chunk.cellRange?.slice(0, 80),
        chars: chunk.text.length,
        createdAt: now,
      });
    }
    const summary = args.summary?.trim().slice(0, 1_500) || undefined;
    await ctx.db.patch(file._id, {
      detectedMimeType: normalizeUploadMime(args.detectedMimeType),
      sha256,
      status: args.status,
      summary,
      searchText: `${file.originalName} ${file.relativePath} ${summary ?? ""}`.slice(0, 4_000),
      extractedTextR2Key: args.extractedTextR2Key?.slice(0, 700),
      previewR2Key: args.previewR2Key?.slice(0, 700),
      extractedChars: args.extractedChars,
      chunkCount: args.chunks.length,
      pageCount: args.pageCount,
      sheetNames: args.sheetNames?.slice(0, 50).map((name) => name.slice(0, 120)),
      ingestClaimToken: undefined,
      ingestOutputMayWriteUntil: undefined,
      lastProgressAt: now,
      errorCode: undefined,
      updatedAt: now,
    });
    if (outputAttempt) {
      // This is the critical atomic consume: either the terminal file row and
      // its pointers commit together with removal of the V2 intent, or neither
      // does. A lost response can therefore reconcile by attempt identity.
      await ctx.db.delete(outputAttempt._id);
    } else {
      const attempts = await outputAttemptsForVersion(ctx, file._id, args.ingestVersion);
      const legacyMarker = legacyBridgeMarker(attempts);
      if (legacyMarker && legacyMarker.claimToken === args.claimToken) await ctx.db.delete(legacyMarker._id);
    }
    return { ok: true, status: args.status };
  },
});

/**
 * Reconcile an ambiguous completeIngest response without ever replaying the
 * terminal mutation. The receipt is intentionally exact: a later retry may
 * reuse the file id but must not make an older worker believe its derived
 * objects are still authoritative.
 */
export const ingestCommitReceipt = query({
  args: {
    fileId: v.id("files"),
    ingestVersion: v.number(),
    extractedTextR2Key: v.optional(v.string()),
    previewR2Key: v.optional(v.string()),
    outputAttemptId: v.optional(v.string()),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireWorker(args.workerToken);
    const file = await ctx.db.get(args.fileId);
    if (
      !file
      || file.ingestVersion !== args.ingestVersion
      || (file.status !== "ready" && file.status !== "stored_only")
      || (file.extractedTextR2Key ?? undefined) !== args.extractedTextR2Key
      || (file.previewR2Key ?? undefined) !== args.previewR2Key
      || (args.outputAttemptId !== undefined && file.ingestOutputAttemptId !== args.outputAttemptId)
    ) {
      return { committed: false as const };
    }
    return { committed: true as const, status: file.status };
  },
});

/**
 * Atomically turn an ambiguous completeIngest outcome into either a confirmed
 * commit or an exact durable cleanup item. A same-version active claim is
 * fenced before it can race the cleanup worker's R2 DELETE.
 */
export const enqueueIngestDerivedCleanup = mutation({
  args: {
    fileId: v.id("files"),
    ingestVersion: v.number(),
    claimToken: v.string(),
    extractedTextR2Key: v.optional(v.string()),
    previewR2Key: v.optional(v.string()),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireWorker(args.workerToken);
    await assertNormalFileMutationAllowed(ctx);
    const r2Keys = legacyDerivedCleanupKeys(args);
    const file = await ctx.db.get(args.fileId);
    const existing = await ctx.db
      .query("fileIngestCleanupOutbox")
      .withIndex("by_file_version", (q) => q.eq("fileId", args.fileId).eq("ingestVersion", args.ingestVersion))
      .first();
    if (file && Number(file.ingestOutputProtocol ?? INGEST_OUTPUT_PROTOCOL_V1) === INGEST_OUTPUT_PROTOCOL_V2) {
      return { committed: false as const, conflict: true as const };
    }
    if (file && matchesIngestCommit(file, args)) {
      if (existing) await ctx.db.delete(existing._id);
      return { committed: true as const, status: file.status as "ready" | "stored_only" };
    }
    const exactActiveClaim = Boolean(
      file
      && file.ingestVersion === args.ingestVersion
      && file.status === "processing"
      && file.ingestClaimToken === args.claimToken,
    );
    if (file?.ingestVersion === args.ingestVersion && file.status === "processing" && !exactActiveClaim) {
      // A newer worker owns these deterministic keys. Wait for its durable
      // terminal state rather than scheduling a cleanup that could delete it.
      return { committed: false as const, waiting: true as const };
    }
    if (file && exactActiveClaim) {
      const now = Date.now();
      // Keep a legacy bridge sweep alongside the historical one-shot outbox:
      // an old worker may have an accepted V1 PUT after its response-loss
      // path, and the bridge is the durable reaper for that shared pair.
      await transferOutputAttemptToCleanup(ctx, file, now);
      await ctx.db.patch(file._id, {
        status: "error",
        errorCode: "ingest_completion_outcome_unknown",
        ingestClaimToken: undefined,
        lastProgressAt: now,
        updatedAt: now,
      });
    }
    if (!r2Keys.length) return { committed: false as const, enqueued: false as const };
    if (existing) {
      if (
        (existing.extractedTextR2Key ?? undefined) !== args.extractedTextR2Key
        || (existing.previewR2Key ?? undefined) !== args.previewR2Key
      ) {
        return { committed: false as const, conflict: true as const };
      }
      return { committed: false as const, outboxId: existing._id };
    }
    const now = Date.now();
    const outboxId = await ctx.db.insert("fileIngestCleanupOutbox", {
      fileId: args.fileId,
      ingestVersion: args.ingestVersion,
      extractedTextR2Key: args.extractedTextR2Key,
      previewR2Key: args.previewR2Key,
      createdAt: now,
      updatedAt: now,
    });
    return { committed: false as const, outboxId };
  },
});

/** Worker-only fallback sweep for cleanup items whose immediate Trigger call was lost. */
export const pendingIngestDerivedCleanup = query({
  args: { limit: v.optional(v.number()), workerToken: v.optional(v.string()) },
  handler: async (ctx, args) => {
    requireWorker(args.workerToken);
    const limit = Math.min(12, Math.max(1, Math.floor(args.limit ?? 8)));
    const rows = await ctx.db.query("fileIngestCleanupOutbox").withIndex("by_createdAt").take(limit);
    return rows.map((row) => ({ outboxId: row._id, fileId: String(row.fileId), ingestVersion: row.ingestVersion }));
  },
});

/** Recheck the durable receipt immediately before an external R2 DELETE. */
export const claimIngestDerivedCleanup = mutation({
  args: {
    outboxId: v.id("fileIngestCleanupOutbox"),
    cleanupClaimToken: v.string(),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireWorker(args.workerToken);
    await assertNormalFileMutationAllowed(ctx);
    const cleanupClaimToken = args.cleanupClaimToken.trim().slice(0, 160);
    if (!cleanupClaimToken) throw new ConvexError({ code: "INGEST_OUTPUT_CLEANUP", message: "Legacy cleanup claim identity is invalid" });
    const outbox = await ctx.db.get(args.outboxId);
    if (!outbox) return null;
    const now = Date.now();
    if (
      outbox.cleanupClaimToken
      && outbox.cleanupClaimToken !== cleanupClaimToken
      && Number(outbox.cleanupClaimExpiresAt ?? 0) > now
    ) {
      return { ready: false as const, retryAfterMs: Number(outbox.cleanupClaimExpiresAt) - now };
    }
    const file = await ctx.db.get(outbox.fileId);
    const keys = legacyDerivedCleanupKeys(outbox);
    let cleanupKeys = keys;
    if (matchesIngestCommit(file, outbox)) {
      await ctx.db.delete(outbox._id);
      return { ready: false as const, committed: true as const };
    }
    if (
      file
      && file.ingestVersion === outbox.ingestVersion
      && ["ready", "stored_only", "error", "quarantined"].includes(file.status)
    ) {
      // Old V1 rows share the vN names. Preserve every pointer the terminal
      // file currently owns—even when its result is a different text/preview
      // subset than the stale legacy cleanup pair.
      const referenced = new Set([file.extractedTextR2Key, file.previewR2Key].filter((key): key is string => Boolean(key)));
      cleanupKeys = keys.filter((key) => !referenced.has(key));
      if (!cleanupKeys.length) {
        await ctx.db.delete(outbox._id);
        return { ready: false as const, committed: true as const };
      }
    }
    if (file && file.ingestVersion === outbox.ingestVersion && file.status === "processing") {
      return { ready: false as const, retryAfterMs: 15_000 };
    }
    if (!cleanupKeys.length) {
      await ctx.db.delete(outbox._id);
      return { ready: false as const, committed: true as const };
    }
    // Persist the exact V1 role subset before returning keys to an external
    // DELETE worker. `finish` intentionally leaves this marker sweeping
    // forever: an accepted delete can complete after the worker
    // response/liveness lease has been lost, and rehome start must see that
    // physical uncertainty rather than invent a clean drain. Do not widen a
    // preview-only stale delete into a full shared pair; that would let the
    // later reaper erase a terminal text pointer it never owned.
    const bridgeFile = file ?? {
      _id: outbox.fileId,
      ingestVersion: outbox.ingestVersion,
      ingestAttempt: 1,
      lastProgressAt: now,
      ingestClaimToken: cleanupClaimToken,
    };
    let bridge = legacyBridgeMarker(await outputAttemptsForVersion(ctx, outbox.fileId, outbox.ingestVersion));
    bridge = bridge ?? await startLegacyBridgeMarker(ctx, bridgeFile, cleanupClaimToken, now, cleanupKeys);
    if (bridge) {
      const bridgeKeys = outboxOutputKeys(bridge);
      await ctx.db.patch(bridge._id, {
        state: "legacy_sweeping",
        // The marker now records that a V1 external delete may be in flight,
        // not merely that an old writer might PUT. Its exact pair remains a
        // reaper and a migration-start safety fence.
        writeStarted: true,
        // Missing flags mean a pre-compat full-pair history, so preserve that
        // conservative interpretation while unioning any new subset.
        cleanupExtractedText: bridge.cleanupExtractedText !== false || cleanupKeys.includes(bridgeKeys.extractedTextR2Key),
        cleanupPreview: bridge.cleanupPreview !== false || cleanupKeys.includes(bridgeKeys.previewR2Key),
        cleanupClaimToken: undefined,
        cleanupClaimExpiresAt: undefined,
        nextCleanupAt: now,
        updatedAt: now,
      });
    }
    await ctx.db.patch(outbox._id, {
      cleanupClaimToken,
      cleanupClaimExpiresAt: now + INGEST_OUTPUT_CLEANUP_LEASE_MS,
      deleteStarted: true,
      updatedAt: now,
    });
    return { ready: true as const, r2Keys: cleanupKeys };
  },
});

export const finishIngestDerivedCleanup = mutation({
  args: {
    outboxId: v.id("fileIngestCleanupOutbox"),
    cleanupClaimToken: v.string(),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireWorker(args.workerToken);
    await assertNormalFileMutationAllowed(ctx);
    const outbox = await ctx.db.get(args.outboxId);
    if (!outbox) return true;
    if (outbox.cleanupClaimToken !== args.cleanupClaimToken.trim()) return false;
    await ctx.db.delete(outbox._id);
    return true;
  },
});

/**
 * V2 workers transfer only their Convex-allocated output attempt. They never
 * submit R2 keys, which keeps the shared worker capability from becoming an
 * arbitrary private-object deletion primitive.
 */
export const retireIngestOutputAttempt = mutation({
  args: {
    fileId: v.id("files"),
    ingestVersion: v.number(),
    claimToken: v.string(),
    outputAttemptId: v.id("fileIngestOutputAttempts"),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireWorker(args.workerToken);
    await assertNormalFileMutationAllowed(ctx);
    const [file, outbox] = await Promise.all([ctx.db.get(args.fileId), ctx.db.get(args.outputAttemptId)]);
    if (!outbox) {
      // completeIngest atomically consumes a successful V2 row. With no row
      // left, the persisted V2 attempt id is the receipt for a lost response;
      // this branch has no cleanup side effect.
      if (
        file
        && file.ingestVersion === args.ingestVersion
        && file.ingestOutputProtocol === INGEST_OUTPUT_PROTOCOL_V2
        && (file.status === "ready" || file.status === "stored_only")
        && file.ingestOutputAttemptId
      ) {
        return { committed: true as const, status: file.status };
      }
      return { committed: false as const, missing: true as const };
    }
    if (
      outbox.fileId !== args.fileId
      || outbox.ingestVersion !== args.ingestVersion
      || outbox.outputProtocol !== INGEST_OUTPUT_PROTOCOL_V2
      || outbox.claimToken !== args.claimToken
    ) return { committed: false as const, missing: true as const };

    // Verify the exact durable pair before this worker can either consume its
    // own receipt or hand it to a deletion task. In particular, a worker must
    // never be able to retire another file's attempt by passing its row ID.
    const keys = outboxOutputKeys(outbox);
    if (matchesIngestCommit(file, {
      ingestVersion: outbox.ingestVersion,
      extractedTextR2Key: keys.extractedTextR2Key,
      previewR2Key: keys.previewR2Key,
      outputAttemptId: outbox.outputAttemptId,
    })) {
      await ctx.db.delete(outbox._id);
      return { committed: true as const, status: file!.status };
    }
    const now = Date.now();
    const ownsCurrentClaim = Boolean(
      file
      && file.status === "processing"
      && file.ingestVersion === args.ingestVersion
      && file.ingestClaimToken === args.claimToken
      && file.ingestOutputProtocol === INGEST_OUTPUT_PROTOCOL_V2
      && file.ingestOutputAttemptId === outbox.outputAttemptId,
    );
    if (ownsCurrentClaim && file) {
      await ctx.db.patch(file._id, {
        status: "error",
        errorCode: "ingest_completion_outcome_unknown",
        ingestClaimToken: undefined,
        ingestOutputMayWriteUntil: undefined,
        lastProgressAt: now,
        updatedAt: now,
      });
    }
    await ctx.db.patch(outbox._id, {
      state: "cleanup",
      // The worker reached this explicit retirement callback after its
      // complete response was lost, so it has handed off future writes.
      writerHandoff: true,
      cleanupClaimToken: undefined,
      cleanupClaimExpiresAt: undefined,
      nextCleanupAt: now,
      updatedAt: now,
    });
    return { committed: false as const, outputAttemptId: outbox._id };
  },
});

/** Worker-only recovery sweep for V2 intents and V1 bridge markers. */
export const pendingIngestOutputCleanup = query({
  args: { limit: v.optional(v.number()), workerToken: v.optional(v.string()) },
  handler: async (ctx, args) => {
    requireWorker(args.workerToken);
    const limit = Math.min(12, Math.max(1, Math.floor(args.limit ?? 8)));
    const now = Date.now();
    // Do not scan by creation time: nonterminal sweep rows intentionally live
    // forever, and a handful of future-scheduled old rows must not starve a
    // newly due cleanup attempt behind them. The state/next-cleanup index
    // gives every durable phase a bounded, due-first slice.
    const states = ["active", "cleanup", "sweeping", "legacy_sweeping", "deleting"] as const;
    const rows = (await Promise.all(states.map(async (state) => await ctx.db
      .query("fileIngestOutputAttempts")
      .withIndex("by_state_cleanup", (q) => q.eq("state", state).lte("nextCleanupAt", now))
      .take(limit)))).flat();
    return rows
      .filter((row) => row.state !== "deleting" || Number(row.cleanupClaimExpiresAt ?? 0) <= now)
      .sort((left, right) => left.nextCleanupAt - right.nextCleanupAt || left.createdAt - right.createdAt)
      .slice(0, limit)
      .map((row) => ({ outputAttemptId: row._id, fileId: String(row.fileId), ingestVersion: row.ingestVersion }));
  },
});

export const claimIngestOutputCleanup = mutation({
  args: {
    outputAttemptId: v.id("fileIngestOutputAttempts"),
    cleanupClaimToken: v.string(),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireWorker(args.workerToken);
    const cleanupClaimToken = args.cleanupClaimToken.trim().slice(0, 160);
    if (!cleanupClaimToken) throw new ConvexError({ code: "INGEST_OUTPUT_CLEANUP", message: "Cleanup claim identity is invalid" });
    const outbox = await ctx.db.get(args.outputAttemptId);
    if (!outbox) return null;
    const keys = outboxOutputKeys(outbox);
    const now = Date.now();
    const file = await ctx.db.get(outbox.fileId);
    const rehomes = await ctx.db
      .query("fileDerivedArtifactRehomes")
      .withIndex("by_file", (q: any) => q.eq("fileId", outbox.fileId))
      .take(4);
    const rehomeControl = await fileDerivedArtifactRehomeControl(ctx);
    const v1SourceAlreadyCutOver = rehomes.some((rehome: any) =>
      rehome.state === "cutover" && rehome.sourceIngestVersion === outbox.ingestVersion);
    if (
      outbox.outputProtocol === INGEST_OUTPUT_PROTOCOL_V1
      && rehomeBlocksNormalFileMutation(rehomeControl)
      && !v1SourceAlreadyCutOver
    ) {
      // Before inventory has placed a per-file migration lock, an old
      // cleanup row still knows the shared V1 paths. The durable global freeze
      // must fence it too: otherwise an already-due cleanup can erase a V1
      // source between freeze and its manifest snapshot. A post-CAS source
      // sweeper is the deliberate exception: its manifest proves the file no
      // longer references that V1 version, so it keeps reaping late V1 PUTs.
      return { ready: false as const, retryAfterMs: FILE_DERIVED_ARTIFACT_REHOME_RETRY_AFTER_MS };
    }
    const activeRehomeTarget = rehomes.find((rehome: any) =>
      rehome.targetOutputAttemptOutboxId === outbox._id
      && ["copying", "verified"].includes(rehome.state));
    if (activeRehomeTarget) {
      // A generic worker must never delete the current rehome generation. The
      // rehome worker either commits it atomically or retires this exact
      // receipt first, at which point it is no longer an active target.
      return { ready: false as const, retryAfterMs: FILE_DERIVED_ARTIFACT_REHOME_RETRY_AFTER_MS };
    }
    if (
      outbox.outputProtocol === INGEST_OUTPUT_PROTOCOL_V1
      && file?.derivedArtifactRehomeId
    ) {
      // This shared V1 pair is still the migration source. It is swept only
      // after the pointer CAS clears the file lock; no normal cleanup gets to
      // race the full-copy/readback proof.
      return { ready: false as const, retryAfterMs: FILE_DERIVED_ARTIFACT_REHOME_RETRY_AFTER_MS };
    }
    if (
      outbox.outputProtocol === INGEST_OUTPUT_PROTOCOL_V2
      && matchesIngestCommit(file, {
        ingestVersion: outbox.ingestVersion,
        extractedTextR2Key: keys.extractedTextR2Key,
        previewR2Key: keys.previewR2Key,
        outputAttemptId: outbox.outputAttemptId,
      })
    ) {
      await ctx.db.delete(outbox._id);
      return { ready: false as const, committed: true as const };
    }
    if (
      outbox.state === "deleting"
      && outbox.cleanupClaimToken !== cleanupClaimToken
      && Number(outbox.cleanupClaimExpiresAt ?? 0) > now
    ) {
      return { ready: false as const, retryAfterMs: Number(outbox.cleanupClaimExpiresAt) - now };
    }
    if (outbox.state === "active") {
      if (outbox.producerMayWriteUntil > now) {
        return { ready: false as const, retryAfterMs: outbox.producerMayWriteUntil - now };
      }
      if (
        outbox.outputProtocol === INGEST_OUTPUT_PROTOCOL_V2
        && file
        && file.status === "processing"
        && file.ingestVersion === outbox.ingestVersion
        && file.ingestOutputProtocol === INGEST_OUTPUT_PROTOCOL_V2
        && file.ingestOutputAttemptId === outbox.outputAttemptId
        && file.ingestClaimToken === outbox.claimToken
      ) {
        // Its hard producer window is over. Fence the exact stale producer
        // before handing its unique paths to R2 cleanup.
        await ctx.db.patch(file._id, {
          status: "error",
          errorCode: "ingest_output_attempt_expired",
          ingestClaimToken: undefined,
          ingestOutputMayWriteUntil: undefined,
          lastProgressAt: now,
          updatedAt: now,
        });
      }
      if (outbox.outputProtocol === INGEST_OUTPUT_PROTOCOL_V1) {
        await moveLegacyBridgeToSweep(ctx, outbox, now);
      } else {
        // The logical producer lease is not a physical R2 fence. Preserve a
        // nonterminal exact attempt after expiry and sweep it repeatedly in
        // case an accepted PUT completes after this cleanup pass.
        await ctx.db.patch(outbox._id, {
          state: "sweeping",
          writerHandoff: false,
          nextCleanupAt: now,
          updatedAt: now,
        });
      }
    }
    const refreshed = await ctx.db.get(args.outputAttemptId);
    if (!refreshed) return null;
    if (
      (refreshed.state === "legacy_sweeping" || refreshed.state === "sweeping")
      && refreshed.nextCleanupAt > now
    ) {
      return { ready: false as const, retryAfterMs: refreshed.nextCleanupAt - now };
    }
    const cleanupKeys = safeV1OutputAttemptCleanupKeys(file, refreshed);
    if (!cleanupKeys.length) {
      // Retain the V1 bridge as durable physical-delete history, but never
      // issue a no-op full-pair delete when the only recorded role is still
      // referenced by a ready/stored-only file.
      if (refreshed.outputProtocol === INGEST_OUTPUT_PROTOCOL_V1) {
        await ctx.db.patch(refreshed._id, {
          state: "legacy_sweeping",
          cleanupClaimToken: undefined,
          cleanupClaimExpiresAt: undefined,
          nextCleanupAt: now + LEGACY_OUTPUT_SWEEP_INTERVAL_MS,
          updatedAt: now,
        });
      }
      return { ready: false as const, committed: true as const };
    }
    await ctx.db.patch(refreshed._id, {
      state: "deleting",
      cleanupClaimToken,
      cleanupClaimExpiresAt: now + INGEST_OUTPUT_CLEANUP_LEASE_MS,
      updatedAt: now,
    });
    return { ready: true as const, r2Keys: cleanupKeys };
  },
});

export const finishIngestOutputCleanup = mutation({
  args: {
    outputAttemptId: v.id("fileIngestOutputAttempts"),
    cleanupClaimToken: v.string(),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireWorker(args.workerToken);
    const outbox = await ctx.db.get(args.outputAttemptId);
    if (!outbox) return true;
    if (outbox.state !== "deleting" || outbox.cleanupClaimToken !== args.cleanupClaimToken.trim()) return false;
    if (
      outbox.outputProtocol === INGEST_OUTPUT_PROTOCOL_V1
      || !outbox.writerHandoff
      // An explicit Convex handoff cannot prove a previously-issued R2 PUT
      // did not reach the provider after its client response was lost. Only a
      // durable prewrite record of `false` permits V2 consumption here.
      || outbox.writeStarted !== false
    ) {
      // Keep the known shared V1 pair sweepable through the compatibility
      // bridge. V2 does the same when its producer lease expired without an
      // explicit terminal handoff: elapsed time cannot prove a late accepted
      // R2 PUT will never land, so the exact path remains reaped.
      const now = Date.now();
      await ctx.db.patch(outbox._id, {
        state: outbox.outputProtocol === INGEST_OUTPUT_PROTOCOL_V1 ? "legacy_sweeping" : "sweeping",
        cleanupClaimToken: undefined,
        cleanupClaimExpiresAt: undefined,
        nextCleanupAt: now + LEGACY_OUTPUT_SWEEP_INTERVAL_MS,
        sweepCount: outbox.sweepCount + 1,
        updatedAt: now,
      });
      return true;
    }
    await ctx.db.delete(outbox._id);
    return true;
  },
});

export const failIngest = mutation({
  args: {
    fileId: v.id("files"),
    ingestVersion: v.number(),
    claimToken: v.string(),
    errorCode: v.string(),
    quarantined: v.optional(v.boolean()),
    ...actorAuthArgs,
  },
  handler: async (ctx, args) => {
    await requireActor(ctx, args);
    await assertNormalFileMutationAllowed(ctx);
    const file = await ctx.db.get(args.fileId);
    // See completeIngest above. A worker that has reached its terminal error
    // path cannot write another derivative, so release only its exact
    // delete-deferred claim rather than holding deletion for a stale timeout.
    if (
      file
      && file.status === "deleting"
      && file.deletePreviousStatus === "processing"
      && file.ingestVersion === args.ingestVersion
      && file.ingestClaimToken === args.claimToken
    ) {
      const now = Date.now();
      await transferOutputAttemptToCleanup(ctx, file, now);
      await ctx.db.patch(file._id, {
        ingestClaimToken: undefined,
        ingestOutputMayWriteUntil: undefined,
        lastProgressAt: now,
        updatedAt: now,
      });
      return true;
    }
    if (!file || file.status !== "processing" || file.ingestVersion !== args.ingestVersion || file.ingestClaimToken !== args.claimToken) return false;
    const now = Date.now();
    await transferOutputAttemptToCleanup(ctx, file, now);
    // See completeIngest's delete-deferred branch: V1 markers stay durable
    // after terminal callbacks because the old worker has no prewrite fence.
    await ctx.db.patch(file._id, {
      status: args.quarantined ? "quarantined" : "error",
      errorCode: args.errorCode.trim().slice(0, 120) || "ingest_failed",
      ingestClaimToken: undefined,
      ingestOutputMayWriteUntil: undefined,
      lastProgressAt: now,
      updatedAt: now,
    });
    return true;
  },
});

export const retryIngest = mutation({
  args: { fileId: v.id("files"), ...actorAuthArgs },
  handler: async (ctx, args) => {
    await requireActor(ctx, args);
    await assertNormalFileMutationAllowed(ctx);
    const file = await ctx.db.get(args.fileId);
    const staleProcessing = file?.status === "processing" && Number(file.lastProgressAt ?? 0) <= Date.now() - INGEST_CLAIM_STALE_MS;
    if (!file || (!staleProcessing && !["uploaded", "error", "stored_only"].includes(file.status))) return null;
    const now = Date.now();
    if (legacyOutputMayBeUncommitted(file)) {
      const marker = await startLegacyBridgeMarker(ctx, file, String(file.ingestClaimToken ?? "legacy"), now);
      if (staleProcessing && marker && marker.producerMayWriteUntil > now) return null;
      if (marker) await moveLegacyBridgeToSweep(ctx, marker, now);
    }
    const ingestVersion = file.ingestVersion + 1;
    await ctx.db.patch(file._id, {
      status: "uploaded",
      ingestVersion,
      ingestAttempt: 0,
      ingestClaimToken: undefined,
      ingestOutputProtocol: undefined,
      ingestOutputAttemptId: undefined,
      ingestOutputMayWriteUntil: undefined,
      errorCode: undefined,
      lastProgressAt: now,
      updatedAt: now,
    });
    return { fileId: String(file._id), ingestVersion };
  },
});

export const pendingIngest = query({
  args: { limit: v.optional(v.number()), ...actorAuthArgs },
  handler: async (ctx, args) => {
    await requireActor(ctx, args);
    return await pendingIngestWakeups(ctx, Math.min(12, Math.max(1, Math.floor(args.limit ?? 8))));
  },
});

export const contextForMessage = query({
  args: { messageId: v.id("chatMessages"), ...actorAuthArgs },
  handler: async (ctx, args) => {
    await requireActor(ctx, args);
    return await messageFileManifests(ctx, args.messageId);
  },
});

/**
 * Atomically refreshes the exact claimed source set and creates the short
 * deletion fence consumed by the foreground worker. The assistant row, its
 * parent user message, the message-file link, and every ready file are checked
 * in this mutation so a delete racing this final validation serializes on the
 * file row rather than leaving a stale R2 key in the model payload.
 */
export const acquireTurnFileLeases = mutation({
  args: {
    threadId: v.string(),
    messageId: v.id("chatMessages"),
    assistantId: v.id("chatMessages"),
    claimToken: v.string(),
    leaseId: v.string(),
    sources: v.array(v.object({
      fileId: v.id("files"),
      sourceKey: v.string(),
    })),
    ...actorAuthArgs,
  },
  handler: async (ctx, args) => {
    await requireActor(ctx, args);
    await assertNormalFileMutationAllowed(ctx);
    const threadId = ownerThread(args.threadId);
    const leaseId = boundedTurnLeaseId(args.leaseId);
    if (args.sources.length > CHAT_FILE_LIMITS.maxFilesPerMessage) {
      throw new ConvexError({ code: "INVALID_FILE_LEASE", message: "Private file lease source bound exceeded" });
    }
    const requested = new Map<string, { fileId: any; sourceKey: string }>();
    for (const source of args.sources) {
      requested.set(String(source.fileId), {
        fileId: source.fileId,
        sourceKey: boundedTurnSourceKey(source.sourceKey),
      });
    }
    if (requested.size !== args.sources.length) {
      throw new ConvexError({ code: "INVALID_FILE_LEASE", message: "Private file lease sources must be unique" });
    }
    if (!requested.size) return { leaseId, leased: true as const };

    const [message, assistant] = await Promise.all([ctx.db.get(args.messageId), ctx.db.get(args.assistantId)]);
    if (
      !message
      || message.role !== "user"
      || message.threadId !== threadId
      || !assistant
      || assistant.role !== "assistant"
      || assistant.threadId !== threadId
      || assistant.parentMessageId !== message._id
      || assistant.status !== "streaming"
      || assistant.claimToken !== args.claimToken
    ) return { leaseId, leased: false as const };

    const now = Date.now();
    const expiresAt = now + TURN_FILE_LEASE_MS;
    const [links, existingLeases] = await Promise.all([
      ctx.db
        .query("messageFiles")
        .withIndex("by_message", (q: any) => q.eq("messageId", message._id))
        .take(CHAT_FILE_LIMITS.maxFilesPerMessage + 1),
      ctx.db
        .query("chatTurnFileLeases")
        .withIndex("by_assistant_claim_lease", (q: any) => q
          .eq("assistantId", assistant._id)
          .eq("claimToken", args.claimToken)
          .eq("leaseId", leaseId))
        .take(CHAT_FILE_LIMITS.maxFilesPerMessage + 1),
    ]);
    if (links.length > CHAT_FILE_LIMITS.maxFilesPerMessage) return { leaseId, leased: false as const };
    const attachedFileIds = new Set(
      links.filter((link: any) => link.threadId === threadId).map((link: any) => String(link.fileId)),
    );

    // Validate every source before creating any row. A two-file turn must
    // never pin A while B changed between the last refresh and model send.
    const validated = await Promise.all([...requested.entries()].map(async ([fileKey, source]) => {
      if (!attachedFileIds.has(fileKey)) return null;
      const file = await ctx.db.get(source.fileId) as any;
      if (!file || !FILE_READY_STATUSES.has(String(file.status))) return null;
      const liveSourceKey = privateFileSourceKey({
        status: String(file.status),
        mimeType: String(file.detectedMimeType ?? file.mimeType),
        sizeBytes: Number(file.sizeBytes),
        r2Key: String(file.r2Key),
        previewR2Key: file.previewR2Key ? String(file.previewR2Key) : undefined,
      });
      return liveSourceKey === source.sourceKey ? { file, source } : null;
    }));
    if (validated.some((source) => source === null)) return { leaseId, leased: false as const };
    const exactSources = validated as Array<{ file: any; source: { fileId: any; sourceKey: string } }>;

    const expiredLeases = existingLeases.filter((lease: any) => Number(lease.expiresAt) <= now);
    const activeLeases = existingLeases.filter((lease: any) => Number(lease.expiresAt) > now);
    const expectedByFileId = new Map(exactSources.map(({ file, source }) => [String(file._id), source.sourceKey]));
    const existingLeaseSetMatches = activeLeases.length === exactSources.length
      && new Set(activeLeases.map((lease: any) => String(lease.fileId))).size === exactSources.length
      && activeLeases.every((lease: any) =>
        lease.threadId === threadId
        && String(lease.messageId) === String(message._id)
        && expectedByFileId.get(String(lease.fileId)) === lease.sourceKey,
      );
    for (const lease of expiredLeases) await ctx.db.delete(lease._id);
    if (activeLeases.length && !existingLeaseSetMatches) return { leaseId, leased: false as const };

    if (existingLeaseSetMatches) {
      for (const lease of activeLeases) await ctx.db.patch(lease._id, { expiresAt });
    } else {
      for (const { file, source } of exactSources) {
        await ctx.db.insert("chatTurnFileLeases", {
          fileId: file._id,
          threadId,
          messageId: message._id,
          assistantId: assistant._id,
          claimToken: args.claimToken,
          leaseId,
          sourceKey: source.sourceKey,
          expiresAt,
          createdAt: now,
        });
      }
    }
    // This write makes final source validation and a deletion transition
    // conflict even when their index reads race on an otherwise empty lease.
    for (const { file } of exactSources) await ctx.db.patch(file._id, { updatedAt: now });
    return { leaseId, leased: true as const, expiresAt };
  },
});

/** Release only the source pins owned by the exact still-fenced foreground
 * turn. A retry or a different message/claim cannot release another turn's
 * private source lease. */
export const releaseTurnFileLeases = mutation({
  args: {
    threadId: v.string(),
    messageId: v.id("chatMessages"),
    assistantId: v.id("chatMessages"),
    claimToken: v.string(),
    leaseId: v.string(),
    ...actorAuthArgs,
  },
  handler: async (ctx, args) => {
    await requireActor(ctx, args);
    const threadId = ownerThread(args.threadId);
    const leaseId = boundedTurnLeaseId(args.leaseId);
    const [message, assistant] = await Promise.all([ctx.db.get(args.messageId), ctx.db.get(args.assistantId)]);
    if (
      !message
      || message.role !== "user"
      || message.threadId !== threadId
      || !assistant
      || assistant.role !== "assistant"
      || assistant.threadId !== threadId
      || assistant.parentMessageId !== message._id
      || assistant.claimToken !== args.claimToken
    ) return false;
    const leases = await ctx.db
      .query("chatTurnFileLeases")
      .withIndex("by_assistant_claim_lease", (q: any) => q
        .eq("assistantId", assistant._id)
        .eq("claimToken", args.claimToken)
        .eq("leaseId", leaseId))
      .take(CHAT_FILE_LIMITS.maxFilesPerMessage + 1);
    let released = false;
    for (const lease of leases) {
      if (lease.threadId !== threadId || String(lease.messageId) !== String(message._id)) continue;
      await ctx.db.delete(lease._id);
      released = true;
    }
    return released;
  },
});

export const searchAttachedFiles = query({
  args: {
    messageId: v.id("chatMessages"),
    mode: v.union(v.literal("search"), v.literal("read")),
    text: v.optional(v.string()),
    fileId: v.optional(v.id("files")),
    afterOrdinal: v.optional(v.number()),
    limit: v.optional(v.number()),
    ...actorAuthArgs,
  },
  handler: async (ctx, args) => {
    await requireActor(ctx, args);
    const message = await ctx.db.get(args.messageId);
    if (!message || message.role !== "user") {
      throw new ConvexError({ code: "INVALID_FILE_MESSAGE", message: "File search requires a user message" });
    }
    const text = args.text?.trim().slice(0, 240) ?? "";
    if (args.mode === "search" && !text) {
      throw new ConvexError({ code: "INVALID_FILE_SEARCH", message: "Search terms are required" });
    }
    const limit = Math.min(6, Math.max(1, Math.floor(args.limit ?? 5)));
    const links = await ctx.db
      .query("messageFiles")
      .withIndex("by_message", (q) => q.eq("messageId", message._id))
      .take(CHAT_FILE_LIMITS.maxFilesPerMessage + 1);
    if (links.length > CHAT_FILE_LIMITS.maxFilesPerMessage) {
      throw new ConvexError({ code: "INVALID_FILE_SELECTION", message: "Message file bound exceeded" });
    }
    const selectedLinks = args.fileId
      ? links.filter((link) => String(link.fileId) === String(args.fileId))
      : links;
    if (args.fileId && selectedLinks.length !== 1) {
      throw new ConvexError({ code: "FILE_NOT_ATTACHED", message: "That file is not attached to this message" });
    }
    const results: Array<{
      fileId: string;
      name: string;
      ordinal: number;
      page?: number;
      sheet?: string;
      cellRange?: string;
      text: string;
    }> = [];
    let remainingChars = CHAT_FILE_LIMITS.maxContextChars;
    if (args.mode === "read") {
      if (!args.fileId) {
        throw new ConvexError({ code: "INVALID_FILE_READ", message: "Reading requires an attached file identity" });
      }
      const afterOrdinal = Math.floor(args.afterOrdinal ?? -1);
      if (!Number.isSafeInteger(afterOrdinal) || afterOrdinal < -1 || afterOrdinal >= CHAT_FILE_LIMITS.maxChunks) {
        throw new ConvexError({ code: "INVALID_FILE_READ", message: "Read cursor is invalid" });
      }
      const file = await ctx.db.get(args.fileId);
      if (!file || !FILE_READY_STATUSES.has(String(file.status))) {
        throw new ConvexError({ code: "FILE_NOT_READY", message: "Attached file is not ready" });
      }
      const draft = await ctx.db.query("fileDocuments").withIndex("by_file", (q) => q.eq("fileId", file._id)).unique();
      if (draft) {
        const draftChunks = String(draft.content).match(/[\s\S]{1,2200}/g) ?? [];
        for (let ordinal = afterOrdinal + 1; ordinal < draftChunks.length && results.length < limit; ordinal += 1) {
          const excerpt = draftChunks[ordinal].slice(0, remainingChars);
          if (!excerpt) break;
          results.push({ fileId: String(file._id), name: String(file.originalName), ordinal, text: excerpt });
          remainingChars -= excerpt.length;
          if (remainingChars <= 0) break;
        }
        const nextOrdinal = results.at(-1)?.ordinal ?? afterOrdinal;
        return { mode: "read" as const, fileId: String(file._id), results, nextOrdinal, hasMore: nextOrdinal + 1 < draftChunks.length };
      }
      const chunks = await ctx.db
        .query("fileChunks")
        .withIndex("by_file_ordinal", (q) => q.eq("fileId", file._id).gt("ordinal", afterOrdinal))
        .take(limit + 1);
      for (const chunk of chunks.slice(0, limit)) {
        const raw = String(chunk.text).slice(0, 2_200);
        if (results.length && raw.length > remainingChars) break;
        const excerpt = raw.slice(0, remainingChars);
        if (!excerpt) break;
        results.push({
          fileId: String(file._id),
          name: String(file.originalName),
          ordinal: Number(chunk.ordinal),
          page: chunk.page === undefined ? undefined : Number(chunk.page),
          sheet: chunk.sheet === undefined ? undefined : String(chunk.sheet),
          cellRange: chunk.cellRange === undefined ? undefined : String(chunk.cellRange),
          text: excerpt,
        });
        remainingChars -= excerpt.length;
        if (remainingChars <= 0) break;
      }
      const nextOrdinal = results.at(-1)?.ordinal ?? afterOrdinal;
      return {
        mode: "read" as const,
        fileId: String(file._id),
        results,
        nextOrdinal,
        hasMore: chunks.length > results.length,
      };
    }

    for (const link of selectedLinks) {
      if (results.length >= limit || remainingChars <= 0) break;
      const file = await ctx.db.get(link.fileId);
      if (!file || !FILE_READY_STATUSES.has(String(file.status))) continue;
      const draft = await ctx.db.query("fileDocuments").withIndex("by_file", (q) => q.eq("fileId", file._id)).unique();
      if (draft) {
        const lower = String(draft.content).toLowerCase();
        const index = lower.indexOf(text.toLowerCase());
        if (index >= 0) {
          const start = Math.max(0, index - 320);
          const excerpt = String(draft.content).slice(start, start + Math.min(1_200, remainingChars));
          results.push({ fileId: String(file._id), name: String(file.originalName), ordinal: Math.floor(start / 2_200), text: excerpt });
          remainingChars -= excerpt.length;
        }
        continue;
      }
      const matches = await ctx.db
        .query("fileChunks")
        .withSearchIndex("search_text", (q) => q.search("text", text).eq("fileKey", String(file._id)))
        .take(limit - results.length);
      for (const chunk of matches) {
        const excerpt = String(chunk.text).slice(0, Math.min(1_200, remainingChars));
        if (!excerpt) continue;
        results.push({
          fileId: String(file._id),
          name: String(file.originalName),
          ordinal: Number(chunk.ordinal),
          page: chunk.page === undefined ? undefined : Number(chunk.page),
          sheet: chunk.sheet === undefined ? undefined : String(chunk.sheet),
          cellRange: chunk.cellRange === undefined ? undefined : String(chunk.cellRange),
          text: excerpt,
        });
        remainingChars -= excerpt.length;
        if (results.length >= limit || remainingChars <= 0) break;
      }
    }
    return { mode: "search" as const, results, hasMore: false };
  },
});

const FILE_TURN_READ_ONLY_TOOLS = new Set([
  "current_time", "calculate",
]);

const FILE_TURN_VISUAL_TOOLS = new Set([
  "show", "show_ranking", "visual_scene", "board", "mind_map", "chart", "memory_map", "draft", "show_uploaded_image",
]);
const GOOGLE_CALENDAR_REQUEST = /\b(?:google\s*calendar|gcal)\b/i;

/**
 * File excerpts are untrusted data. This authorization derives solely from the
 * immutable original user row, so instructions inside a PDF/image can never
 * grant the subscription model permission to perform consequential work.
 */
export const authorizeFileTool = query({
  args: { messageId: v.id("chatMessages"), toolName: v.string(), ...actorAuthArgs },
  handler: async (ctx, args) => {
    await requireActor(ctx, args);
    const toolName = args.toolName.trim().toLowerCase().slice(0, 120);
    const message = await ctx.db.get(args.messageId);
    if (!message || message.role !== "user" || !toolName) return { allowed: false, reason: "invalid_provenance" };
    const linked = await ctx.db
      .query("messageFiles")
      .withIndex("by_message", (q) => q.eq("messageId", message._id))
      .first();
    if (!linked || FILE_TURN_READ_ONLY_TOOLS.has(toolName)) return { allowed: true };

    const userText = visibleTurnText(String(message.text)).toLowerCase().slice(0, 4_000);
    // A file attachment must not create a second, broader calendar admission
    // path than the foreground owner belt. Jarvis is intentionally iCloud-only:
    // a request that names Google Calendar must never become an Apple approval.
    if (toolName === "icloud_calendar_create" && GOOGLE_CALENDAR_REQUEST.test(userText)) {
      return { allowed: false, reason: "file_turn_google_calendar_not_supported" };
    }
    if (FILE_TURN_VISUAL_TOOLS.has(toolName)) {
      const requested = /\b(?:show|display|visual(?:ize|ise)?|chart|graph|plot|map|board|diagram|dashboard|draft)\b/.test(userText);
      return requested ? { allowed: true } : { allowed: false, reason: "file_turn_visual_not_requested" };
    }

    const intentRules: Array<[RegExp, RegExp]> = [
      [/^dispatch_agent$/, /\b(?:delegate|dispatch|assign)\b.{0,36}\b(?:agent|task|work|job)\b/],
      [/^orchestrate$/, /\b(?:orchestrate|run|start|manage)\b.{0,36}\b(?:agents?|workflow|work|job|task)\b/],
      [/^(?:goal_mode|project_goal)$/, /\b(?:start|create|set|open)\b.{0,24}\b(?:goal|project goal|goal mode)\b/],
      [/^creative_sprint$/, /\b(?:start|run|do|begin)\b.{0,24}\b(?:creative sprint|brainstorm)\b/],
      [/^research$/, /\b(?:do|conduct|run|start)\b.{0,20}\bresearch\b|\b(?:research|investigate|look into)\b.{0,24}\b(?:this|that|these|topic|question)\b/],
      [/^self_repair$/, /\b(?:fix|repair|debug)\b.{0,24}\b(?:jarvis|yourself|your system|the system)\b/],
      [/^self_improve$/, /\b(?:improve|upgrade|optimi[sz]e)\b.{0,24}\b(?:jarvis|yourself|your system|the system)\b/],
      [/^web_search$/, /\b(?:search|find|look up|research)\b.{0,36}\b(?:web|online|internet)\b|\b(?:web|online|internet)\b.{0,24}\bsearch\b/],
      [/^read_url$/, /\b(?:read|open|inspect|analy[sz]e|summari[sz]e)\b.{0,30}\b(?:url|link|website|web page)\b/],
      [/^open_uploaded_transcript$/, /\b(?:open|show|display|read|view)\b.{0,36}\b(?:transcript|captions?|audio|video|recording|voice(?:\s+note)?)\b|\b(?:transcript|captions?|audio|video|recording|voice(?:\s+note)?)\b.{0,36}\b(?:open|show|display|read|view)\b/],
      [/^organize_uploaded_file$/, /\b(?:rename|move|organize|organise|tag)\b.{0,64}\b(?:this|that|the|attached|uploaded)?\s*(?:file|document|upload|image|photo|folder|tags?)\b|\b(?:file|document|upload|image|photo)\b.{0,64}\b(?:rename|move|organize|organise|tag)\b/],
      [/^(?:youtube_search|youtube_transcript)$/, /\b(?:search|find|read|get|show)\b.{0,36}\b(?:youtube|video transcript|transcript)\b/],
      [/^flight_search$/, /\b(?:search|find|show|look up)\b.{0,30}\bflights?\b/],
      [/^memory_search$/, /\b(?:search|find|recall|look up)\b.{0,30}\b(?:memory|memories|what you remember)\b/],
      [/^agent_status$/, /\b(?:show|check|give|report)\b.{0,30}\b(?:agent|job|task)\b.{0,20}\b(?:status|progress)\b/],
      [/^(?:rental_availability|rental_stats|rentals_calendar)$/, /\b(?:show|check|find|analy[sz]e|review)\b.{0,36}\brentals?\b|\brentals?\b.{0,30}\b(?:availability|stats|calendar|revenue|booking)\b/],
      [/^weather$/, /\b(?:check|show|get|find|look up|tell me|current|live|latest)\b.{0,30}\b(?:weather|forecast|temperature)\b/],
      [/^(?:market|price_chart|market_analysis)$/, /\b(?:check|show|get|find|look up|analy[sz]e|review|current|live|latest)\b.{0,36}\b(?:market|price|stock|crypto|asset|ticker|coin)\b/],
      [/^briefing$/, /\b(?:show|give|read|create)\b.{0,24}\bbriefing\b/],
      [/^calendar_view$/, /\b(?:show|view|open|check|read)\b.{0,24}\bcalendar\b/],
      [/^icloud_calendar_create$/, /\b(?:add|create|schedule|put|make|remind)\b.{0,64}\b(?:(?:i(?:\s|-)?cloud|apple)\s+)?(?:calendar|event|meeting|appointment|reminder)\b/],
      [/^(?:gmail_search|gmail_read|gmail_list_subscriptions)$/, /\b(?:gmail|google\s+mail|e-?mails?|inbox|mailbox)\b/],
      [/^gmail_draft_reply$/, /\b(?:gmail|google\s+mail|e-?mails?|inbox|mailbox)\b.{0,48}\b(?:draft|reply|respond|write|compose)\b|\b(?:draft|reply|respond|write|compose)\b.{0,48}\b(?:gmail|google\s+mail|e-?mails?|inbox|mailbox)\b/],
      [/^creations_list$/, /\b(?:show|view|open|list)\b.{0,30}\b(?:creations|creation library|saved work)\b/],
      [/^watch_list$/, /\b(?:show|view|open|list)\b.{0,24}\b(?:watch list|watchlist|price watches)\b/],
      [/^todo_list$/, /\b(?:show|view|open|list)\b.{0,24}\b(?:todos?|tasks?|checklist)\b/],
      [/^net_worth$/, /\b(?:show|check|calculate|view)\b.{0,24}\bnet worth\b/],
      [/^news_today$/, /\b(?:show|get|find|look up|current|live|latest|today(?:'s)?)\b.{0,24}\b(?:news|headlines|current events)\b/],
      [/^places_near$/, /\b(?:find|show|search)\b.{0,30}\b(?:places|restaurants?|cafes?|hotels?|nearby)\b/],
      [/^transport_route$/, /\b(?:find|show|get|plan|map|look up)\b.{0,30}\b(?:route|directions|transport|transit|train|drive|walk)\b/],
      [/^shop_search$/, /\b(?:search|find|look up|shop for|buy)\b.{0,30}\b(?:product|item|shop|shopping|price|deal)\b/],
      [/^music_search$/, /\b(?:search|find|play|show)\b.{0,24}\b(?:music|song|album|artist|track)\b/],
      [/^(?:timer|remind_at|reminder_cancel)$/, /\b(?:set|start|create|cancel|remove)\b.{0,24}\b(?:timer|reminder|alarm)\b|\bremind me\b/],
      [/^todo_(?:add|done|remove)$/, /\b(?:add|create|mark|complete|remove|delete)\b.{0,24}\b(?:todo|task|checklist)\b/],
      [/^calendar_(?:add|remove)$/, /\b(?:add|create|put|remove|delete)\b.{0,30}\b(?:calendar|appointment|event)\b/],
      [/^review_uploaded_file$/, /\b(?:favorite|favourite)\b.{0,36}\b(?:this|that|the|uploaded|attached)?\s*(?:file|document|upload|image|photo|picture)\b|\b(?:mark|set|make|flag)\b.{0,36}\b(?:as\s+)?(?:a\s+)?(?:favorite|favourite)\b|\b(?:mark|flag|set)\b.{0,36}\bfor\s+(?:review\s+)?remov(?:al|e)\b|\b(?:clear|reset|remove)\b.{0,36}\breview(?:\s+(?:state|status|mark))?\b/],
      [/^bookings_check$/, /\b(?:check|import|add)\b.{0,30}\bbookings?\b|\bbookings?\b.{0,30}\b(?:calendar|import)\b/],
      [/^(?:remember)$/, /\b(?:remember|memorize|memorise|save (?:this|that) (?:to|in) memory)\b/],
      [/^(?:create_image|store_image)$/, /\b(?:create|generate|render|make|save|store)\b.{0,30}\b(?:image|picture|photo|art|illustration)\b/],
      [/^create_pdf$/, /\b(?:create|generate|export|make)\b.{0,30}\bpdf\b/],
      [/^open_app$/, /\b(?:open|launch)\b.{0,30}\bapp(?:lication)?\b/],
      [/^open_travel_site$/, /\b(?:open|launch)\b.{0,30}\b(?:travel|flight|hotel|booking)\b.{0,20}\b(?:site|website|browser)\b/],
      [/^host_ui$/, /\b(?:click|press|edit|change|focus|highlight)\b.{0,36}\b(?:button|field|element|page|screen|widget|section)\b/],
      [/^mac_shortcut$/, /\b(?:run|use|trigger)\b.{0,24}\bshortcut\b/],
      [/^video_control$/, /\b(?:play|pause|seek|resume|stop)\b.{0,24}\b(?:video|youtube|it)\b/],
      [/^hide$/, /\b(?:hide|close)\b.{0,24}\b(?:panel|overlay|widget|window|it)\b/],
      [/^clear_chat$/, /\b(?:clear|wipe|delete)\b.{0,24}\b(?:chat|conversation|history)\b/],
      [/^new_chat$/, /\b(?:new|start|open)\b.{0,20}\b(?:chat|conversation)\b/],
      [/^trip_open$/, /\b(?:open|create|show)\b.{0,24}\b(?:trip|travel plan|itinerary)\b/],
      [/^trip_plan$/, /\b(?:plan|build|create)\b.{0,24}\b(?:trip|travel|itinerary|holiday|vacation)\b/],
      [/^trip_update$/, /\b(?:update|change|add|remove|edit)\b.{0,30}\b(?:trip|travel plan|itinerary|holiday|vacation)\b/],
      [/^trip_finalize$/, /\b(?:finalize|finalise|finish|confirm)\b.{0,24}\b(?:trip|travel plan|itinerary|holiday|vacation)\b/],
      [/^(?:price_watch|price_alert|watch_cancel)$/, /\b(?:watch|alert|notify|cancel)\b.{0,36}\b(?:price|market|stock|crypto|asset|watch)\b/],
    ];
    const rule = intentRules.find(([tool]) => tool.test(toolName));
    return rule?.[1].test(userText)
      ? { allowed: true }
      : { allowed: false, reason: "file_turn_action_not_requested" };
  },
});

export const beginDelete = mutation({
  args: { fileId: v.id("files"), ...actorAuthArgs },
  handler: async (ctx, args) => {
    await requireActor(ctx, args);
    await assertNormalFileMutationAllowed(ctx);
    const file = await ctx.db.get(args.fileId);
    if (!file || file.status === "deleted") return null;
    const now = Date.now();
    if (file.status === "deleting") {
      const retryAfterMs = earliestRetryAfter(
        await activeIngestCleanupRetryAfter(ctx, file, now),
        await activeDerivedArtifactRehomeRetryAfter(ctx, file),
        await activeTurnFileLeaseRetryAfter(ctx, file._id, now),
      );
      return {
        ok: true as const,
        deferred: retryAfterMs !== null,
        ...(retryAfterMs === null ? {} : { retryAfterMs }),
        r2Keys: cleanupKeysForFile(file),
        idempotent: true as const,
      };
    }
    const reference = await ctx.db.query("creationFileRefs").withIndex("by_file", (q) => q.eq("fileId", file._id)).first();
    if (reference) return { ok: false as const, reason: "creation_reference" as const };
    const turnLeaseRetryAfterMs = await activeTurnFileLeaseRetryAfter(ctx, file._id, now);
    const rehomeRetryAfterMs = await activeDerivedArtifactRehomeRetryAfter(ctx, file);
    if (rehomeRetryAfterMs !== null) {
      return {
        ok: true as const,
        deferred: true as const,
        retryAfterMs: rehomeRetryAfterMs,
        r2Keys: [],
        idempotent: false as const,
      };
    }
    if (turnLeaseRetryAfterMs !== null) {
      await ctx.db.patch(file._id, {
        status: "deleting",
        deletePreviousStatus: file.status,
        libraryVisible: false,
        updatedAt: now,
      });
      return {
        ok: true as const,
        deferred: true as const,
        retryAfterMs: turnLeaseRetryAfterMs,
        r2Keys: cleanupKeysForFile(file),
        idempotent: false as const,
      };
    }
    if (file.status === "uploading" && Number(file.uploadClaimExpiresAt ?? 0) > now) {
      await ctx.db.patch(file._id, {
        cancelRequestedAt: now,
        errorCode: "delete_requested",
        libraryVisible: false,
        updatedAt: now,
      });
      return {
        ok: true as const,
        deferred: true as const,
        retryAfterMs: Number(file.uploadClaimExpiresAt) - now,
        r2Keys: cleanupKeysForFile(file),
        idempotent: false as const,
      };
    }
    const ingestRetryAfterMs = await activeIngestCleanupRetryAfter(ctx, file, now);
    if (ingestRetryAfterMs !== null) {
      await ctx.db.patch(file._id, {
        status: "deleting",
        deletePreviousStatus: "processing",
        libraryVisible: false,
        updatedAt: now,
      });
      return {
        ok: true as const,
        deferred: true as const,
        retryAfterMs: ingestRetryAfterMs,
        r2Keys: cleanupKeysForFile(file),
        idempotent: false as const,
      };
    }
    await ctx.db.patch(file._id, {
      status: "deleting",
      deletePreviousStatus: file.status,
      libraryVisible: false,
      updatedAt: now,
    });
    return { ok: true as const, deferred: false as const, r2Keys: cleanupKeysForFile(file), idempotent: false as const };
  },
});

export const abortDelete = mutation({
  args: { fileId: v.id("files"), ...actorAuthArgs },
  handler: async (ctx, args) => {
    await requireActor(ctx, args);
    const file = await ctx.db.get(args.fileId);
    if (!file || file.status !== "deleting") return false;
    // Byte deletion is irreversible and may already have partly succeeded.
    // Keep the durable outbox state so the exact-key cleanup can be retried.
    return false;
  },
});

export const finishDelete = mutation({
  args: { fileId: v.id("files"), ...actorAuthArgs },
  handler: async (ctx, args) => {
    await requireActor(ctx, args);
    await assertNormalFileMutationAllowed(ctx);
    const file = await ctx.db.get(args.fileId);
    if (!file || file.status !== "deleting") return false;
    const now = Date.now();
    if (earliestRetryAfter(
      await activeIngestCleanupRetryAfter(ctx, file, now),
      await activeDerivedArtifactRehomeRetryAfter(ctx, file),
      await activeTurnFileLeaseRetryAfter(ctx, file._id, now),
    ) !== null) return false;
    if (
      Number(file.ingestOutputProtocol ?? INGEST_OUTPUT_PROTOCOL_V1) === INGEST_OUTPUT_PROTOCOL_V1
      && Number(file.ingestAttempt ?? 0) > 0
    ) {
      // The file is about to lose any V1 pointers/direct-delete visibility.
      // Keep its historical shared pair as a nonterminal reaper after the
      // deletion commits: an old accepted PUT is not fenced by this callback.
      let marker = legacyBridgeMarker(await outputAttemptsForVersion(ctx, file._id, file.ingestVersion));
      marker = marker ?? await startLegacyBridgeMarker(ctx, file, String(file.ingestClaimToken ?? "legacy"), now);
      if (marker) await moveLegacyBridgeToSweep(ctx, marker, now);
    }
    const [chunks, threadLinks, documents] = await Promise.all([
      ctx.db.query("fileChunks").withIndex("by_file_ordinal", (q) => q.eq("fileId", file._id)).collect(),
      ctx.db.query("threadFiles").withIndex("by_file", (q) => q.eq("fileId", file._id)).collect(),
      ctx.db.query("fileDocuments").withIndex("by_file", (q) => q.eq("fileId", file._id)).collect(),
    ]);
    // Keep messageFiles as immutable provenance. Their small manifest remains
    // visible after bytes are deleted, while ready-file validation prevents
    // any deleted content from re-entering a model turn.
    for (const row of [...chunks, ...threadLinks, ...documents]) await ctx.db.delete(row._id);
    await ctx.db.patch(file._id, {
      status: "deleted",
      deletePreviousStatus: undefined,
      uploadClaimToken: undefined,
      uploadClaimExpiresAt: undefined,
      cancelRequestedAt: undefined,
      ingestClaimToken: undefined,
      summary: undefined,
      searchText: file.originalName,
      extractedChars: 0,
      chunkCount: 0,
      libraryVisible: false,
      updatedAt: now,
    });
    return true;
  },
});
