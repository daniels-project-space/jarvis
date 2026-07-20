import { describe, expect, it } from "vitest";
import { providerReleaseAttestationMatches } from "./provider-release-attestor";

describe("Trigger provider release attestor protocol", () => {
  const sourceSha = "a".repeat(40);
  const projectRef = "proj_wjwbdgeipgpddvrazxnp";
  const version = "20260720.42";

  it("accepts the planner's exact providers-v2 identity", () => {
    expect(providerReleaseAttestationMatches({
      payload: {
        protocol: 1,
        releaseId: `providers-v2:${"b".repeat(64)}`,
        expectedSourceSha: sourceSha,
        expectedProjectRef: projectRef,
        expectedVersion: version,
      },
      projectRef,
      sourceSha,
      version,
    })).toBe(true);
  });

  it("rejects the obsolete v1 protocol and every mismatched bundle coordinate", () => {
    const obsolete = {
      protocol: 1 as const,
      releaseId: `providers-v1:${"b".repeat(64)}`,
      expectedSourceSha: sourceSha,
      expectedProjectRef: projectRef,
      expectedVersion: version,
    };
    expect(providerReleaseAttestationMatches({ payload: obsolete, projectRef, sourceSha, version })).toBe(false);

    const payload = { ...obsolete, releaseId: `providers-v2:${"b".repeat(64)}` };
    for (const observed of [
      { projectRef: "proj_wrong", sourceSha, version },
      { projectRef, sourceSha: "c".repeat(40), version },
      { projectRef, sourceSha, version: "20260720.41" },
    ]) {
      expect(providerReleaseAttestationMatches({ payload, ...observed }), JSON.stringify(observed)).toBe(false);
    }
    expect(providerReleaseAttestationMatches({
      payload: { ...payload, expectedSourceSha: "not-a-commit" },
      projectRef,
      sourceSha: "not-a-commit",
      version,
    })).toBe(false);
  });
});
