import { afterEach, describe, expect, it, vi } from "vitest";

const { wakeAgentFleet } = vi.hoisted(() => ({ wakeAgentFleet: vi.fn() }));

vi.mock("@trigger.dev/sdk/v3", () => ({
  schedules: { task: vi.fn((definition) => definition) },
}));
vi.mock("../lib/agent-fleet-dispatch", () => ({ wakeAgentFleet }));
vi.mock("./push-send", () => ({ sendPush: vi.fn() }));

describe("insight recovery wake", () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    wakeAgentFleet.mockReset();
  });

  it("wakes after every durable recovery class, not just a specialist retry", async () => {
    const { shouldWakeFleetAfterInsightSweep } = await import("./insight-engine");

    expect(shouldWakeFleetAfterInsightSweep({ reaped: { releasedDispatches: ["job-1"] } })).toBe(true);
    expect(shouldWakeFleetAfterInsightSweep({ reaped: { expiredControllers: ["integration-1"] } })).toBe(true);
    expect(shouldWakeFleetAfterInsightSweep({ reaped: { requeued: ["job-2"] } })).toBe(true);
    expect(shouldWakeFleetAfterInsightSweep({ stuckRequeued: 1 })).toBe(true);
    expect(shouldWakeFleetAfterInsightSweep({ eligiblePending: 0, reaped: {}, stuckRequeued: 0 })).toBe(false);
  });

  it("keeps recovery autonomous when optional proactive reconciliation is unavailable", async () => {
    vi.stubEnv("JARVIS_WORKER_TOKEN", "worker-capability");
    vi.stubEnv("CONVEX_URL", "https://jarvis.test");
    wakeAgentFleet.mockResolvedValue(true);
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (body.path === "jobs:reapStale") {
        return new Response(JSON.stringify({ value: {
          requeued: [], releasedDispatches: ["job-1"], abandoned: [], expiredControllers: [],
        } }), { status: 200 });
      }
      if (body.path === "chatQueue:reapStuck") {
        return new Response(JSON.stringify({ value: { requeued: 0 } }), { status: 200 });
      }
      if (body.path === "proactive:reconcile") {
        return new Response(JSON.stringify({ status: "error", errorMessage: "optional triage unavailable" }), { status: 503 });
      }
      throw new Error(`unexpected ${body.path}`);
    }));
    const { runInsightSweep } = await import("./insight-engine");

    await expect(runInsightSweep()).resolves.toMatchObject({ woken: true, recovered: 0 });
    expect(wakeAgentFleet).toHaveBeenCalledWith("proactive-reconcile");
  });
});
