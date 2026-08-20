import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { inflateRaw as inflateRawCallback } from "node:zlib";
import { XMLParser, XMLValidator } from "fast-xml-parser";
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
  isXlsxMime,
  normalizeUploadMime,
  type ExtractedChunk,
} from "./chat-files";
import { hasExpectedMediaSignature, transcribableMediaKind, type TranscribableMediaKind } from "./media-types";

const MAX_PDF_PAGES = 200;
const MAX_OFFICE_UNCOMPRESSED_BYTES = 32 * 1024 * 1024;
const MAX_OFFICE_ENTRIES = 2_000;
const MAX_OFFICE_COMPRESSION_RATIO = 100;
const MAX_XLSX_SHEETS = 50;
const MAX_XLSX_ROWS_PER_SHEET = 10_000;
const MAX_XLSX_CELLS = 50_000;
const MAX_XLSX_XML_BYTES = 4 * 1024 * 1024;
const MAX_XLSX_CELL_CHARS = 640;

const ZIP_LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_DIRECTORY_FILE_HEADER_SIGNATURE = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_UINT16_SENTINEL = 0xffff;
const ZIP64_UINT32_SENTINEL = 0xffffffff;
const ZIP_UTF8_FLAG = 0x0800;
const inflateRaw = promisify(inflateRawCallback);

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

function assertDeclaredSignature(declaredMime: string, detected: string | null, name = ""): void {
  if (isPdfMime(declaredMime) && detected !== "application/pdf") throw new FileExtractionError("pdf_signature_mismatch", true);
  if (isDocxMime(declaredMime) && detected !== "application/zip") throw new FileExtractionError("docx_signature_mismatch", true);
  if (isXlsxMime(declaredMime, name) && detected !== "application/zip") throw new FileExtractionError("xlsx_signature_mismatch", true);
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

type OfficeArchiveEntry = {
  path: string;
  rawName: Uint8Array;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  flags: number;
  compressionMethod: number;
  crc32: number;
  directory: boolean;
  dataOffset: number;
};

type OfficeArchive = {
  bytes: Buffer;
  entries: Map<string, OfficeArchiveEntry>;
};

function officeArchiveError(format: "docx" | "xlsx", code: string): never {
  throw new FileExtractionError(`${format}_${code}`, true);
}

function archiveRangeEnd(start: number, length: number, limit: number, format: "docx" | "xlsx"): number {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 0 || start > limit || length > limit - start) {
    officeArchiveError(format, "archive_invalid");
  }
  return start + length;
}

function archiveUInt16(buffer: Buffer, offset: number, format: "docx" | "xlsx"): number {
  archiveRangeEnd(offset, 2, buffer.length, format);
  return buffer.readUInt16LE(offset);
}

function archiveUInt32(buffer: Buffer, offset: number, format: "docx" | "xlsx"): number {
  archiveRangeEnd(offset, 4, buffer.length, format);
  return buffer.readUInt32LE(offset);
}

function archiveEntryName(buffer: Buffer, start: number, length: number, format: "docx" | "xlsx"): { path: string; rawName: Uint8Array; directory: boolean } {
  const end = archiveRangeEnd(start, length, buffer.length, format);
  const rawName = buffer.subarray(start, end);
  let path: string;
  try {
    path = new TextDecoder("utf-8", { fatal: true }).decode(rawName);
  } catch {
    officeArchiveError(format, "archive_invalid");
  }
  const directory = path.endsWith("/");
  const parts = path.split("/");
  const safeParts = directory ? parts.slice(0, -1) : parts;
  if (!path || path.startsWith("/") || path.includes("\\") || path.includes("\u0000") || safeParts.some((part) => !part || part === "." || part === "..")) {
    officeArchiveError(format, "archive_invalid");
  }
  return { path, rawName, directory };
}

function assertNoZip64ExtraField(buffer: Buffer, start: number, length: number, format: "docx" | "xlsx"): void {
  const end = archiveRangeEnd(start, length, buffer.length, format);
  let offset = start;
  while (offset < end) {
    if (end - offset < 4) officeArchiveError(format, "archive_invalid");
    const fieldId = archiveUInt16(buffer, offset, format);
    const fieldLength = archiveUInt16(buffer, offset + 2, format);
    offset = archiveRangeEnd(offset + 4, fieldLength, end, format);
    if (fieldId === 0x0001) officeArchiveError(format, "archive_zip64");
  }
}

