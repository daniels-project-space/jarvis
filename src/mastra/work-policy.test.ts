import { describe, expect, it } from "vitest";
import { workApprovalPolicy } from "../../convex/workPolicy";

describe("server-side work approval policy", () => {
  it("does not let an explicit false waive consequential work", () => {
    expect(
      workApprovalPolicy({
        task: "Deploy the release to production",
        repo: "jarvis",
        approvalRequired: false,
      }).required,
    ).toBe(true);
  });

  it("gates messaging, money, booking and destructive actions", () => {
    for (const task of [
      "Reply to the tenant",
      "Transfer the supplier payment",
      "Book the selected hotel",
      "Delete the production records",
    ]) {
      expect(workApprovalPolicy({ task }).required).toBe(true);
    }
  });

  it("allows bounded read-only and isolated repository work", () => {
    expect(workApprovalPolicy({ task: "Audit why publishing can race", readonly: true }).required).toBe(false);
    expect(workApprovalPolicy({ task: "Fix the parser and run tests", repo: "jarvis" }).required).toBe(false);
    expect(workApprovalPolicy({ task: "Research current orchestration patterns" }).required).toBe(false);
  });

  it("fails closed for an unclassified non-repository action", () => {
    expect(workApprovalPolicy({ task: "Handle this for me" })).toMatchObject({
      required: true,
      reason: "unclassified non-repository action defaults to approval",
    });
  });
});
