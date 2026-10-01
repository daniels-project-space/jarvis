import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
vi.mock("@/lib/control-session", () => ({ adminSessionHash: vi.fn(), validateAdminSession: vi.fn() }));
vi.mock("@/lib/viewer-jwt", () => ({ verifyViewerToken: vi.fn() }));
vi.mock("@/lib/canonical-origin", () => ({ canonicalJarvisRedirect: () => null }));
vi.mock("@trigger.dev/sdk/v3", () => ({ tasks: { trigger: vi.fn() } }));
import { proxy } from "./proxy";
import { POST } from "./app/api/activity-recovery/route";
describe("worker recovery through the real public-path rule", () => {
  it("reaches route authentication without a browser session and rejects anonymous spend", async () => {
    const request = new NextRequest("https://jarvis-orcin-six.vercel.app/api/activity-recovery", { method: "POST" });
    expect((await proxy(request)).headers.get("x-middleware-next")).toBe("1");
    expect((await POST(request)).status).toBe(401);
  });
});
