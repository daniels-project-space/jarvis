"use client";

import { CHAT_FILE_LIMITS, normalizeRelativeUploadPath, normalizeUploadMime, normalizeUploadName } from "./chat-files";
import { viewerFetchWithTimeout } from "./viewer-request";

export type LocalUploadFile = {
  clientId: string;
  blob: Blob;
  name: string;
  relativePath: string;
  mimeType: string;
  sha256: string;
  sizeBytes: number;
  compressed: boolean;
};

export type UploadProgress = {
  completed: number;
  total: number;
  fileName: string;
  phase: "preparing" | "uploading" | "processing" | "cancelling";
};

type UploadSession = {
  ok: boolean;
  batchId: string;
  files: Array<{ clientId: string; fileId: string; uploadUrl: string; status: string }>;
};

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(blob: Blob): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()));
}

function imageBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob(
    (blob) => blob ? resolve(blob) : reject(new Error("Image compression failed")),
    "image/webp",
    quality,
  ));
}

async function compressImage(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    let scale = Math.min(1, CHAT_FILE_LIMITS.imageResizeMaxDimension / Math.max(bitmap.width, bitmap.height));
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("Image compression is unavailable in this browser");
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob = await imageBlob(canvas, Math.max(0.56, 0.88 - attempt * 0.06));
      if (blob.size <= CHAT_FILE_LIMITS.imageResizeTargetBytes) return blob;
      scale *= 0.78;
    }
    throw new Error("Image could not be reduced below the 4 MB private upload limit");
  } finally {
    bitmap.close();
  }
}

function webpName(name: string): string {
  return name.replace(/\.[^.]+$/, "") + ".webp";
}

export async function prepareLocalUpload(file: File): Promise<LocalUploadFile> {
  if (!file.size) throw new Error(`${file.name} is empty`);
  let blob: Blob = file;
  let name = normalizeUploadName(file.name);
  let mimeType = normalizeUploadMime(file.type);
  let compressed = false;
  const isCompressibleImage = ["image/jpeg", "image/png", "image/webp"].includes(mimeType);
  if (file.size > CHAT_FILE_LIMITS.maxFileBytes && isCompressibleImage) {
    blob = await compressImage(file);
    name = name ? webpName(name) : null;
    mimeType = "image/webp";
    compressed = true;
  }
  if (!name) throw new Error("A selected file has an invalid name");
  if (blob.size > CHAT_FILE_LIMITS.maxFileBytes) {
    throw new Error(`${name} is larger than the 4 MB server-mediated upload limit`);
  }
  const originalPath = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
  const pathParts = originalPath.replace(/\\/g, "/").split("/");
  pathParts[pathParts.length - 1] = name;
  const relativePath = normalizeRelativeUploadPath(pathParts.join("/"), name);
  if (!relativePath) throw new Error(`${name} has an invalid folder path`);
  return {
    clientId: crypto.randomUUID(),
    blob,
    name,
    relativePath,
    mimeType,
    sha256: await sha256(blob),
    sizeBytes: blob.size,
    compressed,
  };
}

async function responseError(response: Response, fallback: string): Promise<Error> {
  const payload = await response.json().catch(() => null) as { error?: unknown } | null;
  return new Error(String(payload?.error ?? fallback).slice(0, 240));
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException("Upload cancelled", "AbortError");
}

async function boundedUploadFetch(
  input: RequestInfo | URL,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<Response> {
  try {
    return await viewerFetchWithTimeout(input, { ...init, signal }, CHAT_FILE_LIMITS.clientUploadTimeoutMs);
  } catch {
    throwIfAborted(signal);
    // Reservation and file PUT routes are idempotent. One same-request retry
    // resolves an ambiguous lost response without creating another file/task.
    return await viewerFetchWithTimeout(input, { ...init, signal }, CHAT_FILE_LIMITS.clientUploadTimeoutMs);
  }
}

async function cancelUploadBatch(batchId: string): Promise<boolean> {
  const request = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ batchId }),
  } satisfies RequestInit;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await viewerFetchWithTimeout(
        "/api/files/cancel-upload",
        request,
        CHAT_FILE_LIMITS.clientUploadTimeoutMs,
      );
      if (response.ok) return true;
    } catch {
      // One bounded retry is reserved for failure cleanup only.
    }
  }
  return false;
}

