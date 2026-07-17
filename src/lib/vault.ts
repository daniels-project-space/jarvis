import "server-only";
import { vaultService } from "./vault-client";

export async function getServiceSecrets(service: string): Promise<Record<string, string>> {
  return await vaultService(service);
}

export async function getSecret(service: string, keyName: string): Promise<string> {
  const env = await getServiceSecrets(service);
  const v = env[keyName];
  if (!v) throw new Error(`Vault missing ${service}.${keyName}`);
  return v;
}
