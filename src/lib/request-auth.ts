import "server-only";
import type { NextRequest } from "next/server";
import { adminSessionHash, validateAdminSession } from "./control-session";
import { verifyViewerToken } from "./viewer-jwt";

export type ControlActor =
  | { kind: "admin"; authTokenHash: string }
  | { kind: "viewer" };

export function bearerToken(header: string | null): string | null {
  const match = header?.match(/^Bearer\s+([^\s]+)$/i);
  return match?.[1] ?? null;
}

export async function controlActor(req: NextRequest): Promise<ControlActor | null> {
  // Every interactive client already has this locally verifiable six-hour
  // capability. Check it first so speech does not pay a Convex session query
  // in both Proxy and the route handler before STT can even begin.
  if (await verifyViewerToken(bearerToken(req.headers.get("authorization")))) {
    return { kind: "viewer" };
  }
  const authTokenHash = await adminSessionHash(req);
  if (authTokenHash && await validateAdminSession(authTokenHash)) {
    return { kind: "admin", authTokenHash };
  }
  return null;
}

/** Server-to-Convex credentials. Nothing privileged is returned to the UI. */
export function controlCredentials(actor: ControlActor): { authTokenHash: string } | { workerToken: string } {
  if (actor.kind === "admin") return { authTokenHash: actor.authTokenHash };
  const workerToken = process.env.JARVIS_WORKER_TOKEN;
  if (!workerToken) throw new Error("Jarvis worker capability is unavailable");
  return { workerToken };
}

export const actorAdminHash = (actor: ControlActor): string | undefined =>
  actor.kind === "admin" ? actor.authTokenHash : undefined;
