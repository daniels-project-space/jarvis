import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { adminSessionHash, controlMutation, validateAdminSession } from "@/lib/control-session";
import { encryptGoogleRefreshToken, GoogleOAuthError, isGoogleOAuthConfigurationReady } from "@/lib/google-oauth";

// Feature 4a: completes the Google OAuth connect flow started by
// src/app/api/auth/google/start/route.ts. Validates the CSRF `state`
// cookie, exchanges the code for tokens, encrypts the refresh token
// (never the access token — that stays in-memory only, see
// src/lib/google-oauth.ts), and stores it via convex/googleAuth.ts.
//
// Never log req params, the exchange response, or the encrypted/plaintext
// token — only opaque short status codes go back to the browser, and only
// in a redirect URL, never a JSON response body.

export const runtime = "nodejs";

const STATE_COOKIE = "__Host-jarvis_google_oauth_state";

type CallbackStatus = "connected" | "error";

function redirectWithStatus(req: NextRequest, status: CallbackStatus, detail?: string): NextResponse {
  const url = new URL("/", req.url);
  url.searchParams.set("google_oauth", status);
  if (detail) url.searchParams.set("google_oauth_detail", detail.slice(0, 80));
  const response = NextResponse.redirect(url);
  // One-shot cookie: clear it whether the flow succeeded or failed.
  response.cookies.set(STATE_COOKIE, "", { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 0 });
  return response;
}

export async function GET(req: NextRequest) {
  // Defense in depth: the state-cookie check below already scopes this flow
  // to Daniel's own browser session (the cookie is httpOnly+Secure and was
  // only ever set for an admin-authenticated /start call), but re-validate
  // the admin session directly too, the same way creation-download's GET
  // handler does, in case the admin session was revoked mid-flow.
  const authTokenHash = await adminSessionHash(req);
  if (!authTokenHash || !(await validateAdminSession(authTokenHash))) {
    return NextResponse.redirect(new URL("/", req.url));
  }

  const params = req.nextUrl.searchParams;

  const providerError = params.get("error");
  if (providerError) return redirectWithStatus(req, "error", providerError);

  const returnedState = params.get("state");
  const cookieState = req.cookies.get(STATE_COOKIE)?.value;
  if (!returnedState || !cookieState || returnedState !== cookieState) {
    return redirectWithStatus(req, "error", "invalid_state");
  }

  const code = params.get("code");
  if (!code) return redirectWithStatus(req, "error", "missing_code");

  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret || !isGoogleOAuthConfigurationReady()) {
    return redirectWithStatus(req, "error", "not_configured");
  }

  const redirectUri = new URL("/api/auth/google/callback", req.url).toString();

  try {
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
      cache: "no-store",
    });
    const payload = (await tokenResponse.json().catch(() => ({}))) as {
      refresh_token?: unknown;
      access_token?: unknown;
      scope?: unknown;
    };
    if (!tokenResponse.ok || typeof payload.refresh_token !== "string" || !payload.refresh_token) {
      // Google omits refresh_token on any exchange failure, and can omit it
      // even on success if prompt=consent somehow didn't apply — either way
      // there is nothing safe to store.
      return redirectWithStatus(req, "error", "no_refresh_token");
    }

    // Best-effort only: the requested Gmail and narrow Calendar event scopes
    // do not include email/profile/openid, so Google's userinfo endpoint
    // will typically return nothing usable here. This is expected; `email`
    // is an optional display field and the flow must not fail without it.
    let email: string | undefined;
    if (typeof payload.access_token === "string" && payload.access_token) {
      try {
        const profileResponse = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
          headers: { Authorization: `Bearer ${payload.access_token}` },
          cache: "no-store",
        });
        if (profileResponse.ok) {
          const profile = (await profileResponse.json().catch(() => ({}))) as { email?: unknown };
          if (typeof profile.email === "string" && profile.email) email = profile.email;
        }
      } catch {
        // ignored — email stays undefined
      }
    }

    // Never mark a connection ready when Google omitted the returned grants.
    // We must not assume all requested scopes: consent can be partial, and a
    // Calendar client without a recorded grant must fail closed.
    const scope = typeof payload.scope === "string" ? payload.scope.trim() : "";
    if (!scope) return redirectWithStatus(req, "error", "missing_scope");
    const encryptedRefreshToken = encryptGoogleRefreshToken(payload.refresh_token);

    await controlMutation("googleAuth:upsertConnection", {
      encryptedRefreshToken,
      scope,
      email,
      authTokenHash,
    });

    return redirectWithStatus(req, "connected");
  } catch (err) {
    const detail = err instanceof GoogleOAuthError ? "encryption_failed" : "exchange_failed";
    return redirectWithStatus(req, "error", detail);
  }
}
