// Legacy Jarvis creations were stored in a public R2 development domain.
// Keep the compatibility boundary narrow: only these exact historic objects
// may be fetched through the owner-authorized media/download routes.
export const LEGACY_PUBLIC_CREATION_ORIGIN = "https://pub-901f8094a6f04b32a784dc06cf3ebbc3.r2.dev";
export const MAX_LEGACY_CREATION_MEDIA_BYTES = 30 * 1024 * 1024;
export const LEGACY_CREATION_URL_REDACTION = "[legacy Jarvis creation media]";
export const PRIVATE_CREATION_ASSET_KEY_REDACTION = "[private Jarvis creation asset]";

const LEGACY_CREATION_URL_IN_TEXT = /https:\/\/(?:[^@/\s"'<>\\]+@)?pub-901f8094a6f04b32a784dc06cf3ebbc3\.r2\.dev\/creations\/[^\s"'<>\\]+/gi;
const PRIVATE_CREATION_ASSET_KEY_IN_TEXT = /owners\/daniel\/creations\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/asset/gi;

export function trustedLegacyCreationUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) return null;
  try {
    const url = new URL(value);
    if (
      url.origin !== LEGACY_PUBLIC_CREATION_ORIGIN
      || url.username
      || url.password
      || url.search
      || url.hash
      || !url.pathname.startsWith("/creations/")
    ) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function isLegacyCreationUrlForRedaction(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  try {
    const url = new URL(value);
    return url.origin === LEGACY_PUBLIC_CREATION_ORIGIN && url.pathname.startsWith("/creations/");
  } catch {
    return false;
  }
}

// A browser-visible historical reference may include a harmless query or
// fragment. It is never fetchable as-is, but can still be matched to its
// canonical legacy object and replaced with the authenticated media route.
export function legacyCreationLookupUrl(value: unknown): string | null {
  if (!isLegacyCreationUrlForRedaction(value)) return null;
  const url = new URL(value);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return trustedLegacyCreationUrl(url.toString());
}

// Creation `data` can contain saved board/image references. Keep legacy public
// object URLs out of every viewer-visible projection even when they are nested
// in otherwise useful serialized creation data.
export function redactLegacyCreationUrls(value: string): string {
  const normalizedSlashes = /pub-901f8094a6f04b32a784dc06cf3ebbc3\.r2\.dev/i.test(value)
    ? value.replace(/\\+\/|\\+u002f/gi, "/")
    : value;
  const withoutLegacyUrls = normalizedSlashes.replace(LEGACY_CREATION_URL_IN_TEXT, (candidate) => {
    const suffix = candidate.match(/[),.;:!?}\]]+$/)?.[0] ?? "";
    const url = suffix ? candidate.slice(0, -suffix.length) : candidate;
    return isLegacyCreationUrlForRedaction(url) ? `${LEGACY_CREATION_URL_REDACTION}${suffix}` : candidate;
  });
  return withoutLegacyUrls.replace(PRIVATE_CREATION_ASSET_KEY_IN_TEXT, PRIVATE_CREATION_ASSET_KEY_REDACTION);
}

function declaredLegacyBodyBytes(response: Response): number | null {
  const contentRange = response.headers.get("content-range");
  const rangeTotal = contentRange?.match(/^bytes \d+-\d+\/(\d+)$/i)?.[1];
  const raw = rangeTotal ?? response.headers.get("content-length");
  if (!raw || !/^\d+$/.test(raw)) return null;
  const size = Number(raw);
  return Number.isSafeInteger(size) && size >= 0 ? size : null;
}

function validLegacyRange(range: string | undefined): boolean {
  return !range || (/^bytes=\d*-\d*$/.test(range) && range.length <= 80);
}

// Server routes use this for compatibility reads only. The URL validator runs
// again here so even an invalid intermediary result cannot trigger a fetch.
export async function fetchTrustedLegacyCreation(value: string, range?: string): Promise<Response | null> {
  const url = trustedLegacyCreationUrl(value);
  if (!url) return null;
  if (!validLegacyRange(range)) return new Response(null, { status: 416 });
  const init = range
    ? { cache: "no-store" as const, redirect: "error" as const, headers: { range } }
    : { cache: "no-store" as const, redirect: "error" as const };
  const upstream = await fetch(url, init).catch(() => null);
  if (!upstream || !upstream.ok || !upstream.body) return upstream;
  const declared = declaredLegacyBodyBytes(upstream);
  if (declared === null || declared > MAX_LEGACY_CREATION_MEDIA_BYTES) {
    return new Response(null, { status: 413 });
  }

  let streamed = 0;
  const body = upstream.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      streamed += chunk.byteLength;
      if (streamed > MAX_LEGACY_CREATION_MEDIA_BYTES) {
        controller.error(new Error("legacy creation media exceeded size cap"));
        return;
      }
      controller.enqueue(chunk);
    },
  }));
  return new Response(body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: upstream.headers,
  });
}
