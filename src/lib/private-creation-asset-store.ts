import "server-only";

import { createHash } from "node:crypto";
import { AwsClient } from "aws4fetch";

import { normalizeUploadMime, normalizeUploadSha256 } from "./chat-files";
import {
  assertPrivateR2Configured,
  privateCreationObjectKey,
  privateR2Delete,
  privateR2Get,
  privateR2Put,
  type PrivateCreationObjectPurpose,
} from "./private-r2";
import {
  getPrivateCreationAssetV2VaultSecrets,
  privateCreationAssetV2VaultFailureStage,
  type PrivateCreationAssetV2VaultFailureStage,
} from "./private-creation-asset-v2-vault";

export { PRIVATE_CREATION_ASSET_V2_VAULT_SERVICE } from "./private-creation-asset-v2-vault";

// These names are deliberately not aliases for the generic private-file
// store. A V2 locator is valid only in the dedicated V2 bucket and its own
// vault service. That keeps a missing or miswired V2 capability fail-closed
// instead of quietly reading or writing the legacy bucket.
export const PRIVATE_CREATION_ASSET_STORE_V1 = "private-r2-v1" as const;
export const PRIVATE_CREATION_ASSET_STORE_V2 = "private-r2-v2" as const;
export const PRIVATE_CREATION_ASSET_V2_BUCKET = "jarvis-private-creation-assets-v2";
export const PRIVATE_CREATION_ASSET_STORE_ENV = "JARVIS_PRIVATE_CREATION_ASSET_STORE";
export const PRIVATE_CREATION_ASSET_V2_BUCKET_ENV = "JARVIS_PRIVATE_R2_V2_BUCKET";
export const PRIVATE_CREATION_ASSET_V2_ENDPOINT_ENV = "JARVIS_PRIVATE_R2_V2_ENDPOINT";

export type PrivateCreationAssetStore =
  | typeof PRIVATE_CREATION_ASSET_STORE_V1
  | typeof PRIVATE_CREATION_ASSET_STORE_V2;

export type PrivateCreationAssetLocator = Readonly<{
  assetStore: PrivateCreationAssetStore;
  assetLocator: string;
}>;

type PrivateCreationAssetV2Client = {
  aws: AwsClient;
  endpoint: string;
  bucket: string;
};

export type PrivateCreationAssetStoreConfigurationCode =
  | "store_invalid"
  | "v2_bucket_missing"
  | "v2_bucket_mismatch"
  | "v2_endpoint_missing"
  | "v2_endpoint_invalid"
  | "v2_endpoint_mismatch"
  | "v2_vault_unavailable"
  | `v2_vault_${PrivateCreationAssetV2VaultFailureStage}`
  | "v2_credentials_unavailable"
  | "unknown";

export class PrivateCreationAssetStoreConfigurationError extends Error {
  constructor(
    readonly code: Exclude<PrivateCreationAssetStoreConfigurationCode, "unknown">,
    message: string,
  ) {
    super(message);
    this.name = "PrivateCreationAssetStoreConfigurationError";
  }
}

const UUID_SOURCE = "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const V1_CREATION_LOCATOR = new RegExp(`^owners/daniel/creations/${UUID_SOURCE}/(?:asset|thumb)$`, "i");
// The migration lane has a namespace that V1 can never produce. It intentionally
// accepts only an opaque Convex id component, never an arbitrary caller path.
const V2_LIVE_LOCATOR = new RegExp(`^owners/daniel/creation-assets-v2/live/${UUID_SOURCE}/(?:asset|thumb)$`, "i");
const V2_MIGRATION_LOCATOR = /^owners\/daniel\/creation-assets-v2\/migration\/[1-9][0-9]{0,8}\/[A-Za-z0-9_-]{8,160}\/generation\/[1-9][0-9]{0,8}\/(?:asset|thumb)$/;
const V2_PROBE_LOCATOR = /^owners\/daniel\/creation-assets-v2\/probe\/[A-Za-z0-9_-]{8,160}\/capability$/;
const OPAQUE_V2_MIGRATION_ID = /^[A-Za-z0-9_-]{8,160}$/;
const V2_R2_ENDPOINT = /^https:\/\/[a-f0-9]{32}\.r2\.cloudflarestorage\.com\/?$/i;
const CAPABILITY_PROBE_MAX_BYTES = 4 * 1024;

