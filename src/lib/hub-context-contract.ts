/**
 * Project Hub owns its data and accepts only its narrow `jarvis-context`
 * capability. This contract is shared by Next server code and the outbound
 * self-hosted foreground runtime; neither is a browser bundle.
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
