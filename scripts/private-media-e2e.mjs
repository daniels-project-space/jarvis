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

const video = await generatedVideo();
const videoResult = await uploadAndVerify({
  name: "jarvis-private-proof.mp4",
  relativePath: "e2e/jarvis-private-proof.mp4",
  mimeType: "video/mp4",
  bytes: video,
  assertManifest: (file) => {
    if (file?.status !== "ready" || !/representative frame ready for visual analysis in chat/i.test(String(file.summary ?? ""))) {
      throw new Error(`Video did not reach visual-ready ingestion: ${JSON.stringify({ status: file?.status, summary: file?.summary, errorCode: file?.errorCode })}`);
    }
  },
});

console.log(JSON.stringify({ ok: true, text: textResult, video: videoResult }));
