import { describe, expect, it } from "vitest";
import { workApprovalPolicy } from "../../convex/workPolicy";
import { repairPrompt } from "./repair-prompt";

describe("self-repair prompt", () => {
  it("stays repository-scoped instead of approval-gating its own repair worker", () => {
    const task = repairPrompt({
      source: "client",
      message: "A production query is missing.",
      signature: "missing-query",
      count: 2,
      attempts: 1,
    }, "jarvis");
    expect(workApprovalPolicy({ task, repo: "jarvis", risk: "high" }).required).toBe(false);
    expect(task).toContain("you cannot deploy those");
  });
});
