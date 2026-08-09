import "server-only";
import { createHmac } from "node:crypto";

/**
 * One stable HttpOnly capability keeps direct access stateless and inexpensive.
 * It is derived only on the server from the worker secret and never rendered
 * into HTML or client JavaScript.
 */
export function openOwnerSessionToken(workerToken: string): string {
  if (!workerToken) throw new Error("Jarvis worker capability is unavailable");
  return createHmac("sha256", workerToken)
    .update("jarvis:open-owner-session:v1")
    .digest("base64url");
}
