const VAULT_URL = process.env.VAULT_URL ?? "https://fantastic-roadrunner-485.convex.cloud";

type SecretRow = { keyName: string; value: string };

const cache = new Map<string, Record<string, string>>();

export async function vaultService(service: string): Promise<Record<string, string>> {
  const cached = cache.get(service);
  if (cached) return cached;
  const vaultToken = process.env.VAULT_ACCESS_TOKEN;
  if (!vaultToken) throw new Error("VAULT_ACCESS_TOKEN is not configured");
  const response = await fetch(`${VAULT_URL}/api/query`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      path: "secrets:listByService",
      args: { service, vaultToken },
      format: "json",
    }),
  });
  const payload = await response.json();
  if (!response.ok || payload?.status === "error" || !Array.isArray(payload?.value)) {
    throw new Error(`Vault request rejected for ${service}`);
  }
  const values = Object.fromEntries(
    (payload.value as SecretRow[]).map((secret) => [secret.keyName, secret.value]),
  );
  cache.set(service, values);
  return values;
}
