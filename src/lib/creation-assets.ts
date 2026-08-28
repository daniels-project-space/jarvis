import "server-only";

import { randomUUID } from "node:crypto";

import { normalizeUploadMime } from "./chat-files";
import { privateCreationObjectKey, privateR2Delete, privateR2Put, type PrivateCreationObjectPurpose } from "./private-r2";
export { creationMediaUrl, type CreationMediaVariant } from "./creation-media-url";

const MAX_CREATION_ASSET_BYTES = 30 * 1024 * 1024;

export type PrivateCreationAsset = Readonly<{
  key: string;
  contentType: string;
}>;

export type CreationAssetBody = Uint8Array | ArrayBuffer | string;

// The shared creation-record fence supplies this immediately before the R2
// PUT—not before any provider download or rendering work—so Convex can fence
// creation metadata if the writer loses its bounded lease.
export type PrivateCreationAssetWriteFence = Readonly<{
  beforeR2Write?: () => Promise<void>;
}>;

function bodySizeBytes(body: CreationAssetBody): number {
  if (typeof body === "string") return Buffer.byteLength(body, "utf8");
  return body.byteLength;
}

function assertAssetSize(body: CreationAssetBody): void {
  if (bodySizeBytes(body) > MAX_CREATION_ASSET_BYTES) {
    throw new Error("creation asset too large (30MB cap)");
  }
}

async function readResponseBodyWithinAssetLimit(response: Response): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  // Fetch normally supplies a stream. Keep the legacy empty-body behaviour
  // rather than falling back to arrayBuffer(), which would remove the bound.
  if (!reader) return new Uint8Array();

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      if (value.byteLength > MAX_CREATION_ASSET_BYTES - totalBytes) {
        throw new Error("creation asset too large (30MB cap)");
      }
      chunks.push(value);
      totalBytes += value.byteLength;
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function externalHttpUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("creation asset source must be a valid HTTP(S) URL");
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
    throw new Error("creation asset source must be a credential-free HTTP(S) URL");
  }
  return url;
}

// The key is opaque and carries no title, filename, provider URL, or other
// user-visible metadata. The creation row holds that metadata separately.
export async function putPrivateCreationAsset(
  body: CreationAssetBody,
  contentType: string,
  purpose: PrivateCreationObjectPurpose = "asset",
  assetId: string = randomUUID(),
  fence?: PrivateCreationAssetWriteFence,
): Promise<PrivateCreationAsset> {
  assertAssetSize(body);
  const key = privateCreationObjectKey(assetId, purpose);
  const normalizedContentType = normalizeUploadMime(contentType);
  await fence?.beforeR2Write?.();
  await privateR2Put(key, body, normalizedContentType);
  return { key, contentType: normalizedContentType };
}

// Re-home short-lived provider results before their URL can expire. The caller
// persists only the returned private key; the source URL is never copied into
// the asset record or object name.
export async function storePrivateCreationAssetFromUrl(
  sourceUrl: string,
  purpose: PrivateCreationObjectPurpose = "asset",
  assetId: string = randomUUID(),
  fence?: PrivateCreationAssetWriteFence,
): Promise<PrivateCreationAsset> {
  const source = externalHttpUrl(sourceUrl);
  // Do not follow a provider-controlled redirect into an unexpected network
  // location. Callers can supply the final asset URL if a provider
  // redirects a page rather than an image.
  const response = await fetch(source, { cache: "no-store", redirect: "error" });
  if (!response.ok) throw new Error(`creation asset source fetch failed: ${response.status}`);
  const declaredLength = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_CREATION_ASSET_BYTES) {
    throw new Error("creation asset too large (30MB cap)");
  }
  const bytes = await readResponseBodyWithinAssetLimit(response);
  return await putPrivateCreationAsset(
    bytes,
    response.headers.get("content-type") ?? "application/octet-stream",
    purpose,
    assetId,
    fence,
  );
}

export async function deletePrivateCreationAsset(asset: PrivateCreationAsset | string): Promise<void> {
  const key = typeof asset === "string" ? asset : asset.key;
  await privateR2Delete(key);
}
