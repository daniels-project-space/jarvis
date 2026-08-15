#!/usr/bin/env node
// Explicit production proof for private uploads. It stores only generated,
// non-sensitive fixtures and always removes their private R2/Convex records.
//
//   npm run test:e2e:media
//   BASE=https://... CONVEX=https://... npm run test:e2e:media

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import JSZip from "jszip";

const execFileAsync = promisify(execFile);
const BASE = process.env.BASE ?? "https://jarvis-orcin-six.vercel.app";
const CONVEX = (process.env.CONVEX ?? "https://tangible-goose-318.convex.cloud") + "/api";
const INGEST_TIMEOUT_MS = 105_000;

let viewerToken = "";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function json(response) {
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(body).slice(0, 280)}`);
  return body;
}

async function convexQuery(path, args) {
  const response = await fetch(`${CONVEX}/query`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${viewerToken}` },
    body: JSON.stringify({ path, args, format: "json" }),
  });
  const body = await json(response);
  if (body.status === "error") throw new Error(`Convex ${path}: ${String(body.errorMessage ?? "failed")}`);
  return body.value;
}

async function authenticate() {
  const payload = await json(await fetch(`${BASE}/api/auth/viewer`, {
    method: "POST",
    headers: { origin: BASE, "x-jarvis-embed": "1" },
  }));
  viewerToken = String(payload.viewerToken ?? "");
  if (!viewerToken) throw new Error("Viewer bootstrap returned no token");
}

async function removePrivateFile(fileId) {
  const response = await fetch(`${BASE}/api/files/${encodeURIComponent(fileId)}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${viewerToken}`, origin: BASE },
  });
  const body = await json(response);
  return body;
}

async function waitForIngest(fileId) {
  const deadline = Date.now() + INGEST_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const file = await convexQuery("files:get", { fileId });
    if (["ready", "stored_only", "error", "quarantined"].includes(file?.status)) return file;
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  throw new Error("Timed out waiting for private-file ingestion");
}

