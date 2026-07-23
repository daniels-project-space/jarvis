import { describe, expect, it } from "vitest";
import {
  selectCodexRetryPolicy,
  selectCodexWorkPolicy,
  type CodexWorkPolicyInput,
} from "./codex-work-router";

describe("adaptive Codex work policy", () => {
  it.each<{
    name: string;
    input: CodexWorkPolicyInput;
    model: "luna" | "terra" | "sol";
    effort: "low" | "medium" | "high" | "max";
    reason: RegExp;
  }>([
    {
      name: "bounded research specialist defaults to Luna with proportionate effort",
      input: {
        task: "Research the current primary sources and compare the documented options",
        role: "atlas",
        readonly: true,
        workType: "research",
        complexity: "bounded",
        uncertainty: "medium",
        expectedDuration: "short",
        toolBreadth: "moderate",
      },
      model: "luna",
      effort: "medium",
      reason: /Bounded research specialist/,
    },
    {
      name: "long core architecture selects Sol max",
      input: {
        task: "Redesign the core architecture end-to-end for a long-running distributed orchestration system",
        role: "goal-planner",
        workType: "architecture",
        complexity: "intense",
        uncertainty: "high",
        productionRisk: "high",
        expectedDuration: "long",
        toolBreadth: "broad",
      },
      model: "sol",
      effort: "max",
      reason: /Long or high-risk architecture/,
    },
    {
      name: "production security cannot fall below Sol max",
      input: {
        task: "Repair production authentication and tenant privacy isolation without exposing customer data",
        role: "paul",
        requestedModel: "luna",
        requestedReasoningEffort: "low",
      },
      model: "sol",
      effort: "max",
      reason: /Security\/privacy safety floor/,
    },
    {
      name: "deterministic bounded repair uses Luna medium",
      input: {
        task: "Implement the deterministic bounded known fix in one file and run the exact contract test",
        role: "paul",
        repo: "daniels-project-space/jarvis",
        workType: "implementation",
        complexity: "bounded",
        uncertainty: "low",
        productionRisk: "medium",
        expectedDuration: "short",
        toolBreadth: "narrow",
      },
      model: "luna",
      effort: "medium",
      reason: /Deterministic bounded implementation/,
    },
    {
      name: "routine deterministic verification uses the minimum safe route",
      input: {
        task: "Verify the deterministic fixed fixture with the exact contract test",
        role: "supervisor-reviewer",
        workType: "verification",
        complexity: "bounded",
        uncertainty: "low",
        productionRisk: "low",
        expectedDuration: "short",
        toolBreadth: "narrow",
      },
      model: "luna",
      effort: "low",
      reason: /Routine deterministic verification/,
    },
    {
      name: "an explicit quality override remains a floor",
      input: {
        task: "Apply the routine deterministic rename in one file",
        role: "paul",
        requestedModel: "sol",
        requestedReasoningEffort: "high",
      },
      model: "sol",
      effort: "max",
      reason: /requested Sol\/high floor/,
    },
    {
      name: "cross-project synthesis selects Sol max",
      input: {
        task: "Synthesize the accepted findings into one cross-project brief",
        role: "mission-synthesizer",
        workType: "synthesis",
        crossProject: true,
        complexity: "intense",
        uncertainty: "high",
        expectedDuration: "long",
        toolBreadth: "broad",
      },
      model: "sol",
      effort: "max",
      reason: /Cross-project synthesis/,
    },
  ])("$name", ({ input, model, effort, reason }) => {
    const route = selectCodexWorkPolicy(input);
    expect(route).toMatchObject({ model, reasoningEffort: effort });
    expect(route.modelReason).toMatch(reason);
    expect(route.modelReason.length).toBeLessThanOrEqual(300);
  });

  it("never downgrades an explicit effort floor while applying a higher safety tier", () => {
    expect(selectCodexWorkPolicy({
      task: "Audit the bounded production privacy permission contract",
      role: "sentry",
      requestedModel: "terra",
      requestedReasoningEffort: "max",
    })).toMatchObject({ model: "sol", reasoningEffort: "max" });
  });
});

describe("adaptive Codex retry policy", () => {
  const persisted = {
    model: "luna",
    reasoningEffort: "medium",
    modelReason: "Deterministic bounded implementation; persisted decision",
  } as const;

  it.each([0, 1])("preserves the exact route through %i evidenced quality failure(s)", (qualityFailureCount) => {
    expect(selectCodexRetryPolicy({
      ...persisted,
      qualityFailureCount,
      evidence: qualityFailureCount ? "one supervisor concern" : undefined,
    })).toEqual({ ...persisted, escalated: false });
  });

  it("escalates one tier only after repeated explicit quality evidence", () => {
    const route = selectCodexRetryPolicy({
      ...persisted,
      qualityFailureCount: 2,
      evidence: "the same contract remained incomplete",
    });
    expect(route).toMatchObject({ model: "terra", reasoningEffort: "high", escalated: true });
    expect(route.modelReason).toMatch(/after 2 evidenced quality failures/);
    expect(route.modelReason).toContain("same contract remained incomplete");
  });

  it("allows a later separately evidenced Terra escalation but never exceeds Sol max", () => {
    expect(selectCodexRetryPolicy({
      model: "terra",
      reasoningEffort: "high",
      modelReason: "Prior escalation",
      qualityFailureCount: 2,
      evidence: "two further supervisor concerns",
    })).toMatchObject({ model: "sol", reasoningEffort: "max", escalated: true });
    expect(selectCodexRetryPolicy({
      model: "sol",
      reasoningEffort: "max",
      modelReason: "Safety floor",
      qualityFailureCount: 9,
      evidence: "still incomplete",
    })).toEqual({ model: "sol", reasoningEffort: "max", modelReason: "Safety floor", escalated: false });
  });
});
