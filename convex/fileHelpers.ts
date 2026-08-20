import { ConvexError } from "convex/values";
import { CHAT_FILE_LIMITS, FILE_READY_STATUSES } from "../src/lib/chat-files";
import { isLegacyCreationUrlForRedaction, legacyCreationLookupUrl, redactLegacyCreationUrls } from "../src/lib/legacy-creation-url";

export type ReadyMessageFile = {
  _id: any;
  originalName: string;
  relativePath: string;
  mimeType: string;
  detectedMimeType?: string;
  sizeBytes: number;
  status: string;
  summary?: string;
  r2Key: string;
  previewR2Key?: string;
};

type ChatAttachment = {
  type: string;
  value: string;
  title?: string;
  downloadUrl?: string;
};

function creationMediaUrl(id: unknown): string {
  return `/api/creation-media?id=${encodeURIComponent(String(id))}&variant=asset`;
}

function creationDownloadUrl(id: unknown): string {
  return `/api/creation-download?id=${encodeURIComponent(String(id))}`;
}

async function creationForLegacyUrl(ctx: { db: any }, url: string) {
  const [byUrl, byThumb] = await Promise.all([
    ctx.db.query("creations").withIndex("by_url", (q: any) => q.eq("url", url)).order("desc").first(),
    ctx.db.query("creations").withIndex("by_thumb", (q: any) => q.eq("thumb", url)).order("desc").first(),
  ]);
  return byUrl ?? byThumb;
}

// Public message projections never expose the retired public R2 origin. A
// matched historic card keeps its preview/download behavior through the same
// owner-authorized creation routes as the current private asset flow. An
// orphaned legacy card becomes a harmless notice rather than a raw URL.
export async function safeChatAttachment(ctx: { db: any }, attachment: ChatAttachment): Promise<ChatAttachment> {
  const valueLegacy = isLegacyCreationUrlForRedaction(attachment.value);
  const downloadLegacy = isLegacyCreationUrlForRedaction(attachment.downloadUrl);
  const valueUrl = legacyCreationLookupUrl(attachment.value);
  const downloadUrl = legacyCreationLookupUrl(attachment.downloadUrl);
  const safeAttachment: ChatAttachment = {
    ...attachment,
    value: redactLegacyCreationUrls(attachment.value),
    ...(attachment.title ? { title: redactLegacyCreationUrls(attachment.title) } : {}),
    ...(attachment.downloadUrl ? { downloadUrl: redactLegacyCreationUrls(attachment.downloadUrl) } : {}),
  };
  if (!valueLegacy && !downloadLegacy) return safeAttachment;

  const legacyUrls = [...new Set([valueUrl, downloadUrl].filter((url): url is string => Boolean(url)))];
  const resolved = new Map(await Promise.all(legacyUrls.map(async (url) => [url, await creationForLegacyUrl(ctx, url).catch(() => null)] as const)));
  const valueCreation = valueUrl ? resolved.get(valueUrl) : null;
  const downloadCreation = downloadUrl ? resolved.get(downloadUrl) : null;
  if (valueLegacy && !valueCreation) {
    return {
      type: "markdown",
      value: "This legacy creation media is no longer available in the secure library.",
      title: safeAttachment.title ?? "Legacy creation media unavailable",
    };
  }
  if (downloadLegacy && !downloadCreation) {
    const { downloadUrl: _downloadUrl, ...withoutLegacyDownload } = safeAttachment;
    return valueCreation
      ? { ...withoutLegacyDownload, value: creationMediaUrl(valueCreation._id) }
      : withoutLegacyDownload;
  }
  return {
    ...safeAttachment,
    ...(valueCreation ? { value: creationMediaUrl(valueCreation._id) } : {}),
    ...(downloadCreation ? { downloadUrl: creationDownloadUrl(downloadCreation._id) } : {}),
  };
}

