import { describe, expect, it } from "vitest";
import {
  cumulativeWorkEvidence,
  isPermittedReadonlyAccessGap,
  WORK_VERIFICATION_EVIDENCE_MAX_CHARS,
} from "./work-verification";

describe("supervisor verification boundaries", () => {
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
