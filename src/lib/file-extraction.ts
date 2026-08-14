import { createHash } from "node:crypto";
import mammoth from "mammoth";
import sharp from "sharp";
import {
  CHAT_FILE_LIMITS,
  boundedExtractedText,
  chunkExtractedText,
  isCsvMime,
  isDocxMime,
  isImageMime,
  isPdfMime,
  isPlainTextMime,
  normalizeUploadMime,
  type ExtractedChunk,
} from "./chat-files";
import { hasExpectedMediaSignature, transcribableMediaKind, type TranscribableMediaKind } from "./media-types";

const MAX_PDF_PAGES = 200;
const MAX_DOCX_UNCOMPRESSED_BYTES = 32 * 1024 * 1024;
const MAX_DOCX_ENTRIES = 2_000;

export type FileExtractionResult = {
  sha256: string;
  detectedMimeType: string;
  status: "ready" | "stored_only";
  summary?: string;
  text: string;
  chunks: ExtractedChunk[];
  pageCount?: number;
  sheetNames?: string[];
  preview?: { bytes: Uint8Array; contentType: "image/webp"; timestamps?: number[] };
  /** Present only for verified containers that the private Trigger worker may
   * send to Daniel's configured transcription services. */
  media?: { kind: TranscribableMediaKind };
};

export class FileExtractionError extends Error {
  constructor(public readonly code: string, public readonly quarantined = false) {
    super(code);
  }
}

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((byte, index) => bytes[index] === byte);
}

export function detectFileMime(bytes: Uint8Array): string | null {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "image/webp";
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return "application/zip";
  return null;
}

function assertDeclaredSignature(declaredMime: string, detected: string | null): void {
  if (isPdfMime(declaredMime) && detected !== "application/pdf") throw new FileExtractionError("pdf_signature_mismatch", true);
  if (isDocxMime(declaredMime) && detected !== "application/zip") throw new FileExtractionError("docx_signature_mismatch", true);
  if (isImageMime(declaredMime) && detected !== declaredMime) throw new FileExtractionError("image_signature_mismatch", true);
}

function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le", { fatal: true }).decode(bytes.slice(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = new Uint8Array(bytes.length - 2);
    for (let index = 2; index + 1 < bytes.length; index += 2) {
      swapped[index - 2] = bytes[index + 1];
      swapped[index - 1] = bytes[index];
    }
    return new TextDecoder("utf-16le", { fatal: true }).decode(swapped);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new FileExtractionError("invalid_text_encoding", true);
  }
}

function assertDocxArchiveBounds(bytes: Uint8Array): void {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let entries = 0;
  let uncompressedBytes = 0;
  for (let offset = 0; offset + 46 <= buffer.length; offset += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) continue;
    entries += 1;
    uncompressedBytes += buffer.readUInt32LE(offset + 24);
    if (entries > MAX_DOCX_ENTRIES || uncompressedBytes > MAX_DOCX_UNCOMPRESSED_BYTES) {
      throw new FileExtractionError("docx_archive_limit", true);
    }
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    offset += 45 + nameLength + extraLength + commentLength;
  }
  if (!entries) throw new FileExtractionError("docx_directory_missing", true);
}

function csvChunks(text: string, sheet: string): ExtractedChunk[] {
  const lines = text.split("\n");
  const chunks: ExtractedChunk[] = [];
  let rowStart = 1;
  let current: string[] = [];
  let chars = 0;
  const flush = (rowEnd: number) => {
    const value = current.join("\n").trim();
    if (value) chunks.push({
      ordinal: chunks.length,
      text: value.slice(0, CHAT_FILE_LIMITS.chunkChars),
      sheet,
      cellRange: `rows ${rowStart}-${rowEnd}`,
    });
    current = [];
    chars = 0;
    rowStart = rowEnd + 1;
  };
  for (let index = 0; index < lines.length && chunks.length < CHAT_FILE_LIMITS.maxChunks; index += 1) {
    const line = lines[index];
    if (current.length && chars + line.length + 1 > CHAT_FILE_LIMITS.chunkChars) flush(index);
    current.push(line);
    chars += line.length + 1;
  }
  if (current.length && chunks.length < CHAT_FILE_LIMITS.maxChunks) flush(lines.length);
  return chunks;
}

