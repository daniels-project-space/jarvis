import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

describe("GET /api/health", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("returns uncached liveness with the exact release revision", async () => {
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "a".repeat(40));
    const response = GET();

    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
    await expect(response.json()).resolves.toEqual({
      ok: true,
      service: "jarvis",
      revision: "a".repeat(40),
    });
  });

  it("uses the explicit release revision when a manual Vercel deploy exposes an empty git SHA", async () => {
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "");
    vi.stubEnv("RELEASE_SHA", "b".repeat(40));

    await expect(GET().json()).resolves.toMatchObject({
      revision: "b".repeat(40),
    });
  });
});
