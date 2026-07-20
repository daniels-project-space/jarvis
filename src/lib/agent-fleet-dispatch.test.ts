import { afterEach, describe, expect, it, vi } from "vitest";

const { batchTrigger } = vi.hoisted(() => ({ batchTrigger: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@trigger.dev/sdk/v3", () => ({ tasks: { batchTrigger } }));

describe("Trigger-native agent fleet dispatch", () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    batchTrigger.mockReset();
  });

  it("reserves exact jobs before fanning them into independent Trigger runs", async () => {
    vi.stubEnv("JARVIS_WORKER_TOKEN", "worker-capability");
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      value: {
        reservations: [{
          jobId: "job-1",
          dispatchId: "job-1:1:123",
          attempt: 1,
          missionId: "mission-1",
          agentId: "paul",
          label: "Paul · launch audit",
        }],
      },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    batchTrigger.mockResolvedValue({ batchId: "batch-1" });
    const { wakeAgentFleet } = await import("./agent-fleet-dispatch");

    await expect(wakeAgentFleet("mission:mission-1", 8)).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const reserveBody = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(reserveBody).toMatchObject({
      path: "jobs:reserveDispatchBatch",
      args: { limit: 8, reason: "mission:mission-1", workerToken: "worker-capability" },
    });
    expect(batchTrigger).toHaveBeenCalledWith(
      "jarvis-agent-worker",
      [expect.objectContaining({
        payload: { jobId: "job-1", dispatchId: "job-1:1:123", reason: "mission:mission-1" },
        options: expect.objectContaining({ tags: expect.arrayContaining(["jarvis-agent", "job:job-1", "mission:mission-1"]) }),
      })],
    );
  });

  it("does not create empty workers when another supervisor reserved the queue first", async () => {
    vi.stubEnv("JARVIS_WORKER_TOKEN", "worker-capability");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ value: { reservations: [] } }), { status: 200 }),
    ));
    const { wakeAgentFleet } = await import("./agent-fleet-dispatch");

    await expect(wakeAgentFleet("overlapping-supervisor")).resolves.toBe(false);
    expect(batchTrigger).not.toHaveBeenCalled();
  });
});

