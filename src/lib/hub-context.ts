import "server-only";

/**
 * Project Hub owns its data and accepts only the narrow `jarvis-context`
 * capability for this cross-app snapshot. Keep the wire argument name for
 * compatibility with Hub, but never substitute the broader vault credential.
 */
export const HUB_CONTEXT_URL = "https://fantastic-roadrunner-485.convex.cloud";

type HubContextEnvironment = Readonly<Record<string, string | undefined>>;

export type HubContextReadiness = Readonly<{
  configured: boolean;
}>;

export function hubContextRequestArgs(
  environment: HubContextEnvironment = process.env,
): { vaultToken: string } | null {
  const token = environment.JARVIS_HUB_CONTEXT_TOKEN?.trim();
  return token ? { vaultToken: token } : null;
}

export function hubContextReadiness(
  environment: HubContextEnvironment = process.env,
): HubContextReadiness {
  return { configured: hubContextRequestArgs(environment) !== null };
}
