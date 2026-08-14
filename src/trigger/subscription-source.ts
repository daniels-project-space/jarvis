import { SubscriptionSessionError } from "./subscription-session";

export const CODEX_SESSION_SOURCE_ENV = "JARVIS_CODEX_SESSION_SOURCE";
export const CODEX_SESSION_SOURCE = "vault-broker" as const;

// These names belong only to the trusted subscription controller. Some are
// retired inputs, but stripping them remains important while old Trigger
// revisions and host images drain. Keep this list explicit: broad substring
// matching can accidentally remove ordinary application configuration.
const CONTROLLER_ONLY_ENV_NAMES = new Set([
  CODEX_SESSION_SOURCE_ENV,
  "CODEX_AUTH_JSON_B64",
  "CODEX_AUTH_JSON",
  "CODEX_ACCESS_TOKEN",
  "CODEX_HOME",
  "HOME",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "VAULT_ACCESS_TOKEN",
  "NOVITA_API_KEY",
  "R2_ACCOUNT_ID",
  "R2_PARENT_API_TOKEN",
  "R2_PARENT_ACCESS_KEY_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_SESSION_TOKEN",
  "R2_ENDPOINT",
  "R2_BUCKET",
  "SESSION_ENCRYPTION_KEY_B64",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
]);

export function requireVaultBrokerSubscriptionSource(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): void {
  if (environment[CODEX_SESSION_SOURCE_ENV] !== CODEX_SESSION_SOURCE) {
    throw new SubscriptionSessionError("source_rejected");
  }
}

/**
 * Copy a host environment for an unrelated child without ever reading a
 * controller-only value. The order is intentional: a Proxy-backed secret
 * source must not have its getter invoked before the name is rejected.
 */
export function environmentWithoutSubscriptionController(
  source: Readonly<Record<string, string | undefined>>,
): NodeJS.ProcessEnv {
  const clean = {} as NodeJS.ProcessEnv;
  for (const name of Object.keys(source)) {
    if (CONTROLLER_ONLY_ENV_NAMES.has(name)) continue;
    const value = source[name];
    if (value !== undefined) clean[name] = value;
  }
  return clean;
}

export function isSubscriptionControllerEnvName(name: string): boolean {
  return CONTROLLER_ONLY_ENV_NAMES.has(name);
}