export async function validateReadyMessageFiles(
  ctx: { db: any },
  threadId: string,
  fileIds: any[] | undefined,
  guest: boolean,
): Promise<ReadyMessageFile[]> {
  const ids = [...new Set((fileIds ?? []).map(String))];
  if (!ids.length) return [];
  if (guest) throw new ConvexError({ code: "GUEST_FILES_FORBIDDEN", message: "Guest conversations cannot access private files" });
  if (ids.length > CHAT_FILE_LIMITS.maxFilesPerMessage || ids.length !== (fileIds ?? []).length) {
    throw new ConvexError({ code: "INVALID_FILE_SELECTION", message: "File selection is invalid" });
  }
  const files: ReadyMessageFile[] = [];
  for (const fileId of fileIds ?? []) {
    const link = await ctx.db
      .query("threadFiles")
      .withIndex("by_thread_file", (q: any) => q.eq("threadId", threadId).eq("fileId", fileId))
      .first();
    const file = link ? await ctx.db.get(fileId) : null;
    if (!file || !FILE_READY_STATUSES.has(String(file.status))) {
      throw new ConvexError({ code: "FILE_NOT_READY", message: "Every selected file must be ready in this chat" });
    }
    files.push(file as ReadyMessageFile);
  }
  return files;
}

export async function linkFilesToMessage(
  ctx: { db: any },
  messageId: any,
  threadId: string,
  files: ReadyMessageFile[],
  createdAt: number,
): Promise<void> {
  for (let position = 0; position < files.length; position += 1) {
    const existing = await ctx.db
      .query("messageFiles")
      .withIndex("by_message_file", (q: any) => q.eq("messageId", messageId).eq("fileId", files[position]._id))
      .first();
    if (!existing) {
      await ctx.db.insert("messageFiles", {
        messageId,
        threadId,
        fileId: files[position]._id,
        position,
        createdAt,
      });
    }
    const threadLink = await ctx.db
      .query("threadFiles")
      .withIndex("by_thread_file", (q: any) => q.eq("threadId", threadId).eq("fileId", files[position]._id))
      .first();
    if (threadLink) await ctx.db.patch(threadLink._id, { updatedAt: createdAt });
  }
}

/**
 * Atomically snapshots the exact files used by a user turn onto a saved
 * creation. The composite index makes retries and concurrent tool calls
 * idempotent without scanning an unbounded creation history.
 */
export async function linkMessageFilesToCreation(
  ctx: { db: any },
  creationId: any,
  messageId: any | undefined,
  role = "source",
): Promise<number> {
  if (!messageId) return 0;
  const message = await ctx.db.get(messageId);
  if (!message || message.role !== "user") {
    throw new ConvexError({ code: "INVALID_CREATION_SOURCE", message: "Creation source must be a user message" });
  }
  const links = await ctx.db
    .query("messageFiles")
    .withIndex("by_message", (q: any) => q.eq("messageId", messageId))
    .take(CHAT_FILE_LIMITS.maxFilesPerMessage + 1);
  if (links.length > CHAT_FILE_LIMITS.maxFilesPerMessage) {
    throw new ConvexError({ code: "INVALID_CREATION_SOURCE", message: "Creation source file bound exceeded" });
  }
  let linked = 0;
  const creation = await ctx.db.get(creationId);
  if (!creation) throw new ConvexError({ code: "INVALID_CREATION_SOURCE", message: "Creation was not found" });
  const sourceFiles = new Map<string, { fileId: any; name: string }>(
    (creation.sourceFiles ?? []).map((file: any) => [String(file.fileId), { fileId: file.fileId, name: String(file.name) }]),
  );
  for (const link of links) {
    const file = await ctx.db.get(link.fileId);
    if (!file || !FILE_READY_STATUSES.has(String(file.status))) continue;
    const existing = await ctx.db
      .query("creationFileRefs")
      .withIndex("by_creation_file", (q: any) => q.eq("creationId", creationId).eq("fileId", link.fileId))
      .first();
    if (existing) continue;
    await ctx.db.insert("creationFileRefs", {
      creationId,
      fileId: link.fileId,
      role: role.trim().slice(0, 40) || "source",
      createdAt: Date.now(),
    });
    sourceFiles.set(String(file._id), { fileId: file._id, name: String(file.originalName).slice(0, 240) });
    linked += 1;
  }
  if (linked) await ctx.db.patch(creationId, { sourceFiles: [...sourceFiles.values()].slice(0, 32) });
  return linked;
}

const DETERMINISTIC_FILE_FOLLOW_UP =
  /\b(?:that|this|the|last|previous|uploaded|attached|my|our)\s+(?:file|document|doc|pdf|spreadsheet|csv|image|photo|video|audio|clip|recording)\b/;
