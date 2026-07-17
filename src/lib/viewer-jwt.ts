import "server-only";
import { importJWK, SignJWT, type JWK } from "jose";

export const VIEWER_ISSUER = "https://jarvis-orcin-six.vercel.app";
export const VIEWER_AUDIENCE = "jarvis-convex";
export const VIEWER_SUBJECT = "daniel-owner";
export const VIEWER_TOKEN_SECONDS = 6 * 60 * 60;

let signingKey: Promise<CryptoKey> | null = null;

async function getSigningKey(): Promise<CryptoKey> {
  if (signingKey) return await signingKey;
  signingKey = (async () => {
    const encoded = process.env.JARVIS_VIEWER_SIGNING_JWK_B64;
    if (!encoded) throw new Error("Viewer signing key is not configured");
    const jwk = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as JWK;
    return await importJWK(jwk, "ES256") as CryptoKey;
  })();
  return await signingKey;
}

export async function issueViewerToken(nowMs = Date.now()): Promise<{ token: string; expiresAt: number }> {
  const issuedAt = Math.floor(nowMs / 1000);
  const expiresAtSeconds = issuedAt + VIEWER_TOKEN_SECONDS;
  const encoded = process.env.JARVIS_VIEWER_SIGNING_JWK_B64;
  if (!encoded) throw new Error("Viewer signing key is not configured");
  const jwk = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as JWK;
  const token = await new SignJWT({ role: "viewer", project: "jarvis" })
    .setProtectedHeader({ alg: "ES256", typ: "JWT", kid: String(jwk.kid ?? "jarvis-viewer") })
    .setIssuer(VIEWER_ISSUER)
    .setAudience(VIEWER_AUDIENCE)
    .setSubject(VIEWER_SUBJECT)
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAtSeconds)
    .sign(await getSigningKey());
  return { token, expiresAt: expiresAtSeconds * 1000 };
}
