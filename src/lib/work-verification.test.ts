import { describe, expect, it } from "vitest";
import {
  cumulativeWorkEvidence,
  EVIDENCE_INTEGRITY_RULES,
  isPermittedReadonlyAccessGap,
  SUPERVISOR_MEASUREMENT_RULES,
  supervisorDeliveryBoundary,
  WORK_VERIFICATION_EVIDENCE_MAX_CHARS,
} from "./work-verification";

describe("supervisor verification boundaries", () => {
  it("does not demand controller delivery from an implementation workstream", () => {
    expect(supervisorDeliveryBoundary("building")).toContain("trusted delivery controller");
    expect(supervisorDeliveryBoundary("refining")).toContain("scoped definition of done");
    expect(supervisorDeliveryBoundary("validating")).toBe("");
  });

  it("rejects assertions and compile checks as substitutes for provider lineage", () => {
    expect(EVIDENCE_INTEGRITY_RULES).toContain("caller-supplied field");
    expect(EVIDENCE_INTEGRITY_RULES).toContain("persisted lineage");
    expect(EVIDENCE_INTEGRITY_RULES).toContain("compile-time placeholder");
    expect(EVIDENCE_INTEGRITY_RULES).toContain("static expiring token");
  });

  it("does not promote incidental runtime observations into exact acceptance targets", () => {
    expect(SUPERVISOR_MEASUREMENT_RULES).toContain("ordinary runtime variance is not a concern");
    expect(SUPERVISOR_MEASUREMENT_RULES).toContain("declared metric/target");
    expect(SUPERVISOR_MEASUREMENT_RULES).toContain("inequality");
    expect(SUPERVISOR_MEASUREMENT_RULES).toContain("sandbox Git HEAD is a synthetic transport commit");
    expect(SUPERVISOR_MEASUREMENT_RULES).toContain("post-exit provider termination");
  });

  it("carries completed checkpoint evidence into repair-pass supervision", () => {
    const evidence = cumulativeWorkEvidence(
      "R2 guards, outbox traces, migrations, and CI were implemented and verified.",
      "The forged proxy cookie is now rejected and its regression test passes.",
    );
    expect(evidence).toContain("R2 guards, outbox traces, migrations, and CI");
    expect(evidence).toContain("forged proxy cookie is now rejected");
    expect(evidence.length).toBeLessThanOrEqual(WORK_VERIFICATION_EVIDENCE_MAX_CHARS);
  });

  it("does not escalate an explicitly permitted read-access gap to Daniel", () => {
    expect(isPermittedReadonlyAccessGap({
      readonly: true,
      task: "Never POST or mutate; stop on missing read access and name the gap.",
      result: "Authenticated production evidence is unavailable without a read capability. Source and public checks are documented.",
    })).toBe(true);
  });

  it("does not excuse ordinary incomplete work", () => {
    expect(isPermittedReadonlyAccessGap({
      readonly: true,
      task: "Prove the live rows and finish the report.",
      result: "Authenticated access is unavailable.",
    })).toBe(false);
  });
});
