import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { adminSessionHash, validateAdminSession } from "@/lib/control-session";

// Feature 4a: begins the Google OAuth connect flow. Owner/admin-gated the
// same way src/app/api/creation-download/route.ts gates downloads — only a
// browser holding a valid admin session (Daniel's, established via
// /api/auth/pair) may start this flow. No Gmail read/draft/unsubscribe
// logic lives here; this route only obtains and stores a refresh token.

export const runtime = "nodejs";

const STATE_COOKIE = "__Host-jarvis_google_oauth_state";
const STATE_MAX_AGE_SECONDS = 600; // 10 minutes — plenty for a consent-screen round trip.

// Exact scopes required by the (separate, later) Gmail read/draft/
// unsubscribe task: modify (read + label/trash) and compose (create drafts).
const GOOGLE_OAUTH_SCOPES = "https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.compose";

export async function GET(req: NextRequest) {
  const authTokenHash = await adminSessionHash(req);
  if (!authTokenHash || !(await validateAdminSession(authTokenHash))) {
    return NextResponse.redirect(new URL("/", req.url));
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    return Response.json(
      { ok: false, error: "GOOGLE_CLIENT_ID is not configured." },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }

  const state = randomBytes(32).toString("base64url");
  const redirectUri = new URL("/api/auth/google/callback", req.url).toString();

  const authorizeUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("access_type", "offline");
  // Forces Google to reissue a refresh_token even if Daniel already granted
  // consent before — without this, a reconnect can silently return no
  // refresh_token and the callback would have nothing to store.
  authorizeUrl.searchParams.set("prompt", "consent");
  authorizeUrl.searchParams.set("scope", GOOGLE_OAUTH_SCOPES);
  authorizeUrl.searchParams.set("state", state);

  const response = NextResponse.redirect(authorizeUrl);
  response.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax", // must survive Google's top-level-navigation redirect back to /callback
    path: "/",
    maxAge: STATE_MAX_AGE_SECONDS,
  });
  return response;
}
