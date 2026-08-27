import "server-only";

import { adminSessionStatus, sha256Hex } from "@/lib/control-session";
import { issueViewerToken } from "@/lib/viewer-jwt";

// This is an optional fast path. Never let an unavailable Convex lookup hold
// the owner’s first HTML response hostage; the client bootstrap remains the
// safe recovery path after this short budget expires.
export const OWNER_VIEWER_BOOTSTRAP_DEADLINE_MS = 900;

export type OwnerViewerBootstrap = {
  token: string;
  expiresAt: number;
};

export type OwnerViewerBootstrapRequest = {
  origin: string | null;
  fetchSite: string | null;
  requestOrigin: string | null;
};

export function requestOriginFromHeaders(headers: Pick<Headers, "get">): string | null {
  const firstHeaderValue = (name: string) => headers.get(name)?.split(",")[0]?.trim() || null;
  const host = firstHeaderValue("x-forwarded-host") ?? firstHeaderValue("host");
  const protocol = firstHeaderValue("x-forwarded-proto") ?? "https";
  if (!host || (protocol !== "https" && protocol !== "http")) return null;
  return `${protocol}://${host}`;
}

export function isTrustedOwnerViewerBootstrapRequest({
  origin,
  fetchSite,
  requestOrigin,
}: OwnerViewerBootstrapRequest): boolean {
  if (origin) return Boolean(requestOrigin && origin === requestOrigin);
  return fetchSite === "same-origin" || fetchSite === "none";
}

/**
 * Produces a browser capability only for an already enrolled owner session.
 * Rendering must never create, refresh, or recover a session: an absent or
 * temporarily unavailable session simply falls back to the client bootstrap.
 */
export async function getInitialOwnerViewerSession(
  ownerCookie: string | null | undefined,
  request: OwnerViewerBootstrapRequest,
): Promise<OwnerViewerBootstrap | null> {
  const ownerToken = ownerCookie?.trim();
  if (!ownerToken || !isTrustedOwnerViewerBootstrapRequest(request)) return null;

  const controller = new AbortController();
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    deadlineTimer = setTimeout(() => {
      controller.abort();
      reject(new Error("owner viewer bootstrap timed out"));
    }, OWNER_VIEWER_BOOTSTRAP_DEADLINE_MS);
  });

  try {
    return await Promise.race([
      (async () => {
        const ownerSession = await adminSessionStatus(await sha256Hex(ownerToken), controller.signal);
        if (!ownerSession.valid) return null;

        return await issueViewerToken({ kind: "owner" });
      })(),
      deadline,
    ]);
  } catch {
    // This path is an optional fast start. Fail closed so an unavailable
    // session lookup or signer cannot turn an unauthenticated render into an
    // owner capability.
    return null;
  } finally {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
  }
}