export async function uploadPrivateChatFiles(
  files: File[],
  threadId: string,
  onProgress?: (progress: UploadProgress) => void,
  signal?: AbortSignal,
): Promise<string[]> {
  throwIfAborted(signal);
  if (!files.length) return [];
  if (files.length > CHAT_FILE_LIMITS.maxFilesPerBatch) throw new Error(`Choose at most ${CHAT_FILE_LIMITS.maxFilesPerBatch} files at once`);
  const prepared: LocalUploadFile[] = [];
  for (let index = 0; index < files.length; index += 1) {
    throwIfAborted(signal);
    onProgress?.({ completed: index, total: files.length, fileName: files[index].name, phase: "preparing" });
    prepared.push(await prepareLocalUpload(files[index]));
    throwIfAborted(signal);
  }
  const totalBytes = prepared.reduce((sum, file) => sum + file.sizeBytes, 0);
  if (totalBytes > CHAT_FILE_LIMITS.maxBatchBytes) throw new Error("The selected folder exceeds the 64 MB batch limit");

  const sessionRequest = {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      requestId: `upload:${crypto.randomUUID()}`,
      threadId,
      files: prepared.map((file) => ({
        clientId: file.clientId,
        name: file.name,
        relativePath: file.relativePath,
        mimeType: file.mimeType,
        sha256: file.sha256,
        sizeBytes: file.sizeBytes,
      })),
    }),
  } satisfies RequestInit;
  const response = await boundedUploadFetch("/api/files/upload-session", sessionRequest, signal);
  if (!response.ok) throw await responseError(response, "Could not reserve private file storage");
  const session = await response.json() as UploadSession;
  const reservedByClientId = new Map(session.files.map((file) => [file.clientId, file]));
  const uploadedIds: string[] = [];
  try {
    for (let index = 0; index < prepared.length; index += 1) {
      throwIfAborted(signal);
      const local = prepared[index];
      const reserved = reservedByClientId.get(local.clientId);
      if (!reserved) throw new Error("Upload reservation did not include every selected file");
      onProgress?.({ completed: index, total: prepared.length, fileName: local.name, phase: "uploading" });
      const uploaded = await boundedUploadFetch(reserved.uploadUrl, {
        method: "PUT",
        credentials: "same-origin",
        headers: {
          "content-type": local.mimeType,
          "x-jarvis-sha256": local.sha256,
        },
        body: local.blob,
      }, signal);
      if (!uploaded.ok) throw await responseError(uploaded, `Could not upload ${local.name}`);
      uploadedIds.push(reserved.fileId);
      onProgress?.({ completed: index + 1, total: prepared.length, fileName: local.name, phase: "processing" });
    }
  } catch (error) {
    onProgress?.({ completed: uploadedIds.length, total: prepared.length, fileName: "private upload", phase: "cancelling" });
    const cleanupConfirmed = await cancelUploadBatch(session.batchId);
    if (!cleanupConfirmed) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${message}. Private upload cleanup could not be confirmed; retry cancellation from Library.`);
    }
    throw error;
  }
  return uploadedIds;
}

type FileSystemFileHandleLike = { kind: "file"; name: string; getFile(): Promise<File> };
type FileSystemDirectoryHandleLike = { kind: "directory"; name: string; values(): AsyncIterable<FileSystemFileHandleLike | FileSystemDirectoryHandleLike> };
type LegacyFileEntryLike = {
  isFile: true;
  isDirectory: false;
  name: string;
  file(success: (file: File) => void, failure?: (error: DOMException) => void): void;
};
type LegacyDirectoryEntryLike = {
  isFile: false;
  isDirectory: true;
  name: string;
  createReader(): { readEntries(success: (entries: LegacyEntryLike[]) => void, failure?: (error: DOMException) => void): void };
};
type LegacyEntryLike = LegacyFileEntryLike | LegacyDirectoryEntryLike;

function withRelativePath(file: File, relativePath: string): File {
  Object.defineProperty(file, "webkitRelativePath", { configurable: true, value: relativePath });
  return file;
}

async function filesFromHandle(handle: FileSystemFileHandleLike | FileSystemDirectoryHandleLike, prefix = ""): Promise<File[]> {
  if (handle.kind === "file") {
    const file = await handle.getFile();
    return [withRelativePath(file, `${prefix}${file.name}`)];
  }
  const files: File[] = [];
  for await (const child of handle.values()) {
    files.push(...await filesFromHandle(child, `${prefix}${handle.name}/`));
    if (files.length > CHAT_FILE_LIMITS.maxFilesPerBatch) break;
  }
  return files;
}

async function filesFromLegacyEntry(entry: LegacyEntryLike, prefix = ""): Promise<File[]> {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => entry.file(resolve, reject));
    return [withRelativePath(file, `${prefix}${file.name}`)];
  }
  const reader = entry.createReader();
  const files: File[] = [];
  while (files.length <= CHAT_FILE_LIMITS.maxFilesPerBatch) {
    const entries = await new Promise<LegacyEntryLike[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (!entries.length) break;
    for (const child of entries) {
      files.push(...await filesFromLegacyEntry(child, `${prefix}${entry.name}/`));
      if (files.length > CHAT_FILE_LIMITS.maxFilesPerBatch) break;
    }
  }
  return files;
}

export async function filesFromDrop(dataTransfer: DataTransfer): Promise<File[]> {
  const files: File[] = [];
  for (const item of Array.from(dataTransfer.items)) {
    const extended = item as DataTransferItem & {
      getAsFileSystemHandle?: () => Promise<FileSystemFileHandleLike | FileSystemDirectoryHandleLike | null>;
      webkitGetAsEntry?: () => LegacyEntryLike | null;
    };
    const handle = await extended.getAsFileSystemHandle?.();
    const legacyEntry = handle
      ? null
      : (extended.webkitGetAsEntry?.() as unknown as LegacyEntryLike | null | undefined);
    if (handle) files.push(...await filesFromHandle(handle));
    else if (legacyEntry) files.push(...await filesFromLegacyEntry(legacyEntry));
    else {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
    if (files.length > CHAT_FILE_LIMITS.maxFilesPerBatch) break;
  }
  return files;
}
