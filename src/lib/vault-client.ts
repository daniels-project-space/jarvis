import {
  assertExactResponseOrigin,
  hasExactKeys,
  isJsonRecord,
  readBoundedResponseJson,
  runWithDeadline,
} from "./bounded-json";

const EXPECTED_VAULT_ORIGIN = "https://fantastic-roadrunner-485.convex.cloud";
const VAULT_REQUEST_TIMEOUT_MS = 10_000;
const VAULT_RESPONSE_MAX_BYTES = 512 * 1_024;
const VAULT_MAX_SECRET_ROWS = 128;
const VAULT_MAX_SECRET_VALUE_BYTES = 128 * 1_024;

type SecretRow = { keyName: string; value: string };

export type VaultFailureStage =
  | "configuration"
  | "capability"
  | "transport"
  | "timeout"
  | "origin"
  | "http"
  | "payload";

class VaultRequestError extends Error {
  constructor(readonly stage: VaultFailureStage) {
    super("Vault request unavailable");
  }
}

export function vaultFailureStage(error: unknown): VaultFailureStage | "unknown" {
  return error instanceof VaultRequestError ? error.stage : "unknown";
}

const cache = new Map<string, Record<string, string>>();

function vaultQueryUrl(): string {
  let configured: URL;
  try {
    configured = new URL(process.env.VAULT_URL?.trim() || EXPECTED_VAULT_ORIGIN);
  } catch {
    throw new VaultRequestError("configuration");
  }
  if (configured.origin !== EXPECTED_VAULT_ORIGIN
    || configured.username || configured.password
    || (configured.pathname !== "/" && configured.pathname !== "")
    || configured.search || configured.hash) {
    throw new VaultRequestError("configuration");
  }
  return `${EXPECTED_VAULT_ORIGIN}/api/query`;
}

export async function vaultService(service: string): Promise<Record<string, string>> {
  const cached = cache.get(service);
  if (cached) return cached;
  // Project Hub has a small number of legacy, explicitly scoped service
  // names that use underscores (including Apple Calendar). The service name
  // is still a fixed caller constant and Vault enforces the caller's service
  // allowlist; accept that legacy grammar without accepting arbitrary paths.
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(service)) throw new VaultRequestError("configuration");
  const vaultToken = process.env.VAULT_ACCESS_TOKEN?.trim();
  if (!vaultToken) throw new VaultRequestError("capability");
  const body = JSON.stringify({
    path: "secrets:listByService",
    args: { service, vaultToken },
    format: "json",
  });
  let payload: unknown;
  try {
    payload = await runWithDeadline(VAULT_REQUEST_TIMEOUT_MS, async (signal) => {
      let response: Response;
      try {
        response = await fetch(vaultQueryUrl(), {
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
        if (error instanceof VaultRequestError) throw error;
        throw new VaultRequestError("transport");
      }
      try {
        assertExactResponseOrigin(response, EXPECTED_VAULT_ORIGIN);
      } catch {
        throw new VaultRequestError("origin");
      }
      if (!response.ok) throw new VaultRequestError("http");
      try {
        return await readBoundedResponseJson(response, VAULT_RESPONSE_MAX_BYTES);
      } catch {
        throw new VaultRequestError("payload");
      }
    });
  } catch (error) {
    if (error instanceof VaultRequestError) throw error;
    if (String(error).includes("operation deadline exceeded")) throw new VaultRequestError("timeout");
    throw new VaultRequestError("transport");
  }
  if (!isJsonRecord(payload) || !hasExactKeys(payload, ["status", "value"])
    || payload.status !== "success" || !Array.isArray(payload.value)
    || payload.value.length > VAULT_MAX_SECRET_ROWS) {
    throw new VaultRequestError("payload");
  }
  const rows = payload.value as unknown[];
  const names = new Set<string>();
  if (rows.some((row) => {
    if (!isJsonRecord(row)
      || typeof row.keyName !== "string" || !/^[A-Z][A-Z0-9_]{0,127}$/.test(row.keyName)
      || typeof row.value !== "string" || Buffer.byteLength(row.value, "utf8") > VAULT_MAX_SECRET_VALUE_BYTES
      || names.has(row.keyName)) return true;
    names.add(row.keyName);
    return false;
  })) {
    throw new VaultRequestError("payload");
  }
  const values = Object.fromEntries((rows as SecretRow[]).map((secret) => [secret.keyName, secret.value]));
  cache.set(service, values);
  return values;
}
