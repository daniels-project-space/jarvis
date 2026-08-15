import { describe, expect, it } from "vitest";
import { hubActionsStatusPresentation } from "./hub-actions-status";

describe("Project Hub actions status presentation", () => {
  it("keeps the capability boundary explicit in every owner-visible state", () => {
    expect(hubActionsStatusPresentation("configured")).toMatchObject({
      label: "configured ✓",
      tone: "ready",
    });
    expect(hubActionsStatusPresentation("needs_setup").hint).toContain("broad vault credential");
    expect(hubActionsStatusPresentation("unavailable").hint).toContain("no Hub to-do changes");
    expect(hubActionsStatusPresentation("checking").tone).toBe("neutral");
  });
});
