import { describe, expect, it } from "vitest";
import { admissionMutationName, missionProtocolPhase, rolloutReadiness } from "./mission-protocol-rollout";

describe("additive mission protocol rollout", () => {
  it("keeps a new dormant caller on old-Convex-compatible names", () => {
    expect(missionProtocolPhase(undefined)).toBe("dormant");
    expect(admissionMutationName("mission", "dormant")).toBe("missions:create");
    expect(admissionMutationName("job", "dormant")).toBe("jobs:enqueue");
    expect(admissionMutationName("goal", "dormant")).toBe("goalMode:create");
  });

  it("activates only explicit v2 names after the old executable drain", () => {
    expect(rolloutReadiness({
      phase: "active", v2ConvexAvailable: true, v2WorkersReady: true, legacyExecutableJobs: 1,
    })).toEqual({ executableV2: false, reason: "legacy_drain_incomplete" });
    expect(rolloutReadiness({
      phase: "active", v2ConvexAvailable: true, v2WorkersReady: true, legacyExecutableJobs: 0,
    })).toEqual({ executableV2: true, reason: "active" });
    expect(admissionMutationName("mission", "active")).toBe("missions:createV2");
  });

  it("rolls admission back to a durable non-executable v1 hold", () => {
    expect(admissionMutationName("job", "rollback")).toBe("jobs:enqueue");
    expect(rolloutReadiness({
      phase: "rollback", v2ConvexAvailable: true, v2WorkersReady: true, legacyExecutableJobs: 0,
    })).toEqual({ executableV2: false, reason: "rollback" });
  });
});
