export const CLOUD_PROVIDER_PROBE_MAX_AGE_MS = 24 * 60 * 60_000;
export const VERCEL_CLOUD_PROVIDER_PROBE_MAX_AGE_MS = 30 * 24 * 60 * 60_000;

/**
 * Vercel receipts can live for the bound Trigger deployment because every new
 * Vercel workspace independently re-checks the authoritative zero-overage
 * Hobby plan. Other providers retain the short default attestation window.
 */
export function cloudProviderProbeMaxAgeMs(provider: string): number {
  return provider === "vercel"
    ? VERCEL_CLOUD_PROVIDER_PROBE_MAX_AGE_MS
    : CLOUD_PROVIDER_PROBE_MAX_AGE_MS;
}
