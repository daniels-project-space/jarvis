import { describe, expect, it } from "vitest";
import { hubContextStatusPresentation } from "./hub-context-status";

describe("Project Hub context status presentation", () => {
  it("makes dedicated-capability setup explicit without implying the broad vault is used", () => {
    expect(hubContextStatusPresentation("configured")).toMatchObject({
      label: "configured ✓",
      tone: "ready",
    });
    expect(hubContextStatusPresentation("needs_setup")).toMatchObject({
      label: "needs setup",
      tone: "attention",
      hint: expect.stringContaining("never use the broad vault credential"),
    });
  });

  it("keeps checking and transient-unavailable states distinguishable", () => {
    expect(hubContextStatusPresentation("checking")).toMatchObject({ label: "checking…", tone: "neutral" });
    expect(hubContextStatusPresentation("unavailable")).toMatchObject({ label: "check later", tone: "attention" });
  });
});