let v2Cached: PrivateCreationAssetV2Client | null = null;

export function isPrivateCreationAssetStore(value: unknown): value is PrivateCreationAssetStore {
  return value === PRIVATE_CREATION_ASSET_STORE_V1 || value === PRIVATE_CREATION_ASSET_STORE_V2;
}

export function privateCreationAssetStoreConfigurationCode(error: unknown): PrivateCreationAssetStoreConfigurationCode {
  return error instanceof PrivateCreationAssetStoreConfigurationError ? error.code : "unknown";
}

export function activePrivateCreationAssetStore(
  env: Record<string, string | undefined> = process.env,
): PrivateCreationAssetStore {
  const configured = env[PRIVATE_CREATION_ASSET_STORE_ENV]?.trim();
  // Existing production stays on V1 until the controlled cutover explicitly
  // sets the V2 selector. Absence is backwards compatibility, not a V2
  // fallback: a row whose locator says V2 can never be read through this path.
  if (!configured || configured === PRIVATE_CREATION_ASSET_STORE_V1) {
    return PRIVATE_CREATION_ASSET_STORE_V1;
  }
  if (configured === PRIVATE_CREATION_ASSET_STORE_V2) return PRIVATE_CREATION_ASSET_STORE_V2;
  throw new PrivateCreationAssetStoreConfigurationError(
    "store_invalid",
    `${PRIVATE_CREATION_ASSET_STORE_ENV} must select a known private creation asset store`,
  );
}

function cleanUuid(value: string): string {
  const id = String(value).trim().toLowerCase();
  if (!new RegExp(`^${UUID_SOURCE}$`, "i").test(id)) {
    throw new Error("invalid private creation asset identity");
  }
  return id;
}

function cleanMigrationObjectId(value: string): string {
  const id = String(value).trim();
  if (!OPAQUE_V2_MIGRATION_ID.test(id)) {
    throw new Error("invalid private creation migration object identity");
  }
  return id;
}

export function privateCreationAssetLocatorForWrite(
  assetStore: PrivateCreationAssetStore,
  assetId: string,
  purpose: PrivateCreationObjectPurpose = "asset",
): PrivateCreationAssetLocator {
  if (purpose !== "asset" && purpose !== "thumb") throw new Error("invalid private creation object purpose");
  if (assetStore === PRIVATE_CREATION_ASSET_STORE_V1) {
    return { assetStore, assetLocator: privateCreationObjectKey(assetId, purpose) };
  }
  const id = cleanUuid(assetId);
  return { assetStore, assetLocator: `owners/daniel/creation-assets-v2/live/${id}/${purpose}` };
}

// Migration object names are derived only from a server-issued creation id
// stored in the manifest. They are deliberately in a separate grammar from
// both V1 and new V2 writes, so a delayed V1 operation cannot target them.
export function privateCreationAssetLocatorForMigration(
  creationId: string,
  attempt = 1,
  generation = 1,
  purpose: PrivateCreationObjectPurpose = "asset",
): PrivateCreationAssetLocator {
  if (purpose !== "asset" && purpose !== "thumb") throw new Error("invalid private creation object purpose");
  const id = cleanMigrationObjectId(creationId);
  if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > 999_999_999) {
    throw new Error("invalid private creation migration attempt");
  }
  if (!Number.isSafeInteger(generation) || generation < 1 || generation > 999_999_999) {
    throw new Error("invalid private creation migration generation");
  }
  return {
    assetStore: PRIVATE_CREATION_ASSET_STORE_V2,
    assetLocator: `owners/daniel/creation-assets-v2/migration/${attempt}/${id}/generation/${generation}/${purpose}`,
  };
}

