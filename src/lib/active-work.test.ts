import { describe, expect, it } from "vitest";
import {
  cacheCompactWorkSnapshot,
  needsDaniel,
  retainedFleetSelection,
  visibleWorkSnapshot,
  type CompactWorkCache,
  type CompactWorkSnapshot,
} from "./active-work";

function snapshot(stage = "dispatching"): CompactWorkSnapshot {
  return {
    active: { id: "job-1", missionId: "mission-1", label: "Paul · current repair", status: stage === "dispatching" ? "dispatching" : "running", stage, percent: stage === "dispatching" ? 2 : 64, model: "terra", reasoningEffort: "high", modelReason: "Standard implementation route", extraCount: 2, needsDaniel: false },
    fleet: {
      id: "mission-1", goal: "Repair this request", mode: "goal", status: "running", phase: stage,
      percent: 64, repository: "daniels-project-space/jarvis", planDigest: "digest", planGeneration: 2,
      integrationState: "building", attentionCount: 0, controls: ["pause", "cancel", "steer"], edges: [],
      nodes: [{
        id: "surface", jobId: "job-1", label: "Paul · current repair", agent: "paul", repository: "daniels-project-space/jarvis",
        state: "running", status: "running", stage, percent: 64, progress: "Testing", progressAt: 1,
        model: "terra", reasoningEffort: "high", modelReason: "Standard implementation route", workerRuntime: "trigger", workerRunId: "run-1", generation: 2,
        attempt: 1, maxAttempts: 12, dependencyCount: 0, dependenciesReady: 0, integrationState: "not_applicable",
        deliveryStatus: null, mergeState: "not started", recoverySummary: null, needsDaniel: false, attentionReason: null,
        controls: ["pause", "cancel", "steer"], startedAt: 1,
      }],
    },
  };
}

describe("fleet snapshot continuity", () => {
  it("retains the whole same-thread projection through an unresolved refresh and provider handoff", () => {
    const dispatching = snapshot();
    let cache: CompactWorkCache = cacheCompactWorkSnapshot(null, "thread-a", dispatching);
    expect(visibleWorkSnapshot(cache, "thread-a", undefined)).toBe(dispatching);

    const running = snapshot("testing");
    expect(visibleWorkSnapshot(cache, "thread-a", running)).toBe(running);
    cache = cacheCompactWorkSnapshot(cache, "thread-a", running);
    expect(visibleWorkSnapshot(cache, "thread-a", undefined)).toBe(running);
    expect(visibleWorkSnapshot(cache, "thread-a", undefined).fleet?.nodes[0].jobId).toBe("job-1");
  });

  it("honours an explicit empty result and never carries a snapshot across conversations", () => {
    let cache: CompactWorkCache = cacheCompactWorkSnapshot(null, "thread-a", snapshot());
    const empty: CompactWorkSnapshot = { active: null, fleet: null };
    expect(visibleWorkSnapshot(cache, "thread-a", empty)).toEqual(empty);
    cache = cacheCompactWorkSnapshot(cache, "thread-a", empty);
    expect(visibleWorkSnapshot(cache, "thread-a", undefined)).toEqual(empty);
    expect(visibleWorkSnapshot(cacheCompactWorkSnapshot(null, "thread-a", snapshot()), "thread-b", undefined)).toEqual(empty);
  });

  it("never auto-selects stale work from an earlier browser state", () => {
    expect(retainedFleetSelection(null, snapshot())).toBeNull();
    expect(retainedFleetSelection("job-1", snapshot())).toBe("job-1");
    expect(retainedFleetSelection("job-from-old-session", snapshot())).toBeNull();
  });

  it("classifies explicit attention states", () => {
    expect(needsDaniel({ status: "awaiting_approval" })).toBe(true);
    expect(needsDaniel({ status: "needs_input" })).toBe(true);
    expect(needsDaniel({ status: "running", needsDaniel: true })).toBe(true);
    expect(needsDaniel({ status: "running" })).toBe(false);
  });
});
