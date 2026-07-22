import { afterEach, describe, expect, it, vi } from "vitest";
import { isAdminSession, requireAdmin, requireDispatcher, requireViewer, requireWorker } from "../../convex/controlAuth";

function authContext(session: { tokenHash: string; expiresAt: number; enrolledAt?: number } | null) {
  return {
    db: {
      query: () => ({
        withIndex: () => ({ first: async () => session }),
      }),
    },
  };
}

describe("privileged control authentication", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("accepts only the configured worker capability", () => {
    vi.stubEnv("JARVIS_WORKER_TOKEN", "worker-secret-with-enough-entropy");
    expect(() => requireWorker("worker-secret-with-enough-entropy")).not.toThrow();
    expect(() => requireWorker("wrong-secret")).toThrow(/Unauthorized worker/);
    expect(() => requireWorker(undefined)).toThrow(/Unauthorized worker/);
  });

  it("fails closed when the worker capability is not configured", () => {
    vi.stubEnv("JARVIS_WORKER_TOKEN", "");
    expect(() => requireWorker("anything")).toThrow(/Unauthorized worker/);
  });

  it("recognizes only a live opaque admin-session digest", async () => {
    const tokenHash = "a".repeat(64);
    await expect(isAdminSession(authContext({ tokenHash, enrolledAt: Date.now(), expiresAt: Date.now() + 60_000 }), tokenHash)).resolves.toBe(true);
    await expect(isAdminSession(authContext({ tokenHash, expiresAt: Date.now() - 1 }), tokenHash)).resolves.toBe(false);
    await expect(isAdminSession(authContext(null), "not-a-digest")).resolves.toBe(false);
    await expect(isAdminSession(authContext({ tokenHash, expiresAt: Date.now() + 60_000 }), tokenHash)).resolves.toBe(false);
  });

  it("rejects missing or expired Daniel sessions", async () => {
    const tokenHash = "b".repeat(64);
    await expect(requireAdmin(authContext(null), tokenHash)).rejects.toThrow(/Authentication required/);
    await expect(
      requireAdmin(authContext({ tokenHash, expiresAt: Date.now() - 1 }), tokenHash),
    ).rejects.toThrow(/Authentication required/);
  });

  it("keeps dispatch narrower while allowing admin or scoped dispatch credentials", async () => {
    vi.stubEnv("JARVIS_WORKER_TOKEN", "worker-capability");
    vi.stubEnv("JARVIS_DISPATCH_TOKEN", "dispatch-capability");
    const tokenHash = "c".repeat(64);
    const ctx = authContext({ tokenHash, enrolledAt: Date.now(), expiresAt: Date.now() + 60_000 });
    await expect(requireDispatcher(ctx, { dispatchToken: "dispatch-capability" })).resolves.toBeUndefined();
    await expect(requireDispatcher(ctx, { workerToken: "worker-capability" })).resolves.toBeUndefined();
    await expect(requireDispatcher(ctx, { authTokenHash: tokenHash })).resolves.toBeUndefined();
    await expect(requireDispatcher(authContext(null), {})).rejects.toThrow(/Authentication required/);
  });

  it("accepts a live read-only viewer capability without treating it as admin", async () => {
    const viewerToken = "d".repeat(64);
    const ctx = {
      db: {
        query: (table: string) => ({
          withIndex: (_index: string, apply: (q: { eq: (field: string, value: string) => unknown }) => unknown) => {
            let requested = "";
            apply({ eq: (_field, value) => { requested = value; return {}; } });
            return {
              first: async () => table === "viewerSessions" && requested === viewerToken
                ? { token: viewerToken, adminTokenHash: "f".repeat(64), expiresAt: Date.now() + 60_000 }
                : table === "adminSessions" && requested === "f".repeat(64)
                  ? { tokenHash: "f".repeat(64), enrolledAt: Date.now(), expiresAt: Date.now() + 60_000 }
                  : null,
            };
          },
        }),
      },
    };
    await expect(requireViewer(ctx, { viewerToken })).resolves.toBeUndefined();
    await expect(requireAdmin(ctx, viewerToken)).rejects.toThrow(/Authentication required/);
    await expect(requireViewer(ctx, { viewerToken: "e".repeat(64) })).rejects.toThrow(/Authentication required/);
  });

  it("accepts the Convex-verified Jarvis viewer identity without a session-table read", async () => {
    const ctx = {
      auth: {
        getUserIdentity: async () => ({
          issuer: "https://jarvis-orcin-six.vercel.app",
          subject: "daniel-owner",
        }),
      },
      db: {
        query: () => {
          throw new Error("viewer identity should not touch session storage");
        },
      },
    };
    await expect(requireViewer(ctx, {})).resolves.toBeUndefined();
  });
});