/**
 * Validate a canonical, non-ZIP64 single-disk archive before handing it to an
 * inflater. OOXML does not need self-extracting prefixes, data descriptors,
 * archive comments, encrypted entries, or extra data between local entries
 * and the central directory. Rejecting those forms gives the declared sizes
 * an unambiguous authority for the allocation limits below.
 */
function assertOfficeArchiveBounds(bytes: Uint8Array, format: "docx" | "xlsx"): OfficeArchive {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.length < 22) officeArchiveError(format, "directory_missing");
  const eocdOffset = buffer.length - 22;
  if (archiveUInt32(buffer, eocdOffset, format) !== ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
    officeArchiveError(format, "directory_missing");
  }
  if (archiveUInt16(buffer, eocdOffset + 20, format) !== 0) officeArchiveError(format, "archive_invalid");
  if (eocdOffset >= 20 && archiveUInt32(buffer, eocdOffset - 20, format) === ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR_SIGNATURE) {
    officeArchiveError(format, "archive_zip64");
  }

  const diskNumber = archiveUInt16(buffer, eocdOffset + 4, format);
  const centralDirectoryDisk = archiveUInt16(buffer, eocdOffset + 6, format);
  const entriesOnDisk = archiveUInt16(buffer, eocdOffset + 8, format);
  const entryCount = archiveUInt16(buffer, eocdOffset + 10, format);
  const centralDirectorySize = archiveUInt32(buffer, eocdOffset + 12, format);
  const centralDirectoryOffset = archiveUInt32(buffer, eocdOffset + 16, format);
  if (
    entriesOnDisk === ZIP64_UINT16_SENTINEL
    || entryCount === ZIP64_UINT16_SENTINEL
    || centralDirectorySize === ZIP64_UINT32_SENTINEL
    || centralDirectoryOffset === ZIP64_UINT32_SENTINEL
  ) {
    officeArchiveError(format, "archive_zip64");
  }
  if (
    diskNumber !== 0
    || centralDirectoryDisk !== 0
    || entriesOnDisk !== entryCount
  ) {
    officeArchiveError(format, "archive_invalid");
  }
  if (!entryCount) officeArchiveError(format, "directory_missing");
  if (entryCount > MAX_OFFICE_ENTRIES) officeArchiveError(format, "archive_limit");

  const centralDirectoryEnd = archiveRangeEnd(centralDirectoryOffset, centralDirectorySize, buffer.length, format);
  if (centralDirectoryEnd !== eocdOffset) officeArchiveError(format, "archive_invalid");

  const entries = new Map<string, OfficeArchiveEntry>();
  const orderedEntries: OfficeArchiveEntry[] = [];
  let uncompressedBytes = 0;
  let offset = centralDirectoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (archiveRangeEnd(offset, 46, centralDirectoryEnd, format) > centralDirectoryEnd || archiveUInt32(buffer, offset, format) !== ZIP_CENTRAL_DIRECTORY_FILE_HEADER_SIGNATURE) {
      officeArchiveError(format, "archive_invalid");
    }
    const flags = archiveUInt16(buffer, offset + 8, format);
    const compressionMethod = archiveUInt16(buffer, offset + 10, format);
    const crc32 = archiveUInt32(buffer, offset + 16, format);
    const compressedSize = archiveUInt32(buffer, offset + 20, format);
    const uncompressedSize = archiveUInt32(buffer, offset + 24, format);
    const nameLength = archiveUInt16(buffer, offset + 28, format);
    const extraLength = archiveUInt16(buffer, offset + 30, format);
    const commentLength = archiveUInt16(buffer, offset + 32, format);
    const diskStart = archiveUInt16(buffer, offset + 34, format);
    const localHeaderOffset = archiveUInt32(buffer, offset + 42, format);
    if (
      compressedSize === ZIP64_UINT32_SENTINEL
      || uncompressedSize === ZIP64_UINT32_SENTINEL
      || localHeaderOffset === ZIP64_UINT32_SENTINEL
      || diskStart === ZIP64_UINT16_SENTINEL
    ) {
      officeArchiveError(format, "archive_zip64");
    }
    if ((flags & ~ZIP_UTF8_FLAG) !== 0 || (compressionMethod !== 0 && compressionMethod !== 8) || diskStart !== 0) {
      officeArchiveError(format, "archive_invalid");
    }
    const nameStart = offset + 46;
    const extraStart = archiveRangeEnd(nameStart, nameLength, centralDirectoryEnd, format);
    const commentStart = archiveRangeEnd(extraStart, extraLength, centralDirectoryEnd, format);
    const recordEnd = archiveRangeEnd(commentStart, commentLength, centralDirectoryEnd, format);
    const { path, rawName, directory } = archiveEntryName(buffer, nameStart, nameLength, format);
    assertNoZip64ExtraField(buffer, extraStart, extraLength, format);
    if (entries.has(path) || (directory && (compressedSize !== 0 || uncompressedSize !== 0))) {
      officeArchiveError(format, "archive_invalid");
    }
    if (!directory && !compressedSize && uncompressedSize) officeArchiveError(format, "archive_invalid");
    if (uncompressedSize > MAX_OFFICE_UNCOMPRESSED_BYTES || uncompressedSize > compressedSize * MAX_OFFICE_COMPRESSION_RATIO) {
      officeArchiveError(format, uncompressedSize > MAX_OFFICE_UNCOMPRESSED_BYTES ? "archive_limit" : "archive_ratio_limit");
    }
    uncompressedBytes += uncompressedSize;
    if (uncompressedBytes > MAX_OFFICE_UNCOMPRESSED_BYTES) officeArchiveError(format, "archive_limit");
    const entry: OfficeArchiveEntry = {
      path,
      rawName,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      flags,
      compressionMethod,
      crc32,
      directory,
      dataOffset: 0,
    };
    entries.set(path, entry);
    orderedEntries.push(entry);
    offset = recordEnd;
  }
  if (offset !== centralDirectoryEnd || entries.size !== entryCount) officeArchiveError(format, "archive_invalid");

  orderedEntries.sort((left, right) => left.localHeaderOffset - right.localHeaderOffset);
  for (let index = 0; index < orderedEntries.length; index += 1) {
    const entry = orderedEntries[index];
    const nextOffset = index + 1 < orderedEntries.length ? orderedEntries[index + 1].localHeaderOffset : centralDirectoryOffset;
    if (entry.localHeaderOffset < 0 || entry.localHeaderOffset >= centralDirectoryOffset || (index > 0 && entry.localHeaderOffset === orderedEntries[index - 1].localHeaderOffset)) {
      officeArchiveError(format, "archive_invalid");
    }
    if (archiveRangeEnd(entry.localHeaderOffset, 30, centralDirectoryOffset, format) > centralDirectoryOffset || archiveUInt32(buffer, entry.localHeaderOffset, format) !== ZIP_LOCAL_FILE_HEADER_SIGNATURE) {
      officeArchiveError(format, "archive_invalid");
    }
    const localFlags = archiveUInt16(buffer, entry.localHeaderOffset + 6, format);
    const localCompressionMethod = archiveUInt16(buffer, entry.localHeaderOffset + 8, format);
    const localCrc32 = archiveUInt32(buffer, entry.localHeaderOffset + 14, format);
    const localCompressedSize = archiveUInt32(buffer, entry.localHeaderOffset + 18, format);
    const localUncompressedSize = archiveUInt32(buffer, entry.localHeaderOffset + 22, format);
    const localNameLength = archiveUInt16(buffer, entry.localHeaderOffset + 26, format);
    const localExtraLength = archiveUInt16(buffer, entry.localHeaderOffset + 28, format);
    if (
      localCompressedSize === ZIP64_UINT32_SENTINEL
      || localUncompressedSize === ZIP64_UINT32_SENTINEL
      || localFlags !== entry.flags
      || localCompressionMethod !== entry.compressionMethod
      || localCrc32 !== entry.crc32
      || localCompressedSize !== entry.compressedSize
      || localUncompressedSize !== entry.uncompressedSize
    ) {
      officeArchiveError(format, "archive_invalid");
    }
    const localNameStart = entry.localHeaderOffset + 30;
    const localExtraStart = archiveRangeEnd(localNameStart, localNameLength, centralDirectoryOffset, format);
    const localDataStart = archiveRangeEnd(localExtraStart, localExtraLength, centralDirectoryOffset, format);
    if (localNameLength !== entry.rawName.byteLength || !buffer.subarray(localNameStart, localExtraStart).equals(entry.rawName)) {
      officeArchiveError(format, "archive_invalid");
    }
    assertNoZip64ExtraField(buffer, localExtraStart, localExtraLength, format);
    const localDataEnd = archiveRangeEnd(localDataStart, entry.compressedSize, centralDirectoryOffset, format);
    if (localDataEnd !== nextOffset) officeArchiveError(format, "archive_invalid");
    entry.dataOffset = localDataStart;
  }
  if (orderedEntries[0]?.localHeaderOffset !== 0) officeArchiveError(format, "archive_invalid");
  return { bytes: buffer, entries };
}

