import { randomBytes } from "node:crypto";
import type { NextRequest } from "next/server";
import { adminSessionHash, controlMutation, sha256Hex, validateAdminSession } from "@/lib/control-session";
import { isTrustedJarvisEmbedOrigin } from "@/lib/embed-origin";
import { issueViewerToken } from "@/lib/viewer-jwt";

export const runtime = "nodejs";
const EMBED_SESSION_MS = 365 * 24 * 60 * 60 * 1000;

function html(body: string, status = 200, nonce?: string) {
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><body style="margin:0;background:#050506;color:#f4f2ed;font:14px system-ui;padding:32px">${body}</body>`, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce ?? "none"}'; base-uri 'none'; frame-ancestors 'none'`,
    },
  });
}

export async function GET(req: NextRequest) {
  const hostOrigin = req.nextUrl.searchParams.get("hostOrigin");
  const state = req.nextUrl.searchParams.get("state") ?? "";
  if (!isTrustedJarvisEmbedOrigin(hostOrigin) || !/^[A-Za-z0-9_-]{32,128}$/.test(state)) {
    return html("<strong>Jarvis refused an untrusted connection.</strong>", 403);
  }
  const authTokenHash = await adminSessionHash(req);
  if (!authTokenHash || !(await validateAdminSession(authTokenHash))) {
    return html("<strong>This browser is not paired.</strong><p>Open your one-time Jarvis owner link first, then try again.</p>", 401);
  }

  const controlToken = randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + EMBED_SESSION_MS;
  const created = await controlMutation("controlAuth:createEmbedControlSession", {
    authTokenHash,
    tokenHash: await sha256Hex(controlToken),
    hostOrigin,
    expiresAt,
  }).catch(() => null) as { expiresAt?: number } | null;
  if (!created?.expiresAt) return html("<strong>Jarvis could not create the connection.</strong>", 503);

  const viewer = await issueViewerToken({ kind: "owner" }).catch(() => null);
  if (!viewer) return html("<strong>Jarvis could not create the connection.</strong>", 503);
  const nonce = randomBytes(18).toString("base64url");
  const payload = JSON.stringify({
    jarvis: "owner-embed-grant",
    state,
    hostOrigin,
    viewerToken: viewer.token,
    controlToken,
    expiresAt,
  }).replace(/</g, "\\u003c");
  const targetOrigin = JSON.stringify(req.nextUrl.origin);
  return html(`<strong>Jarvis connected.</strong><p>This window will close automatically.</p><script nonce="${nonce}">if(window.opener){window.opener.postMessage(${payload},${targetOrigin});setTimeout(()=>window.close(),80)}</script>`, 200, nonce);
}
