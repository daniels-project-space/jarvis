import {
  assertExactResponseOrigin,
  hasExactKeys,
  isJsonRecord,
  readBoundedResponseJson,
} from "./bounded-json";

const EXPECTED_VAULT_ORIGIN = "https://fantastic-roadrunner-485.convex.cloud";
const VAULT_REQUEST_TIMEOUT_MS = 10_000;
const VAULT_RESPONSE_MAX_BYTES = 512 * 1_024;
const VAULT_MAX_SECRET_ROWS = 128;
const VAULT_MAX_SECRET_VALUE_BYTES = 128 * 1_024;

type SecretRow = { keyName: string; value: string };

const cache = new Map<string, Record<string, string>>();

function vaultQueryUrl(): string {
  let configured: URL;
  try {
    configured = new URL(process.env.VAULT_URL?.trim() || EXPECTED_VAULT_ORIGIN);
  } catch {
    throw new Error("Vault request unavailable");
  }
  if (configured.origin !== EXPECTED_VAULT_ORIGIN
    || configured.username || configured.password
    || (configured.pathname !== "/" && configured.pathname !== "")
    || configured.search || configured.hash) {
    throw new Error("Vault request unavailable");
  }
  return `${EXPECTED_VAULT_ORIGIN}/api/query`;
}

export async function vaultService(service: string): Promise<Record<string, string>> {
  const cached = cache.get(service);
  if (cached) return cached;
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(service)) throw new Error("Vault request unavailable");
  const vaultToken = process.env.VAULT_ACCESS_TOKEN;
  if (!vaultToken) throw new Error("VAULT_ACCESS_TOKEN is not configured");
  const body = JSON.stringify({
    path: "secrets:listByService",
    args: { service, vaultToken },
    format: "json",
  });
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
      signal: AbortSignal.timeout(VAULT_REQUEST_TIMEOUT_MS),
    });
    assertExactResponseOrigin(response, EXPECTED_VAULT_ORIGIN);
  } catch {
    throw new Error("Vault request unavailable");
  }
  if (!response.ok) throw new Error("Vault request unavailable");
  let payload: unknown;
  try {
    payload = await readBoundedResponseJson(response, VAULT_RESPONSE_MAX_BYTES);
  } catch {
    throw new Error("Vault request unavailable");
  }
  if (!isJsonRecord(payload) || !hasExactKeys(payload, ["status", "value"])
    || payload.status !== "success" || !Array.isArray(payload.value)
    || payload.value.length > VAULT_MAX_SECRET_ROWS) {
    throw new Error("Vault request unavailable");
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
    throw new Error("Vault request unavailable");
  }
  const values = Object.fromEntries((rows as SecretRow[]).map((secret) => [secret.keyName, secret.value]));
  cache.set(service, values);
  return values;
}
