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
    effort: "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
    reason: RegExp;
  }>([
    {
      name: "ordinary research defaults to Terra xhigh",
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
      model: "terra",
      effort: "xhigh",
      reason: /Research workload/,
    },
    {
      name: "long core architecture selects Terra ultra before Sol",
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
      model: "terra",
      effort: "ultra",
      reason: /Architecture on Terra/,
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
      reason: /Exceptional security\/privacy safety floor/,
    },
    {
      name: "writable implementation uses the Terra xhigh quality default",
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
      model: "terra",
      effort: "xhigh",
      reason: /Implementation quality default/,
    },
    {
      name: "routine deterministic verification keeps the Terra quality default unless explicitly read-only",
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
      model: "terra",
      effort: "xhigh",
      reason: /Verification workload/,
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
      effort: "xhigh",
      reason: /requested Sol\/high floor/,
    },
    {
      name: "single-repository root-cause repair uses Terra xhigh instead of automatic Sol max",
      input: {
        task: "Find and fix the difficult root cause of the stuck compact task card in this repository",
        role: "paul",
        repo: "daniels-project-space/jarvis",
        workType: "implementation",
        complexity: "complex",
        uncertainty: "medium",
        productionRisk: "medium",
        expectedDuration: "medium",
        toolBreadth: "moderate",
      },
      model: "terra",
      effort: "xhigh",
      reason: /Difficult root-cause work/,
    },
    {
      name: "cross-project synthesis selects Terra ultra before Sol",
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
      model: "terra",
      effort: "ultra",
      reason: /Cross-project synthesis/,
    },
    {
      name: "Paul applying a routine repair keeps the Terra xhigh implementation default",
      input: {
        task: "Apply the routine deterministic rename in one file",
        role: "paul",
      },
      model: "terra",
      effort: "xhigh",
      reason: /Implementation quality default/,
    },
    {
      name: "writable bounded synthesis uses Terra xhigh",
      input: {
        task: "Consolidate one completed exchange into a bounded deterministic memory record",
        role: "memory-extractor",
        workType: "synthesis",
        complexity: "bounded",
        uncertainty: "low",
        productionRisk: "medium",
        expectedDuration: "short",
        toolBreadth: "narrow",
      },
      model: "terra",
      effort: "xhigh",
      reason: /Synthesis workload/,
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

  it("keeps human-gated external actions on Terra unless production or sensitive-data risk makes Sol necessary", () => {
    expect(selectCodexWorkPolicy({
      task: "Send the approved client a confirmation email",
      role: "jarvis",
      risk: "consequential",
    })).toMatchObject({ model: "terra", reasoningEffort: "xhigh", productionRisk: "high" });
    expect(selectCodexWorkPolicy({
      task: "Deploy the production privacy permission repair for customer data",
      role: "paul",
      risk: "consequential",
    })).toMatchObject({ model: "sol", reasoningEffort: "max", productionRisk: "critical" });
  });

  it("accepts Terra/xhigh and Terra/ultra as persisted quality floors", () => {
    expect(selectCodexWorkPolicy({
      task: "Apply the routine deterministic rename using Terra/xhigh",
      role: "paul",
    })).toMatchObject({ model: "terra", reasoningEffort: "xhigh" });
    expect(selectCodexWorkPolicy({
      task: "Complete the multi-repository architecture migration using Terra/ultra",
      role: "paul",
    })).toMatchObject({ model: "terra", reasoningEffort: "ultra" });
    expect(selectCodexWorkPolicy({
      task: "Complete the multi-repository architecture migration using Terra ultra",
      role: "paul",
    })).toMatchObject({ model: "terra", reasoningEffort: "ultra" });
    expect(selectCodexWorkPolicy({
      task: "Apply the routine deterministic rename using Terra x high",
      role: "paul",
    })).toMatchObject({ model: "terra", reasoningEffort: "xhigh" });
  });

  it("does not mistake a non-model use of ultra for an expensive reasoning request", () => {
    expect(selectCodexWorkPolicy({
      task: "Make the microphone startup feel ultra fast without changing behavior",
      role: "paul",
    })).toMatchObject({ model: "terra", reasoningEffort: "xhigh" });
  });

  it("keeps emphatic quality language on Terra ultra unless Sol/max is explicit", () => {
    expect(selectCodexWorkPolicy({
      task: "Think really hard and produce the highest quality architecture recommendation",
      role: "goal-planner",
    })).toMatchObject({ model: "terra", reasoningEffort: "ultra" });
    expect(selectCodexWorkPolicy({
      task: "Use Sol/max for the exceptional safety review",
      role: "sentry",
    })).toMatchObject({ model: "sol", reasoningEffort: "max" });
  });

  it.each([
    {
      task: "Apply the routine deterministic rename with high reasoning effort",
      model: "terra",
      reasoningEffort: "xhigh",
    },
    {
      task: "Apply the routine deterministic rename at high quality",
      model: "terra",
      reasoningEffort: "xhigh",
    },
    {
      task: "Apply the routine deterministic rename using Terra/high",
      model: "terra",
      reasoningEffort: "xhigh",
    },
  ])("retains a natural-language quality floor: $task", ({ task, model, reasoningEffort }) => {
    const route = selectCodexWorkPolicy({ task, role: "paul" });
    expect(route).toMatchObject({ model, reasoningEffort });
    expect(route.modelReason).toMatch(/Explicit quality floor retained/);
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
    expect(route).toMatchObject({ model: "terra", reasoningEffort: "xhigh", escalated: true });
    expect(route.modelReason).toMatch(/after 2 evidenced quality failures/);
    expect(route.modelReason).toContain("same contract remained incomplete");
  });

  it("spends the remaining Terra/ultra step before Sol max", () => {
    expect(selectCodexRetryPolicy({
      model: "terra",
      reasoningEffort: "xhigh",
      modelReason: "Prior escalation",
      qualityFailureCount: 2,
      evidence: "two further supervisor concerns",
    })).toMatchObject({ model: "terra", reasoningEffort: "ultra", escalated: true });
    expect(selectCodexRetryPolicy({
      model: "terra",
      reasoningEffort: "ultra",
      modelReason: "Ultra route still failed independently",
      qualityFailureCount: 4,
      evidence: "four supervisor-evidenced quality failures",
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