async function uploadAndVerify({ name, relativePath, mimeType, bytes, assertManifest }) {
  const requestId = `private-media-e2e-${randomUUID()}`;
  const threadId = `private-media-e2e-${randomUUID()}`;
  let fileId = "";
  try {
    const reservation = await json(await fetch(`${BASE}/api/files/upload-session`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${viewerToken}`,
        origin: BASE,
      },
      body: JSON.stringify({
        requestId,
        threadId,
        files: [{
          clientId: randomUUID(),
          name,
          relativePath,
          mimeType,
          sizeBytes: bytes.byteLength,
          sha256: sha256(bytes),
        }],
      }),
    }));
    const reserved = reservation.files?.[0];
    fileId = String(reserved?.fileId ?? "");
    if (!fileId || !reserved?.uploadUrl) throw new Error("Upload reservation was malformed");

    const uploaded = await json(await fetch(`${BASE}${reserved.uploadUrl}`, {
      method: "PUT",
      headers: {
        "content-type": mimeType,
        authorization: `Bearer ${viewerToken}`,
        origin: BASE,
        "x-jarvis-sha256": sha256(bytes),
      },
      body: bytes,
    }));
    if (uploaded.status !== "uploaded") throw new Error(`Unexpected upload state: ${JSON.stringify(uploaded)}`);

    const manifest = await waitForIngest(fileId);
    assertManifest(manifest);

    const download = await fetch(`${BASE}/api/files/${encodeURIComponent(fileId)}`, {
      headers: { authorization: `Bearer ${viewerToken}` },
    });
    const returned = Buffer.from(await download.arrayBuffer());
    if (download.status !== 200 || !returned.equals(bytes)) {
      throw new Error(`Protected file download mismatch (${download.status})`);
    }

    const deleted = await removePrivateFile(fileId);
    fileId = "";
    return { bytes: bytes.byteLength, status: manifest.status, extractedChars: manifest.extractedChars, delete: deleted.ok === true ? "deleted" : "cleanup-queued" };
  } finally {
    if (fileId) await removePrivateFile(fileId).catch(() => undefined);
  }
}

async function generatedVideo() {
  const directory = await mkdtemp(join(tmpdir(), "jarvis-private-media-e2e-"));
  const path = join(directory, "proof.mp4");
  try {
    await execFileAsync("ffmpeg", [
      "-loglevel", "error",
      "-f", "lavfi",
      "-i", "color=c=0x174a68:s=160x90:d=1",
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-y",
      path,
    ]);
    return await readFile(path);
  } finally {
    await unlink(path).catch(() => undefined);
    await rmdir(directory).catch(() => undefined);
  }
}

async function generatedXlsx() {
  // Keep this fixture completely synthetic: the assertions below prove that
  // production ingest preserves both sheet names and the exact indexed cell
  // count without sending any user document through the system.
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
        <sheet name="Sample plan" sheetId="1" r:id="rId1"/>
        <sheet name="Sample transit" sheetId="2" r:id="rId2"/>
      </sheets>
    </workbook>`);
  zip.file("xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
      <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
    </Relationships>`);
  zip.file("xl/sharedStrings.xml", `<?xml version="1.0" encoding="UTF-8"?>
    <sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="3" uniqueCount="3">
      <si><t>Category</t></si><si><t>Value</t></si><si><t>Demo</t></si>
    </sst>`);
  zip.file("xl/worksheets/sheet1.xml", `<?xml version="1.0" encoding="UTF-8"?>
    <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
      <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
      <row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>42</v></c></row>
      <row r="3"><c r="A3" t="b"><v>1</v></c><c r="B3"><f>SUM(B2:B2)</f><v>42</v></c></row>
    </sheetData></worksheet>`);
  zip.file("xl/worksheets/sheet2.xml", `<?xml version="1.0" encoding="UTF-8"?>
    <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
      <row r="1"><c r="A1" t="inlineStr"><is><t>Connection at 10:30</t></is></c></row>
    </sheetData></worksheet>`);
  return await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

await authenticate();

const text = Buffer.from(
  `Jarvis private-file E2E proof ${new Date().toISOString()}\nThis generated text is removed after ingestion.`,
  "utf8",
);
const textResult = await uploadAndVerify({
  name: "jarvis-private-proof.txt",
  relativePath: "e2e/jarvis-private-proof.txt",
  mimeType: "text/plain",
  bytes: text,
  assertManifest: (file) => {
    if (file?.status !== "ready" || !Number(file.extractedChars) || !/^Text · \d+ characters indexed$/.test(String(file.summary ?? ""))) {
      throw new Error(`Text ingestion was not safely indexed: ${JSON.stringify({ status: file?.status, summary: file?.summary })}`);
    }
  },
});

const xlsx = await generatedXlsx();
const xlsxResult = await uploadAndVerify({
  name: "jarvis-private-proof.xlsx",
  relativePath: "e2e/jarvis-private-proof.xlsx",
  mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  bytes: xlsx,
  assertManifest: (file) => {
    const expectedSheets = ["Sample plan", "Sample transit"];
    if (
      file?.status !== "ready"
      || file?.summary !== "Excel workbook · 2 sheets · 7 cells indexed"
      || JSON.stringify(file?.sheetNames) !== JSON.stringify(expectedSheets)
      || file?.chunkCount !== 2
      || !Number(file?.extractedChars)
    ) {
      throw new Error(`XLSX did not preserve synthetic sheet/cell context: ${JSON.stringify({
        status: file?.status,
        summary: file?.summary,
        sheetNames: file?.sheetNames,
        chunkCount: file?.chunkCount,
        extractedChars: file?.extractedChars,
        errorCode: file?.errorCode,
      })}`);
    }
  },
});

const video = await generatedVideo();
const videoResult = await uploadAndVerify({
  name: "jarvis-private-proof.mp4",
  relativePath: "e2e/jarvis-private-proof.mp4",
  mimeType: "video/mp4",
  bytes: video,
  assertManifest: (file) => {
    if (file?.status !== "ready" || !/(?:representative frame|\d+ timestamped frames) ready for visual analysis in chat/i.test(String(file.summary ?? ""))) {
      throw new Error(`Video did not reach visual-ready ingestion: ${JSON.stringify({ status: file?.status, summary: file?.summary, errorCode: file?.errorCode })}`);
    }
  },
});

console.log(JSON.stringify({ ok: true, text: textResult, xlsx: xlsxResult, video: videoResult }));
