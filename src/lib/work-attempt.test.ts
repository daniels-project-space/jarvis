import { describe, expect, it } from "vitest";
import { hasAttemptBudget, isMeaningfulWorkProgress } from "./work-attempt";

describe("durable work attempt policy", () => {
  it("does not treat liveness-shaped text as causal progress", () => {
    expect(isMeaningfulWorkProgress({
      currentStage: "executing", currentPercent: 32, currentProgress: "still running",
      nextProgress: "still running",
    })).toBe(false);
  });

  it("accepts a stage or percentage advance as durable progress", () => {
    expect(isMeaningfulWorkProgress({
      currentStage: "executing", currentPercent: 32, currentProgress: "command",
      nextStage: "reviewing", nextPercent: 32, nextProgress: "checking evidence",
    })).toBe(true);
    expect(isMeaningfulWorkProgress({
      currentStage: "executing", currentPercent: 32, currentProgress: "command",
      nextPercent: 45, nextProgress: "more work complete",
    })).toBe(true);
  });

  it("keeps retries inside their bounded attempt budget", () => {
    expect(hasAttemptBudget(3, 3)).toBe(true);
    expect(hasAttemptBudget(4, 3)).toBe(false);
  });
});
