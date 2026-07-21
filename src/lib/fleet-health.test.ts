import { describe, expect, it } from "vitest";
import { classifyFleetHealth } from "./fleet-health";

describe("mechanical fleet health", () => {
  it("keeps a multi-hour provider task healthy while heartbeats are fresh", () => {
    const now = Date.now();
    expect(classifyFleetHealth({ status: "running", stage: "provider upload", heartbeatAt: now - 1_000 }, now)).toBe("provider-waiting");
    expect(classifyFleetHealth({ status: "running", stage: "implementation", heartbeatAt: now - 1_000 }, now)).toBe("active");
  });

  it("classifies retries, checkpoints, lost leases, and terminals without model judgement", () => {
    const now = Date.now();
    expect(classifyFleetHealth({ status: "pending", nextRunAt: now + 60_000 }, now)).toBe("retry-due");
    expect(classifyFleetHealth({ status: "paused", checkpoint: "safe" }, now)).toBe("checkpointed");
    expect(classifyFleetHealth({ status: "running", heartbeatAt: now - 6 * 60_000 }, now)).toBe("stalled");
    expect(classifyFleetHealth({ status: "done" }, now)).toBe("terminal");
  });
});
