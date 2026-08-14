import "server-only";
import { AwsClient } from "aws4fetch";
import { getServiceSecrets } from "./vault";

// Deprecated legacy public artifact storage. Existing creations can still
// reference this bucket, but all new images, PDFs, exports, and captures must
// use the private R2 helpers in `private-r2.ts` / `creation-assets.ts`.

const BUCKET = "jarvis";
const PUBLIC_BASE = "https://pub-901f8094a6f04b32a784dc06cf3ebbc3.r2.dev";

let cached: { aws: AwsClient; endpoint: string } | null = null;

async function client(): Promise<{ aws: AwsClient; endpoint: string }> {
  if (cached) return cached;
  const cf = await getServiceSecrets("cloudflare");
  if (!cf.R2_ACCESS_KEY_ID || !cf.R2_SECRET_ACCESS_KEY || !cf.R2_ENDPOINT)
    throw new Error("R2 credentials missing from vault (cloudflare service)");
  cached = {
    aws: new AwsClient({
      accessKeyId: cf.R2_ACCESS_KEY_ID,
      secretAccessKey: cf.R2_SECRET_ACCESS_KEY,
      service: "s3",
      region: "auto",
    }),
    endpoint: cf.R2_ENDPOINT.replace(/\/$/, ""),
  };
  return cached;
}

const slug = (s: string) =>
  String(s || "file")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48) || "file";

// Upload bytes and return the permanent public URL.
export async function r2Put(name: string, body: Uint8Array | ArrayBuffer | string, contentType: string): Promise<string> {
  const { aws, endpoint } = await client();
  const ext = contentType.includes("png")
    ? "png"
    : contentType.includes("webp")
      ? "webp"
      : contentType.includes("jpeg")
        ? "jpg"
        : contentType.includes("svg")
          ? "svg"
        : contentType.includes("pdf")
          ? "pdf"
          : contentType.includes("json")
            ? "json"
            : "bin";
  const key = `creations/${new Date().toISOString().slice(0, 7)}/${slug(name)}-${Date.now().toString(36)}.${ext}`;
  const payload = typeof body === "string" ? new TextEncoder().encode(body) : body instanceof ArrayBuffer ? new Uint8Array(body) : body;
  // Vercel's fetch streams buffered bodies chunked (no Content-Length) and R2
  // answers 411 — set the length explicitly.
  const r = await aws.fetch(`${endpoint}/${BUCKET}/${key}`, {
    method: "PUT",
    headers: { "content-type": contentType, "content-length": String(payload.byteLength) },
    body: payload as unknown as BodyInit,
  });
  if (!r.ok) throw new Error(`R2 upload failed: ${r.status} ${(await r.text()).slice(0, 150)}`);
  return `${PUBLIC_BASE}/${key}`;
}

// Only used to compensate for a failed durable-record write immediately after
// this process created an object. Keeping the URL → key conversion narrow
// prevents a caller from turning this into a general bucket-delete primitive.
export async function r2DeleteFreshCreation(url: string): Promise<void> {
  const prefix = `${PUBLIC_BASE}/creations/`;
  if (!url.startsWith(prefix)) throw new Error("refusing to delete a non-Jarvis creation object");
  const key = url.slice(`${PUBLIC_BASE}/`.length);
  if (!key || key.includes("..") || /[?#]/.test(key)) throw new Error("invalid Jarvis creation object key");
  const { aws, endpoint } = await client();
  const response = await aws.fetch(`${endpoint}/${BUCKET}/${key}`, { method: "DELETE" });
  if (!response.ok && response.status !== 404) {
    throw new Error(`R2 cleanup failed: ${response.status} ${(await response.text()).slice(0, 150)}`);
  }
}

// Fetch a remote image (e.g. a Novita result before its 48h TTL runs out) and
// re-home it permanently in R2.
export async function r2StoreFromUrl(name: string, url: string): Promise<{ url: string; contentType: string }> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`source fetch failed: ${r.status}`);
  const contentType = r.headers.get("content-type") ?? "image/png";
  const buf = await r.arrayBuffer();
  if (buf.byteLength > 30 * 1024 * 1024) throw new Error("file too large (30MB cap)");
  return { url: await r2Put(name, buf, contentType), contentType };
}
