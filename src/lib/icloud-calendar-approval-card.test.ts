import { describe, expect, it } from "vitest";
import {
  canSubmitICloudCalendarApproval,
  iCloudCalendarApprovalFailureState,
  iCloudCalendarApprovalButtonLabel,
} from "./icloud-calendar-approval-card";

describe("iCloud Calendar approval card state", () => {
  it("allows a transient provider failure to retry the same sealed receipt", () => {
    expect(canSubmitICloudCalendarApproval("ready")).toBe(true);
    expect(canSubmitICloudCalendarApproval("error")).toBe(true);
    expect(canSubmitICloudCalendarApproval("approving")).toBe(false);
    expect(canSubmitICloudCalendarApproval("completed")).toBe(false);
    expect(canSubmitICloudCalendarApproval("expired")).toBe(false);
    expect(iCloudCalendarApprovalButtonLabel("error")).toBe("Retry iCloud event");
    expect(iCloudCalendarApprovalFailureState(502)).toBe("error");
  });

  it("does not offer a dead retry for an expired or invalid receipt", () => {
    expect(iCloudCalendarApprovalFailureState(400)).toBe("expired");
    expect(iCloudCalendarApprovalButtonLabel("expired")).toBe("Approval expired");
  });
});