const DETERMINISTIC_FILE_SOURCE_REFERENCE =
  /\b(?:from|using|with)\s+(?:that|this|the|last|previous|my|our)\s+(?:file|document|doc|pdf|spreadsheet|csv|image|photo|video|audio|clip|recording)\b/;
const LIKELY_FILE_NOUN =
  /\b(?:file|files|folder|document|doc|pdf|spreadsheet|csv|image|photo|attachment|upload|library)\b/;
// Keep this aligned with the private media containers admitted by
// src/lib/media-types.ts. A filename only selects a catalog candidate; bytes
// still enter a claim solely after exact thread-scoped resolution.
const LIKELY_FILE_EXTENSION =
  /\b[\w-]+\.(?:txt|md|csv|json|pdf|docx?|xlsx?|png|jpe?g|webp|mp3|m4a|ogg|wav|webm|mp4|mov)\b/;

export type RequestedPrivateMediaKind = "audio" | "video" | "media" | "ambiguous" | null;

/**
 * A deictic media follow-up may resolve only a compatible private file. Do
 * not treat a bare media noun as a file reference; it could be ordinary
 * conversation such as a request for a video-game recommendation.
 */
export function requestedPrivateMediaKind(text: string): RequestedPrivateMediaKind {
  const value = text.toLowerCase().slice(0, 2_000);
  const wantsVideo = /\b(?:video|clip)\b/.test(value);
  const wantsAudio = /\baudio\b/.test(value);
  const wantsRecording = /\brecording\b/.test(value);
  if (wantsVideo && wantsAudio) return "ambiguous";
  if (wantsVideo) return "video";
  if (wantsAudio) return "audio";
  return wantsRecording ? "media" : null;
}

export function isDeterministicFileFollowUp(text: string): boolean {
  const value = text.toLowerCase().slice(0, 2_000);
  return DETERMINISTIC_FILE_FOLLOW_UP.test(value)
    || DETERMINISTIC_FILE_SOURCE_REFERENCE.test(value)
    || /\b(?:chart|map|summari[sz]e|analy[sz]e|read|use)\b.{0,36}\b(?:it|that)\b/.test(value);
}

export function isLikelyFileReference(text: string): boolean {
  const value = text.toLowerCase().slice(0, 2_000);
  return isDeterministicFileFollowUp(value)
    || LIKELY_FILE_NOUN.test(value)
    || LIKELY_FILE_EXTENSION.test(value);
}

function boundedChunkSearch(text: string | undefined): string {
  if (!text) return "";
  const stop = new Set(["about", "after", "again", "analyze", "attached", "chart", "document", "file", "from", "have", "into", "make", "please", "show", "that", "these", "this", "using", "what", "with"]);
  return [...new Set((text.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? []).filter((term) => !stop.has(term)))]
    .slice(0, 8)
    .join(" ")
    .slice(0, 180);
}

