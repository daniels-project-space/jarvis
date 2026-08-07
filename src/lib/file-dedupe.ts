import { CHAT_FILE_LIMITS, FILE_READY_STATUSES, normalizeUploadSha256, type ExtractedChunk } from "./chat-files";

export type ReadyDuplicateRecord = {
  file: {
    status: string;
    sha256?: string;
    detectedMimeType?: string;
    mimeType: string;
    summary?: string;
    extractedTextR2Key?: string;
    previewR2Key?: string;
    extractedChars?: number;
    pageCount?: number;
    sheetNames?: string[];
  };
  chunks: ExtractedChunk[];
};

/** Validate every durable invariant before a worker trusts derived bytes from
 * another independently owned original object. */
export function trustedReadyDuplicate(duplicate: ReadyDuplicateRecord | null, expectedSha256: string): ReadyDuplicateRecord | null {
  const expected = normalizeUploadSha256(expectedSha256);
  if (!duplicate || !expected || duplicate.file.sha256 !== expected || !FILE_READY_STATUSES.has(duplicate.file.status)) return null;
  if (duplicate.chunks.length > CHAT_FILE_LIMITS.maxChunks) return null;
  if (duplicate.chunks.some((chunk, index) => chunk.ordinal !== index || !chunk.text.trim() || chunk.text.length > 2_200)) return null;
  if (duplicate.chunks.length && !duplicate.file.extractedTextR2Key) return null;
  return duplicate;
}
