import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/request-auth", () => ({
  controlActor: vi.fn(),
  controlCredentials: vi.fn(() => ({ authTokenHash: "scoped" })),
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

  it("reports a stale or missing control capability as a conflict, never success", async () => {
    vi.mocked(controlActor).mockResolvedValue({ kind: "viewer" } as any);
    vi.mocked(controlMutation).mockResolvedValue(false as any);
    const response = await POST(request({ jobId: "job-1", action: "pause" }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      ok: false,
      error: "That work item cannot apply this control from its current state.",
    });
  });
});
