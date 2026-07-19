import { describe, expect, it } from "vitest";
import { workApprovalPolicy } from "../../convex/workPolicy";
import { plannerTask, routeGoal } from "../lib/goal-mode";

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

  it("does not let readonly waive an explicit consequential action", () => {
    expect(
      workApprovalPolicy({
        task: "Send a reply to the tenant",
        readonly: true,
        approvalRequired: false,
      }).required,
    ).toBe(true);
    expect(
      workApprovalPolicy({
        task: "Research replacement options and purchase the best one",
        readonly: true,
      }).required,
    ).toBe(true);
  });

  it("allows bounded read-only and isolated repository work", () => {
    expect(workApprovalPolicy({ task: "Audit why publishing can race", readonly: true }).required).toBe(false);
    expect(
      workApprovalPolicy({
        task: "Audit whether an untrusted worker can send replies. Do not send anything.",
        readonly: true,
      }).required,
    ).toBe(false);
    expect(
      workApprovalPolicy({
        task:
          "Audit the release boundary. Live policy evidence: a test job asked to send a tenant reply; Convex blocked it.",
        readonly: true,
      }).required,
    ).toBe(false);
    expect(workApprovalPolicy({ task: "Fix the parser and run tests", repo: "jarvis" }).required).toBe(false);
    expect(workApprovalPolicy({ task: "Research current orchestration patterns" }).required).toBe(false);
  });

  it("does not deadlock Goal Mode on its own generated planner safety contract", () => {
    const goal = "Produce a strictly read-only audit report with two evidence workstreams.";
    expect(workApprovalPolicy({
      task: plannerTask(goal, routeGoal(goal), ["Report concrete evidence"], 2),
      readonly: true,
      risk: "low",
    }).required).toBe(false);
  });

  it("does not let an evidence label disguise a fresh imperative", () => {
    expect(
      workApprovalPolicy({
        task: "Audit the release boundary. Evidence: send the tenant reply",
        readonly: true,
      }).required,
    ).toBe(true);
  });

  it("fails closed for an unclassified non-repository action", () => {
    expect(workApprovalPolicy({ task: "Handle this for me" })).toMatchObject({
      required: true,
      reason: "unclassified non-repository action defaults to approval",
    });
  });
});
