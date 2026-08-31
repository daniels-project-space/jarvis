/**
 * The Trigger build receives its values from Vercel. Most are credentials and
 * must remain absent unless the trusted host provides them. This one value is
 * intentionally different: it is a non-secret protocol selector that the
 * worker validates again before it can acquire any subscription session.
 */
export const CODEX_SESSION_SOURCE_ENV = "JARVIS_CODEX_SESSION_SOURCE";
export const CODEX_SESSION_SOURCE = "vault-broker";
// Trigger receives a deliberately narrow Vault capability. It must never reuse
// the web application's broader runtime capability just because both run the
// same source tree.
export const TRIGGER_VAULT_ACCESS_TOKEN_SOURCE_ENV = "JARVIS_TRIGGER_VAULT_ACCESS_TOKEN";

export const JARVIS_TRIGGER_ENV_KEYS = [
  // Managed ChatGPT state is fetched by the controller from the codex-session
  // vault service and persisted encrypted in its private R2 bucket. Never fan
  // auth.json into Trigger containers.
  "CONVEX_URL", "JARVIS_WORKER_TOKEN", "JARVIS_FILE_REHOME_TOKEN", "JARVIS_DISPATCH_TOKEN", "GITHUB_TOKEN", "VAULT_ACCESS_TOKEN",
  // Trigger refreshes only explicit saved-trip Gmail identities. It needs the
  // same server-side OAuth envelope inputs as Vercel; no OAuth bearer is ever
  // synced or written into a task payload.
  "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_TOKEN_ENCRYPTION_KEY",
  // Dedicated, read-only Hub context capability. It stays in the trusted
  // worker/controller environment and is stripped from any Codex child process.
  "JARVIS_HUB_CONTEXT_TOKEN",
  // Separate, narrowly scoped Hub to-do/widget actions capability.
  "JARVIS_HUB_ACTIONS_TOKEN",
  "JARVIS_PRIVATE_R2_BUCKET",
  CODEX_SESSION_SOURCE_ENV,
  // Non-secret cutover fence used by Vercel and Trigger while legacy shared
  // derivative paths are drained before the attempt-scoped protocol activates.
  "JARVIS_FILE_INGEST_WAKE_PAUSED",
  "JARVIS_MISSION_PROTOCOL_ROLLOUT",
  "JARVIS_MISSION_SUPERVISOR_ROLLOUT",
  // Exact non-secret origin allowlist for private media transcription.
  "JARVIS_LOCAL_STT_ORIGIN",
  // Non-secret immutable identity for the optional, bounded Novita patch
  // proposer. The API key stays behind VAULT_ACCESS_TOKEN.
  "JARVIS_NOVITA_QWEN_ATTESTATION",
  "JARVIS_CLOUD_WORKSPACE_PROVIDER", "JARVIS_CLOUD_WORKSPACE_TEMPLATE", "JARVIS_CLOUD_WORKSPACE_TEMPLATE_DIGEST", "JARVIS_VERCEL_PRO_SPEND_APPROVED",
  "JARVIS_CLOUD_PROVIDER_DEPLOYMENT_ID", "JARVIS_CLOUD_PROVIDER_PROBE_RECEIPT", "JARVIS_CLOUD_PROVIDER_PROBE_KEYRING",
  // A Daniel-controlled runner reached through an HTTPS tunnel. Both values
  // are required; the runner never receives controller or subscription
  // credentials, only a credentialless source archive.
  "JARVIS_SELF_HOST_RUNNER_URL", "JARVIS_SELF_HOST_RUNNER_TOKEN",
  // Explicitly forwarded but dormant unless exactly `live`; this gates the
  // owner-only attestation task before any provider call.
  "JARVIS_CLOUD_PROVIDER_PROBE",
  "E2B_API_KEY", "SANDBOX0_TOKEN", "SANDBOX0_BASE_URL", "VERCEL_TOKEN", "VERCEL_TEAM_ID", "VERCEL_PROJECT_ID",
] as const;

/**
 * Build the explicit environment allowlist for Trigger. The source selector
 * has a safe, non-secret default because its absence otherwise prevents every
 * foreground voice/text worker from starting; runtime still requires this
 * exact value before reading the Vault-backed session controller.
 */
export function syncedJarvisTriggerEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  return JARVIS_TRIGGER_ENV_KEYS.reduce<Record<string, string>>((values, key) => {
    const value = key === CODEX_SESSION_SOURCE_ENV
      ? (environment[key]?.trim() || CODEX_SESSION_SOURCE)
      : key === "VAULT_ACCESS_TOKEN"
        ? (environment[TRIGGER_VAULT_ACCESS_TOKEN_SOURCE_ENV]?.trim() || environment[key])
        : environment[key];
    if (value) values[key] = value;
    return values;
  }, {});
}
