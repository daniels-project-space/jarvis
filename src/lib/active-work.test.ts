import { describe, expect, it } from "vitest";
import {
  cacheCompactWorkSnapshot,
  needsDaniel,
  retainedFleetSelection,
  visibleWorkSnapshot,
  type CompactWorkCache,
  type CompactWorkSnapshot,
  type FleetNode,
} from "./active-work";

function snapshot(stage = "dispatching"): CompactWorkSnapshot {
  const job: FleetNode = {
    id: "surface", jobId: "job-1", label: "Paul · current repair", agent: "paul", repository: "daniels-project-space/jarvis",
    state: "running", status: "running", stage, percent: 64, progress: "Testing", progressAt: 1,
    model: "terra", reasoningEffort: "high", modelReason: "Terra/high for bounded implementation",
    workerRuntime: "trigger", workerRunId: "run-1", generation: 2,
    attempt: 1, maxAttempts: 12, dependencyCount: 0, dependenciesReady: 0, integrationState: "not_applicable",
    deliveryStatus: null, mergeState: "not started", recoverySummary: null, needsDaniel: false, attentionReason: null,
    controls: ["pause", "cancel", "steer"], startedAt: 1,
  };
  return {
    active: { id: "job-1", missionId: "mission-1", label: "Paul · current repair", status: stage === "dispatching" ? "dispatching" : "running", stage, percent: stage === "dispatching" ? 2 : 64, extraCount: 2, needsDaniel: false },
    fleet: {
      id: "mission-1", goal: "Repair this request", mode: "goal", status: "running", phase: stage,
      percent: 64, repository: "daniels-project-space/jarvis", planDigest: "digest", planGeneration: 2,
      integrationState: "building", attentionCount: 0, controls: ["pause", "cancel", "steer"], edges: [],
      nodes: [job],
    },
    hierarchy: [{
      id: "mission-group-1", label: "Repair this request", status: "running", phase: stage,
      projects: [{ id: "project-group-1", canonicalProjectId: "jarvis", repository: "daniels-project-space/jarvis", jobs: [job] }],
    }],
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
    const empty: CompactWorkSnapshot = { active: null, fleet: null, hierarchy: [] };
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

  it("retains an explicit selection from a concurrent mission outside the primary fleet DAG", () => {
    const current = snapshot();
    current.hierarchy.push({
      id: "mission-group-2", label: "Concurrent mission", status: "running", phase: "building",
      projects: [{
        id: "project-group-2", canonicalProjectId: "jarvis", repository: "daniels-project-space/jarvis",
        jobs: [{ ...current.hierarchy[0].projects[0].jobs[0], id: "second", jobId: "job-2", label: "Second mission work" }],
      }],
    });
    expect(retainedFleetSelection("job-2", current)).toBe("job-2");
  });

  it("classifies explicit attention states", () => {
    expect(needsDaniel({ status: "awaiting_approval" })).toBe(true);
    expect(needsDaniel({ status: "needs_input" })).toBe(true);
    expect(needsDaniel({ status: "running", needsDaniel: true })).toBe(true);
    expect(needsDaniel({ status: "running" })).toBe(false);
  });
});
