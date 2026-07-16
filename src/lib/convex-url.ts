export const DEFAULT_CONVEX_URL = "https://tangible-goose-318.convex.cloud";

function isAbsoluteHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && Boolean(url.host);
  } catch {
    return false;
  }
}

/**
 * Provider env files can contain present-but-empty values, so nullish
 * coalescing is not sufficient here. Only accept usable absolute URLs.
 */
export function resolveConvexUrl(...candidates: Array<string | undefined>): string {
  for (const candidate of candidates) {
    const value = candidate?.trim();
    if (value && isAbsoluteHttpUrl(value)) return value.replace(/\/$/, "");
  }
  return DEFAULT_CONVEX_URL;
}
