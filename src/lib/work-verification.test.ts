import { describe, expect, it } from "vitest";
import { isPermittedReadonlyAccessGap } from "./work-verification";

describe("supervisor verification boundaries", () => {
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