// This is intentionally neither a live creation key nor a migration-copy
// key. It exists only long enough for Vercel and Trigger to prove they each
// have the selected isolated-V2 vault/bucket capability before V1 freezes.
export function privateCreationAssetLocatorForCapabilityProbe(proofId: string): PrivateCreationAssetLocator {
  const id = cleanMigrationObjectId(proofId);
  return {
    assetStore: PRIVATE_CREATION_ASSET_STORE_V2,
    assetLocator: `owners/daniel/creation-assets-v2/probe/${id}/capability`,
  };
}

export function isPrivateCreationAssetLocator(value: unknown): value is PrivateCreationAssetLocator {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as { assetStore?: unknown; assetLocator?: unknown };
  if (!isPrivateCreationAssetStore(record.assetStore) || typeof record.assetLocator !== "string") return false;
  const locator = record.assetLocator;
  return record.assetStore === PRIVATE_CREATION_ASSET_STORE_V1
    ? V1_CREATION_LOCATOR.test(locator)
    : V2_LIVE_LOCATOR.test(locator) || V2_MIGRATION_LOCATOR.test(locator) || V2_PROBE_LOCATOR.test(locator);
}

export function requirePrivateCreationAssetLocator(value: PrivateCreationAssetLocator): PrivateCreationAssetLocator {
  if (!isPrivateCreationAssetLocator(value)) throw new Error("invalid private creation asset locator");
  return { assetStore: value.assetStore, assetLocator: value.assetLocator };
}

function encodedLocator(locator: PrivateCreationAssetLocator): string {
  return requirePrivateCreationAssetLocator(locator).assetLocator.split("/").map(encodeURIComponent).join("/");
}

function assertV2BucketName(value: string | undefined): string {
  const bucket = value?.trim();
  if (!bucket) {
    throw new PrivateCreationAssetStoreConfigurationError(
      "v2_bucket_missing",
      `${PRIVATE_CREATION_ASSET_V2_BUCKET_ENV} is not configured`,
    );
  }
  if (bucket !== PRIVATE_CREATION_ASSET_V2_BUCKET) {
    throw new PrivateCreationAssetStoreConfigurationError(
      "v2_bucket_mismatch",
      `${PRIVATE_CREATION_ASSET_V2_BUCKET_ENV} must be ${PRIVATE_CREATION_ASSET_V2_BUCKET}`,
    );
  }
  return bucket;
}

function cleanV2R2Endpoint(value: string | undefined, code: "v2_endpoint_missing" | "v2_endpoint_invalid"): string {
  const raw = value?.trim();
  if (!raw) {
    throw new PrivateCreationAssetStoreConfigurationError(
      code,
      code === "v2_endpoint_missing"
        ? `${PRIVATE_CREATION_ASSET_V2_ENDPOINT_ENV} is not configured`
        : "private creation V2 R2 endpoint is invalid",
    );
  }
  // Inspect the un-normalized input first. URL normalizes an explicit :443
  // away, which would otherwise accidentally admit a port despite the V2
  // endpoint pin requiring an origin-only Cloudflare R2 hostname.
  if (!V2_R2_ENDPOINT.test(raw)) {
    throw new PrivateCreationAssetStoreConfigurationError(code, "private creation V2 R2 endpoint is invalid");
  }
  let endpoint: URL;
  try {
    endpoint = new URL(raw);
  } catch {
    throw new PrivateCreationAssetStoreConfigurationError(code, "private creation V2 R2 endpoint is invalid");
  }
  return endpoint.origin;
}