type XmlRecord = Record<string, unknown>;

type XlsxCell = {
  ref: string;
  value: string;
};

type XlsxChunkBuilder = {
  sheet: string;
  lines: string[];
  chars: number;
  startCell: string;
  endCell: string;
};

function isXmlRecord(value: unknown): value is XmlRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function xmlArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** Read OOXML text without interpreting formulas or executing any workbook
 * content. This deliberately handles the small XML value shapes used by XLSX
 * instead of treating workbook XML as trusted HTML or general markup. */
function xlsxXmlText(value: unknown, depth = 0): string {
  if (depth > 24) throw new FileExtractionError("xlsx_xml_depth_limit", true);
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map((item) => xlsxXmlText(item, depth + 1)).join("");
  if (!isXmlRecord(value)) return "";
  if ("#text" in value) return xlsxXmlText(value["#text"], depth + 1);
  if ("t" in value) return xlsxXmlText(value.t, depth + 1);
  return Object.entries(value)
    .filter(([key]) => !key.startsWith("@_"))
    .map(([, child]) => xlsxXmlText(child, depth + 1))
    .join("");
}

function xlsxDisplayText(value: unknown): string {
  return xlsxXmlText(value)
    .replace(/\u0000/g, "")
    .replace(/\s*\r?\n\s*/g, " ")
    .trim()
    .slice(0, MAX_XLSX_CELL_CHARS);
}

