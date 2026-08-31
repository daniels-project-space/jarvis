import "server-only";
import { AwsClient } from "aws4fetch";
import { getServiceSecrets } from "./vault";
import { vaultFailureStage, type VaultFailureStage } from "./vault-client";
import { CHAT_FILE_LIMITS, normalizeUploadMime, normalizeUploadSha256 } from "./chat-files";

const REQUIRED_PRIVATE_BUCKET = "jarvis-private-files";
const FILE_OBJECT_KEY = /^owners\/daniel\/files\/[a-zA-Z0-9_-]+\/v[1-9][0-9]*\/(?:original|extracted\.txt|preview\.webp|a[a-zA-Z0-9_-]+\/(?:extracted\.txt|preview\.webp))$/;
const FILE_OUTPUT_ATTEMPT_ID = /^[a-zA-Z0-9_-]{16,180}$/;
const OPAQUE_OBJECT_ID_SOURCE = "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const OPAQUE_OBJECT_ID = new RegExp(`^${OPAQUE_OBJECT_ID_SOURCE}$`, "i");
const CREATION_OBJECT_KEY = new RegExp(`^owners/daniel/creations/${OPAQUE_OBJECT_ID_SOURCE}/(?:asset|thumb)$`, "i");
const CAPTURE_OBJECT_KEY = new RegExp(`^owners/daniel/captures/${OPAQUE_OBJECT_ID_SOURCE}/image$`, "i");

export type PrivateCreationObjectPurpose = "asset" | "thumb";

export type PrivateR2ConfigurationCode =
  | "bucket_missing"
  | "bucket_mismatch"
  | "vault_unavailable"
  | `vault_${VaultFailureStage}`
  | "credentials_unavailable"
  | "unknown";

class PrivateR2ConfigurationError extends Error {
  constructor(readonly code: Exclude<PrivateR2ConfigurationCode, "unknown">, message: string) {
    super(message);
    this.name = "PrivateR2ConfigurationError";
  }
}

export function privateR2ConfigurationCode(error: unknown): PrivateR2ConfigurationCode {
  return error instanceof PrivateR2ConfigurationError ? error.code : "unknown";
}

type PrivateR2Client = {
  aws: AwsClient;
  endpoint: string;
  bucket: string;
};

export type PrivateR2Head = {
  sizeBytes: number;
  contentType: string;
  etag?: string;
  expectedSha256?: string;
};

let cached: PrivateR2Client | null = null;

export function assertPrivateBucketName(value: string | undefined): string {
  const bucket = value?.trim();
  if (!bucket) {
    throw new PrivateR2ConfigurationError("bucket_missing", "JARVIS_PRIVATE_R2_BUCKET is not configured");
  }
  if (bucket !== REQUIRED_PRIVATE_BUCKET) {
    throw new PrivateR2ConfigurationError(
      "bucket_mismatch",
      `JARVIS_PRIVATE_R2_BUCKET must be ${REQUIRED_PRIVATE_BUCKET}`,
    );
  }
  return bucket;
}

function validateObjectKey(value: string): string {
  const key = value.trim();
  if (!FILE_OBJECT_KEY.test(key) && !CREATION_OBJECT_KEY.test(key) && !CAPTURE_OBJECT_KEY.test(key)) {
    throw new Error("invalid private R2 object key");
  }
  return key;
}

function opaqueObjectId(value: string, label: string): string {
  const id = String(value).trim().toLowerCase();
  if (!OPAQUE_OBJECT_ID.test(id)) throw new Error(`invalid private ${label} object identity`);
  return id;
}

export function privateFileObjectKey(
  fileId: string,
  version: number,
  purpose: "original" | "extracted.txt" | "preview.webp",
): string {
  const id = String(fileId).trim();
  if (!/^[a-zA-Z0-9_-]+$/.test(id) || !Number.isSafeInteger(version) || version < 1) {
    throw new Error("invalid private file object identity");
  }
  return validateObjectKey(`owners/daniel/files/${id}/v${version}/${purpose}`);
}

/**
 * A derived-output generation is minted by Convex with the ingest claim. It
 * deliberately cannot address an original upload or an arbitrary file prefix.
 */
export function privateFileAttemptObjectKey(
  fileId: string,
  version: number,
  attemptId: string,
  purpose: "extracted.txt" | "preview.webp",
): string {
  const id = String(fileId).trim();
  const attempt = String(attemptId).trim();
  if (
    !/^[a-zA-Z0-9_-]+$/.test(id)
    || !Number.isSafeInteger(version)
    || version < 1
    || !FILE_OUTPUT_ATTEMPT_ID.test(attempt)
  ) {
    throw new Error("invalid private file output attempt identity");
  }
  return validateObjectKey(`owners/daniel/files/${id}/v${version}/a${attempt}/${purpose}`);
}

