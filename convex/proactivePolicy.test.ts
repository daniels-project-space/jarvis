import { describe, expect, it } from "vitest";
import { countGeneralHarnessDemand, deriveProactiveSignals } from "./proactivePolicy";

const now = 2_000_000_000_000;

describe("deriveProactiveSignals", () => {
  it("leaves Goal Mode wake ownership to its dedicated coordinator", () => {
    expect(countGeneralHarnessDemand({
      now,
      goalMissionIds: new Set(["goal-1"]),
      jobs: [
        { _id: "goal-job", missionId: "goal-1", status: "pending", task: "Terra build", createdAt: now - 1_000 },
        { _id: "general-job", missionId: "mission-2", status: "pending", task: "General work", createdAt: now - 1_000 },
        { _id: "future-job", status: "pending", task: "Later", createdAt: now, nextRunAt: now + 60_000 },
      ],
    })).toBe(1);
  });

  it("detects an eligible queue with no live harness", () => {
    const signals = deriveProactiveSignals({
      now,
      goals: [],
      jobs: [{ _id: "job-1", status: "pending", task: "Build feature", createdAt: now - 21 * 60_000 }],
    });
    expect(signals[0]).toMatchObject({
      fingerprint: "proactive:agent-harness:not-claiming",
      severity: "critical",
      actionClass: "ask",
    });
  });

  it("does not call a queued job stalled while a worker heartbeat is live", () => {
    const signals = deriveProactiveSignals({
      now,
      goals: [],
      jobs: [
        { _id: "job-1", status: "pending", task: "Queued work", createdAt: now - 30 * 60_000 },
        { _id: "job-2", status: "running", task: "Active work", createdAt: now - 40 * 60_000, heartbeatAt: now - 10_000 },
      ],
    });
    expect(signals).toEqual([]);
  });

  it("surfaces only high-priority blocked outcomes", () => {
    const signals = deriveProactiveSignals({
      now,
      jobs: [],
      goals: [
        { _id: "low", project: "jarvis", title: "Someday", status: "blocked", priority: 40, updatedAt: now },
        { _id: "high", project: "jarvis", title: "Launch", status: "blocked", priority: 90, blockedBy: "Daniel must choose a direction", updatedAt: now },
      ],
    });
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ severity: "decision", actionClass: "ask" });
  });

  it("keeps system repair failures out of Daniel's duplicate task queue", () => {
    const signals = deriveProactiveSignals({
      now,
      goals: [],
      jobs: [
        { _id: "system", status: "error", task: "Repair", visibility: "system", createdAt: now - 1_000 },
        { _id: "conversation", status: "error", task: "Requested work", visibility: "conversation", createdAt: now - 1_000 },
      ],
    });
    expect(signals).toHaveLength(1);
    expect(signals[0].jobId).toBe("conversation");
  });
});
