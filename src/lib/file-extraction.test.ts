import { readFile } from "node:fs/promises";
import { join } from "node:path";
import JSZip from "jszip";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { FileExtractionError, extractPrivateFile } from "./file-extraction";

async function realDocxFixture(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?>
    <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      <Default Extension="xml" ContentType="application/xml"/>
      <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
    </Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
    </Relationships>`);
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
      <w:p><w:r><w:t>Signed rental contract for Venice to London.</w:t></w:r></w:p>
      <w:p><w:r><w:t>Total confirmed revenue is 2645 euros.</w:t></w:r></w:p>
    </w:body></w:document>`);
  return await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

async function realXlsxFixture(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?>
    <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      <Default Extension="xml" ContentType="application/xml"/>
      <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
      <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
      <Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
      <Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
    </Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
    </Relationships>`);
  zip.file("xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8"?>
    <workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
      <sheets>
        <sheet name="Booked stay" sheetId="1" r:id="rId1"/>
        <sheet name="Flights" sheetId="2" r:id="rId2"/>
      </sheets>
    </workbook>`);
  zip.file("xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
      <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
    </Relationships>`);
  zip.file("xl/sharedStrings.xml", `<?xml version="1.0" encoding="UTF-8"?>
    <sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="3" uniqueCount="3">
      <si><t>City</t></si><si><t>Revenue</t></si><si><r><t>Ven</t></r><r><t>ice</t></r></si>
    </sst>`);
  zip.file("xl/worksheets/sheet1.xml", `<?xml version="1.0" encoding="UTF-8"?>
    <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
      <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
      <row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>2645</v></c></row>
      <row r="3"><c r="A3" t="b"><v>1</v></c><c r="B3"><f>SUM(B2:B2)</f><v>2645</v></c></row>
    </sheetData></worksheet>`);
  zip.file("xl/worksheets/sheet2.xml", `<?xml version="1.0" encoding="UTF-8"?>
    <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
      <row r="1"><c r="A1" t="inlineStr"><is><t>Flight leaves 10:30</t></is></c></row>
    </sheetData></worksheet>`);
  return await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

async function xlsxWithWorksheetXml(sheetXml: string): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(await realXlsxFixture());
  zip.file("xl/worksheets/sheet1.xml", sheetXml);
  // The raw-cell cap tests exercise parser bounds, not compression bounds.
  return await zip.generateAsync({ type: "uint8array", compression: "STORE" });
}

async function xlsxWithDeflatedWorksheetXml(sheetXml: string): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(await realXlsxFixture());
  zip.file("xl/worksheets/sheet1.xml", sheetXml);
  return await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

async function xlsxWithWorkbookPart(path: "xl/workbook.xml" | "xl/_rels/workbook.xml.rels", xml: string): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(await realXlsxFixture());
  zip.file(path, xml);
  return await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

function centralDirectoryOffset(bytes: Uint8Array): number {
  const buffer = Buffer.from(bytes);
  const eocdOffset = buffer.length - 22;
  if (buffer.readUInt32LE(eocdOffset) !== 0x06054b50) throw new Error("fixture is missing EOCD");
  return buffer.readUInt32LE(eocdOffset + 16);
}

function withForgedCentralUncompressedSize(bytes: Uint8Array): Uint8Array {
  const buffer = Buffer.from(bytes);
  buffer.writeUInt32LE(0, centralDirectoryOffset(buffer) + 24);
  return new Uint8Array(buffer);
}

function withZip64EntryCount(bytes: Uint8Array): Uint8Array {
  const buffer = Buffer.from(bytes);
  const eocdOffset = buffer.length - 22;
  buffer.writeUInt16LE(0xffff, eocdOffset + 10);
  return new Uint8Array(buffer);
}

function centralDirectoryEntryOffset(bytes: Uint8Array, path: string): number {
  const buffer = Buffer.from(bytes);
  const eocdOffset = buffer.length - 22;
  const count = buffer.readUInt16LE(eocdOffset + 10);
  let offset = centralDirectoryOffset(buffer);
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error("fixture central directory is malformed");
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    if (buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8") === path) return offset;
    offset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`fixture is missing ${path}`);
}

function withForgedEntryUncompressedSize(bytes: Uint8Array, path: string, size: number): Uint8Array {
  const buffer = Buffer.from(bytes);
  const centralOffset = centralDirectoryEntryOffset(buffer, path);
  const localOffset = buffer.readUInt32LE(centralOffset + 42);
  buffer.writeUInt32LE(size, centralOffset + 24);
  buffer.writeUInt32LE(size, localOffset + 22);
  return new Uint8Array(buffer);
}

function worksheetWithCells(cells: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
    <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
      <row r="1">${cells}</row>
    </sheetData></worksheet>`;
}