// Generated artifacts and transient camera/screen captures get their own
// deliberately narrow namespaces. Their opaque UUIDs are minted server-side;
// accepting no arbitrary prefix here keeps the generic private R2 operations
// from becoming a bucket-read/write primitive.
export function privateCreationObjectKey(
  assetId: string,
  purpose: PrivateCreationObjectPurpose = "asset",
): string {
  if (purpose !== "asset" && purpose !== "thumb") throw new Error("invalid private creation object purpose");
  const id = opaqueObjectId(assetId, "creation");
  return validateObjectKey(`owners/daniel/creations/${id}/${purpose}`);
}

export function privateCaptureObjectKey(captureId: string): string {
  const id = opaqueObjectId(captureId, "capture");
  return validateObjectKey(`owners/daniel/captures/${id}/image`);
}

function encodedKey(value: string): string {
  return validateObjectKey(value).split("/").map(encodeURIComponent).join("/");
}

async function client(): Promise<PrivateR2Client> {
  if (cached) return cached;
  const bucket = assertPrivateBucketName(process.env.JARVIS_PRIVATE_R2_BUCKET);
  const secrets = await getServiceSecrets("cloudflare").catch((error) => {
    const stage = vaultFailureStage(error);
    throw new PrivateR2ConfigurationError(
      stage === "unknown" ? "vault_unavailable" : `vault_${stage}`,
      "private R2 vault capability is unavailable",
    );
  });
  if (!secrets.R2_ACCESS_KEY_ID || !secrets.R2_SECRET_ACCESS_KEY || !secrets.R2_ENDPOINT) {
    throw new PrivateR2ConfigurationError(
      "credentials_unavailable",
      "private R2 credentials are unavailable",
    );
  }
  cached = {
    aws: new AwsClient({
      accessKeyId: secrets.R2_ACCESS_KEY_ID,
      secretAccessKey: secrets.R2_SECRET_ACCESS_KEY,
      sessionToken: secrets.R2_SESSION_TOKEN || undefined,
      service: "s3",
      region: "auto",
      retries: 2,
    }),
    endpoint: secrets.R2_ENDPOINT.replace(/\/$/, ""),
    bucket,
  };
  return cached;
}

export async function assertPrivateR2Configured(): Promise<void> {
  await client();
}

async function objectUrl(key: string): Promise<string> {
  const config = await client();
  return `${config.endpoint}/${config.bucket}/${encodedKey(key)}`;
}

export async function privateR2PresignGet(key: string, expiresSeconds = 90): Promise<string> {
  const config = await client();
  const target = new URL(await objectUrl(key));
  target.searchParams.set("X-Amz-Expires", String(Math.min(5 * 60, Math.max(30, Math.floor(expiresSeconds)))));
  const signed = await config.aws.sign(target.toString(), { method: "GET", aws: { signQuery: true } });
  return signed.url;
}

export async function privateR2Head(key: string): Promise<PrivateR2Head | null> {
  const config = await client();
  const response = await config.aws.fetch(await objectUrl(key), { method: "HEAD" });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`private R2 HEAD failed (${response.status})`);
  const sizeBytes = Number(response.headers.get("content-length"));
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || sizeBytes > CHAT_FILE_LIMITS.maxFileBytes) {
    throw new Error("private R2 object has invalid size");
  }
  return {
    sizeBytes,
    contentType: normalizeUploadMime(response.headers.get("content-type")),
    etag: response.headers.get("etag")?.replace(/^\"|\"$/g, "") || undefined,
    expectedSha256: normalizeUploadSha256(response.headers.get("x-amz-meta-sha256")) ?? undefined,
  };
}

export async function privateR2Get(
  key: string,
  range?: string,
  signal?: AbortSignal,
): Promise<Response> {
  const config = await client();
  const headers = new Headers();
  if (range) {
    if (!/^bytes=\d*-\d*$/.test(range) || range.length > 80) throw new Error("invalid byte range");
    headers.set("range", range);
  }
  return await config.aws.fetch(await objectUrl(key), {
    method: "GET",
    headers,
    cache: "no-store",
    signal,
  });
}

export async function privateR2Put(
  key: string,
  body: Uint8Array | ArrayBuffer | string,
  contentType: string,
  metadata?: { sha256?: string },
): Promise<{ etag?: string }> {
  const config = await client();
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
  const response = await config.aws.fetch(await objectUrl(key), {
    method: "PUT",
    headers,
    body: payload as unknown as BodyInit,
  });
  if (!response.ok) throw new Error(`private R2 PUT failed (${response.status})`);
  return { etag: response.headers.get("etag")?.replace(/^\"|\"$/g, "") || undefined };
}

export async function privateR2Delete(key: string): Promise<void> {
  const config = await client();
  const response = await config.aws.fetch(await objectUrl(key), { method: "DELETE" });
  if (!response.ok && response.status !== 404) throw new Error(`private R2 DELETE failed (${response.status})`);
}

export function resetPrivateR2ClientForTests(): void {
  cached = null;
}
