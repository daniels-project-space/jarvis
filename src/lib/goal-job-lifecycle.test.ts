import { describe, expect, it } from "vitest";
import { isResumeOnlyUntouchedGoalJob, shouldPauseGoalJob } from "./goal-job-lifecycle";

describe("Goal Mode pause and resume lifecycle", () => {
  it("invalidates reserved and running workers without rewriting untouched pending jobs", () => {
    expect(shouldPauseGoalJob("dispatching")).toBe(true);
    expect(shouldPauseGoalJob("running")).toBe(true);
    expect(shouldPauseGoalJob("pending")).toBe(false);
  });

  it("recognizes only legacy resume notes on a never-started job", () => {
    const note = "Daniel resumed the parent goal. Preserve completed evidence and retry only the unfinished boundary.";
    expect(isResumeOnlyUntouchedGoalJob({
      status: "pending",
      progress: "Goal Mode recovery queued",
      checkpoint: `${note}\n\n${note}`,
    })).toBe(true);
    expect(isResumeOnlyUntouchedGoalJob({
      status: "pending",
      progress: "Goal Mode recovery queued",
      checkpoint: `Previous work: real evidence\n\n${note}`,
    })).toBe(false);
    expect(isResumeOnlyUntouchedGoalJob({
      status: "pending",
      progress: "Goal Mode recovery queued",
      checkpoint: note,
      workerRunId: "run_123",
    })).toBe(false);
  });
});

