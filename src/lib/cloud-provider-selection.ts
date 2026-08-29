export type ConfiguredCloudWorkspaceProvider = "e2b" | "sandbox0" | "vercel" | "selfhost" | "cloudflare";

const PROVIDERS = new Set<ConfiguredCloudWorkspaceProvider>([
  "e2b",
  "sandbox0",
  "vercel",
  "selfhost",
  "cloudflare",
]);

function providerFromReceipt(serialized: string | undefined): ConfiguredCloudWorkspaceProvider | null {
  if (!serialized) return null;
  try {
    const envelope = JSON.parse(serialized) as { receipt?: { provider?: unknown } };
    const provider = String(envelope?.receipt?.provider ?? "").trim().toLowerCase();
    return PROVIDERS.has(provider as ConfiguredCloudWorkspaceProvider)
      ? provider as ConfiguredCloudWorkspaceProvider
      : null;
  } catch {
    return null;
  }
}

/**
 * Resolve a provider without creating one. An explicit setting always wins;
 * otherwise a signed-receipt tuple or one complete credential set restores
 * the intended managed provider after an environment-sync omission.
 */
export function configuredCloudWorkspaceProviderName(
  env: Readonly<Record<string, string | undefined>>,
): ConfiguredCloudWorkspaceProvider | null {
  const explicit = String(env.JARVIS_CLOUD_WORKSPACE_PROVIDER ?? "").trim().toLowerCase();
  if (explicit) {
    return PROVIDERS.has(explicit as ConfiguredCloudWorkspaceProvider)
      ? explicit as ConfiguredCloudWorkspaceProvider
      : null;
  }

  const receiptProvider = providerFromReceipt(env.JARVIS_CLOUD_PROVIDER_PROBE_RECEIPT);
  if (receiptProvider) return receiptProvider;
  if (env.VERCEL_TOKEN && env.VERCEL_TEAM_ID && env.VERCEL_PROJECT_ID) return "vercel";
  if (env.SANDBOX0_TOKEN) return "sandbox0";
  if (env.E2B_API_KEY) return "e2b";
  // A remote runner is never inferred from its URL alone. Its shared bearer
  // is an explicit execution authority and must be provisioned as a pair.
  if (env.JARVIS_SELF_HOST_RUNNER_URL && env.JARVIS_SELF_HOST_RUNNER_TOKEN) return "selfhost";
  return null;
}
