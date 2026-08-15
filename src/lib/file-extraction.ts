import { createHash } from "node:crypto";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import JSZip from "jszip";
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
const MAX_XLSX_SHEETS = 50;
const MAX_XLSX_ROWS_PER_SHEET = 10_000;
const MAX_XLSX_CELLS = 50_000;
const MAX_XLSX_XML_BYTES = 4 * 1024 * 1024;
const MAX_XLSX_CELL_CHARS = 640;

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

function assertOfficeArchiveBounds(bytes: Uint8Array, format: "docx" | "xlsx"): void {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let entries = 0;
  let uncompressedBytes = 0;
  for (let offset = 0; offset + 46 <= buffer.length; offset += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) continue;
    entries += 1;
    uncompressedBytes += buffer.readUInt32LE(offset + 24);
    if (entries > MAX_OFFICE_ENTRIES || uncompressedBytes > MAX_OFFICE_UNCOMPRESSED_BYTES) {
      throw new FileExtractionError(`${format}_archive_limit`, true);
    }
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    offset += 45 + nameLength + extraLength + commentLength;
  }
  if (!entries) throw new FileExtractionError(`${format}_directory_missing`, true);
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

async function xlsxEntryText(zip: JSZip, path: string, required?: true): Promise<string>;
async function xlsxEntryText(zip: JSZip, path: string, required: false): Promise<string | null>;
async function xlsxEntryText(zip: JSZip, path: string, required = true): Promise<string | null> {
  const entry = zip.file(path);
  if (!entry || entry.dir) {
    if (required) throw new FileExtractionError("xlsx_structure_invalid", true);
    return null;
  }
  try {
    const bytes = await entry.async("uint8array");
    if (bytes.byteLength > MAX_XLSX_XML_BYTES) throw new FileExtractionError("xlsx_xml_size_limit", true);
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
  assertOfficeArchiveBounds(bytes, "xlsx");
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes, { checkCRC32: false, createFolders: false });
  } catch {
    throw new FileExtractionError("xlsx_zip_invalid", true);
  }

  const contentTypes = parseXlsxXml(await xlsxEntryText(zip, "[Content_Types].xml"));
  if (!isXmlRecord(contentTypes.Types)) throw new FileExtractionError("xlsx_structure_invalid", true);
  const workbook = parseXlsxXml(await xlsxEntryText(zip, "xl/workbook.xml"));
  const relationships = parseXlsxXml(await xlsxEntryText(zip, "xl/_rels/workbook.xml.rels"));
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

  const sharedStringsXml = await xlsxEntryText(zip, "xl/sharedStrings.xml", false);
  const sharedStrings = sharedStringsXml ? xlsxSharedStrings(parseXlsxXml(sharedStringsXml)) : [];
  const chunks: ExtractedChunk[] = [];
  let indexedCells = 0;
  let truncated = allSheets.length > sheets.length;

  sheetLoop: for (const sheet of sheets) {
    const parsed = parseXlsxXml(await xlsxEntryText(zip, sheet.path));
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
      const cells = xmlArray(row.c).map((cell, ordinal) => {
        if (!isXmlRecord(cell)) throw new FileExtractionError("xlsx_structure_invalid", true);
        return {
          ref: xlsxCellRef(cell["@_r"], effectiveRow, ordinal),
          value: xlsxCellValue(cell, sharedStrings),
        };
      });
      const formatted = xlsxRow(cells);
      if (!formatted) continue;
      if (!appendXlsxRow(builder, chunks, formatted)) {
        truncated = true;
        break sheetLoop;
      }
      indexedCells += formatted.cellCount;
      if (formatted.clipped) truncated = true;
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