describe("deterministic private file extraction", () => {
  it("indexes a real CSV fixture with bounded row citations", async () => {
    const bytes = await readFile(join(process.cwd(), "src/lib/__fixtures__/rental-revenue.csv"));
    const result = await extractPrivateFile({ bytes, name: "rental-revenue.csv", mimeType: "text/csv" });
    expect(result.status).toBe("ready");
    expect(result.sheetNames).toEqual(["rental-revenue.csv"]);
    expect(result.text).toContain("2645");
    expect(result.chunks[0]).toMatchObject({ ordinal: 0, sheet: "rental-revenue.csv", cellRange: "rows 1-4" });
  });

  it("extracts text and page provenance from a real two-page PDF", async () => {
    // Reproduce the missing filesystem worker path used by serverless bundles.
    // extractPrivateFile must replace it with pdf-parse's inline worker.
    const { PDFParse } = await import("pdf-parse");
    PDFParse.setWorker("file:///app/pdf.worker.mjs");
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    pdf.addPage().drawText("June rental revenue 1840 euros", { x: 40, y: 720, font });
    pdf.addPage().drawText("August rental revenue 2645 euros", { x: 40, y: 720, font });
    const result = await extractPrivateFile({ bytes: await pdf.save(), name: "revenue.pdf", mimeType: "application/pdf" });
    expect(result.pageCount).toBe(2);
    expect(result.text).toContain("August rental revenue 2645 euros");
    expect(new Set(result.chunks.map((chunk) => chunk.page))).toEqual(new Set([1, 2]));
  });

  it("extracts a real DOCX package without an LLM", async () => {
    const result = await extractPrivateFile({
      bytes: await realDocxFixture(),
      name: "contract.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    expect(result.detectedMimeType).toContain("wordprocessingml.document");
    expect(result.text).toContain("Venice to London");
    expect(result.text).toContain("2645 euros");
  });

  it("extracts a real XLSX workbook with sheet and cell provenance without evaluating formulas", async () => {
    const result = await extractPrivateFile({
      bytes: await realXlsxFixture(),
      name: "travel-budget.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    expect(result).toMatchObject({
      status: "ready",
      detectedMimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      sheetNames: ["Booked stay", "Flights"],
    });
    expect(result.text).toContain("Venice");
    expect(result.text).toContain("formula: =SUM(B2:B2)");
    expect(result.chunks).toEqual(expect.arrayContaining([
      expect.objectContaining({ sheet: "Booked stay", cellRange: "A1:B3" }),
      expect.objectContaining({ sheet: "Flights", cellRange: "A1" }),
    ]));
  });

  it("recognizes a verified .xlsx when the browser supplies only a generic ZIP MIME type", async () => {
    const result = await extractPrivateFile({
      bytes: await realXlsxFixture(),
      name: "travel-budget.xlsx",
      mimeType: "application/octet-stream",
    });
    expect(result).toMatchObject({
      status: "ready",
      detectedMimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      sheetNames: ["Booked stay", "Flights"],
    });
  });

  it("rejects forged central-directory sizes before any XLSX entry can inflate", async () => {
    await expect(extractPrivateFile({
      bytes: withForgedCentralUncompressedSize(await realXlsxFixture()),
      name: "forged.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    })).rejects.toMatchObject({ code: "xlsx_archive_invalid", quarantined: true } satisfies Partial<FileExtractionError>);
  });

  it("rejects ZIP64 and archive comments instead of accepting ambiguous OOXML ZIP metadata", async () => {
    await expect(extractPrivateFile({
      bytes: withZip64EntryCount(await realXlsxFixture()),
      name: "zip64.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    })).rejects.toMatchObject({ code: "xlsx_archive_zip64", quarantined: true } satisfies Partial<FileExtractionError>);

    const zip = await JSZip.loadAsync(await realXlsxFixture());
    await expect(extractPrivateFile({
      bytes: await zip.generateAsync({ type: "uint8array", compression: "DEFLATE", comment: "ambiguous archive tail" }),
      name: "commented.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    })).rejects.toMatchObject({ code: "xlsx_directory_missing", quarantined: true } satisfies Partial<FileExtractionError>);
  });

  it("rejects a high-ratio archive entry before any workbook XML is inflated", async () => {
    const zip = await JSZip.loadAsync(await realXlsxFixture());
    zip.file("xl/media/repetitive.bin", "x".repeat(256_000));
    await expect(extractPrivateFile({
      bytes: await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" }),
      name: "ratio.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    })).rejects.toMatchObject({ code: "xlsx_archive_ratio_limit", quarantined: true } satisfies Partial<FileExtractionError>);
  });

  it("stops forged DEFLATE output at the XML ceiling instead of buffering a declared-small payload", async () => {
    const oversizedWorksheet = worksheetWithCells(`<c><v>${"x".repeat(4 * 1024 * 1024 + 1)}</v></c>`);
    await expect(extractPrivateFile({
      bytes: withForgedEntryUncompressedSize(
        await xlsxWithDeflatedWorksheetXml(oversizedWorksheet),
        "xl/worksheets/sheet1.xml",
        1,
      ),
      name: "forged-bomb.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    })).rejects.toMatchObject({ code: "xlsx_xml_size_limit", quarantined: true } satisfies Partial<FileExtractionError>);
  });

  it("charges blank raw cells to the XLSX processing cap before formatting", async () => {
    const result = await extractPrivateFile({
      bytes: await xlsxWithWorksheetXml(worksheetWithCells("<c><v/></c>".repeat(50_001))),
      name: "blank-cells.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    expect(result.summary).toContain("50,000 cells indexed");
    expect(result.summary).toContain("bounded extract");
    expect(result.chunks).toEqual([]);
  });

  it("charges cells omitted by a clipped row to the XLSX processing cap", async () => {
    const result = await extractPrivateFile({
      bytes: await xlsxWithWorksheetXml(worksheetWithCells("<c><v>x</v></c>".repeat(50_001))),
      name: "clipped-cells.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    expect(result.summary).toContain("50,000 cells indexed");
    expect(result.summary).toContain("bounded extract");
    expect(result.chunks[0]?.text).toContain("row 1 cell 1: x");
  });

  it("rejects XML declarations with entities and sheets routed through external relationships", async () => {
    await expect(extractPrivateFile({
      bytes: await xlsxWithWorkbookPart("xl/workbook.xml", `<!DOCTYPE workbook [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
        <workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Unsafe" sheetId="1" r:id="rId1"/></sheets></workbook>`),
      name: "entity.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    })).rejects.toMatchObject({ code: "xlsx_unsafe_xml", quarantined: true } satisfies Partial<FileExtractionError>);

    await expect(extractPrivateFile({
      bytes: await xlsxWithWorkbookPart("xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8"?>
        <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="https://example.test/worksheet.xml" TargetMode="External"/></Relationships>`),
      name: "external.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    })).rejects.toMatchObject({ code: "xlsx_structure_invalid", quarantined: true } satisfies Partial<FileExtractionError>);
  });

  it("decodes and previews a real PNG", async () => {
    const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
    const result = await extractPrivateFile({ bytes, name: "proof.png", mimeType: "image/png" });
    expect(result.summary).toContain("1 × 1");
    expect(result.summary).toContain("ready for visual analysis in chat");
    expect(result.preview?.contentType).toBe("image/webp");
    expect(result.preview?.bytes.byteLength).toBeGreaterThan(0);
  });

  it.each([
    [
      "voice-note.wav",
      "audio/wav",
      Buffer.from("524946462400000057415645666d74201000000001000100401f0000803e0000020010006461746100000000", "hex"),
      "audio",
    ],
    [
      "clip.mp4",
      "video/mp4",
      Buffer.from("000000186674797069736f6d0000020069736f6d69736f3261766331", "hex"),
      "video",
    ],
  ])("admits a verified %s container to secure transcription ingestion", async (name, mimeType, bytes, kind) => {
    const result = await extractPrivateFile({ bytes, name, mimeType });
    expect(result).toMatchObject({
      status: "stored_only",
      text: "",
      chunks: [],
      media: { kind },
    });
    expect(result.summary).toContain("transcription will run during secure ingestion");
  });

  it("quarantines media whose declared container signature does not match", async () => {
    await expect(extractPrivateFile({
      bytes: new TextEncoder().encode("not a video"),
      name: "fake.mp4",
      mimeType: "video/mp4",
    })).rejects.toMatchObject({ code: "media_signature_mismatch", quarantined: true } satisfies Partial<FileExtractionError>);
  });

  it("quarantines declared formats whose signatures do not match", async () => {
    await expect(extractPrivateFile({
      bytes: new TextEncoder().encode("not a pdf"),
      name: "fake.pdf",
      mimeType: "application/pdf",
    })).rejects.toMatchObject({ code: "pdf_signature_mismatch", quarantined: true } satisfies Partial<FileExtractionError>);
  });

  it("fails closed when a declared XLSX is a ZIP without required workbook parts", async () => {
    const zip = new JSZip();
    zip.file("unrelated.txt", "not a workbook");
    await expect(extractPrivateFile({
      bytes: await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" }),
      name: "fake.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    })).rejects.toMatchObject({ code: "xlsx_structure_invalid", quarantined: true } satisfies Partial<FileExtractionError>);
  });
});
