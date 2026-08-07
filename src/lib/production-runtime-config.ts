import { createHash } from "node:crypto";

const REQUIRED_PRODUCTION_SERVER_CONFIG = [
  "NEXT_PUBLIC_CONVEX_URL",
  "JARVIS_DISPATCH_TOKEN",
  "JARVIS_WORKER_TOKEN",
  "JARVIS_VIEWER_SIGNING_JWK_B64",
  "TRIGGER_SECRET_KEY",
  "VAULT_ACCESS_TOKEN",
  "JARVIS_VAULT_CAPABILITY_SHA256",
  "JARVIS_PRIVATE_R2_BUCKET",
] as const;

type RuntimeEnvironment = Record<string, string | undefined>;

export function missingProductionRuntimeConfig(env: RuntimeEnvironment): string[] {
  if (env.VERCEL_ENV !== "production") return [];
  return REQUIRED_PRODUCTION_SERVER_CONFIG.filter((name) => !env[name]?.trim());
}

/**
 * Fail the Vercel production build instead of deploying an application whose
 * chat wake-ups, private storage, or control authentication can only fail at
 * runtime. Preview/local builds intentionally retain their narrower configs.
 */
export function assertProductionRuntimeConfig(env: RuntimeEnvironment): void {
  const missing = missingProductionRuntimeConfig(env);
  if (missing.length) {
    throw new Error(`Production runtime configuration is empty or missing: ${missing.join(", ")}`);
  }
  if (env.VERCEL_ENV !== "production") return;

  const expectedVaultHash = env.JARVIS_VAULT_CAPABILITY_SHA256!.trim().toLowerCase();
  const actualVaultHash = createHash("sha256").update(env.VAULT_ACCESS_TOKEN!.trim()).digest("hex");
  if (!/^[a-f0-9]{64}$/.test(expectedVaultHash) || actualVaultHash !== expectedVaultHash) {
    throw new Error("Production VAULT_ACCESS_TOKEN does not match its configured capability fingerprint");
  }
}
