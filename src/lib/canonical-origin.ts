const DEFAULT_CANONICAL_HOST = "jarvis-orcin-six.vercel.app";

function normalizedHost(value: string | null | undefined): string | null {
  const first = value?.split(",", 1)[0]?.trim().toLowerCase().replace(/\.$/, "");
  if (!first) return null;
  try {
    return new URL(`https://${first}`).host;
  } catch {
    return null;
  }
}

export function canonicalJarvisRedirect(options: {
  requestUrl: string;
  requestHost: string | null | undefined;
  vercelEnvironment: string | null | undefined;
  canonicalHost?: string | null;
}): URL | null {
  if (options.vercelEnvironment !== "production") return null;

  const current = normalizedHost(options.requestHost);
  const canonical = normalizedHost(options.canonicalHost) ?? DEFAULT_CANONICAL_HOST;
  if (!current || current === canonical) return null;

  const target = new URL(options.requestUrl);
  target.protocol = "https:";
  target.host = canonical;
  if (!canonical.includes(":")) target.port = "";
  return target;
}