function parseXlsxXml(value: string): XmlRecord {
  // OOXML has no reason to include document/entity declarations. Rejecting
  // them keeps parser behavior deterministic and avoids accepting a workbook
  // that relies on a second XML processing surface.
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(value)) throw new FileExtractionError("xlsx_unsafe_xml", true);
  try {
    if (XMLValidator.validate(value) !== true) throw new FileExtractionError("xlsx_xml_invalid", true);
    const parsed = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
      textNodeName: "#text",
      trimValues: false,
      processEntities: false,
      parseTagValue: false,
      parseAttributeValue: false,
    }).parse(value);
    if (!isXmlRecord(parsed)) throw new FileExtractionError("xlsx_xml_invalid", true);
    return parsed;
  } catch (error) {
    if (error instanceof FileExtractionError) throw error;
    throw new FileExtractionError("xlsx_xml_invalid", true);
  }
}

type XlsxInflationBudget = { remainingBytes: number };

async function xlsxEntryBytes(archive: OfficeArchive, entry: OfficeArchiveEntry, maxOutputBytes: number): Promise<Uint8Array> {
  const compressed = archive.bytes.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
  if (entry.compressionMethod === 0) return compressed;
  try {
    return await inflateRaw(compressed, { maxOutputLength: maxOutputBytes });
  } catch (error) {
    if (isXmlRecord(error) && error.code === "ERR_BUFFER_TOO_LARGE") {
      throw new FileExtractionError("xlsx_xml_size_limit", true);
    }
    throw new FileExtractionError("xlsx_zip_invalid", true);
  }
}

