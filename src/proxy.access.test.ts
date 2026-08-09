import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/canonical-origin", () => ({ canonicalJarvisRedirect: () => null }));
vi.mock("@/lib/control-session", () => ({
  adminSessionHash: vi.fn(async () => null),
  validateAdminSession: vi.fn(async () => false),
}));
vi.mock("@/lib/request-auth", () => ({ bearerToken: () => null }));
vi.mock("@/lib/viewer-jwt", () => ({ verifyViewerToken: vi.fn(async () => null) }));
vi.mock("@/lib/public-path", () => ({ isJarvisPublicPath: () => false }));

import { proxy } from "./proxy";

describe("open Jarvis overlay boundary", () => {
  it("loads without a host allowlist, declared origin, referrer, or frame restriction", async () => {
    const response = await proxy(new NextRequest("https://jarvis-orcin-six.vercel.app/embed"));

    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.headers.get("content-security-policy")).toBeNull();
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("does not turn an unknown referrer into an access error", async () => {
    const response = await proxy(new NextRequest("https://jarvis-orcin-six.vercel.app/embed", {
      headers: { referer: "https://unregistered.example/app" },
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });
});
