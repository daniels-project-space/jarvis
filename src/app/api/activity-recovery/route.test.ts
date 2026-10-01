import { afterEach, describe, expect, it, vi } from "vitest";
const trigger = vi.hoisted(() => vi.fn(async (_id: string, _payload: unknown, _options: unknown) => ({ id: "run" })));
vi.mock("@trigger.dev/sdk/v3", () => ({ tasks: { trigger } }));
import { POST } from "./route";
afterEach(() => { vi.unstubAllEnvs(); trigger.mockClear(); });
function request(body: unknown, token = "worker") {
  return new Request("https://jarvis.example/api/activity-recovery", {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body),
  });
}
describe("recovery wake boundary", () => {
  it("rejects anonymous and malformed wakes before Trigger spend", async () => {
    vi.stubEnv("JARVIS_WORKER_TOKEN", "worker");
    expect((await POST(request({}, "other"))).status).toBe(401);
    expect((await POST(request({ chat: true, fleet: false, at: 0 }))).status).toBe(400);
    expect(trigger).not.toHaveBeenCalled();
  });
  it("wakes only the requested lane with a stable retry key", async () => {
    vi.stubEnv("JARVIS_WORKER_TOKEN", "worker");
    const body = { chat: false, fleet: true, at: Date.now() };
    expect((await POST(request(body))).status).toBe(200);
    expect((await POST(request(body))).status).toBe(200);
    expect(trigger.mock.calls[0]).toEqual(trigger.mock.calls[1]);
    expect(trigger).toHaveBeenCalledWith("jarvis-agent-fleet-supervisor", {}, { idempotencyKey: expect.stringContaining("activity-recovery-") });
  });
});
