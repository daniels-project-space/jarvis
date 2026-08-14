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

type CreationAssetBody = Uint8Array | ArrayBuffer | string;

function bodySizeBytes(body: CreationAssetBody): number {
  if (typeof body === "string") return Buffer.byteLength(body, "utf8");
  return body.byteLength;
}

function assertAssetSize(body: CreationAssetBody): void {
  if (bodySizeBytes(body) > MAX_CREATION_ASSET_BYTES) {
    throw new Error("creation asset too large (30MB cap)");
  }
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
): Promise<PrivateCreationAsset> {
  assertAssetSize(body);
  const key = privateCreationObjectKey(randomUUID(), purpose);
  const normalizedContentType = normalizeUploadMime(contentType);
  await privateR2Put(key, body, normalizedContentType);
  return { key, contentType: normalizedContentType };
}

// Re-home short-lived provider results before their URL can expire. The caller
// persists only the returned private key; the source URL is never copied into
// the asset record or object name.
export async function storePrivateCreationAssetFromUrl(
  sourceUrl: string,
  purpose: PrivateCreationObjectPurpose = "asset",
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
  const bytes = await response.arrayBuffer();
  return await putPrivateCreationAsset(bytes, response.headers.get("content-type") ?? "application/octet-stream", purpose);
}

export async function deletePrivateCreationAsset(asset: PrivateCreationAsset | string): Promise<void> {
  const key = typeof asset === "string" ? asset : asset.key;
  await privateR2Delete(key);
}
