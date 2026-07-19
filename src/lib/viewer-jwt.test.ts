import { afterEach, describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, jwtVerify } from "jose";

vi.mock("server-only", () => ({}));

describe("stateless Convex viewer identity", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("mints a short-lived audience-bound ES256 token", async () => {
    const { publicKey, privateKey } = await generateKeyPair("ES256", { extractable: true });
    const privateJwk = await exportJWK(privateKey);
    Object.assign(privateJwk, { kid: "test-viewer", alg: "ES256", use: "sig" });
    const encodedJwk = Buffer.from(JSON.stringify(privateJwk)).toString("base64");
    vi.stubEnv("JARVIS_VIEWER_SIGNING_JWK_B64", encodedJwk);
    vi.stubGlobal("Buffer", undefined);

    const { issueViewerToken, verifyViewerToken, VIEWER_AUDIENCE, VIEWER_ISSUER, VIEWER_SUBJECT } = await import("./viewer-jwt");
    const issued = await issueViewerToken(1_800_000_000_000);
    const verified = await jwtVerify(issued.token, publicKey, {
      issuer: VIEWER_ISSUER,
      audience: VIEWER_AUDIENCE,
      currentDate: new Date(1_800_000_000_000),
    });

    expect(verified.payload.sub).toBe(VIEWER_SUBJECT);
    expect(verified.payload.role).toBe("viewer");
    expect(issued.expiresAt).toBeGreaterThan(1_800_000_000_000);
    await expect(verifyViewerToken(issued.token, 1_800_000_000_000)).resolves.toBe(true);
    await expect(verifyViewerToken(`${issued.token}broken`, 1_800_000_000_000)).resolves.toBe(false);
  });
});
