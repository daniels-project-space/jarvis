import type { IdempotencyKey } from "@trigger.dev/sdk/v3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  MissionSupervisorServerDispatchError,
  dispatchMissionSupervisorWakeTicket,
  type MissionSupervisorServerDispatchDependencies,
} from "./mission-supervisor-dispatch-server";
import {
  MISSION_SUPERVISOR_TICK_TASK_ID,
  MissionSupervisorDispatchContractError,
  missionSupervisorDispatchIdentity,
  type MissionSupervisorWakeTicket,
} from "./mission-supervisor-dispatch";

const ticket: MissionSupervisorWakeTicket = {
  protocolVersion: 1,
  missionId: "mission-immediate-wake-1",
  expectedLeaseVersion: 4,
  expectedEpoch: 2,
  expectedDecisionSequence: 9,
  expectedInputRevision: 13,
};
const globalKey =
  "global:mission-supervisor-test-key" as IdempotencyKey;
const SUPERVISOR_ROLLOUT_ENV = "JARVIS_MISSION_SUPERVISOR_ROLLOUT";

function harness(options: {
  configured?: boolean;
  trigger?: MissionSupervisorServerDispatchDependencies["triggerTick"];
} = {}) {
  const createIdempotencyKey = vi.fn(async () => globalKey);
  const triggerTick = vi.fn(
    options.trigger
      ?? (async () => ({
        id: "run-immediate-wake-1",
        publicAccessToken: "public-test-token",
      })),
  );
  const isConfigured = vi.fn(() => options.configured ?? true);
  const dependencies: MissionSupervisorServerDispatchDependencies = {
    isConfigured,
    createIdempotencyKey,
    triggerTick,
  };
  return {
    dependencies,
    isConfigured,
    createIdempotencyKey,
    triggerTick,
  };
}

describe("mission supervisor Next server dispatch", () => {
  beforeEach(() => {
    vi.stubEnv(SUPERVISOR_ROLLOUT_ENV, "active");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("treats a null wake ticket as an intentional no-op", async () => {
    const runtime = harness();
    await expect(dispatchMissionSupervisorWakeTicket(
      null,
      runtime.dependencies,
    )).resolves.toEqual({
      dispatched: false,
      reason: "no_wake_ticket",
    });
    expect(runtime.isConfigured).not.toHaveBeenCalled();
    expect(runtime.createIdempotencyKey).not.toHaveBeenCalled();
    expect(runtime.triggerTick).not.toHaveBeenCalled();
  });

  it.each(["dormant", "rollback"])(
    "does no ticket, Trigger config, or idempotency work while %s",
    async (rollout) => {
      vi.stubEnv(SUPERVISOR_ROLLOUT_ENV, rollout);
      const runtime = harness({ configured: false });

      await expect(dispatchMissionSupervisorWakeTicket(
        undefined,
        runtime.dependencies,
      )).resolves.toEqual({
        dispatched: false,
        reason: "supervisor_rollout_disabled",
      });
      expect(runtime.isConfigured).not.toHaveBeenCalled();
      expect(runtime.createIdempotencyKey).not.toHaveBeenCalled();
      expect(runtime.triggerTick).not.toHaveBeenCalled();
    },
  );

  it("fails before Trigger on malformed tickets or missing configuration", async () => {
    const malformed = harness();
    await expect(dispatchMissionSupervisorWakeTicket(
      undefined,
      malformed.dependencies,
    )).rejects.toBeInstanceOf(MissionSupervisorDispatchContractError);
    expect(malformed.isConfigured).not.toHaveBeenCalled();
    expect(malformed.createIdempotencyKey).not.toHaveBeenCalled();
    expect(malformed.triggerTick).not.toHaveBeenCalled();

    const unconfigured = harness({ configured: false });
    await expect(dispatchMissionSupervisorWakeTicket(
      ticket,
      unconfigured.dependencies,
    )).rejects.toMatchObject({
      name: "MissionSupervisorServerDispatchError",
      code: "trigger_not_configured",
    });
    expect(unconfigured.createIdempotencyKey).not.toHaveBeenCalled();
    expect(unconfigured.triggerTick).not.toHaveBeenCalled();
  });

  it("dispatches only the exact tick task and returns its accepted handle", async () => {
    const runtime = harness();
    const identity = missionSupervisorDispatchIdentity(ticket);
    const result = await dispatchMissionSupervisorWakeTicket(
      ticket,
      runtime.dependencies,
    );
    expect(runtime.createIdempotencyKey).toHaveBeenCalledWith(
      identity.idempotencyKey,
      { scope: "global" },
    );
    expect(runtime.triggerTick).toHaveBeenCalledWith(
      MISSION_SUPERVISOR_TICK_TASK_ID,
      ticket,
      {
        idempotencyKey: globalKey,
        idempotencyKeyTTL: "1m",
        concurrencyKey: identity.concurrencyKey,
        tags: identity.tags,
      },
    );
    expect(result).toEqual({
      dispatched: true,
      runId: "run-immediate-wake-1",
      handle: {
        id: "run-immediate-wake-1",
        publicAccessToken: "public-test-token",
      },
      payload: ticket,
      idempotencyKey: identity.idempotencyKey,
    });
  });

  it("preserves exact dispatch in canary rollout", async () => {
    vi.stubEnv(SUPERVISOR_ROLLOUT_ENV, "canary");
    const runtime = harness();

    await expect(dispatchMissionSupervisorWakeTicket(
      ticket,
      runtime.dependencies,
    )).resolves.toMatchObject({
      dispatched: true,
      runId: "run-immediate-wake-1",
    });
    expect(runtime.isConfigured).toHaveBeenCalledOnce();
    expect(runtime.createIdempotencyKey).toHaveBeenCalledOnce();
    expect(runtime.triggerTick).toHaveBeenCalledOnce();
  });

  it("surfaces an ambiguous launch failure and reuses the same retry identity", async () => {
    let attempt = 0;
    const runtime = harness({
      trigger: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error("transport failed after acceptance");
        return { id: "run-reconciled-retry" };
      },
    });
    const identity = missionSupervisorDispatchIdentity(ticket);

    await expect(dispatchMissionSupervisorWakeTicket(
      { ...ticket },
      runtime.dependencies,
    )).rejects.toMatchObject({
      name: "MissionSupervisorServerDispatchError",
      code: "trigger_dispatch_failed",
      cause: expect.objectContaining({
        message: "transport failed after acceptance",
      }),
    });
    await expect(dispatchMissionSupervisorWakeTicket(
      { ...ticket },
      runtime.dependencies,
    )).resolves.toMatchObject({
      dispatched: true,
      runId: "run-reconciled-retry",
      idempotencyKey: identity.idempotencyKey,
    });
    expect(runtime.createIdempotencyKey).toHaveBeenCalledTimes(2);
    expect(runtime.createIdempotencyKey.mock.calls).toEqual([
      [identity.idempotencyKey, { scope: "global" }],
      [identity.idempotencyKey, { scope: "global" }],
    ]);
    expect(runtime.triggerTick.mock.calls[0]).toEqual(
      runtime.triggerTick.mock.calls[1],
    );
  });

  it("rejects an accepted response without a usable run identity", async () => {
    const runtime = harness({
      trigger: async () => ({ id: "" }),
    });
    const dispatched = dispatchMissionSupervisorWakeTicket(
      ticket,
      runtime.dependencies,
    );
    await expect(dispatched)
      .rejects.toBeInstanceOf(MissionSupervisorServerDispatchError);
    await expect(dispatched).rejects.toMatchObject({
      code: "invalid_trigger_handle",
    });
  });
});
