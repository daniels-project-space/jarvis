import "server-only";

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { controlQuery } from "./control-session";
import { hasGoogleScopes } from "./google-scopes";

// Google OAuth connect infrastructure — shared access-token helper. This file
// owns:
//   1. The AES-256-GCM envelope used to store Daniel's Google refresh token
//      at rest in Convex (mirrors AesGcmSessionSnapshotCipher in
//      src/trigger/subscription-session.ts: schema byte + 12-byte nonce +
//      16-byte GCM tag + ciphertext, AAD-bound, base64-encoded for the
//      JSON-over-HTTP Convex API).
//   2. the token refresh boundary for the Gmail foreground lane and the
//      separately scoped Google Calendar primary-calendar lane. It reads the
//      connection from Convex first, and falls back to the legacy
//      GMAIL_BOOKINGS_* env vars (the same triplet src/lib/booking-email.ts
//      reads today) so nothing regresses if those ever get populated
//      before the Convex-backed connection exists.
//
// This module deliberately has no Gmail/Calendar UI logic. Calendar callers
// must use getGoogleAccessTokenForScopes(), which refuses legacy Gmail-only
// credentials unless the encrypted connection explicitly grants the scope.

export class GoogleOAuthError extends Error {}

/**
 * A non-secret diagnostic of the persisted OAuth connection. This deliberately
 * decrypts only enough to prove that the current server can read the stored
 * envelope; it never refreshes a Google access token or contacts Google.
 */
export type GoogleOAuthStoredConnectionReadiness =
  | "not_configured"
  | "missing"
  | "readable"
  | "needs_reconnect"
  | "unavailable";

const TOKEN_ENVELOPE_SCHEMA = 1 as const;
const ENVELOPE_AAD = "jarvis/google-oauth-refresh/v1";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

function encryptionKey(): Buffer {
  const raw = process.env.GOOGLE_TOKEN_ENCRYPTION_KEY?.trim();
  if (!raw) {
    throw new GoogleOAuthError(
      "GOOGLE_TOKEN_ENCRYPTION_KEY is not set; cannot encrypt or decrypt the stored Google refresh token.",
    );
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(raw)) {
    throw new GoogleOAuthError("GOOGLE_TOKEN_ENCRYPTION_KEY must be base64-encoded.");
  }
  const bytes = Buffer.from(raw, "base64");
  if (bytes.toString("base64") !== raw || bytes.byteLength !== 32) {
    throw new GoogleOAuthError("GOOGLE_TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes (AES-256 key).");
  }
  return bytes;
}

/**
 * Checks the complete server-only configuration before the browser is sent
 * to Google. Starting consent with only a client ID used to strand a user at
 * callback time when the client secret or encryption key was absent.
 */
export function isGoogleOAuthConfigurationReady(): boolean {
  if (!process.env.GOOGLE_CLIENT_ID?.trim() || !process.env.GOOGLE_CLIENT_SECRET?.trim()) return false;
  try {
    encryptionKey();
    return true;
  } catch {
    return false;
  }
}

/**
 * Encrypts a Google refresh token for storage in the `googleAccounts` Convex
 * table. Called by src/app/api/auth/google/callback/route.ts immediately
 * after the authorization-code exchange, before the plaintext token is
 * discarded. Never log the return value — it is still a bearer secret even
 * encrypted, and its plaintext source must never be logged either.
 */
export function encryptGoogleRefreshToken(refreshToken: string): string {
  const key = encryptionKey();
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(ENVELOPE_AAD, "utf8"));
  const encrypted = Buffer.concat([cipher.update(Buffer.from(refreshToken, "utf8")), cipher.final()]);
  return Buffer.concat([Buffer.from([TOKEN_ENVELOPE_SCHEMA]), nonce, cipher.getAuthTag(), encrypted]).toString(
    "base64",
  );
}

function decryptGoogleRefreshToken(envelopeB64: string): string {
  const key = encryptionKey();
  try {
    const bytes = Buffer.from(envelopeB64, "base64");
    if (bytes.byteLength < 1 + NONCE_BYTES + TAG_BYTES || bytes[0] !== TOKEN_ENVELOPE_SCHEMA) {
      throw new Error("invalid envelope");
    }
    const nonce = bytes.subarray(1, 1 + NONCE_BYTES);
    const tag = bytes.subarray(1 + NONCE_BYTES, 1 + NONCE_BYTES + TAG_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(Buffer.from(ENVELOPE_AAD, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(bytes.subarray(1 + NONCE_BYTES + TAG_BYTES)), decipher.final()]).toString(
      "utf8",
    );
  } catch (error) {
    if (error instanceof GoogleOAuthError) throw error;
    throw new GoogleOAuthError("Stored Google refresh token could not be decrypted (corrupt envelope or wrong key).");
  }
}

function isEncryptedConnection(value: unknown): value is { encryptedRefreshToken: string; scope: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { encryptedRefreshToken?: unknown }).encryptedRefreshToken === "string" &&
    typeof (value as { scope?: unknown }).scope === "string"
  );
}

/**
 * Checks whether the server can still read the saved OAuth connection without
 * exposing its envelope or spending a Google API request. A stored connection
 * can become unreadable when an operator rotates or mistypes the token
 * encryption key; surfacing that state in Options is safer than claiming the
 * account is ready until the next Gmail/Calendar action fails.
 */
