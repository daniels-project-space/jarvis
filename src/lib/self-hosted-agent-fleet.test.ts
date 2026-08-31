import { describe, expect, it, vi } from "vitest";
import type { AgentFleetReservation } from "./agent-fleet-dispatch";
import {
  runSelfHostedAgentFleetController,
  type SelfHostedAgentFleetDependencies,
} from "./self-hosted-agent-fleet";

const reservation: AgentFleetReservation = {
  jobId: "job-1",
  dispatchId: "job-1:1:dispatch",
  attempt: 1,
  expectedAttempt: 1,
  dispatchGeneration: 1,
  dispatchPhase: "specialist",
  dispatchReceiptDigest: "e".repeat(64),
  dispatchPayloadDigest: "f".repeat(64),
  missionId: "mission-1",
  agentId: "paul",
  label: "Paul · bounded repair",
  authorityDigest: "a".repeat(64),
  workOrderRevisionDigest: "b".repeat(64),
  triggerMachinePreset: "medium-1x",
  triggerMachineReason: "admitted_bounded_read",
  reason: "selfhost test",
};

function dependencies(overrides: Partial<SelfHostedAgentFleetDependencies> = {}) {
  const defaults: SelfHostedAgentFleetDependencies = {
    activateProtocol: vi.fn(async () => undefined),
    validateProvider: vi.fn(async () => undefined),
    resumeProviderHolds: vi.fn(async () => undefined),
    runMaintenance: vi.fn(async () => undefined),
    runSupervisorSweep: vi.fn(async () => undefined),
    reserve: vi.fn(async () => []),
    runJob: vi.fn(async () => undefined),
    wait: vi.fn(async () => undefined),
    now: vi.fn(() => 1_000),
  };
  return { ...defaults, ...overrides };
}

describe("self-hosted durable agent fleet controller", () => {
  it("fails before job admission when provider proof is unavailable", async () => {
    const abort = new AbortController();
    const deps = dependencies({
      validateProvider: vi.fn(async () => { throw new Error("proof rejected"); }),
    });

    await expect(runSelfHostedAgentFleetController(1_000, abort.signal, deps)).rejects.toThrow("proof rejected");
    expect(deps.activateProtocol).not.toHaveBeenCalled();
    expect(deps.reserve).not.toHaveBeenCalled();
    expect(deps.runJob).not.toHaveBeenCalled();
  });

  it("uses the existing reservation authority and immediately checks successors", async () => {
    const abort = new AbortController();
    const reserve = vi.fn()
      .mockResolvedValueOnce([reservation])
      .mockImplementationOnce(async () => {
        abort.abort();
        return [];
      });
    const deps = dependencies({ reserve });

    await runSelfHostedAgentFleetController(1_000, abort.signal, deps);

    expect(deps.validateProvider).toHaveBeenCalledBefore(deps.activateProtocol as ReturnType<typeof vi.fn>);
    expect(deps.resumeProviderHolds).toHaveBeenCalledTimes(1);
    expect(deps.runJob).toHaveBeenCalledWith(reservation, abort.signal);
    expect(reserve).toHaveBeenNthCalledWith(1, "selfhost-daemon", 1);
    expect(reserve).toHaveBeenCalledTimes(2);
    expect(deps.wait).not.toHaveBeenCalled();
    expect(deps.runSupervisorSweep).toHaveBeenCalledTimes(1);
  });

  it("idles without inventing work and wakes from the abort signal", async () => {
    const abort = new AbortController();
    const wait = vi.fn(async (_delay: number, signal: AbortSignal) => {
      expect(signal).toBe(abort.signal);
      abort.abort();
    });
    const deps = dependencies({ wait });

    await runSelfHostedAgentFleetController(750, abort.signal, deps);

    expect(deps.reserve).toHaveBeenCalledWith("selfhost-daemon", 1);
    expect(deps.runJob).not.toHaveBeenCalled();
    expect(wait).toHaveBeenCalledWith(750, abort.signal);
  });

  it("does not let a stuck maintenance or supervisor sweep block queued work", async () => {
    const abort = new AbortController();
    const reserve = vi.fn()
      .mockResolvedValueOnce([reservation])
      .mockImplementationOnce(async () => {
        abort.abort();
        return [];
      });
    const never = () => new Promise<void>(() => undefined);
    const deps = dependencies({
      reserve,
      runMaintenance: vi.fn(never),
      runSupervisorSweep: vi.fn(never),
    });

    await runSelfHostedAgentFleetController(1_000, abort.signal, deps);

    expect(deps.runMaintenance).toHaveBeenCalledTimes(1);
    expect(deps.runSupervisorSweep).toHaveBeenCalledTimes(1);
    expect(deps.runJob).toHaveBeenCalledWith(reservation, abort.signal);
    expect(reserve).toHaveBeenCalledTimes(2);
  });
});
