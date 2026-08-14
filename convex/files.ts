import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { paginationOptsValidator } from "convex/server";
import { actorAuthArgs, requireActor, requireViewer, viewerAuthArgs } from "./controlAuth";
import {
  CHAT_FILE_LIMITS,
  FILE_READY_STATUSES,
  normalizeRelativeUploadPath,
  normalizeUploadMime,
  normalizeUploadName,
  normalizeUploadSha256,
} from "../src/lib/chat-files";
import { visibleTurnText } from "../src/lib/host-context";
import { messageFileManifests } from "./fileHelpers";

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
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function cleanupKeysForFile(file: any): string[] {
  const prefix = `owners/daniel/files/${String(file._id)}/v${Number(file.ingestVersion)}`;
  return [...new Set([
    String(file.r2Key),
    file.extractedTextR2Key ? String(file.extractedTextR2Key) : `${prefix}/extracted.txt`,
    file.previewR2Key ? String(file.previewR2Key) : `${prefix}/preview.webp`,
  ])];
}

async function retireUploadBatch(ctx: { db: any }, batch: any, status: "expired" | "cancelled") {
  const now = Date.now();
  const cleanup: Array<{ fileId: string; r2Keys: string[]; deferred: boolean }> = [];
  let retired = 0;
  for (const fileId of batch.fileIds.slice(0, CHAT_FILE_LIMITS.maxFilesPerBatch)) {
    const file = await ctx.db.get(fileId);
    if (!file || file.status === "deleted") continue;
    const claimActive = file.status === "uploading" && Number(file.uploadClaimExpiresAt ?? 0) > now;
    await ctx.db.patch(fileId, claimActive ? {
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
    cleanup.push({ fileId: String(fileId), r2Keys: cleanupKeysForFile(file), deferred: claimActive });
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
    const file = await ctx.db.get(args.fileId);
    if (!file || file.status === "deleted") return null;
    if (file.status === "deleting") return { ready: true as const, r2Keys: cleanupKeysForFile(file) };
    if (file.status !== "uploading" || !file.cancelRequestedAt) return null;
    const now = Date.now();
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
    const file = await ctx.db.get(args.fileId);
    if (!file || file.status === "deleted" || file.status === "deleting") return null;
    const now = Date.now();
    await ctx.db.patch(file._id, { reviewState: args.reviewState, updatedAt: now });
    return publicFile({ ...file, reviewState: args.reviewState, updatedAt: now });
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

export const claimIngest = mutation({
  args: { fileId: v.id("files"), ingestVersion: v.number(), claimToken: v.string(), ...actorAuthArgs },
  handler: async (ctx, args) => {
    await requireActor(ctx, args);
    const file = await ctx.db.get(args.fileId);
    if (!file || file.ingestVersion !== args.ingestVersion) return null;
    const now = Date.now();
    if (file.status === "processing" && Number(file.lastProgressAt ?? 0) > now - 90_000) return null;
    if (!["uploaded", "error", "processing"].includes(file.status) || file.ingestAttempt >= 3) return null;
    const claimToken = args.claimToken.trim().slice(0, 160);
    if (!claimToken) return null;
    await ctx.db.patch(file._id, {
      status: "processing",
      ingestAttempt: file.ingestAttempt + 1,
      ingestClaimToken: claimToken,
      lastProgressAt: now,
      errorCode: undefined,
      updatedAt: now,
    });
    return { ...file, status: "processing", ingestAttempt: file.ingestAttempt + 1, ingestClaimToken: claimToken };
  },
});

export const heartbeatIngest = mutation({
  args: { fileId: v.id("files"), ingestVersion: v.number(), claimToken: v.string(), ...actorAuthArgs },
  handler: async (ctx, args) => {
    await requireActor(ctx, args);
    const file = await ctx.db.get(args.fileId);
    if (!file || file.status !== "processing" || file.ingestVersion !== args.ingestVersion || file.ingestClaimToken !== args.claimToken) return false;
    const now = Date.now();
    await ctx.db.patch(file._id, { lastProgressAt: now, updatedAt: now });
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
    extractedChars: v.number(),
    pageCount: v.optional(v.number()),
    sheetNames: v.optional(v.array(v.string())),
    chunks: v.array(extractedChunk),
    ...actorAuthArgs,
  },
  handler: async (ctx, args) => {
    await requireActor(ctx, args);
    const file = await ctx.db.get(args.fileId);
    if (!file || file.status !== "processing" || file.ingestVersion !== args.ingestVersion || file.ingestClaimToken !== args.claimToken) {
      return { ok: false, reason: "stale_claim" as const };
    }
    const sha256 = normalizeUploadSha256(args.sha256);
    if (!sha256 || sha256 !== file.expectedSha256) {
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
      lastProgressAt: now,
      errorCode: undefined,
      updatedAt: now,
    });
    return { ok: true, status: args.status };
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
    const file = await ctx.db.get(args.fileId);
    if (!file || file.status !== "processing" || file.ingestVersion !== args.ingestVersion || file.ingestClaimToken !== args.claimToken) return false;
    const now = Date.now();
    await ctx.db.patch(file._id, {
      status: args.quarantined ? "quarantined" : "error",
      errorCode: args.errorCode.trim().slice(0, 120) || "ingest_failed",
      ingestClaimToken: undefined,
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
    const file = await ctx.db.get(args.fileId);
    const staleProcessing = file?.status === "processing" && Number(file.lastProgressAt ?? 0) <= Date.now() - 90_000;
    if (!file || (!staleProcessing && !["uploaded", "error", "stored_only"].includes(file.status))) return null;
    const now = Date.now();
    const ingestVersion = file.ingestVersion + 1;
    await ctx.db.patch(file._id, {
      status: "uploaded",
      ingestVersion,
      ingestAttempt: 0,
      ingestClaimToken: undefined,
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
    const limit = Math.min(12, Math.max(1, Math.floor(args.limit ?? 8)));
    const [uploaded, failed, processing] = await Promise.all([
      ctx.db.query("files").withIndex("by_status_updated", (q) => q.eq("status", "uploaded")).order("asc").take(limit),
      ctx.db.query("files").withIndex("by_status_updated", (q) => q.eq("status", "error")).order("asc").take(limit),
      ctx.db.query("files").withIndex("by_status_updated", (q) => q.eq("status", "processing")).order("asc").take(limit),
    ]);
    const staleBefore = Date.now() - 90_000;
    return [...uploaded, ...failed, ...processing]
      .filter((file) => file.ingestAttempt < 3 && (file.status !== "processing" || Number(file.lastProgressAt ?? 0) <= staleBefore))
      .slice(0, limit)
      .map((file) => ({ fileId: String(file._id), ingestVersion: file.ingestVersion }));
  },
});

export const contextForMessage = query({
  args: { messageId: v.id("chatMessages"), ...actorAuthArgs },
  handler: async (ctx, args) => {
    await requireActor(ctx, args);
    return await messageFileManifests(ctx, args.messageId);
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
      [/^(?:youtube_search|youtube_transcript)$/, /\b(?:search|find|read|get|show)\b.{0,36}\b(?:youtube|video transcript|transcript)\b/],
      [/^flight_search$/, /\b(?:search|find|show|look up)\b.{0,30}\bflights?\b/],
      [/^memory_search$/, /\b(?:search|find|recall|look up)\b.{0,30}\b(?:memory|memories|what you remember)\b/],
      [/^agent_status$/, /\b(?:show|check|give|report)\b.{0,30}\b(?:agent|job|task)\b.{0,20}\b(?:status|progress)\b/],
      [/^(?:rental_availability|rental_stats|rentals_calendar)$/, /\b(?:show|check|find|analy[sz]e|review)\b.{0,36}\brentals?\b|\brentals?\b.{0,30}\b(?:availability|stats|calendar|revenue|booking)\b/],
      [/^weather$/, /\b(?:check|show|get|find|look up|tell me|current|live|latest)\b.{0,30}\b(?:weather|forecast|temperature)\b/],
      [/^(?:market|price_chart|market_analysis)$/, /\b(?:check|show|get|find|look up|analy[sz]e|review|current|live|latest)\b.{0,36}\b(?:market|price|stock|crypto|asset|ticker|coin)\b/],
      [/^briefing$/, /\b(?:show|give|read|create)\b.{0,24}\bbriefing\b/],
      [/^calendar_view$/, /\b(?:show|view|open|check|read)\b.{0,24}\bcalendar\b/],
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
    const file = await ctx.db.get(args.fileId);
    if (!file || file.status === "deleted") return null;
    if (file.status === "deleting") return { ok: true as const, r2Keys: cleanupKeysForFile(file), idempotent: true as const };
    const reference = await ctx.db.query("creationFileRefs").withIndex("by_file", (q) => q.eq("fileId", file._id)).first();
    if (reference) return { ok: false as const, reason: "creation_reference" as const };
    const now = Date.now();
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
    const file = await ctx.db.get(args.fileId);
    if (!file || file.status !== "deleting") return false;
    const [chunks, threadLinks] = await Promise.all([
      ctx.db.query("fileChunks").withIndex("by_file_ordinal", (q) => q.eq("fileId", file._id)).collect(),
      ctx.db.query("threadFiles").withIndex("by_file", (q) => q.eq("fileId", file._id)).collect(),
    ]);
    // Keep messageFiles as immutable provenance. Their small manifest remains
    // visible after bytes are deleted, while ready-file validation prevents
    // any deleted content from re-entering a model turn.
    for (const row of [...chunks, ...threadLinks]) await ctx.db.delete(row._id);
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
      updatedAt: Date.now(),
    });
    return true;
  },
});