export async function googleOAuthStoredConnectionReadiness(): Promise<GoogleOAuthStoredConnectionReadiness> {
  if (!isGoogleOAuthConfigurationReady()) return "not_configured";

  let raw: unknown;
  try {
    raw = await controlQuery("googleAuth:getEncryptedConnection", {
      workerToken: process.env.JARVIS_WORKER_TOKEN,
    });
  } catch {
    // A Convex outage or unavailable worker capability is not evidence that
    // Daniel needs to reconnect. Keep the recovery affordance disabled until
    // the trusted store can be checked again.
    return "unavailable";
  }

  if (raw == null) return "missing";
  if (!isEncryptedConnection(raw)) return "needs_reconnect";

  try {
    decryptGoogleRefreshToken(raw.encryptedRefreshToken);
    return "readable";
  } catch {
    return "needs_reconnect";
  }
}

type Credentials = { clientId: string; clientSecret: string; refreshToken: string; scope?: string };

async function loadCredentials(): Promise<Credentials> {
  // Convex is treated as best-effort here: a transient outage falls through
  // to the legacy env-var path below (same resilience posture as
  // adminSessionStatus() in control-session.ts, which never hard-fails a
  // temporary Convex/network blip). If legacy vars are also absent, the
  // clear GoogleOAuthError at the bottom of this function fires either way.
  let stored: { encryptedRefreshToken: string; scope: string } | null = null;
  try {
    const raw = await controlQuery("googleAuth:getEncryptedConnection", {
      workerToken: process.env.JARVIS_WORKER_TOKEN,
    });
    stored = isEncryptedConnection(raw) ? raw : null;
  } catch {
    stored = null;
  }

  if (stored) {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new GoogleOAuthError(
        "A Google account is connected but GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET are not set; cannot refresh its access token.",
      );
    }
    return {
      clientId,
      clientSecret,
      refreshToken: decryptGoogleRefreshToken(stored.encryptedRefreshToken),
      scope: stored.scope,
    };
  }

  const legacyClientId = process.env.GMAIL_BOOKINGS_CLIENT_ID;
  const legacyClientSecret = process.env.GMAIL_BOOKINGS_CLIENT_SECRET;
  const legacyRefreshToken = process.env.GMAIL_BOOKINGS_REFRESH_TOKEN;
  if (legacyClientId && legacyClientSecret && legacyRefreshToken) {
    return { clientId: legacyClientId, clientSecret: legacyClientSecret, refreshToken: legacyRefreshToken };
  }

  throw new GoogleOAuthError(
    "No Google account is connected (googleAccounts is empty) and no legacy GMAIL_BOOKINGS_CLIENT_ID/CLIENT_SECRET/REFRESH_TOKEN are configured.",
  );
}

let tokenCache: { value: string; expiresAt: number; credentialKey: string; scope?: string } | null = null;

function credentialCacheKey(credentials: Credentials): string {
  // Do not retain the refresh token itself in the cache key. This only makes
  // an in-process cache safe to invalidate when Daniel reconnects another
  // Google account or grants an additional scope.
  return createHash("sha256")
    .update(credentials.clientId)
    .update("\0")
    .update(credentials.refreshToken)
    .digest("hex");
}

async function refreshGoogleAccessToken(credentials: Credentials): Promise<string> {
  const { clientId, clientSecret, refreshToken } = credentials;
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
    cache: "no-store",
  });
  const payload = (await response.json().catch(() => ({}))) as { access_token?: unknown; expires_in?: unknown };
  if (!response.ok || typeof payload.access_token !== "string" || !payload.access_token) {
    throw new GoogleOAuthError("Google OAuth token refresh failed; the stored credentials may be invalid or revoked.");
  }
  tokenCache = {
    value: payload.access_token,
    expiresAt: Date.now() + Math.max(60, Number(payload.expires_in ?? 300) - 45) * 1000,
    credentialKey: credentialCacheKey(credentials),
    scope: credentials.scope,
  };
  return tokenCache.value;
}

/**
 * Returns a live OAuth access token for Gmail-compatible callers, refreshing
 * it from the stored (or legacy) refresh token when the cached one is near
 * expiry.
 * Mirrors the token-exchange shape and the ~45s safety margin already used
 * by accessToken() in src/lib/booking-email.ts.
 */
export async function getGoogleAccessToken(): Promise<string> {
  // Reload the connection before trusting the in-memory token. A reconnect
  // can replace Daniel's Google account or its grants while this process is
  // warm; serving the old bearer token until expiry would cross that boundary.
  const credentials = await loadCredentials();
  const key = credentialCacheKey(credentials);
  if (tokenCache && tokenCache.expiresAt > Date.now() && tokenCache.credentialKey === key) return tokenCache.value;
  return await refreshGoogleAccessToken(credentials);
}

/**
 * Returns a token only when the encrypted OAuth connection explicitly holds
 * every required scope. Unlike the Gmail-compatible helper above, this never
 * falls back to legacy `GMAIL_BOOKINGS_*` credentials because those have no
 * trustworthy Calendar-scope record.
 */
export async function getGoogleAccessTokenForScopes(requiredScopes: readonly string[]): Promise<string> {
  const credentials = await loadCredentials();
  if (!credentials.scope || !hasGoogleScopes(credentials.scope, requiredScopes)) {
    throw new GoogleOAuthError(
      "Google Calendar is not connected with the required limited calendar scope. Reconnect Google from Options to grant Calendar access.",
    );
  }
  const key = credentialCacheKey(credentials);
  if (
    tokenCache &&
    tokenCache.expiresAt > Date.now() &&
    tokenCache.credentialKey === key &&
    tokenCache.scope === credentials.scope
  ) {
    return tokenCache.value;
  }
  return await refreshGoogleAccessToken(credentials);
}
