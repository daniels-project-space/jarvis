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
      "Audio saved privately · no transcript is available, so Jarvis cannot inspect its contents.",
    ],
    [
      "clip.mp4",
      "video/mp4",
      Buffer.from("000000186674797069736f6d0000020069736f6d69736f3261766331", "hex"),
      "Video saved privately · no transcript or frame analysis is available, so Jarvis cannot inspect its contents.",
    ],
  ])("keeps %s available while making media-analysis limits explicit", async (name, mimeType, bytes, summary) => {
    const result = await extractPrivateFile({ bytes, name, mimeType });
    expect(result).toMatchObject({ status: "stored_only", summary, text: "", chunks: [] });
  });

  it("quarantines declared formats whose signatures do not match", async () => {
    await expect(extractPrivateFile({
      bytes: new TextEncoder().encode("not a pdf"),
      name: "fake.pdf",
      mimeType: "application/pdf",
    })).rejects.toMatchObject({ code: "pdf_signature_mismatch", quarantined: true } satisfies Partial<FileExtractionError>);
  });
});
