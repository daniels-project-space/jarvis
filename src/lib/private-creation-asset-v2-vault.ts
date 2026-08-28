import "server-only";

import {
  assertExactResponseOrigin,
  hasExactKeys,
  isJsonRecord,
  readBoundedResponseJson,
  runWithDeadline,
} from "./bounded-json";

// This is intentionally not a selector accepted from a caller. The dedicated
// vault endpoint is configured server-side to return this service only.
export const PRIVATE_CREATION_ASSET_V2_VAULT_SERVICE = "cloudflare-private-r2-v2" as const;
export const PRIVATE_CREATION_ASSET_V2_VAULT_TOKEN_ENV = "JARVIS_PRIVATE_CREATION_ASSET_V2_VAULT_TOKEN";

const EXPECTED_V2_VAULT_ORIGIN = "https://fantastic-roadrunner-485.convex.cloud";
const DEDICATED_V2_VAULT_PATH = "/api/query";
const DEDICATED_V2_VAULT_QUERY = "privateCreationAssetV2:credentials";
const DEDICATED_V2_VAULT_URL = `${EXPECTED_V2_VAULT_ORIGIN}${DEDICATED_V2_VAULT_PATH}`;
const V2_VAULT_REQUEST_TIMEOUT_MS = 10_000;
const V2_VAULT_RESPONSE_MAX_BYTES = 128 * 1024;
const V2_VAULT_MAX_SECRET_VALUE_BYTES = 128 * 1024;
const V2_VAULT_SECRET_NAMES = new Set([
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_ENDPOINT",
  "R2_SESSION_TOKEN",
]);

type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

export type PrivateCreationAssetV2VaultFailureStage =
  | "configuration"
  | "capability"
  | "transport"
  | "timeout"
  | "origin"
  | "http"
  | "payload";

export class PrivateCreationAssetV2VaultError extends Error {
  constructor(readonly stage: PrivateCreationAssetV2VaultFailureStage) {
    super("Private creation V2 vault capability unavailable");
  }
}

export function privateCreationAssetV2VaultFailureStage(
  error: unknown,
): PrivateCreationAssetV2VaultFailureStage | "unknown" {
  return error instanceof PrivateCreationAssetV2VaultError ? error.stage : "unknown";
}

function dedicatedSecrets(value: unknown): Record<string, string> {
  if (!isJsonRecord(value) || !hasExactKeys(value, ["service", "secrets"])
    || value.service !== PRIVATE_CREATION_ASSET_V2_VAULT_SERVICE
    || !isJsonRecord(value.secrets)
    || !hasExactKeys(value.secrets, [
      "R2_ACCESS_KEY_ID",
      "R2_SECRET_ACCESS_KEY",
      "R2_ENDPOINT",
    ], ["R2_SESSION_TOKEN"])) {
    throw new PrivateCreationAssetV2VaultError("payload");
  }
  const secrets = value.secrets;
  if (Object.keys(secrets).some((name) => !V2_VAULT_SECRET_NAMES.has(name)
    || typeof secrets[name] !== "string"
    || Buffer.byteLength(secrets[name], "utf8") > V2_VAULT_MAX_SECRET_VALUE_BYTES)) {
    throw new PrivateCreationAssetV2VaultError("payload");
  }
  return Object.fromEntries(Object.entries(secrets).map(([name, secret]) => [name, String(secret)]));
}

// The V2 path has its own capability and endpoint. It deliberately does not
// import vaultService/getServiceSecrets, read VAULT_ACCESS_TOKEN, or accept a
// service argument, so an old generic-vault runtime cannot select this bucket.
export async function getPrivateCreationAssetV2VaultSecrets(
  environment: RuntimeEnvironment = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, string>> {
  const dedicatedToken = environment[PRIVATE_CREATION_ASSET_V2_VAULT_TOKEN_ENV]?.trim();
  if (!dedicatedToken) throw new PrivateCreationAssetV2VaultError("capability");
  const body = JSON.stringify({
    path: DEDICATED_V2_VAULT_QUERY,
    args: { v2VaultToken: dedicatedToken },
    format: "json",
  });
  let payload: unknown;
  try {
    payload = await runWithDeadline(V2_VAULT_REQUEST_TIMEOUT_MS, async (signal) => {
      let response: Response;
      try {
        response = await fetchImpl(DEDICATED_V2_VAULT_URL, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": String(Buffer.byteLength(body, "utf8")),
          },
          body,
          cache: "no-store",
          redirect: "error",
          signal,
        });
      } catch (error) {
        if (error instanceof PrivateCreationAssetV2VaultError) throw error;
        throw new PrivateCreationAssetV2VaultError("transport");
      }
      try {
        assertExactResponseOrigin(response, EXPECTED_V2_VAULT_ORIGIN);
      } catch {
        throw new PrivateCreationAssetV2VaultError("origin");
      }
      if (!response.ok) throw new PrivateCreationAssetV2VaultError("http");
      try {
        return await readBoundedResponseJson(response, V2_VAULT_RESPONSE_MAX_BYTES);
      } catch {
        throw new PrivateCreationAssetV2VaultError("payload");
      }
    });
  } catch (error) {
    if (error instanceof PrivateCreationAssetV2VaultError) throw error;
    if (String(error).includes("operation deadline exceeded")) {
      throw new PrivateCreationAssetV2VaultError("timeout");
    }
    throw new PrivateCreationAssetV2VaultError("transport");
  }
  if (!isJsonRecord(payload) || !hasExactKeys(payload, ["status", "value"])
    || payload.status !== "success") {
    throw new PrivateCreationAssetV2VaultError("payload");
  }
  return dedicatedSecrets(payload.value);
}
