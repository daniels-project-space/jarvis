const EXPECTED_VAULT_ORIGIN = "https://fantastic-roadrunner-485.convex.cloud";
const VAULT_REQUEST_TIMEOUT_MS = 10_000;

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
  let response: Response;
  try {
    response = await fetch(vaultQueryUrl(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        path: "secrets:listByService",
        args: { service, vaultToken },
        format: "json",
      }),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(VAULT_REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new Error("Vault request unavailable");
  }
  if (!response.ok) throw new Error("Vault request unavailable");
  let payload: { status?: unknown; value?: unknown };
  try {
    payload = await response.json() as { status?: unknown; value?: unknown };
  } catch {
    throw new Error("Vault request unavailable");
  }
  if (payload.status === "error" || !Array.isArray(payload.value)
    || payload.value.some((row) => !row || typeof row !== "object"
      || typeof (row as SecretRow).keyName !== "string"
      || typeof (row as SecretRow).value !== "string")) {
    throw new Error("Vault request unavailable");
  }
  const values = Object.fromEntries((payload.value as SecretRow[]).map((secret) => [secret.keyName, secret.value]));
  cache.set(service, values);
  return values;
}