async function v2Client(): Promise<PrivateCreationAssetV2Client> {
  if (v2Cached) return v2Cached;
  const bucket = assertV2BucketName(process.env[PRIVATE_CREATION_ASSET_V2_BUCKET_ENV]);
  const expectedEndpoint = cleanV2R2Endpoint(
    process.env[PRIVATE_CREATION_ASSET_V2_ENDPOINT_ENV],
    "v2_endpoint_missing",
  );
  const secrets = await getPrivateCreationAssetV2VaultSecrets().catch((error) => {
    const stage = privateCreationAssetV2VaultFailureStage(error);
    throw new PrivateCreationAssetStoreConfigurationError(
      stage === "unknown" ? "v2_vault_unavailable" : `v2_vault_${stage}`,
      "private creation V2 vault capability is unavailable",
    );
  });
  if (!secrets.R2_ACCESS_KEY_ID || !secrets.R2_SECRET_ACCESS_KEY || !secrets.R2_ENDPOINT) {
    throw new PrivateCreationAssetStoreConfigurationError(
      "v2_credentials_unavailable",
      "private creation V2 R2 credentials are unavailable",
    );
  }
  const endpoint = cleanV2R2Endpoint(secrets.R2_ENDPOINT, "v2_endpoint_invalid");
  if (endpoint !== expectedEndpoint) {
    throw new PrivateCreationAssetStoreConfigurationError(
      "v2_endpoint_mismatch",
      "private creation V2 vault endpoint does not match the pinned V2 R2 endpoint",
    );
  }
  v2Cached = {
    aws: new AwsClient({
      accessKeyId: secrets.R2_ACCESS_KEY_ID,
      secretAccessKey: secrets.R2_SECRET_ACCESS_KEY,
      sessionToken: secrets.R2_SESSION_TOKEN || undefined,
      service: "s3",
      region: "auto",
      retries: 2,
    }),
    endpoint,
    bucket,
  };
  return v2Cached;
}

async function v2ObjectUrl(locator: PrivateCreationAssetLocator): Promise<string> {
  const config = await v2Client();
  return `${config.endpoint}/${config.bucket}/${encodedLocator(locator)}`;
}

async function v2Get(locator: PrivateCreationAssetLocator, range?: string, signal?: AbortSignal): Promise<Response> {
  const config = await v2Client();
  const headers = new Headers();
  if (range) {
    if (!/^bytes=\d*-\d*$/.test(range) || range.length > 80) throw new Error("invalid byte range");
    headers.set("range", range);
  }
  return await config.aws.fetch(await v2ObjectUrl(locator), {
    method: "GET",
    headers,
    cache: "no-store",
    signal,
  });
}

