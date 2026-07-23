import { afterEach, describe, expect, it, vi } from "vitest";

const { batchTrigger, createIdempotencyKey } = vi.hoisted(() => ({
  batchTrigger: vi.fn(),
  createIdempotencyKey: vi.fn(async (material: string[]) => `global:${material.join(":")}`),
}));

vi.mock("server-only", () => ({}));
vi.mock("@trigger.dev/sdk/v3", () => ({
  tasks: { batchTrigger },
  idempotencyKeys: { create: createIdempotencyKey },
}));

describe("Trigger-native agent fleet dispatch", () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    batchTrigger.mockReset();
    createIdempotencyKey.mockClear();
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
          authorityDigest: "a".repeat(64),
          workOrderRevisionDigest: "b".repeat(64),
          triggerMachinePreset: "medium-2x",
          triggerMachineReason: "admitted_write_or_hard",
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
        payload: expect.objectContaining({
          jobId: "job-1",
          dispatchId: "job-1:1:123",
          expectedAttempt: 1,
          authorityDigest: "a".repeat(64),
          workOrderRevisionDigest: "b".repeat(64),
          triggerMachinePreset: "medium-2x",
          triggerMachineReason: "admitted_write_or_hard",
          reason: "mission:mission-1",
        }),
        options: expect.objectContaining({
          machine: "medium-2x",
          idempotencyKey: expect.stringContaining("global:jarvis-agent-attempt-v2:job-1:1:"),
          idempotencyKeyTTL: "30d",
          tags: expect.arrayContaining(["jarvis-agent", "job:job-1", "mission:mission-1"]),
        }),
      })],
    );
    expect(createIdempotencyKey).toHaveBeenCalledWith([
      "jarvis-agent-attempt-v2", "job-1", "1", "a".repeat(64), "b".repeat(64),
    ], { scope: "global" });
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

  it("keeps an ambiguous launch reconciling under the same immutable global key", async () => {
    vi.stubEnv("JARVIS_WORKER_TOKEN", "worker-capability");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        value: {
          reservations: [{
            jobId: "job-read",
            dispatchId: "job-read:2:456",
            attempt: 2,
            missionId: null,
            agentId: "rose",
            label: "bounded audit",
            authorityDigest: "c".repeat(64),
            workOrderRevisionDigest: "d".repeat(64),
            triggerMachinePreset: "medium-1x",
            triggerMachineReason: "admitted_bounded_read",
          }],
        },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ value: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    batchTrigger.mockRejectedValueOnce(new Error("response lost"));
    const { wakeAgentFleet } = await import("./agent-fleet-dispatch");

    await expect(wakeAgentFleet("reconcile")).resolves.toBe(false);
    expect(batchTrigger).toHaveBeenCalledWith(
      "jarvis-agent-worker",
      [expect.objectContaining({
        options: expect.objectContaining({ machine: "medium-1x", idempotencyKeyTTL: "30d" }),
      })],
    );
    const reconcileBody = JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body));
    expect(reconcileBody).toMatchObject({
      path: "jobs:markDispatchLaunchUnknown",
      args: {
        jobId: "job-read",
        dispatchId: "job-read:2:456",
        workerToken: "worker-capability",
      },
    });
  });
});
