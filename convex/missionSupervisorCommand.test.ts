import { describe, expect, it } from "vitest";
import type { Doc, Id } from "./_generated/dataModel";
import { projectMissionSupervisorCommand } from "./missionSupervisorCommand";

const MISSION_ID = "mission-command-projection" as Id<"missions">;

function mission(
  overrides: Partial<Doc<"missions">> = {},
): Doc<"missions"> {
  return {
    _id: MISSION_ID,
    _creationTime: 100,
    goal: "Keep the supervisor command projection bounded.",
    mode: "supervised",
    status: "running",
    phase: "planning",
    percent: 20,
    priority: 90,
    originThreadId: "main",
    steerRevision: 1,
    createdAt: 100,
    updatedAt: 200,
    ...overrides,
  } as Doc<"missions">;
}

function state(
  overrides: Partial<Doc<"missionSupervisorState">> = {},
): Doc<"missionSupervisorState"> {
  return {
    _id: "mission-command-state" as Id<"missionSupervisorState">,
    _creationTime: 101,
    protocolVersion: 1,
    missionId: MISSION_ID,
    requestKey: "command-projection-test",
    requestDigest: "a".repeat(64),
    profile: "short_fleet",
    state: "needs_input",
    epoch: 1,
    nextDecisionSequence: 1,
    inputRevision: 2,
    handledInputRevision: 1,
    steerDigest: "b".repeat(64),
    dirtyJobIds: [],
    deadlineAt: 10_000,
    maxJobs: 24,
    maxDecisions: 64,
    totalJobs: 1,
    decisionCount: 1,
    consecutiveFailures: 0,
    leaseVersion: 1,
    createdAt: 101,
    updatedAt: 300,
    ...overrides,
  } as Doc<"missionSupervisorState">;
}

describe("mission supervisor command projection", () => {
  it("redacts secrets and bounds questions by UTF-8 bytes", () => {
    const projection = projectMissionSupervisorCommand(
      mission(),
      state(),
      `Use sk-proj-abcdefghijklmnopqrstuvwxyz0123456789 then ${"🛰️".repeat(600)}`,
      true,
    );

    expect(projection.question).not.toContain("sk-proj-");
    expect(projection.question).toContain("[REDACTED_TOKEN]");
    expect(new TextEncoder().encode(projection.question).byteLength)
      .toBeLessThanOrEqual(1_000);
    expect(projection.inputTargeted).toBe(true);
  });

  it("normalizes malformed counters and deactivates terminal authority", () => {
    const projection = projectMissionSupervisorCommand(
      mission({
        status: "done",
        priority: Number.POSITIVE_INFINITY,
        steerRevision: Number.NaN,
      }),
      state({
        state: "terminal",
        inputRevision: Number.NaN,
        totalJobs: 500,
      }),
    );

    expect(projection).toMatchObject({
      active: false,
      priority: 50,
      inputRevision: 0,
      steerRevision: 0,
      totalJobs: 24,
    });
  });

  it("projects exact rollout-safe controls instead of inferring from total jobs", () => {
    const capability = {
      activeJobControlProtocolVersion: 1 as const,
      activeJobControlActions: ["pause" as const, "resume" as const],
    };
    expect(projectMissionSupervisorCommand(
      mission(),
      state({
        ...capability,
        state: "ready",
        totalJobs: 3,
        nonterminalJobCount: 2,
      }),
    ).supportedControlActions).toEqual(["pause"]);
    expect(projectMissionSupervisorCommand(
      mission({ status: "paused" }),
      state({
        ...capability,
        state: "paused",
        totalJobs: 3,
        nonterminalJobCount: 2,
      }),
    ).supportedControlActions).toEqual(["resume"]);
    expect(projectMissionSupervisorCommand(
      mission(),
      state({
        ...capability,
        state: "ready",
        totalJobs: 0,
        nonterminalJobCount: 0,
      }),
    ).supportedControlActions).toEqual(["pause", "cancel", "steer"]);
    expect(projectMissionSupervisorCommand(
      mission({ status: "needs_input" }),
      state({
        ...capability,
        state: "needs_input",
        totalJobs: 1,
        nonterminalJobCount: 0,
      }),
      "Choose the exact recovery.",
      false,
    ).supportedControlActions).toEqual(["cancel"]);
    expect(projectMissionSupervisorCommand(
      mission({ status: "needs_input" }),
      state({
        ...capability,
        state: "needs_input",
        totalJobs: 1,
        nonterminalJobCount: 0,
      }),
      "Choose the exact recovery.",
      true,
    ).supportedControlActions).toEqual(["cancel", "provide_input"]);
    expect(projectMissionSupervisorCommand(
      mission(),
      state({
        state: "ready",
        totalJobs: 3,
        nonterminalJobCount: 2,
      }),
    )).toMatchObject({
      controlAffordanceProtocolVersion: 1,
      supportedControlActions: [],
    });
  });
});