async function v2Put(
  locator: PrivateCreationAssetLocator,
  body: Uint8Array | ArrayBuffer | string,
  contentType: string,
  metadata?: { sha256?: string },
): Promise<{ etag?: string }> {
  const config = await v2Client();
  const payload = typeof body === "string"
    ? new TextEncoder().encode(body)
    : body instanceof ArrayBuffer
      ? new Uint8Array(body)
      : body;
  const headers: Record<string, string> = {
    "content-type": normalizeUploadMime(contentType),
    "content-length": String(payload.byteLength),
    "cache-control": "private, no-store, max-age=0",
  };
  if (metadata?.sha256 !== undefined) {
    const sha256 = normalizeUploadSha256(metadata.sha256);
    if (!sha256) throw new Error("invalid private R2 content digest metadata");
    headers["x-amz-meta-sha256"] = sha256;
  }
  const response = await config.aws.fetch(await v2ObjectUrl(locator), {
    method: "PUT",
    headers,
    body: payload as unknown as BodyInit,
  });
  if (!response.ok) throw new Error(`private creation V2 R2 PUT failed (${response.status})`);
  return { etag: response.headers.get("etag")?.replace(/^\"|\"$/g, "") || undefined };
}

async function v2Delete(locator: PrivateCreationAssetLocator): Promise<void> {
  const config = await v2Client();
  const response = await config.aws.fetch(await v2ObjectUrl(locator), { method: "DELETE" });
  if (!response.ok && response.status !== 404) throw new Error(`private creation V2 R2 DELETE failed (${response.status})`);
}

export async function assertPrivateCreationAssetStoreConfigured(assetStore: PrivateCreationAssetStore): Promise<void> {
  if (assetStore === PRIVATE_CREATION_ASSET_STORE_V1) {
    // Calling the V1 primitive is deliberately the only legal V1 route.
    // It performs its established dedicated-bucket/vault checks without a
    // storage probe. Do not turn a V2 capability check into a V1 fallback.
    await assertPrivateR2Configured();
    return;
  }
  await v2Client();
}

async function readCapabilityProbe(response: Response): Promise<Uint8Array> {
  if (!response.ok || !response.body) throw new Error(`private creation V2 capability read failed (${response.status})`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      if (value.byteLength > CAPABILITY_PROBE_MAX_BYTES - total) throw new Error("private creation V2 capability response is too large");
      chunks.push(value);
      total += value.byteLength;
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export type PrivateCreationAssetCapabilityResult = Readonly<{ sha256: string; sizeBytes: number }>;

// This proof exercises the exact selected V2 client rather than merely
// constructing credentials: PUT, full GET/readback SHA, then DELETE of a
// server-issued isolated probe key. It has no V1 branch or fallback.
export async function provePrivateCreationAssetV2Capability(
  proofId: string,
  dependencies: {
    activeStore?: typeof activePrivateCreationAssetStore;
    assertStore?: typeof assertPrivateCreationAssetStoreConfigured;
    get?: typeof privateCreationAssetGet;
    put?: typeof privateCreationAssetPut;
    remove?: typeof privateCreationAssetDelete;
  } = {},
): Promise<PrivateCreationAssetCapabilityResult> {
  const activeStore = dependencies.activeStore ?? activePrivateCreationAssetStore;
  const assertStore = dependencies.assertStore ?? assertPrivateCreationAssetStoreConfigured;
  const get = dependencies.get ?? privateCreationAssetGet;
  const put = dependencies.put ?? privateCreationAssetPut;
  const remove = dependencies.remove ?? privateCreationAssetDelete;
  if (activeStore() !== PRIVATE_CREATION_ASSET_STORE_V2) {
    throw new PrivateCreationAssetStoreConfigurationError(
      "store_invalid",
      `${PRIVATE_CREATION_ASSET_STORE_ENV} must select ${PRIVATE_CREATION_ASSET_STORE_V2} for the migration capability proof`,
    );
  }
  const locator = privateCreationAssetLocatorForCapabilityProbe(proofId);
  const bytes = new TextEncoder().encode(`jarvis-private-creation-v2-capability:${proofId}`);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  let wrote = false;
  try {
    await assertStore(PRIVATE_CREATION_ASSET_STORE_V2);
    await put(locator, bytes, "application/octet-stream", { sha256 });
    wrote = true;
    const readback = await readCapabilityProbe(await get(locator));
    const readbackSha256 = createHash("sha256").update(readback).digest("hex");
    if (readback.byteLength !== bytes.byteLength || readbackSha256 !== sha256) {
      throw new Error("private creation V2 capability readback digest mismatch");
    }
    return { sha256, sizeBytes: bytes.byteLength };
  } finally {
    if (wrote) await remove(locator);
  }
}

export async function privateCreationAssetGet(
  locator: PrivateCreationAssetLocator,
  range?: string,
  signal?: AbortSignal,
): Promise<Response> {
  const clean = requirePrivateCreationAssetLocator(locator);
  if (clean.assetStore === PRIVATE_CREATION_ASSET_STORE_V1) {
    return await privateR2Get(clean.assetLocator, range, signal);
  }
  // Never retry V2 through V1. A missing V2 vault/bucket is a hard error.
  return await v2Get(clean, range, signal);
}

export async function privateCreationAssetPut(
  locator: PrivateCreationAssetLocator,
  body: Uint8Array | ArrayBuffer | string,
  contentType: string,
  metadata?: { sha256?: string },
): Promise<{ etag?: string }> {
  const clean = requirePrivateCreationAssetLocator(locator);
  if (clean.assetStore === PRIVATE_CREATION_ASSET_STORE_V1) {
    if (metadata === undefined) {
      return await privateR2Put(clean.assetLocator, body, contentType);
    }
    return await privateR2Put(clean.assetLocator, body, contentType, metadata);
  }
  return await v2Put(clean, body, contentType, metadata);
}

export async function privateCreationAssetDelete(locator: PrivateCreationAssetLocator): Promise<void> {
  const clean = requirePrivateCreationAssetLocator(locator);
  if (clean.assetStore === PRIVATE_CREATION_ASSET_STORE_V1) {
    await privateR2Delete(clean.assetLocator);
    return;
  }
  await v2Delete(clean);
}

export function resetPrivateCreationAssetStoreForTests(): void {
  v2Cached = null;
}