export async function messageFileManifests(
  ctx: { db: any },
  messageId: any,
  queryText?: string,
): Promise<Array<{
  fileId: string;
  name: string;
  relativePath: string;
  mimeType: string;
  sizeBytes: number;
  status: string;
  summary?: string;
  r2Key: string;
  previewR2Key?: string;
  excerpts: Array<{ ordinal: number; text: string; page?: number; sheet?: string; cellRange?: string }>;
}>> {
  const links = await ctx.db
    .query("messageFiles")
    .withIndex("by_message", (q: any) => q.eq("messageId", messageId))
    .take(CHAT_FILE_LIMITS.maxFilesPerMessage);
  const manifests = [];
  for (const link of links) {
    const file = await ctx.db.get(link.fileId);
    if (!file || !FILE_READY_STATUSES.has(String(file.status))) continue;
    const leading = await ctx.db
      .query("fileChunks")
      .withIndex("by_file_ordinal", (q: any) => q.eq("fileId", link.fileId))
      .take(1);
    const search = boundedChunkSearch(queryText);
    const matches = search
      ? await ctx.db
          .query("fileChunks")
          .withSearchIndex("search_text", (q: any) => q.search("text", search).eq("fileKey", String(file._id)))
          .take(Math.max(1, CHAT_FILE_LIMITS.maxContextChunksPerFile + 1))
      : [];
    const chunks = [...leading, ...matches]
      .filter((chunk: any, index: number, all: any[]) => all.findIndex((candidate) => String(candidate._id) === String(chunk._id)) === index)
      .slice(0, CHAT_FILE_LIMITS.maxContextChunksPerFile + 1);
    manifests.push({
      fileId: String(file._id),
      name: String(file.originalName),
      relativePath: String(file.relativePath),
      mimeType: String(file.detectedMimeType ?? file.mimeType),
      sizeBytes: Number(file.sizeBytes),
      status: String(file.status),
      summary: file.summary ? String(file.summary) : undefined,
      selection: "message" as const,
      r2Key: String(file.r2Key),
      previewR2Key: file.previewR2Key ? String(file.previewR2Key) : undefined,
      excerpts: chunks.map((chunk: any) => ({
        ordinal: Number(chunk.ordinal),
        text: String(chunk.text),
        page: chunk.page === undefined ? undefined : Number(chunk.page),
        sheet: chunk.sheet === undefined ? undefined : String(chunk.sheet),
        cellRange: chunk.cellRange === undefined ? undefined : String(chunk.cellRange),
      })),
    });
  }
  return manifests;
}

export async function threadFileCatalog(ctx: { db: any }, threadId: string) {
  const links = await ctx.db
    .query("threadFiles")
    .withIndex("by_thread_updated", (q: any) => q.eq("threadId", threadId))
    .order("desc")
    .take(20);
  const files = await Promise.all(links.map((link: any) => ctx.db.get(link.fileId)));
  return files.flatMap((file: any, index: number) => file && FILE_READY_STATUSES.has(String(file.status)) ? [{
    fileId: String(file._id),
    name: String(file.originalName),
    relativePath: String(file.relativePath),
    mimeType: String(file.detectedMimeType ?? file.mimeType),
    sizeBytes: Number(file.sizeBytes),
    status: String(file.status),
    summary: file.summary ? String(file.summary) : undefined,
    updatedAt: Number(links[index].updatedAt),
  }] : []).slice(0, 12);
}

function mediaKindMatches(mimeType: unknown, requested: RequestedPrivateMediaKind): boolean {
  if (!requested) return true;
  if (requested === "ambiguous") return false;
  const value = String(mimeType ?? "").toLowerCase();
  if (requested === "media") return value.startsWith("audio/") || value.startsWith("video/");
  return value.startsWith(`${requested}/`);
}

export async function recentThreadFileManifest(
  ctx: { db: any },
  threadId: string,
  requestedMediaKind: RequestedPrivateMediaKind = null,
) {
  const links = await ctx.db
    .query("threadFiles")
    .withIndex("by_thread_updated", (q: any) => q.eq("threadId", threadId))
    .order("desc")
    .take(20);
  for (const link of links) {
    const file = await ctx.db.get(link.fileId);
    if (!file || !FILE_READY_STATUSES.has(String(file.status))) continue;
    if (!mediaKindMatches(file.detectedMimeType ?? file.mimeType, requestedMediaKind)) continue;
    const chunks = await ctx.db
      .query("fileChunks")
      .withIndex("by_file_ordinal", (q: any) => q.eq("fileId", link.fileId))
      .take(CHAT_FILE_LIMITS.maxContextChunksPerFile);
    return {
      fileId: String(file._id),
      name: String(file.originalName),
      relativePath: String(file.relativePath),
      mimeType: String(file.detectedMimeType ?? file.mimeType),
      sizeBytes: Number(file.sizeBytes),
      status: String(file.status),
      summary: file.summary ? String(file.summary) : undefined,
      selection: "recent_followup" as const,
      r2Key: String(file.r2Key),
      previewR2Key: file.previewR2Key ? String(file.previewR2Key) : undefined,
      excerpts: chunks.map((chunk: any) => ({
        ordinal: Number(chunk.ordinal),
        text: String(chunk.text),
        page: chunk.page === undefined ? undefined : Number(chunk.page),
        sheet: chunk.sheet === undefined ? undefined : String(chunk.sheet),
        cellRange: chunk.cellRange === undefined ? undefined : String(chunk.cellRange),
      })),
    };
  }
  return null;
}

