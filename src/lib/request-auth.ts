import "server-only";
import type { NextRequest } from "next/server";
import { adminSessionHash, validateAdminSession } from "./control-session";
import { verifyViewerToken } from "./viewer-jwt";

export type ControlActor =
  | { kind: "owner"; authTokenHash: string }
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
  const identity = await verifyViewerToken(bearerToken(req.headers.get("authorization")));
  if (identity?.kind === "guest") return identity;
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
