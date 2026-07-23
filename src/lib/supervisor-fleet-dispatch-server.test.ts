import type { IdempotencyKey } from "@trigger.dev/sdk/v3";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  SupervisorFleetReservationTransportError,
  dispatchSupervisorFleetWakeTicket,
  type SupervisorFleetDispatchDependencies,
} from "./supervisor-fleet-dispatch-server";

const ticket = {
  protocolVersion: 1 as const,
  controlReceiptId: "control-resume-1",
};
const reservation = {
  jobId: "job-1",
  dispatchId: "job-1:1:1:specialist",
  attempt: 1,
  expectedAttempt: 1,
  dispatchGeneration: 1,
  dispatchPhase: "specialist",
  dispatchReceiptDigest: "e".repeat(64),
  dispatchPayloadDigest: "f".repeat(64),
  missionId: "mission-1",
  missionGroupId: "mission-group-1",
  projectGroupId: "project-group-1",
  projectRepository: "owner/repository",
  schedulingGroupKey: "group-1",
  agentId: "paul",
  label: "Paul · exact wake",
  authorityDigest: "a".repeat(64),
  workOrderRevisionDigest: "b".repeat(64),
  triggerMachinePreset: "medium-2x",
  triggerMachineReason: "admitted_write_or_hard",
  reason: "supervisor resume immediate wake",
  sourceSupervisorControlReceiptId: "must-not-reach-trigger",
  sourceSupervisorFleetDigest: "c".repeat(64),
  sourceSupervisorMemberDigest: "d".repeat(64),
};

function harness(
  reserveValue: unknown = {
    protocolVersion: 1,
    status: "reserved",
    reservations: [reservation],
  },
) {
  const reserveBatch = vi.fn(async () => reserveValue);
  const markLaunchUnknown = vi.fn(async () => true);
  const createIdempotencyKey = vi.fn(
    async () => "global:exact-agent-key" as IdempotencyKey,
  );
  const triggerBatch = vi.fn(async (): Promise<unknown> => ({
    batchId: "batch-1",
    runCount: 1,
    publicAccessToken: "must-not-leak",
  }));
  const dependencies: SupervisorFleetDispatchDependencies = {
    reserveBatch,
    markLaunchUnknown,
    createIdempotencyKey,
    triggerBatch,
  };
  return {
    dependencies,
    reserveBatch,
    markLaunchUnknown,
    createIdempotencyKey,
    triggerBatch,
  };
}

