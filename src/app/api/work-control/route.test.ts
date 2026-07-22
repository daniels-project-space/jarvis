import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/request-auth", () => ({
  controlActor: vi.fn(),
  controlCredentials: vi.fn(() => ({ authTokenHash: "scoped" })),
  isOwnerActor: (actor: { kind?: string }) => actor.kind === "owner",
}));
vi.mock("@/lib/control-session", () => ({ controlMutation: vi.fn() }));
vi.mock("@/lib/agent-fleet-dispatch", () => ({ wakeAgentFleet: vi.fn() }));

import { controlMutation } from "@/lib/control-session";
import { controlActor } from "@/lib/request-auth";
import { POST } from "./route";

function request(body: Record<string, unknown>) {
  return new Request("https://jarvis-orcin-six.vercel.app/api/work-control", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }) as any;
}

describe("authenticated work-control errors", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 401 before reading or mutating work without a controller actor", async () => {
    vi.mocked(controlActor).mockResolvedValue(null);
    const response = await POST(request({ jobId: "job-1", action: "pause" }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ ok: false });
    expect(controlMutation).not.toHaveBeenCalled();
  });

  it("rejects a guest before reading or mutating privileged control", async () => {
    vi.mocked(controlActor).mockResolvedValue({ kind: "guest", guestId: "g".repeat(32) } as any);
    const response = await POST(request({ jobId: "job-1", action: "pause" }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      ok: false,
      error: "owner enrollment required",
    });
    expect(controlMutation).not.toHaveBeenCalled();
  });
});
