import "server-only";
import { importJWK, jwtVerify, SignJWT, type JWK } from "jose";

export const VIEWER_ISSUER = "https://jarvis-orcin-six.vercel.app";
export const VIEWER_AUDIENCE = "jarvis-convex";
export const VIEWER_SUBJECT = "daniel-owner";
export const VIEWER_TOKEN_SECONDS = 6 * 60 * 60;
export const GUEST_SUBJECT_PREFIX = "jarvis-guest:";

export type BrowserIdentity =
  | { kind: "owner" }
  | { kind: "guest"; guestId: string };

let signingKey: Promise<CryptoKey> | null = null;
let verificationKey: Promise<CryptoKey> | null = null;

function configuredJwk(): JWK {
  const encoded = process.env.JARVIS_VIEWER_SIGNING_JWK_B64;
  if (!encoded) throw new Error("Viewer signing key is not configured");
  // Proxy can execute in an Edge isolate where Node's Buffer global does not
  // exist. JWK JSON is ASCII, so the Web-standard decoder works in both the
  // Node route that issues capabilities and the Proxy that verifies them.
  return JSON.parse(atob(encoded)) as JWK;
}

async function getSigningKey(): Promise<CryptoKey> {
  if (signingKey) return await signingKey;
  signingKey = (async () => {
    return await importJWK(configuredJwk(), "ES256") as CryptoKey;
  })();
  return await signingKey;
}

async function getVerificationKey(): Promise<CryptoKey> {
  if (verificationKey) return await verificationKey;
  verificationKey = (async () => {
    // Import a public-only key. A private WebCrypto key has `sign` usage and
    // cannot be passed to subtle.verify even though it contains x/y. Private
    // JWKs may also be provisioned with key_ops=["sign"]; carrying that onto
    // the public copy makes jose reject it as a verification key.
    const publicJwk = { ...configuredJwk() };
    delete publicJwk.d;
    delete publicJwk.key_ops;
    return await importJWK(publicJwk, "ES256") as CryptoKey;
  })();
  return await verificationKey;
}

export async function issueViewerToken(
  identity: BrowserIdentity = { kind: "owner" },
  nowMs = Date.now(),
): Promise<{ token: string; expiresAt: number }> {
  const issuedAt = Math.floor(nowMs / 1000);
  const expiresAtSeconds = issuedAt + VIEWER_TOKEN_SECONDS;
  const jwk = configuredJwk();
  const subject = identity.kind === "owner" ? VIEWER_SUBJECT : `${GUEST_SUBJECT_PREFIX}${identity.guestId}`;
  const token = await new SignJWT({ role: identity.kind, project: "jarvis" })
    .setProtectedHeader({ alg: "ES256", typ: "JWT", kid: String(jwk.kid ?? "jarvis-viewer") })
    .setIssuer(VIEWER_ISSUER)
    .setAudience(VIEWER_AUDIENCE)
    .setSubject(subject)
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAtSeconds)
    .sign(await getSigningKey());
  return { token, expiresAt: expiresAtSeconds * 1000 };
}

/**
 * Verify the short-lived capability already used by Convex subscriptions.
 * Embedded browsers commonly block third-party cookies, so the same signed
 * identity also authenticates Jarvis's same-origin API calls without exposing
 * an admin cookie or a worker capability to the browser.
 */
export async function verifyViewerToken(token: string | null | undefined, nowMs = Date.now()): Promise<BrowserIdentity | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, await getVerificationKey(), {
      algorithms: ["ES256"],
      issuer: VIEWER_ISSUER,
      audience: VIEWER_AUDIENCE,
      currentDate: new Date(nowMs),
    });
    if (payload.project !== "jarvis") return null;
    if (payload.role === "owner" && payload.sub === VIEWER_SUBJECT) return { kind: "owner" };
    if (
      payload.role === "guest"
      && typeof payload.sub === "string"
      && payload.sub.startsWith(GUEST_SUBJECT_PREFIX)
    ) {
      const guestId = payload.sub.slice(GUEST_SUBJECT_PREFIX.length);
      if (/^[A-Za-z0-9_-]{32,128}$/.test(guestId)) return { kind: "guest", guestId };
    }
    return null;
  } catch {
    return null;
  }
}