export async function namedThreadFileManifest(ctx: { db: any }, threadId: string, text: string) {
  const value = text.toLocaleLowerCase().slice(0, 2_000);
  const links = await ctx.db
    .query("threadFiles")
    .withIndex("by_thread_updated", (q: any) => q.eq("threadId", threadId))
    .order("desc")
    .take(20);
  const matches = [];
  for (const link of links) {
    const file = await ctx.db.get(link.fileId);
    if (!file || !FILE_READY_STATUSES.has(String(file.status))) continue;
    const identifiers = [String(file._id), String(file.originalName), String(file.relativePath)]
      .map((identifier) => identifier.toLocaleLowerCase())
      .filter((identifier) => identifier.length >= 3);
    if (identifiers.some((identifier) => value.includes(identifier))) matches.push(file);
  }
  if (matches.length !== 1) return null;
  const file = matches[0];
  const chunks = await ctx.db
    .query("fileChunks")
    .withIndex("by_file_ordinal", (q: any) => q.eq("fileId", file._id))
    .take(CHAT_FILE_LIMITS.maxContextChunksPerFile);
  return {
    fileId: String(file._id),
    name: String(file.originalName),
    relativePath: String(file.relativePath),
    mimeType: String(file.detectedMimeType ?? file.mimeType),
    sizeBytes: Number(file.sizeBytes),
    status: String(file.status),
    summary: file.summary ? String(file.summary) : undefined,
    selection: "named_reference" as const,
    r2Key: String(file.r2Key),
    previewR2Key: file.previewR2Key ? String(file.previewR2Key) : undefined,
    excerpts: chunks.map((chunk: any) => ({
      ordinal: Number(chunk.ordinal),
      text: String(chunk.text),
      page: chunk.page === undefined ? undefined : Number(chunk.page),
      sheet: chunk.sheet === undefined ? undefined : String(chunk.sheet),
      cellRange: chunk.cellRange === undefined ? undefined : String(chunk.cellRange),
    })),
  };
}

export async function attachFileBadgesToMessages(ctx: { db: any }, threadId: string, rows: any[]) {
  if (!rows.length) return rows;
  const messageIds = new Set(rows.map((row) => String(row._id)));
  const minimum = Math.min(...rows.map((row) => Number(row.createdAt)));
  const maximum = Math.max(...rows.map((row) => Number(row.createdAt)));
  const bound = rows.length * CHAT_FILE_LIMITS.maxFilesPerMessage;
  const links = await ctx.db
    .query("messageFiles")
    .withIndex("by_thread_created", (q: any) => q.eq("threadId", threadId).gte("createdAt", minimum).lte("createdAt", maximum))
    .take(bound + 1);
  if (links.length > bound) throw new Error("message file manifest bound exceeded");
  const relevant = links.filter((link: any) => messageIds.has(String(link.messageId)));
  const files = await Promise.all(relevant.map((link: any) => ctx.db.get(link.fileId)));
  const byMessage = new Map<string, any[]>();
  relevant.forEach((link: any, index: number) => {
    const file = files[index];
    if (!file) return;
    const badges = byMessage.get(String(link.messageId)) ?? [];
    badges.push({
      fileId: String(file._id),
      name: String(file.originalName),
      relativePath: String(file.relativePath),
      mimeType: String(file.detectedMimeType ?? file.mimeType),
      sizeBytes: Number(file.sizeBytes),
      status: String(file.status),
      summary: file.summary ? String(file.summary) : undefined,
      position: Number(link.position),
    });
    byMessage.set(String(link.messageId), badges);
  });
  const withFiles = rows.map((row) => {
    const badges = byMessage.get(String(row._id));
    const publicRow = typeof row.text === "string"
      ? { ...row, text: redactLegacyCreationUrls(row.text) }
      : row;
    return badges?.length
      ? {
          ...publicRow,
          files: badges.sort((left, right) => left.position - right.position).map((badge) => {
            const file = { ...badge };
            delete file.position;
            return file;
          }),
        }
      : publicRow;
  });
  return await Promise.all(withFiles.map(async (row) =>
    row.attachment ? { ...row, attachment: await safeChatAttachment(ctx, row.attachment) } : row,
  ));
}