async function xlsxEntryText(archive: OfficeArchive, inflationBudget: XlsxInflationBudget, path: string, required?: true): Promise<string>;
async function xlsxEntryText(archive: OfficeArchive, inflationBudget: XlsxInflationBudget, path: string, required: false): Promise<string | null>;
async function xlsxEntryText(archive: OfficeArchive, inflationBudget: XlsxInflationBudget, path: string, required = true): Promise<string | null> {
  const archiveEntry = archive.entries.get(path);
  if (archiveEntry && archiveEntry.uncompressedSize > MAX_XLSX_XML_BYTES) {
    throw new FileExtractionError("xlsx_xml_size_limit", true);
  }
  if (!archiveEntry || archiveEntry.directory) {
    if (required) throw new FileExtractionError("xlsx_structure_invalid", true);
    return null;
  }
  const maxOutputBytes = Math.min(MAX_XLSX_XML_BYTES, inflationBudget.remainingBytes);
  if (maxOutputBytes <= 0) throw new FileExtractionError("xlsx_archive_limit", true);
  try {
    const bytes = await xlsxEntryBytes(archive, archiveEntry, maxOutputBytes);
    if (bytes.byteLength !== archiveEntry.uncompressedSize) throw new FileExtractionError("xlsx_archive_invalid", true);
    if (bytes.byteLength > maxOutputBytes) throw new FileExtractionError("xlsx_xml_size_limit", true);
    inflationBudget.remainingBytes -= bytes.byteLength;
    return decodeText(bytes);
  } catch (error) {
    if (error instanceof FileExtractionError) throw error;
    throw new FileExtractionError("xlsx_zip_invalid", true);
  }
}

function xlsxSheetPath(value: string): string {
  const target = value.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!target || target.includes("..") || !target.endsWith(".xml")) {
    throw new FileExtractionError("xlsx_structure_invalid", true);
  }
  const path = target.startsWith("xl/") ? target : `xl/${target}`;
  if (!path.startsWith("xl/")) throw new FileExtractionError("xlsx_structure_invalid", true);
  return path;
}

function xlsxSheetName(value: unknown, index: number): string {
  return xlsxDisplayText(value).slice(0, 120) || `Sheet ${index + 1}`;
}

function xlsxSharedStrings(parsed: XmlRecord): string[] {
  const root = isXmlRecord(parsed.sst) ? parsed.sst : null;
  if (!root) throw new FileExtractionError("xlsx_structure_invalid", true);
  const values = xmlArray(root.si);
  if (values.length > MAX_XLSX_CELLS) throw new FileExtractionError("xlsx_processing_limit", true);
  return values.map((value) => xlsxDisplayText(value));
}

function xlsxCellRef(value: unknown, row: number, ordinal: number): string {
  const ref = typeof value === "string" ? value.trim().toUpperCase() : "";
  if (/^[A-Z]{1,3}[1-9]\d*$/.test(ref)) return ref;
  return `row ${row} cell ${ordinal + 1}`;
}

function xlsxCellValue(cell: XmlRecord, sharedStrings: string[]): string {
  const type = typeof cell["@_t"] === "string" ? cell["@_t"] : "";
  const formula = xlsxDisplayText(cell.f);
  let value = "";
  if (type === "s") {
    const index = Number(xlsxDisplayText(cell.v));
    if (!Number.isSafeInteger(index) || index < 0 || index >= sharedStrings.length) {
      throw new FileExtractionError("xlsx_shared_string_invalid", true);
    }
    value = sharedStrings[index];
  } else if (type === "inlineStr") {
    value = xlsxDisplayText(cell.is);
  } else if (type === "b") {
    const raw = xlsxDisplayText(cell.v);
    value = raw === "1" ? "TRUE" : raw === "0" ? "FALSE" : raw;
  } else {
    value = xlsxDisplayText(cell.v);
  }
  if (!formula) return value;
  // Never evaluate a formula. Its cached value is useful evidence when
  // available; otherwise expose the formula itself as inert reference text.
  return value ? `${value} (formula: =${formula})`.slice(0, MAX_XLSX_CELL_CHARS) : `=${formula}`.slice(0, MAX_XLSX_CELL_CHARS);
}