describe("receipt-bound supervisor fleet dispatch", () => {
  it("launches only the exact reserved envelope and keeps source authority server-private", async () => {
    const runtime = harness();
    await expect(dispatchSupervisorFleetWakeTicket(
      ticket,
      runtime.dependencies,
    )).resolves.toEqual({
      status: "dispatched",
      offeredCount: 1,
    });
    expect(runtime.reserveBatch).toHaveBeenCalledWith("control-resume-1");
    expect(runtime.createIdempotencyKey).toHaveBeenCalledWith([
      "jarvis-agent-dispatch-v2",
      "job-1",
      "1",
      "1",
      "specialist",
      "e".repeat(64),
      "a".repeat(64),
      "b".repeat(64),
    ], { scope: "global" });
    expect(runtime.triggerBatch).toHaveBeenCalledWith(
      "jarvis-agent-worker",
      [expect.objectContaining({
        payload: expect.objectContaining({
          jobId: "job-1",
          dispatchId: "job-1:1:1:specialist",
          dispatchReceiptDigest: "e".repeat(64),
          dispatchPayloadDigest: "f".repeat(64),
        }),
        options: expect.objectContaining({
          idempotencyKey: "global:exact-agent-key",
          idempotencyKeyTTL: "30d",
          machine: "medium-2x",
        }),
      })],
    );
    const triggerJson = JSON.stringify(runtime.triggerBatch.mock.calls);
    expect(triggerJson).not.toContain("sourceSupervisor");
    expect(triggerJson).not.toContain("must-not-reach-trigger");
    expect(triggerJson).not.toContain("c".repeat(64));
    expect(triggerJson).not.toContain("d".repeat(64));
    expect(runtime.markLaunchUnknown).not.toHaveBeenCalled();
  });

  it("fails closed before Trigger when reservation transport or shape is unknown", async () => {
    const transport = harness();
    transport.reserveBatch.mockRejectedValueOnce(
      new Error("response lost after commit"),
    );
    await expect(dispatchSupervisorFleetWakeTicket(
      ticket,
      transport.dependencies,
    )).rejects.toBeInstanceOf(SupervisorFleetReservationTransportError);
    expect(transport.triggerBatch).not.toHaveBeenCalled();

    const malformed = harness({
      protocolVersion: 1,
      status: "reserved",
      reservations: [{ ...reservation, dispatchReceiptDigest: "bad" }],
    });
    await expect(dispatchSupervisorFleetWakeTicket(
      ticket,
      malformed.dependencies,
    )).rejects.toMatchObject({
      code: "reservation_transport_unknown",
    });
    expect(malformed.triggerBatch).not.toHaveBeenCalled();

    for (const invalidReservation of [
      { ...reservation, dispatchPhase: "integration" },
      { ...reservation, dispatchId: "substituted-dispatch-id" },
    ]) {
      const invalid = harness({
        protocolVersion: 1,
        status: "reserved",
        reservations: [invalidReservation],
      });
      await expect(dispatchSupervisorFleetWakeTicket(
        ticket,
        invalid.dependencies,
      )).rejects.toMatchObject({
        code: "reservation_transport_unknown",
      });
      expect(invalid.triggerBatch).not.toHaveBeenCalled();
    }
  });

  it("enforces reservation count semantics for every mutation disposition", async () => {
    for (const value of [
      {
        protocolVersion: 1,
        status: "reserved",
        reservations: [],
      },
      {
        protocolVersion: 1,
        status: "already_inflight",
        reservations: [reservation],
      },
      {
        protocolVersion: 1,
        status: "invalid_manifest",
        reservations: [reservation],
      },
    ]) {
      const runtime = harness(value);
      await expect(dispatchSupervisorFleetWakeTicket(
        ticket,
        runtime.dependencies,
      )).rejects.toMatchObject({
        code: "reservation_transport_unknown",
      });
      expect(runtime.triggerBatch).not.toHaveBeenCalled();
    }
  });

  it("treats a definitive no-reservation disposition as a coarse hold", async () => {
    for (const status of [
      "invalid_manifest",
      "stale_manifest",
      "already_inflight",
      "already_advanced",
      "fallback_pending",
      "capacity_limited",
    ]) {
      const runtime = harness({
        protocolVersion: 1,
        status,
        reservations: [],
      });
      await expect(dispatchSupervisorFleetWakeTicket(
        ticket,
        runtime.dependencies,
      )).resolves.toEqual({ status: "held", offeredCount: 0 });
      expect(runtime.triggerBatch).not.toHaveBeenCalled();
    }
  });

  it("marks the exact receipts reconciling and resolves coarsely when Trigger acceptance is ambiguous", async () => {
    const runtime = harness();
    runtime.triggerBatch.mockRejectedValueOnce(
      new Error("response lost after acceptance"),
    );
    await expect(dispatchSupervisorFleetWakeTicket(
      ticket,
      runtime.dependencies,
    )).resolves.toEqual({
      status: "reconciling",
      offeredCount: 1,
    });
    expect(runtime.markLaunchUnknown).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: "job-1",
        dispatchId: "job-1:1:1:specialist",
        dispatchGeneration: 1,
        dispatchReceiptDigest: "e".repeat(64),
      }),
      expect.stringContaining("Trigger launch acceptance unknown"),
    );
  });

  it("does not claim durable reconciliation when an exact marking is false or lost", async () => {
    for (const marking of [
      () => Promise.resolve(false),
      () => Promise.reject(new Error("mark response lost")),
    ]) {
      const runtime = harness();
      runtime.triggerBatch.mockRejectedValueOnce(
        new Error("response lost after acceptance"),
      );
      runtime.markLaunchUnknown.mockImplementationOnce(marking);
      await expect(dispatchSupervisorFleetWakeTicket(
        ticket,
        runtime.dependencies,
      )).resolves.toEqual({
        status: "held",
        offeredCount: 1,
      });
    }
  });

  it("reconciles a partial or malformed Trigger batch acceptance", async () => {
    for (const handle of [
      { batchId: "batch-1", runCount: 0 },
      { batchId: "batch-1" },
    ]) {
      const runtime = harness();
      runtime.triggerBatch.mockResolvedValueOnce(handle);
      await expect(dispatchSupervisorFleetWakeTicket(
        ticket,
        runtime.dependencies,
      )).resolves.toEqual({
        status: "reconciling",
        offeredCount: 1,
      });
      expect(runtime.markLaunchUnknown).toHaveBeenCalledTimes(1);
    }
  });

  it("rejects malformed private tickets before reserving anything", async () => {
    const runtime = harness();
    await expect(dispatchSupervisorFleetWakeTicket(
      { ...ticket, leaked: true },
      runtime.dependencies,
    )).rejects.toBeInstanceOf(TypeError);
    expect(runtime.reserveBatch).not.toHaveBeenCalled();
  });
});
