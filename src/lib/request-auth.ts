import "server-only";
import type { NextRequest } from "next/server";
import { adminSessionHash, controlQuery, sha256Hex, validateAdminSession } from "./control-session";
import { isTrustedJarvisEmbedOrigin } from "./embed-origin";
import { openOwnerSessionToken } from "./open-owner-session";
import { verifyViewerToken } from "./viewer-jwt";

export type ControlActor =
  | { kind: "owner"; authTokenHash: string }
  // Retained temporarily as a compile-time migration shape only. The request
  // boundary below never returns it and Convex rejects all guest credentials.
  | { kind: "guest"; guestId: string };

export function bearerToken(header: string | null): string | null {
  const match = header?.match(/^Bearer\s+([^\s]+)$/i);
  return match?.[1] ?? null;
}

export async function controlActor(req: NextRequest): Promise<ControlActor | null> {
  // A browser capability is deliberately never an owner-control credential.
  // Check the HttpOnly enrolled session first; a copied Convex read token must
  // not turn into authority over work, files, or third-party actions.
  const authTokenHash = await adminSessionHash(req);
  if (authTokenHash && await validateAdminSession(authTokenHash)) {
    return { kind: "owner", authTokenHash };
  }
  const bearer = bearerToken(req.headers.get("authorization"));
  const hostOrigin = req.headers.get("x-jarvis-embed-origin");
  const workerToken = process.env.JARVIS_WORKER_TOKEN;
  if (bearer && workerToken && hostOrigin && isTrustedJarvisEmbedOrigin(hostOrigin) && /^[A-Za-z0-9_-]{40,128}$/.test(bearer)) {
    const status = await controlQuery("controlAuth:embedControlSessionStatus", {
      tokenHash: await sha256Hex(bearer),
      hostOrigin,
      workerToken,
    }) as { valid?: boolean; authTokenHash?: string } | null;
    if (status?.valid && typeof status.authTokenHash === "string") {
      return { kind: "owner", authTokenHash: status.authTokenHash };
    }
  }

  // With the front-door gate intentionally removed, the signed six-hour owner
  // viewer capability is the efficient recovery path for browsers and
  // third-party-cookie-blocked overlays alike. It maps back to the same stable
  // server-only admin session; no secret or durable credential reaches the UI.
  const viewer = await verifyViewerToken(bearer);
  if (viewer?.kind === "owner" && workerToken) {
    const openSessionHash = await sha256Hex(openOwnerSessionToken(workerToken));
    if (await validateAdminSession(openSessionHash)) {
      return { kind: "owner", authTokenHash: openSessionHash };
    }
  }
  return null;
}

/** Server-to-Convex credentials. Nothing privileged is returned to the UI. */
export function controlCredentials(actor: Extract<ControlActor, { kind: "owner" }>): { authTokenHash: string } {
  return { authTokenHash: actor.authTokenHash };
}

export const actorAdminHash = (actor: ControlActor): string | undefined =>
  actor.kind === "owner" ? actor.authTokenHash : undefined;

export function isOwnerActor(actor: ControlActor): actor is Extract<ControlActor, { kind: "owner" }> {
  return actor.kind === "owner";
}
