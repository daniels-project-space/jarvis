import { describe, expect, it, vi } from "vitest";
import type { IdempotencyKey } from "@trigger.dev/sdk/v3";

const trigger = vi.hoisted(() => {
  const metadata = {
    set: vi.fn(),
    flush: vi.fn(async () => undefined),
  };
  metadata.set.mockImplementation(() => metadata);
  return {
    metadata,
    batchTrigger: vi.fn(async () => ({ batchId: "unused-batch" })),
    triggerTask: vi.fn(async () => ({ id: "unused-trigger-run" })),
    createIdempotencyKey: vi.fn(async () => "unused-idempotency-key"),
  };
});

vi.mock("@trigger.dev/sdk/v3", () => ({
  metadata: trigger.metadata,
  task: (definition: unknown) => definition,
  schedules: { task: (definition: unknown) => definition },
  tasks: {
    batchTrigger: trigger.batchTrigger,
    trigger: trigger.triggerTask,
  },
  idempotencyKeys: { create: trigger.createIdempotencyKey },
  timeout: { None: "none" },
}));

import {
  dispatchMissionSupervisorWakeTicket,
  type MissionSupervisorServerDispatchDependencies,
} from "../lib/mission-supervisor-dispatch-runtime";
import {
  handoffCompletedAgentWorker,
  type AgentWorkerCompletionHandoffDependencies,
} from "./agent-runner";

const TICKET = {
  protocolVersion: 1 as const,
  missionId: "mission-supervisor-handoff",
  expectedLeaseVersion: 3,
  expectedEpoch: 2,
  expectedDecisionSequence: 4,
  expectedInputRevision: 7,
};

describe("agent worker supervisor completion handoff", () => {
  it("replays one exact ticket through the same Trigger idempotency identity", async () => {
    let run = 0;
    const triggerTick = vi.fn<
      MissionSupervisorServerDispatchDependencies["triggerTick"]
    >(async () => ({
      id: `supervisor-run-${++run}`,
    }));
    const createIdempotencyKey = vi.fn<
      MissionSupervisorServerDispatchDependencies["createIdempotencyKey"]
    >(
      async (material: string) => `global:${material}` as IdempotencyKey,
    );
    const dispatchDependencies: MissionSupervisorServerDispatchDependencies = {
      isConfigured: () => true,
      createIdempotencyKey,
      triggerTick,
    };
    const query = vi.fn(async () => TICKET);
    const wakeFleet = vi.fn(async () => true);
    const dependencies: AgentWorkerCompletionHandoffDependencies = {
      query,
      dispatchWakeTicket: async (ticket) =>
        await dispatchMissionSupervisorWakeTicket(
          ticket,
          dispatchDependencies,
        ),
      wakeFleet,
    };

    await expect(handoffCompletedAgentWorker(
      "job-supervised-handoff",
      dependencies,
    )).resolves.toEqual({
      supervisorContinued: true,
      continued: true,
    });
    await expect(handoffCompletedAgentWorker(
      "job-supervised-handoff",
      dependencies,
    )).resolves.toEqual({
      supervisorContinued: true,
      continued: true,
    });

    expect(query).toHaveBeenNthCalledWith(
      1,
      "missionSupervisorHandoff:completionWakeTicketV1",
      { jobId: "job-supervised-handoff" },
    );
    expect(createIdempotencyKey).toHaveBeenCalledTimes(2);
    expect(createIdempotencyKey.mock.calls[0]).toEqual(
      createIdempotencyKey.mock.calls[1],
    );
    expect(triggerTick).toHaveBeenCalledTimes(2);
    expect(triggerTick.mock.calls[0]?.[2]).toEqual(
      triggerTick.mock.calls[1]?.[2],
    );
    expect(triggerTick.mock.calls[0]?.[2]).toMatchObject({
      idempotencyKeyTTL: "1m",
    });
    expect(wakeFleet).toHaveBeenNthCalledWith(
      1,
      "worker-complete:job-supervised-handoff",
    );
    expect(wakeFleet).toHaveBeenCalledTimes(2);
  });

  it("retains the generic fleet wake when direct dispatch fails ambiguously", async () => {
    const query = vi.fn(async () => TICKET);
    const dispatchWakeTicket = vi.fn(async () => {
      throw new Error("ambiguous Trigger failure");
    });
    const wakeFleet = vi.fn(async () => true);

    await expect(handoffCompletedAgentWorker(
      "job-dispatch-failure",
      { query, dispatchWakeTicket, wakeFleet },
    )).resolves.toEqual({
      supervisorContinued: false,
      continued: true,
    });
    expect(dispatchWakeTicket).toHaveBeenCalledWith(TICKET);
    expect(wakeFleet).toHaveBeenCalledWith(
      "worker-complete:job-dispatch-failure",
    );
  });

  it("skips direct dispatch without a ticket but still wakes the fleet", async () => {
    const query = vi.fn(async () => null);
    const dispatchWakeTicket = vi.fn(async () => ({
      dispatched: true,
    }));
    const wakeFleet = vi.fn(async () => true);

    await expect(handoffCompletedAgentWorker(
      "job-not-supervised",
      { query, dispatchWakeTicket, wakeFleet },
    )).resolves.toEqual({
      supervisorContinued: false,
      continued: true,
    });
    expect(dispatchWakeTicket).not.toHaveBeenCalled();
    expect(wakeFleet).toHaveBeenCalledWith(
      "worker-complete:job-not-supervised",
    );
  });
});
