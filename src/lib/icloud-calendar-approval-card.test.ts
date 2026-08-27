import { describe, expect, it } from "vitest";
import {
  canSubmitICloudCalendarApproval,
  iCloudCalendarApprovalButtonLabel,
} from "./icloud-calendar-approval-card";

describe("iCloud Calendar approval card state", () => {
  it("allows a transient provider failure to retry the same sealed receipt", () => {
    expect(canSubmitICloudCalendarApproval("ready")).toBe(true);
    expect(canSubmitICloudCalendarApproval("error")).toBe(true);
    expect(canSubmitICloudCalendarApproval("approving")).toBe(false);
    expect(canSubmitICloudCalendarApproval("completed")).toBe(false);
    expect(iCloudCalendarApprovalButtonLabel("error")).toBe("Retry iCloud event");
  });
});