async function extractPdf(bytes: Uint8Array, sha256: string): Promise<FileExtractionResult> {
  // Serverless task bundles do not preserve pdf.js' default filesystem worker
  // path. Load the package's self-contained worker only on the PDF path so the
  // extractor stays portable without adding work to non-PDF ingestion.
  const { getData } = await import("pdf-parse/worker");
  const { PDFParse } = await import("pdf-parse");
  PDFParse.setWorker(getData());
  const parser = new PDFParse({ data: bytes });
  try {
    const result = await parser.getText({ first: MAX_PDF_PAGES });
    const chunks: ExtractedChunk[] = [];
    const pageText: string[] = [];
    for (const page of result.pages) {
      const bounded = boundedExtractedText(page.text);
      if (bounded) pageText.push(`[Page ${page.num}]\n${bounded}`);
      for (const chunk of chunkExtractedText(bounded)) {
        if (chunks.length >= CHAT_FILE_LIMITS.maxChunks) break;
        chunks.push({ ...chunk, ordinal: chunks.length, page: page.num });
      }
      if (chunks.length >= CHAT_FILE_LIMITS.maxChunks) break;
    }
    const text = boundedExtractedText(pageText.join("\n\n"));
    return {
      sha256,
      detectedMimeType: "application/pdf",
      status: "ready",
      summary: `PDF · ${result.total} page${result.total === 1 ? "" : "s"}${result.total > MAX_PDF_PAGES ? ` · first ${MAX_PDF_PAGES} pages indexed` : ""} · ${text.length.toLocaleString("en-US")} characters indexed`,
      text,
      chunks,
      pageCount: result.total,
    };
  } catch (error) {
    if (error instanceof FileExtractionError) throw error;
    throw new FileExtractionError(`pdf_parse_failed:${String(error).slice(0, 80)}`);
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

async function extractDocx(bytes: Uint8Array, sha256: string): Promise<FileExtractionResult> {
  assertDocxArchiveBounds(bytes);
  try {
    const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    const text = boundedExtractedText(result.value);
    return {
      sha256,
      detectedMimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      status: "ready",
      summary: `Word document · ${text.length.toLocaleString("en-US")} characters indexed`,
      text,
      chunks: chunkExtractedText(text),
    };
  } catch (error) {
    if (error instanceof FileExtractionError) throw error;
    throw new FileExtractionError(`docx_parse_failed:${String(error).slice(0, 80)}`);
  }
}

async function extractImage(bytes: Uint8Array, detectedMimeType: string, sha256: string): Promise<FileExtractionResult> {
  try {
    const source = sharp(bytes, { failOn: "error", limitInputPixels: 80_000_000 });
    const metadata = await source.metadata();
    if (!metadata.width || !metadata.height) throw new Error("dimensions missing");
    const preview = await source
      .clone()
      .rotate()
      .resize({ width: 768, height: 768, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 80, effort: 4 })
      .toBuffer();
    return {
      sha256,
      detectedMimeType,
      status: "ready",
      summary: `Image · ${metadata.width} × ${metadata.height} · ${metadata.format ?? detectedMimeType.split("/")[1]} · ready for visual analysis in chat`,
      text: "",
      chunks: [],
      preview: { bytes: preview, contentType: "image/webp" },
    };
  } catch (error) {
    throw new FileExtractionError(`image_decode_failed:${String(error).slice(0, 80)}`, true);
  }
}

function storedOnlySummary(mimeType: string): string {
  if (mimeType.startsWith("audio/")) {
    return "Audio saved privately · no transcript is available, so Jarvis cannot inspect its contents.";
  }
  if (mimeType.startsWith("video/")) {
    return "Video saved privately · no transcript or frame analysis is available, so Jarvis cannot inspect its contents.";
  }
  return "Stored privately · deterministic text extraction is not available for this format";
}

export async function extractPrivateFile(input: {
  bytes: Uint8Array;
  name: string;
  mimeType: string;
}): Promise<FileExtractionResult> {
  const { bytes, name } = input;
  if (!bytes.byteLength || bytes.byteLength > CHAT_FILE_LIMITS.maxFileBytes) throw new FileExtractionError("file_size_invalid", true);
  const declaredMime = normalizeUploadMime(input.mimeType);
  const signatureMime = detectFileMime(bytes);
  assertDeclaredSignature(declaredMime, signatureMime);
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  if (signatureMime === "application/pdf") return await extractPdf(bytes, sha256);
  if (isDocxMime(declaredMime)) return await extractDocx(bytes, sha256);
  if (signatureMime && isImageMime(signatureMime)) return await extractImage(bytes, signatureMime, sha256);
  const mediaKind = transcribableMediaKind(declaredMime);
  if (mediaKind) {
    if (!hasExpectedMediaSignature(declaredMime, bytes)) {
      throw new FileExtractionError("media_signature_mismatch", true);
    }
    return {
      sha256,
      detectedMimeType: declaredMime,
      status: "stored_only",
      summary: `${mediaKind === "video" ? "Video" : "Audio"} saved privately · transcription will run during secure ingestion.`,
      text: "",
      chunks: [],
      media: { kind: mediaKind },
    };
  }
  if (isCsvMime(declaredMime, name)) {
    const text = boundedExtractedText(decodeText(bytes));
    const sheet = name.slice(0, 120);
    return {
      sha256,
      detectedMimeType: "text/csv",
      status: "ready",
      summary: `CSV · ${text.split("\n").length.toLocaleString("en-US")} rows · ${text.length.toLocaleString("en-US")} characters indexed`,
      text,
      chunks: csvChunks(text, sheet),
      sheetNames: [sheet],
    };
  }
  if (isPlainTextMime(declaredMime, name)) {
    const text = boundedExtractedText(decodeText(bytes));
    return {
      sha256,
      detectedMimeType: declaredMime,
      status: "ready",
      summary: `Text · ${text.length.toLocaleString("en-US")} characters indexed`,
      text,
      chunks: chunkExtractedText(text),
    };
  }
  return {
    sha256,
    detectedMimeType: signatureMime ?? declaredMime,
    status: "stored_only",
    summary: storedOnlySummary(signatureMime ?? declaredMime),
    text: "",
    chunks: [],
  };
}