function xlsxRow(cells: XlsxCell[]): { text: string; startCell: string; endCell: string; cellCount: number; clipped: boolean } | null {
  const included: XlsxCell[] = [];
  let chars = 0;
  let clipped = false;
  for (const cell of cells) {
    if (!cell.value) continue;
    const part = `${cell.ref}: ${cell.value}`;
    const separator = included.length ? " | " : "";
    if (chars + separator.length + part.length > CHAT_FILE_LIMITS.chunkChars) {
      if (!included.length) included.push({ ...cell, value: cell.value.slice(0, CHAT_FILE_LIMITS.chunkChars - cell.ref.length - 2) });
      clipped = true;
      break;
    }
    included.push(cell);
    chars += separator.length + part.length;
  }
  if (!included.length) return null;
  return {
    text: included.map((cell) => `${cell.ref}: ${cell.value}`).join(" | "),
    startCell: included[0].ref,
    endCell: included.at(-1)!.ref,
    cellCount: included.length,
    clipped,
  };
}

function flushXlsxChunk(builder: XlsxChunkBuilder, chunks: ExtractedChunk[]): void {
  if (!builder.lines.length || chunks.length >= CHAT_FILE_LIMITS.maxChunks) return;
  chunks.push({
    ordinal: chunks.length,
    text: builder.lines.join("\n"),
    sheet: builder.sheet,
    cellRange: builder.startCell === builder.endCell ? builder.startCell : `${builder.startCell}:${builder.endCell}`,
  });
  builder.lines = [];
  builder.chars = 0;
  builder.startCell = "";
  builder.endCell = "";
}

function appendXlsxRow(builder: XlsxChunkBuilder, chunks: ExtractedChunk[], row: NonNullable<ReturnType<typeof xlsxRow>>): boolean {
  if (builder.lines.length && builder.chars + 1 + row.text.length > CHAT_FILE_LIMITS.chunkChars) {
    flushXlsxChunk(builder, chunks);
  }
  if (chunks.length >= CHAT_FILE_LIMITS.maxChunks) return false;
  const separator = builder.lines.length ? 1 : 0;
  if (!builder.lines.length) builder.startCell = row.startCell;
  builder.lines.push(row.text);
  builder.chars += separator + row.text.length;
  builder.endCell = row.endCell;
  return true;
}

async function extractXlsx(bytes: Uint8Array, sha256: string): Promise<FileExtractionResult> {
  const archive = assertOfficeArchiveBounds(bytes, "xlsx");
  const inflationBudget: XlsxInflationBudget = { remainingBytes: MAX_OFFICE_UNCOMPRESSED_BYTES };

  const contentTypes = parseXlsxXml(await xlsxEntryText(archive, inflationBudget, "[Content_Types].xml"));
  if (!isXmlRecord(contentTypes.Types)) throw new FileExtractionError("xlsx_structure_invalid", true);
  const workbook = parseXlsxXml(await xlsxEntryText(archive, inflationBudget, "xl/workbook.xml"));
  const relationships = parseXlsxXml(await xlsxEntryText(archive, inflationBudget, "xl/_rels/workbook.xml.rels"));
  const relationshipRoot = isXmlRecord(relationships.Relationships) ? relationships.Relationships : null;
  if (!relationshipRoot) throw new FileExtractionError("xlsx_structure_invalid", true);
  const relationshipPaths = new Map<string, string>();
  for (const relationship of xmlArray(relationshipRoot.Relationship)) {
    if (!isXmlRecord(relationship) || relationship["@_TargetMode"] === "External") continue;
    const id = typeof relationship["@_Id"] === "string" ? relationship["@_Id"] : "";
    const target = typeof relationship["@_Target"] === "string" ? relationship["@_Target"] : "";
    if (id && target) relationshipPaths.set(id, xlsxSheetPath(target));
  }
  const workbookRoot = isXmlRecord(workbook.workbook) ? workbook.workbook : null;
  const sheetRoot = workbookRoot && isXmlRecord(workbookRoot.sheets) ? workbookRoot.sheets : null;
  if (!sheetRoot) throw new FileExtractionError("xlsx_structure_invalid", true);
  const allSheets = xmlArray(sheetRoot.sheet).map((sheet, index) => {
    if (!isXmlRecord(sheet)) throw new FileExtractionError("xlsx_structure_invalid", true);
    const relationshipId = typeof sheet["@_r:id"] === "string" ? sheet["@_r:id"] : "";
    const path = relationshipPaths.get(relationshipId);
    if (!path) throw new FileExtractionError("xlsx_structure_invalid", true);
    return { name: xlsxSheetName(sheet["@_name"], index), path };
  });
  if (!allSheets.length) throw new FileExtractionError("xlsx_structure_invalid", true);
  const sheets = allSheets.slice(0, MAX_XLSX_SHEETS);

  const sharedStringsXml = await xlsxEntryText(archive, inflationBudget, "xl/sharedStrings.xml", false);
  const sharedStrings = sharedStringsXml ? xlsxSharedStrings(parseXlsxXml(sharedStringsXml)) : [];
  const chunks: ExtractedChunk[] = [];
  let indexedCells = 0;
  let truncated = allSheets.length > sheets.length;

  sheetLoop: for (const sheet of sheets) {
    const parsed = parseXlsxXml(await xlsxEntryText(archive, inflationBudget, sheet.path));
    const worksheet = isXmlRecord(parsed.worksheet) ? parsed.worksheet : null;
    // Chartsheets do not contain cell data; retain their names without making
    // a malformed-data claim about an otherwise valid workbook.
    const sheetData = worksheet && isXmlRecord(worksheet.sheetData) ? worksheet.sheetData : null;
    if (!sheetData) continue;
    const rows = xmlArray(sheetData.row);
    const builder: XlsxChunkBuilder = { sheet: sheet.name, lines: [], chars: 0, startCell: "", endCell: "" };
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      if (rowIndex >= MAX_XLSX_ROWS_PER_SHEET || indexedCells >= MAX_XLSX_CELLS) {
        truncated = true;
        break;
      }
      const row = rows[rowIndex];
      if (!isXmlRecord(row)) throw new FileExtractionError("xlsx_structure_invalid", true);
      const rowNumber = Number(row["@_r"]);
      const effectiveRow = Number.isSafeInteger(rowNumber) && rowNumber > 0 ? rowNumber : rowIndex + 1;
      const rawCells = xmlArray(row.c);
      const remainingCells = MAX_XLSX_CELLS - indexedCells;
      const boundedRawCells = rawCells.slice(0, remainingCells);
      const cellLimitReached = boundedRawCells.length < rawCells.length;
      // Count every raw <c> before formatting. Blank cells and cells omitted
      // from a clipped row still consume the workbook processing budget.
      indexedCells += boundedRawCells.length;
      const cells = boundedRawCells.map((cell, ordinal) => {
        if (!isXmlRecord(cell)) throw new FileExtractionError("xlsx_structure_invalid", true);
        return {
          ref: xlsxCellRef(cell["@_r"], effectiveRow, ordinal),
          value: xlsxCellValue(cell, sharedStrings),
        };
      });
      const formatted = xlsxRow(cells);
      if (!formatted) {
        if (cellLimitReached) {
          truncated = true;
          break;
        }
        continue;
      }
      if (!appendXlsxRow(builder, chunks, formatted)) {
        truncated = true;
        break sheetLoop;
      }
      if (formatted.clipped) truncated = true;
      if (cellLimitReached) {
        truncated = true;
        break;
      }
    }
    flushXlsxChunk(builder, chunks);
    if (chunks.length >= CHAT_FILE_LIMITS.maxChunks) {
      truncated = true;
      break;
    }
  }

  const text = boundedExtractedText(chunks.map((chunk) => `[${chunk.sheet} · ${chunk.cellRange}]\n${chunk.text}`).join("\n\n"));
  const sheetSummary = `${sheets.length} sheet${sheets.length === 1 ? "" : "s"}`;
  const indexedSummary = `${indexedCells.toLocaleString("en-US")} cell${indexedCells === 1 ? "" : "s"} indexed`;
  return {
    sha256,
    detectedMimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    status: "ready",
    summary: `Excel workbook · ${sheetSummary} · ${indexedSummary}${truncated ? " · bounded extract" : ""}`,
    text,
    chunks,
    sheetNames: sheets.map((sheet) => sheet.name),
  };
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
  assertOfficeArchiveBounds(bytes, "docx");
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
  assertDeclaredSignature(declaredMime, signatureMime, name);
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  if (signatureMime === "application/pdf") return await extractPdf(bytes, sha256);
  if (isDocxMime(declaredMime)) return await extractDocx(bytes, sha256);
  if (isXlsxMime(declaredMime, name)) return await extractXlsx(bytes, sha256);
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
